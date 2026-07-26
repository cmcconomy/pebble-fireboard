// ES5 only. The only file that touches Pebble globals.
var Budget = require('./budget').Budget;
var fireboard = require('./fireboard');
var model = require('./model');
var History = require('./history').History;
var alertsMod = require('./alerts');
var transform = require('./transform');
var configMod = require('./config');

var CONFIG_URL = 'https://cmcconomy.github.io/pebble-fireboard/config/';
var SETTINGS_KEY = 'fb.settings';
var USER_AGENT = 'pebble-fireboard/0.1';
var STALE_AFTER_SEC = 120;
var MAX_BACKOFF_MS = 600000;
// The FireBoard budget is 17 calls per 5 minutes and it is SHARED with the
// user's own phone app. A settings save must not be able to spend a call
// instantly on every keystroke-close of the config page.
var MIN_REPOLL_MS = 10000;

var state = {
  settings: null,
  client: null,
  budget: null,
  history: new History({ maxSamples: 120 }),
  timer: null,
  prevLevel: 0,
  failures: 0,
  // Last values actually observed from the API. Error frames carry these
  // forward instead of inventing defaults: a hardcoded sessionId 0 makes the
  // watch read every error as a NEW cook, and a hardcoded degreetype 2 flips a
  // Celsius user's unit to Fahrenheit on every dropped poll.
  lastSessionId: 0,
  lastDegreetype: 2,
  // Wall-clock time of the last poll that actually spent a budget call.
  lastPollMs: 0,
  // Sticky: a dead token stays dead until the token value actually changes,
  // not merely because settings were re-saved (webviewclosed handles that).
  tokenDead: false,
  // Bumped on every reconfiguration so an in-flight request started under the
  // old client/settings can detect it is stale and drop itself on return.
  generation: 0,
};

function now() { return Date.now(); }

function loadSettings() {
  try {
    var raw = localStorage.getItem(SETTINGS_KEY);
    if (raw == null) return configMod.defaultSettings();
    return configMod.parseConfigResponse(raw);
  } catch (e) {
    return configMod.defaultSettings();
  }
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}

function toF(v, degreetype) {
  // degreetype 1 = Celsius, 2 = Fahrenheit. Stall thresholds are Fahrenheit.
  if (degreetype === 1) return (v * 9 / 5) + 32;
  return v;
}

// Absolute temperature conversion between degreetypes (1 = C, 2 = F).
function convertTemp(v, from, to) {
  if (v === null || v === undefined) return v;
  if (from === to) return v;
  if (to === 1) return (v - 32) * 5 / 9;      // F -> C
  return (v * 9 / 5) + 32;                    // C -> F
}

// The unit the WATCH should display in. 'auto' follows the FireBoard account
// (DEGREETYPE from the API); 'F'/'C' override it.
function displayDegreetype(apiDegreetype) {
  var u = state.settings ? state.settings.units : 'auto';
  if (u === 'F') return 2;
  if (u === 'C') return 1;
  return apiDegreetype;
}

function send(frame) {
  Pebble.sendAppMessage(frame, function () {}, function (e) {
    console.log('send failed: ' + JSON.stringify(e));
  });
}

function sendStatus(bannerText, cooking) {
  send(transform.buildFrame({
    probes: [], pitChannel: null, rates: {}, perProbe: {},
    alertLevel: 0, banner: bannerText, elapsedSec: 0, stalenessSec: 0,
    // Carry the last known session/unit forward -- see state.lastSessionId.
    batteryPct: 0, sessionId: state.lastSessionId,
    degreetype: displayDegreetype(state.lastDegreetype),
    layout: state.settings ? state.settings.layout : 0,
    cooking: !!cooking, showAlertVisuals: true, stale: true,
  }));
}

function bannerForError(kind) {
  if (kind === 'bad_token') return 'SIGN IN AGAIN';
  if (kind === 'no_user_agent') return 'APP ERROR';
  if (kind === 'waf') return 'TRY AGAIN LATER';
  if (kind === 'rate_limited') return 'PAUSED';
  if (kind === 'network') return 'NO SIGNAL';
  return 'RETRYING';
}

function backoffMs() {
  if (state.failures === 0) return 0;
  var ms = 2000 * Math.pow(2, state.failures - 1);
  return ms > MAX_BACKOFF_MS ? MAX_BACKOFF_MS : ms;
}

function normalDelayMs() {
  return (state.settings.pollSec || 30) * 1000;
}

// The loop is a self-rescheduling chain (setTimeout), not setInterval, so a
// failure can widen the gap before the next attempt and a success can return
// to the steady interval. A dead token (state.tokenDead) refuses to schedule
// at all until webviewclosed sees the token value actually change.
function scheduleNext(delayMs) {
  stopTimer();
  if (state.tokenDead) return;
  state.timer = setTimeout(poll, delayMs);
}

function poll() {
  if (!state.client) { sendStatus('SIGN IN', false); scheduleNext(normalDelayMs()); return; }
  if (!state.budget.allow()) { sendStatus('PAUSED', false); scheduleNext(normalDelayMs()); return; }

  state.budget.record();
  state.lastPollMs = now();
  var gen = state.generation;
  state.client.getDevices(function (err, devices) {
    // A reconfiguration happened while this request was in flight. Its
    // result belongs to a client/settings pair that no longer exists —
    // touching state or history now would re-seed data the user just reset.
    if (gen !== state.generation) return;

    if (err) {
      state.failures += 1;
      if (err.kind === 'bad_token') {
        // Terminal: retrying a dead token against a WAF-gated login endpoint
        // makes things worse. Stay stopped until the token value changes.
        state.tokenDead = true;
        sendStatus(bannerForError(err.kind), false);
        stopTimer();
        return;
      }
      // Every other error kind backs off and keeps the token.
      sendStatus(bannerForError(err.kind), false);
      scheduleNext(backoffMs());
      return;
    }
    state.failures = 0;

    var norm = model.normalise(devices, { pitOverride: state.settings.pitOverride });
    var t = now();
    var sessionId = norm.sessionId || 0;
    var dt = displayDegreetype(norm.degreetype);

    // A new session id is a NEW COOK. history.push resets its own series on the
    // change, but prevLevel lives here and must be reset alongside it: a cook
    // that ended at CRITICAL would otherwise leave prevLevel at 3 and the next
    // cook's genuine CRITICAL would fail the rising-edge test and never buzz.
    if (sessionId !== state.lastSessionId) state.prevLevel = 0;
    state.lastSessionId = sessionId;
    state.lastDegreetype = norm.degreetype;

    if (norm.probes.length === 0) {
      // No probes means the cook is over (or has not started). Drop the alert
      // level with it: leaving prevLevel at its final value silently disarms
      // the rising-edge vibration test for the whole of the next cook.
      state.prevLevel = 0;
      send(transform.buildFrame({
        probes: [], pitChannel: null, rates: {}, perProbe: {},
        alertLevel: 0, banner: '', elapsedSec: 0, stalenessSec: 0,
        batteryPct: norm.batteryPct, sessionId: sessionId,
        degreetype: dt, layout: state.settings.layout,
        cooking: false, showAlertVisuals: state.settings.showAlertVisuals,
        stale: false, mayVibrate: false,
      }));
      scheduleNext(normalDelayMs());
      return;
    }

    var stalenessSec = norm.lastTemplogMs
      ? Math.floor((t - norm.lastTemplogMs) / 1000) : 0;
    var elapsedSec = norm.startedMs ? Math.floor((t - norm.startedMs) / 1000) : 0;
    var isStale = stalenessSec > STALE_AFTER_SEC;

    // Unit override. 'auto' follows the account; 'F'/'C' convert everything the
    // watch will display -- temp and the alert bounds it is compared against --
    // into the chosen unit, and DEGREETYPE is set to match so the watch labels
    // it correctly. Bounds must be converted with the SAME transform as temp or
    // the out-of-band comparison in alerts.evaluate becomes nonsense.
    var displayProbes = [];
    var j;
    for (j = 0; j < norm.probes.length; j++) {
      var np = norm.probes[j];
      displayProbes.push({
        channel: np.channel,
        label: np.label,
        hasAlert: np.hasAlert,
        temp: convertTemp(np.temp, norm.degreetype, dt),
        min: convertTemp(np.min, norm.degreetype, dt),
        max: convertTemp(np.max, norm.degreetype, dt),
      });
    }

    // history.js documents that callers must pass Fahrenheit; convert every
    // probe temperature before pushing so the stall band (150-170F) and the
    // 0.1F/min rate gate are evaluated in the units they were tuned for, even
    // on a Celsius account. Only temp feeds history's arithmetic.
    //
    // STALE DATA MUST NOT ENTER THE HISTORY. When a FireBoard loses power the
    // API keeps serving the last reading unchanged. Pushing that frozen value
    // every 30s manufactures a ~0 rate over a 20-minute window with the pit
    // still recorded above 180F -- exactly the isStalled() signature -- and the
    // watch would report a comfortable STALLED while the fire is actually out.
    // Skipping the push leaves the series frozen at the last live sample and
    // forcing stalled=false refuses to make any stall claim from dead data.
    if (!isStale) {
      var historyProbes = [];
      for (j = 0; j < norm.probes.length; j++) {
        historyProbes.push({
          channel: norm.probes[j].channel,
          temp: toF(norm.probes[j].temp, norm.degreetype),
        });
      }
      state.history.push(sessionId, historyProbes, t);
    }

    var pitTempF = null;
    var i;
    for (i = 0; i < norm.probes.length; i++) {
      if (norm.probes[i].channel === norm.pitChannel) {
        pitTempF = toF(norm.probes[i].temp, norm.degreetype);
      }
    }

    var rates = {};
    var stalledChannels = {};
    for (i = 0; i < norm.probes.length; i++) {
      var ch = norm.probes[i].channel;
      var rateF = state.history.rate(ch);
      // history always stores Fahrenheit, so rate() returns F/min. P_RATE is
      // displayed in the unit the watch is showing (dt), so convert back for a
      // Celsius display. A rate is a DELTA: scale by 5/9 only -- never apply
      // the +32 offset here.
      rates[ch] = (rateF === null || dt !== 1) ? rateF : (rateF * 5 / 9);
      if (ch !== norm.pitChannel) {
        stalledChannels[ch] = isStale
          ? false : state.history.isStalled(ch, t, pitTempF);
      }
    }

    var evaluated = alertsMod.evaluate({
      probes: displayProbes,
      pitChannel: norm.pitChannel,
      stalledChannels: stalledChannels,
    });

    var d = new Date();
    var vibrate = alertsMod.shouldVibrate(evaluated.level, state.prevLevel, {
      vibrateEnabled: state.settings.vibrateEnabled,
      quietHours: state.settings.quietStart === null ? null : {
        startMinutes: state.settings.quietStart,
        endMinutes: state.settings.quietEnd,
      },
      nowLocalMinutes: d.getHours() * 60 + d.getMinutes(),
    });

    // The phone owns the vibrate policy (quiet hours, the enabled toggle);
    // the watch owns the buzz itself, triggering on a rising ALERT_LEVEL only
    // when MAY_VIBRATE is set. One AppMessage per poll -- no second send.
    send(transform.buildFrame({
      probes: displayProbes,
      pitChannel: norm.pitChannel,
      rates: rates,
      perProbe: evaluated.perProbe,
      alertLevel: evaluated.level,
      banner: evaluated.banner,
      elapsedSec: elapsedSec,
      stalenessSec: stalenessSec,
      batteryPct: norm.batteryPct,
      sessionId: sessionId,
      degreetype: dt,
      layout: state.settings.layout,
      cooking: true,
      showAlertVisuals: state.settings.showAlertVisuals,
      stale: isStale,
      mayVibrate: vibrate,
    }));

    state.prevLevel = evaluated.level;
    scheduleNext(normalDelayMs());
  });
}

function stopTimer() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
}

function restartTimer() {
  stopTimer();
  // A dead token refuses to restart the loop at all -- see poll()'s
  // bad_token handling and webviewclosed's token check below.
  if (state.tokenDead) return;
  var delay = backoffMs();
  // Debounce the immediate re-poll. backoffMs() is 0 after a successful poll,
  // so every settings save used to spend a budget call the instant the config
  // page closed -- and a user tweaking three settings in a row burned three of
  // the 17-per-5-minutes that are shared with their own phone app. Nothing in
  // a settings change makes fresher data available, so waiting is free.
  var since = now() - state.lastPollMs;
  if (state.lastPollMs && since < MIN_REPOLL_MS) {
    var wait = MIN_REPOLL_MS - since;
    if (wait > delay) delay = wait;
  }
  scheduleNext(delay);
}

function rebuild() {
  state.budget = new Budget({
    now: now, storage: localStorage, limit: 17, windowMs: 300000,
  });
  if (!state.settings.token) { state.client = null; return; }
  state.client = new fireboard.Client({
    token: state.settings.token,
    xhrFactory: XMLHttpRequest,
    userAgent: USER_AGENT,
  });
}

Pebble.addEventListener('ready', function () {
  state.settings = loadSettings();
  rebuild();
  restartTimer();
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(configMod.buildConfigUrl(CONFIG_URL, state.settings));
});

// True when THIS config response changed the credential situation, either by
// delivering a non-empty token or by explicitly signing out. Inspecting the
// merged settings instead cannot answer the question: the merge deliberately
// carries the previous token forward when the page omits the key, so
// `updated.token` is non-empty on virtually every save.
//
// `signOut` and `token` are mutually exclusive on the wire -- the config page
// sends one or the other, never both (see the Save handler in
// config/index.html) -- so a sign-out carries NO token key and must be
// recognised on its own. Testing only for a delivered token strands the user
// on the stale SIGN IN AGAIN banner after signing out, with entering a brand
// new token as the sole escape: exactly what someone who just signed out is
// not about to do.
function credentialChanged(raw) {
  var o;
  try { o = JSON.parse(raw); } catch (err) { return false; }
  if (!o) return false;
  if (o.signOut === true) return true;
  return !!(typeof o.token === 'string' && o.token);
}

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  // Pass the CURRENT settings as the merge base. The config page deliberately
  // never receives the token (it must not travel in a URL), so it omits the
  // token key entirely when the user did not re-authenticate. Parsing against
  // defaults instead of current settings would read that absence as an empty
  // token and silently sign the user out on every settings save.
  // An explicit sign-out arrives as `signOut: true`, not as an empty token.
  var raw = decodeURIComponent(e.response);
  var updated = configMod.parseConfigResponse(raw, state.settings);
  state.settings = updated;
  saveSettings(updated);
  state.history.reset();
  state.prevLevel = 0;
  state.failures = 0;
  // Invalidate any request still in flight under the old client/settings;
  // its callback will see a stale generation and drop itself on return
  // instead of re-seeding the history/prevLevel we just reset.
  state.generation += 1;
  // A changed credential situation clears the sticky dead-token flag: either a
  // non-empty token (including the IDENTICAL one -- the obvious thing to try
  // when a token was revoked and then reinstated server-side) or an explicit
  // sign-out, after which the loop should fall back to the SIGN IN banner
  // rather than stay frozen on SIGN IN AGAIN. A settings save that carries
  // neither (the common case) still cannot resurrect the loop, which is the
  // property the stickiness exists to protect.
  if (credentialChanged(raw)) {
    state.tokenDead = false;
  }
  rebuild();
  restartTimer();
});
