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

function poll() {
  if (!state.client) { sendStatus('SIGN IN', false); return; }
  if (!state.budget.allow()) { sendStatus('PAUSED', false); return; }

  state.budget.record();
  state.client.getDevices(function (err, devices) {
    if (err) {
      state.failures += 1;
      // A dead token is terminal; everything else is worth retrying.
      if (err.kind === 'bad_token') { stopTimer(); }
      sendStatus(bannerForError(err.kind), false);
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
        stale: false,
      }));
      return;
    }

    state.history.push(norm.sessionId, norm.probes, t);

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
      rates[ch] = state.history.rate(ch);
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
    }));

    var d = new Date();
    var vibrate = alertsMod.shouldVibrate(evaluated.level, state.prevLevel, {
      vibrateEnabled: state.settings.vibrateEnabled,
      quietHours: state.settings.quietStart === null ? null : {
        startMinutes: state.settings.quietStart,
        endMinutes: state.settings.quietEnd,
      },
      nowLocalMinutes: d.getHours() * 60 + d.getMinutes(),
    });
    // The watch owns the buzz: it already has ALERT_LEVEL and vibrates on a
    // rising edge. This flag exists so quiet hours are honoured phone-side.
    if (!vibrate && evaluated.level > state.prevLevel) {
      send({ ALERT_LEVEL: 0 });
    }
    state.prevLevel = evaluated.level;
  });
}

function stopTimer() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

function restartTimer() {
  stopTimer();
  var ms = (state.settings.pollSec || 30) * 1000;
  var delay = backoffMs();
  state.timer = setInterval(poll, ms);
  if (delay === 0) poll();
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
  var updated = configMod.parseConfigResponse(decodeURIComponent(e.response),
                                              state.settings);
  state.settings = updated;
  saveSettings(updated);
  state.history.reset();
  state.prevLevel = 0;
  state.failures = 0;
  rebuild();
  restartTimer();
});
