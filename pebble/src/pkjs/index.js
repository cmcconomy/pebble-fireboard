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

var state = {
  settings: null,
  client: null,
  budget: null,
  history: new History({ maxSamples: 120 }),
  timer: null,
  prevLevel: 0,
  failures: 0,
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

function send(frame) {
  Pebble.sendAppMessage(frame, function () {}, function (e) {
    console.log('send failed: ' + JSON.stringify(e));
  });
}

function sendStatus(bannerText, cooking) {
  send(transform.buildFrame({
    probes: [], pitChannel: null, rates: {}, perProbe: {},
    alertLevel: 0, banner: bannerText, elapsedSec: 0, stalenessSec: 0,
    batteryPct: 0, sessionId: 0, degreetype: 2,
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

    if (norm.probes.length === 0) {
      send(transform.buildFrame({
        probes: [], pitChannel: null, rates: {}, perProbe: {},
        alertLevel: 0, banner: '', elapsedSec: 0, stalenessSec: 0,
        batteryPct: norm.batteryPct, sessionId: norm.sessionId || 0,
        degreetype: norm.degreetype, layout: state.settings.layout,
        cooking: false, showAlertVisuals: state.settings.showAlertVisuals,
        stale: false, mayVibrate: false,
      }));
      scheduleNext(normalDelayMs());
      return;
    }

    // history.js documents that callers must pass Fahrenheit; convert every
    // probe temperature before pushing so the stall band (150-170F) and the
    // 0.1F/min rate gate are evaluated in the units they were tuned for, even
    // on a Celsius account. Only temp feeds history's arithmetic.
    var historyProbes = [];
    var j;
    for (j = 0; j < norm.probes.length; j++) {
      historyProbes.push({
        channel: norm.probes[j].channel,
        temp: toF(norm.probes[j].temp, norm.degreetype),
      });
    }
    state.history.push(norm.sessionId, historyProbes, t);

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
      // history now always stores Fahrenheit, so rate() returns F/min.
      // P_RATE is displayed in the account's own unit (DEGREETYPE), so
      // convert back for a Celsius account. A rate is a delta: scale by
      // 5/9 only -- never apply the +32 offset here.
      rates[ch] = (rateF === null || norm.degreetype !== 1) ? rateF : (rateF * 5 / 9);
      if (ch !== norm.pitChannel) {
        stalledChannels[ch] = state.history.isStalled(ch, t, pitTempF);
      }
    }

    var evaluated = alertsMod.evaluate({
      probes: norm.probes,
      pitChannel: norm.pitChannel,
      stalledChannels: stalledChannels,
    });

    var stalenessSec = norm.lastTemplogMs
      ? Math.floor((t - norm.lastTemplogMs) / 1000) : 0;
    var elapsedSec = norm.startedMs ? Math.floor((t - norm.startedMs) / 1000) : 0;

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
      probes: norm.probes,
      pitChannel: norm.pitChannel,
      rates: rates,
      perProbe: evaluated.perProbe,
      alertLevel: evaluated.level,
      banner: evaluated.banner,
      elapsedSec: elapsedSec,
      stalenessSec: stalenessSec,
      batteryPct: norm.batteryPct,
      sessionId: norm.sessionId || 0,
      degreetype: norm.degreetype,
      layout: state.settings.layout,
      cooking: true,
      showAlertVisuals: state.settings.showAlertVisuals,
      stale: stalenessSec > STALE_AFTER_SEC,
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
  // bad_token handling and webviewclosed's token-change check below.
  if (state.tokenDead) return;
  scheduleNext(backoffMs());
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

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  // Pass the CURRENT settings as the merge base. The config page deliberately
  // never receives the token (it must not travel in a URL), so it omits the
  // token key entirely when the user did not re-authenticate. Parsing against
  // defaults instead of current settings would read that absence as an empty
  // token and silently sign the user out on every settings save.
  // An explicit sign-out arrives as `signOut: true`, not as an empty token.
  var oldToken = state.settings.token;
  var updated = configMod.parseConfigResponse(decodeURIComponent(e.response),
                                              state.settings);
  state.settings = updated;
  saveSettings(updated);
  state.history.reset();
  state.prevLevel = 0;
  state.failures = 0;
  // Invalidate any request still in flight under the old client/settings;
  // its callback will see a stale generation and drop itself on return
  // instead of re-seeding the history/prevLevel we just reset.
  state.generation += 1;
  // Only an actual token change clears the sticky dead-token flag -- merely
  // saving settings (e.g. a layout change) with the same dead token must not
  // resurrect a doomed polling loop.
  if (updated.token !== oldToken) {
    state.tokenDead = false;
  }
  rebuild();
  restartTimer();
});
