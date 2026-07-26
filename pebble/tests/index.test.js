// Drives src/pkjs/index.js against stubbed Pebble globals and a stubbed
// FireBoard client, so the poll loop's decisions (staleness gating, alert-level
// edges, unit override, budget debounce, token recovery) can be asserted
// directly. index.js reads Pebble/localStorage/XMLHttpRequest at load and at
// event time, so every global must exist before require().
//
// The loop never polls synchronously -- 'ready' only schedules -- so tests
// advance fake timers to make a poll happen. POLL_SEC is 60 so one poll is one
// minute of history, which is the granularity the stall window cares about.

const KEYS = require('../src/pkjs/transform').KEYS;

const POLL_SEC = 60;

// `mock`-prefixed so jest.mock's factory may close over it. `devices` is a
// FUNCTION so each poll gets a payload timestamped at that poll's clock.
const mockApi = { devices: () => [], error: null };

jest.mock('../src/pkjs/fireboard', () => ({
  Client: function Client() {
    this.getDevices = function (cb) { cb(mockApi.error, mockApi.devices()); };
  },
}));

let handlers;
let sent;
let store;

function settings(extra) {
  return Object.assign({
    token: 'tok', layout: 0, pitOverride: null, units: 'auto',
    showAlertVisuals: true, vibrateEnabled: true,
    quietStart: null, quietEnd: null, pollSec: POLL_SEC,
  }, extra || {});
}

function boot(s) {
  jest.resetModules();
  handlers = {};
  sent = [];
  store = { 'fb.settings': JSON.stringify(settings(s)) };
  mockApi.error = null;
  mockApi.devices = () => [];

  global.Pebble = {
    addEventListener: (name, fn) => { handlers[name] = fn; },
    sendAppMessage: (frame) => { sent.push(frame); },
    openURL: () => {},
  };
  global.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  global.XMLHttpRequest = function () {};

  jest.isolateModules(() => { require('../src/pkjs/index'); });
  handlers.ready();
}

// Run exactly ONE scheduled poll. advanceTimersByTime would run the poll AND
// the follow-up it schedules inside the same window, which silently doubles
// every sample and destroys the rising-edge assertions.
function nextPoll() { jest.advanceTimersToNextTimer(); }

// `agoSec` is how long ago the FireBoard last logged a temperature.
function deviceFn(opts) {
  const o = opts || {};
  const agoSec = o.agoSec === undefined ? 5 : o.agoSec;
  return () => [{
    degreetype: o.degreetype === undefined ? 2 : o.degreetype,
    last_battery_reading: 0.78,
    last_templog: new Date(Date.now() - agoSec * 1000).toISOString(),
    channels: (o.channels || []).map((c) => Object.assign({
      created: new Date(Date.now() - 3600 * 1000).toISOString(),
      sessionid: o.sessionId === undefined ? 111 : o.sessionId,
    }, c)),
  }];
}

function ch(channel, label, temp, alert) {
  return {
    channel, channel_label: label, current_temp: temp,
    alerts: alert ? [Object.assign({ enabled: true }, alert)] : [],
  };
}

function last() { return sent[sent.length - 1]; }
function probeTemp(f, i) { return f[String(KEYS.P_TEMP + i)]; }
function probeMin(f, i) { return f[String(KEYS.P_MIN + i)]; }
function probeMax(f, i) { return f[String(KEYS.P_MAX + i)]; }
function probeFlags(f, i) { return f[String(KEYS.P_FLAGS + i)]; }
function probeRate(f, i) { return f[String(KEYS.P_RATE + i)]; }

const STATE_STALE = 4;
const STATE_MAY_VIBRATE = 8;
const FLAG_STALLED = 8;

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

// --- IMPORTANT 1: stale data must not feed the stall detector ---------------

const STALLING = [ch(1, 'pit', 200), ch(2, 'butt', 160)];

test('a live flat probe under a hot pit is reported as STALLED', () => {
  boot();
  mockApi.devices = deviceFn({ channels: STALLING });
  for (let i = 0; i < 30; i++) nextPoll();
  expect(last().STATE_FLAGS & STATE_STALE).toBeFalsy();
  expect(probeFlags(last(), 1) & FLAG_STALLED).toBeTruthy();
  expect(last().BANNER).toContain('STALLED');
});

test('a stale reading is never reported as STALLED', () => {
  // A dead FireBoard keeps serving its last reading. Those repeats look
  // exactly like a stall (flat probe, hot pit, >20min window) but the fire may
  // be out -- the watch must not reassure the user with a frozen number.
  boot();
  mockApi.devices = deviceFn({ channels: STALLING });
  for (let i = 0; i < 30; i++) nextPoll();
  expect(probeFlags(last(), 1) & FLAG_STALLED).toBeTruthy();

  // Same numbers, but last_templog has stopped moving.
  mockApi.devices = deviceFn({ agoSec: 900, channels: STALLING });
  nextPoll();
  expect(last().STATE_FLAGS & STATE_STALE).toBeTruthy();
  expect(probeFlags(last(), 1) & FLAG_STALLED).toBeFalsy();
  expect(last().BANNER).not.toContain('STALLED');
});

test('stale readings cannot manufacture a stall from scratch', () => {
  // Never any live history: every sample arrives already stale. Without the
  // gate these repeats alone would build a 20-minute flat window and claim a
  // stall the phone has no evidence for.
  boot();
  mockApi.devices = deviceFn({ agoSec: 900, channels: STALLING });
  for (let i = 0; i < 30; i++) nextPoll();
  expect(last().STATE_FLAGS & STATE_STALE).toBeTruthy();
  expect(probeFlags(last(), 1) & FLAG_STALLED).toBeFalsy();
});

test('a stale reading does not extend the history window', () => {
  boot();
  mockApi.devices = deviceFn({ channels: [ch(1, 'pit', 200), ch(2, 'butt', 100)] });
  nextPoll();
  nextPoll();
  const rateAfterLive = probeRate(last(), 1);

  mockApi.devices = deviceFn({
    agoSec: 600, channels: [ch(1, 'pit', 200), ch(2, 'butt', 100)],
  });
  for (let i = 0; i < 25; i++) nextPoll();
  // Unchanged: the stale samples never entered the series.
  expect(probeRate(last(), 1)).toBe(rateAfterLive);
  expect(probeFlags(last(), 1) & FLAG_STALLED).toBeFalsy();
});

// --- IMPORTANT 2: prevLevel must reset between cooks -------------------------

function criticalFn(sessionId) {
  return deviceFn({
    sessionId,
    channels: [ch(1, 'pit', 200), ch(2, 'butt', 205, { temp_max: 203 })],
  });
}

test('a second cook can still vibrate after the first ended at CRITICAL', () => {
  boot();
  mockApi.devices = criticalFn(111);
  nextPoll();
  expect(last().ALERT_LEVEL).toBe(3);
  expect(last().STATE_FLAGS & STATE_MAY_VIBRATE).toBeTruthy();   // rising edge

  // Cook 1 ends: no probes at all.
  mockApi.devices = deviceFn({ sessionId: 111, channels: [] });
  nextPoll();
  expect(last().N_PROBES).toBe(0);

  // Cook 2 hits CRITICAL. Without the prevLevel reset this stays silent.
  mockApi.devices = criticalFn(222);
  nextPoll();
  expect(last().ALERT_LEVEL).toBe(3);
  expect(last().STATE_FLAGS & STATE_MAY_VIBRATE).toBeTruthy();
});

test('a new session id alone resets the alert edge', () => {
  boot();
  mockApi.devices = criticalFn(111);
  nextPoll();
  expect(last().STATE_FLAGS & STATE_MAY_VIBRATE).toBeTruthy();

  nextPoll();                                    // same session, no re-buzz
  expect(last().STATE_FLAGS & STATE_MAY_VIBRATE).toBeFalsy();

  mockApi.devices = criticalFn(999);             // new cook, buzz again
  nextPoll();
  expect(last().STATE_FLAGS & STATE_MAY_VIBRATE).toBeTruthy();
});

// --- IMPORTANT 3: the Units setting -----------------------------------------

test('units auto follows the account degreetype', () => {
  boot({ units: 'auto' });
  mockApi.devices = deviceFn({ degreetype: 1, channels: [ch(1, 'pit', 100)] });
  nextPoll();
  expect(last().DEGREETYPE).toBe(1);
  expect(probeTemp(last(), 0)).toBe(1000);        // unconverted
});

test('units F converts a Celsius account to Fahrenheit', () => {
  boot({ units: 'F' });
  mockApi.devices = deviceFn({ degreetype: 1, channels: [ch(1, 'pit', 100)] });
  nextPoll();
  expect(last().DEGREETYPE).toBe(2);
  expect(probeTemp(last(), 0)).toBe(2120);        // 100C -> 212F
});

test('units C converts a Fahrenheit account to Celsius', () => {
  boot({ units: 'C' });
  mockApi.devices = deviceFn({ degreetype: 2, channels: [ch(1, 'pit', 212)] });
  nextPoll();
  expect(last().DEGREETYPE).toBe(1);
  expect(probeTemp(last(), 0)).toBe(1000);        // 212F -> 100C
});

test('unit override converts alert bounds with the temperature', () => {
  // 100C inside a 90-110C band is IN band. Converting only the temperature
  // would compare 212F against a 90-110 band and scream HIGH.
  boot({ units: 'F' });
  mockApi.devices = deviceFn({
    degreetype: 1,
    channels: [ch(1, 'pit', 100, { temp_min: 90, temp_max: 110 })],
  });
  nextPoll();
  expect(last().ALERT_LEVEL).toBe(0);
  expect(last().BANNER).toBe('');
  expect(probeMin(last(), 0)).toBe(1940);         // 90C  -> 194F
  expect(probeMax(last(), 0)).toBe(2300);         // 110C -> 230F
});

test('a rate is scaled without the freezing-point offset', () => {
  // +1.0 F/min is +0.56 C/min, not +33.8. A rate is a delta: no +32.
  boot({ units: 'C' });
  mockApi.devices = deviceFn({ degreetype: 2, channels: [ch(1, 'pit', 200)] });
  nextPoll();
  mockApi.devices = deviceFn({ degreetype: 2, channels: [ch(1, 'pit', 210)] });
  nextPoll();
  expect(probeRate(last(), 0)).toBe(56);          // +10F/min -> +5.6C/min
  // A +32 offset would land near 380. It must not appear on a delta.
  expect(probeRate(last(), 0)).toBeLessThan(100);
});

// --- carried session id / degreetype on error frames -------------------------

test('an error frame keeps the last known session id and unit', () => {
  boot();
  mockApi.devices = deviceFn({
    sessionId: 4242, degreetype: 1, channels: [ch(1, 'pit', 100)],
  });
  nextPoll();
  expect(last().SESSION_ID).toBe(4242);

  mockApi.error = { kind: 'network' };
  nextPoll();
  expect(last().BANNER).toBe('NO SIGNAL');
  expect(last().SESSION_ID).toBe(4242);           // not 0 -- not a new cook
  expect(last().DEGREETYPE).toBe(1);              // not forced to Fahrenheit
});

test('an error frame under a unit override reports the overridden unit', () => {
  boot({ units: 'C' });
  mockApi.devices = deviceFn({ degreetype: 2, channels: [ch(1, 'pit', 212)] });
  nextPoll();
  mockApi.error = { kind: 'waf' };
  nextPoll();
  expect(last().BANNER).toBe('TRY AGAIN LATER');
  expect(last().DEGREETYPE).toBe(1);
});

// --- budget debounce ---------------------------------------------------------

function saveSettings(response) {
  handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify(response)) });
}

test('a settings save does not poll immediately after a recent poll', () => {
  boot();
  mockApi.devices = deviceFn({ channels: [ch(1, 'pit', 200)] });
  nextPoll();
  const before = sent.length;

  saveSettings({ layout: 0 });
  jest.advanceTimersByTime(5000);
  expect(sent.length).toBe(before);               // still debounced

  jest.advanceTimersByTime(6000);
  expect(sent.length).toBe(before + 1);           // ran at ~10s
});

test('three rapid settings saves cost one poll, not three', () => {
  boot();
  mockApi.devices = deviceFn({ channels: [ch(1, 'pit', 200)] });
  nextPoll();
  const before = sent.length;

  saveSettings({ layout: 0 });
  jest.advanceTimersByTime(1000);
  saveSettings({ layout: 1 });
  jest.advanceTimersByTime(1000);
  saveSettings({ layout: 2 });
  jest.advanceTimersByTime(11000);
  expect(sent.length).toBe(before + 1);
});

// --- dead-token recovery -----------------------------------------------------

test('re-entering the identical dead token revives the poll loop', () => {
  boot();
  mockApi.error = { kind: 'bad_token' };
  nextPoll();
  expect(last().BANNER).toBe('SIGN IN AGAIN');
  const stopped = sent.length;
  nextPoll();
  expect(sent.length).toBe(stopped);              // loop is stopped

  // The token was reinstated server-side; the user retypes the same value.
  mockApi.error = null;
  mockApi.devices = deviceFn({ channels: [ch(1, 'pit', 200)] });
  saveSettings({ token: 'tok' });
  jest.advanceTimersByTime(30000);
  expect(sent.length).toBeGreaterThan(stopped);
  expect(last().N_PROBES).toBe(1);
});

// This path has now been wrong in two opposite directions -- once leaving the
// flag set when it should clear, once clearing it when it should stay set --
// so all three config-response shapes are pinned explicitly. `signOut` and
// `token` are mutually exclusive on the wire: the config page sends one or the
// other, never both.

// Kill the loop with a bad_token error, then return the API to health so any
// revival is immediately visible as a real poll.
function stranded() {
  boot();
  mockApi.error = { kind: 'bad_token' };
  nextPoll();
  expect(last().BANNER).toBe('SIGN IN AGAIN');
  mockApi.error = null;
  mockApi.devices = deviceFn({ channels: [ch(1, 'pit', 200)] });
  return sent.length;
}

test('(a) a settings-only save leaves a dead token dead', () => {
  const stopped = stranded();
  saveSettings({ layout: 1 });                    // no token, no signOut
  jest.advanceTimersByTime(60000);
  expect(sent.length).toBe(stopped);
});

test('(b) an explicit sign-out clears the dead-token flag', () => {
  // signOut carries NO token key, so a delivered-token test alone would strand
  // the user on the stale SIGN IN AGAIN banner forever.
  const stopped = stranded();
  saveSettings({ signOut: true });
  jest.advanceTimersByTime(60000);
  expect(sent.length).toBeGreaterThan(stopped);
  // Signed out means no client, so the loop asks for credentials afresh
  // rather than repeating the dead-token complaint.
  expect(last().BANNER).toBe('SIGN IN');
});

test('(c) a new non-empty token clears the dead-token flag', () => {
  const stopped = stranded();
  saveSettings({ token: 'a-brand-new-token' });
  jest.advanceTimersByTime(60000);
  expect(sent.length).toBeGreaterThan(stopped);
  expect(last().N_PROBES).toBe(1);
});

test('a sign-out actually clears the stored token', () => {
  stranded();
  saveSettings({ signOut: true });
  expect(JSON.parse(store['fb.settings']).token).toBe('');
});
