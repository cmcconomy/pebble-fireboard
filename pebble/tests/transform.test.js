const { buildFrame, estimateFrameBytes, FLAG, STATE, KEYS } =
  require('../src/pkjs/transform');

// Probe fields are indexed off a single base key per block. `k('P_TEMP', 1)`
// is the numeric-string property the frame is expected to carry.
const k = (block, i) => String(KEYS[block] + i);

const base = {
  probes: [
    { channel: 4, label: 'pit', temp: 278.9, min: 210, max: 240, hasAlert: true },
    { channel: 3, label: 'boneless butt', temp: 84.4, min: null, max: null,
      hasAlert: false },
  ],
  pitChannel: 4,
  rates: { 4: 1.2, 3: 0.5 },
  perProbe: {
    4: { flags: { outOfBand: true, stalled: false } },
    3: { flags: { outOfBand: false, stalled: false } },
  },
  alertLevel: 2,
  banner: 'PIT HIGH 279',
  elapsedSec: 15120,
  stalenessSec: 12,
  batteryPct: 78,
  sessionId: 11569055,
  degreetype: 2,
  layout: 0,
  cooking: true,
  showAlertVisuals: true,
  stale: false,
};

test('sends the pit first regardless of channel order', () => {
  const f = buildFrame(base);
  expect(f[k('P_LABEL', 0)]).toBe('pit');
  expect(f[k('P_LABEL', 1)]).toBe('boneless butt');
});

test('encodes temperatures as tenths', () => {
  const f = buildFrame(base);
  expect(f[k('P_TEMP', 0)]).toBe(2789);
  expect(f[k('P_TEMP', 1)]).toBe(844);
});

test('encodes rates as tenths', () => {
  const f = buildFrame(base);
  expect(f[k('P_RATE', 0)]).toBe(12);
  expect(f[k('P_RATE', 1)]).toBe(5);
});

test('sets per-probe flags', () => {
  const f = buildFrame(base);
  expect(f[k('P_FLAGS', 0)] & FLAG.IS_PIT).toBeTruthy();
  expect(f[k('P_FLAGS', 0)] & FLAG.HAS_ALERT).toBeTruthy();
  expect(f[k('P_FLAGS', 0)] & FLAG.OUT_OF_BAND).toBeTruthy();
  expect(f[k('P_FLAGS', 1)] & FLAG.IS_PIT).toBeFalsy();
  expect(f[k('P_FLAGS', 1)] & FLAG.HAS_ALERT).toBeFalsy();
});

test('sends zero bounds when a probe has no alert', () => {
  const f = buildFrame(base);
  expect(f[k('P_MIN', 1)]).toBe(0);
  expect(f[k('P_MAX', 1)]).toBe(0);
});

test('sets state flags', () => {
  const f = buildFrame(base);
  expect(f.STATE_FLAGS & STATE.COOKING).toBeTruthy();
  expect(f.STATE_FLAGS & STATE.SHOW_ALERT_VISUALS).toBeTruthy();
  expect(f.STATE_FLAGS & STATE.STALE).toBeFalsy();
});

test('existing STATE bits keep their historical values', () => {
  expect(STATE.COOKING).toBe(1);
  expect(STATE.SHOW_ALERT_VISUALS).toBe(2);
  expect(STATE.STALE).toBe(4);
});

test('sets MAY_VIBRATE when mayVibrate is true', () => {
  const f = buildFrame(Object.assign({}, base, { mayVibrate: true }));
  expect(f.STATE_FLAGS & STATE.MAY_VIBRATE).toBeTruthy();
});

test('clears MAY_VIBRATE when mayVibrate is false', () => {
  const f = buildFrame(Object.assign({}, base, { mayVibrate: false }));
  expect(f.STATE_FLAGS & STATE.MAY_VIBRATE).toBeFalsy();
});

test('MAY_VIBRATE defaults to unset when omitted', () => {
  const f = buildFrame(base);
  expect(f.STATE_FLAGS & STATE.MAY_VIBRATE).toBeFalsy();
});

test('idle frame reports no probes and is not cooking', () => {
  const f = buildFrame(Object.assign({}, base, { probes: [], cooking: false }));
  expect(f.N_PROBES).toBe(0);
  expect(f.STATE_FLAGS & STATE.COOKING).toBeFalsy();
});

test('caps at four probes', () => {
  const many = [];
  for (let i = 1; i <= 6; i++) {
    many.push({ channel: i, label: 'p' + i, temp: 100, min: null, max: null,
                hasAlert: false });
  }
  const f = buildFrame(Object.assign({}, base, {
    probes: many, pitChannel: 1, rates: {}, perProbe: {},
  }));
  expect(f.N_PROBES).toBe(4);
  expect(f[k('P_LABEL', 3)]).toBe('p4');
  // Index 4 is out of the P_LABEL block: P_LABEL + 4 collides with P_TEMP + 0,
  // so it cannot be probed for absence. Assert instead that the 5th and 6th
  // probes were dropped entirely.
  const labels = [0, 1, 2, 3].map((i) => f[k('P_LABEL', i)]);
  expect(labels).toEqual(['p1', 'p2', 'p3', 'p4']);
  expect(Object.keys(f).map((key) => f[key])).not.toContain('p5');
});

test('truncates long labels', () => {
  const f = buildFrame(Object.assign({}, base, {
    probes: [{ channel: 4, label: 'an extremely long probe label here',
               temp: 100, min: null, max: null, hasAlert: false }],
    pitChannel: 4, rates: {}, perProbe: {},
  }));
  expect(f[k('P_LABEL', 0)].length).toBeLessThanOrEqual(16);
});

test('worst-case frame fits the 1024-byte inbox', () => {
  const many = [];
  for (let i = 1; i <= 4; i++) {
    many.push({ channel: i, label: 'sixteen chars ok', temp: 999.9,
                min: 100, max: 200, hasAlert: true });
  }
  const f = buildFrame(Object.assign({}, base, {
    probes: many, pitChannel: 1,
    banner: 'X'.repeat(64),
  }));
  const bytes = estimateFrameBytes(f);
  expect(bytes).toBeLessThan(1024);
});

test('handles a missing rate as zero', () => {
  const f = buildFrame(Object.assign({}, base, { rates: {} }));
  expect(f[k('P_RATE', 0)]).toBe(0);
});

test('clamps temperature above int16 ceiling to 32767', () => {
  const f = buildFrame(Object.assign({}, base, {
    probes: [{ channel: 4, label: 'fault', temp: 9999.0,
               min: null, max: null, hasAlert: false }],
    pitChannel: 4, rates: {}, perProbe: {},
  }));
  expect(f[k('P_TEMP', 0)]).toBe(32767);
});

test('clamps value below int16 floor to -32768', () => {
  const f = buildFrame(Object.assign({}, base, {
    probes: [{ channel: 4, label: 'fault', temp: -9999.0,
               min: null, max: null, hasAlert: false }],
    pitChannel: 4, rates: {}, perProbe: {},
  }));
  expect(f[k('P_TEMP', 0)]).toBe(-32768);
});

test('normal temperature passes through clamping unchanged', () => {
  const f = buildFrame(base);
  expect(f[k('P_TEMP', 0)]).toBe(2789);
  expect(f[k('P_TEMP', 1)]).toBe(844);
});

test('null and undefined still yield 0 after clamping', () => {
  const f = buildFrame(Object.assign({}, base, {
    probes: [{ channel: 4, label: 'test', temp: null,
               min: undefined, max: null, hasAlert: false }],
    pitChannel: 4, rates: {}, perProbe: {},
  }));
  expect(f[k('P_TEMP', 0)]).toBe(0);
  expect(f[k('P_MIN', 0)]).toBe(0);
  expect(f[k('P_MAX', 0)]).toBe(0);
});

// --- regression guard for the dropped-tuple defect --------------------------
// Array messageKeys allocate one base symbol per block; there is no key named
// "P_LABEL0". Emitting a NAMED probe key means the SDK cannot resolve it and
// drops the tuple silently in flight, so the watch renders empty rows at 0
// degrees while still receiving N_PROBES. This guard fails loudly if any probe
// key regresses to a name.

const SCALAR_KEYS = [
  'N_PROBES', 'ELAPSED_SEC', 'STALENESS_SEC', 'FB_BATTERY', 'SESSION_ID',
  'ALERT_LEVEL', 'BANNER', 'LAYOUT', 'DEGREETYPE', 'STATE_FLAGS',
];

test('every non-scalar frame key is numeric', () => {
  const f = buildFrame(base);
  const offenders = Object.keys(f).filter(
    (key) => !SCALAR_KEYS.includes(key) && !/^\d+$/.test(key));
  expect(offenders).toEqual([]);
});

test('no frame key uses the P_ name form', () => {
  const many = [];
  for (let i = 1; i <= 4; i++) {
    many.push({ channel: i, label: 'p' + i, temp: 100, min: 1, max: 2,
                hasAlert: true });
  }
  const f = buildFrame(Object.assign({}, base, { probes: many, pitChannel: 1 }));
  expect(Object.keys(f).filter((key) => /^P_/.test(key))).toEqual([]);
});

test('probe keys land on the documented numeric bases', () => {
  const f = buildFrame(base);
  expect(f['10000']).toBe('pit');       // P_LABEL + 0
  expect(f['10001']).toBe('boneless butt');
  expect(f['10004']).toBe(2789);        // P_TEMP  + 0
  expect(f['10008']).toBe(2100);        // P_MIN   + 0
  expect(f['10012']).toBe(2400);        // P_MAX   + 0
  expect(f['10016']).toBe(12);          // P_RATE  + 0
  expect(f['10020']).toBe(FLAG.IS_PIT | FLAG.HAS_ALERT | FLAG.OUT_OF_BAND);
});

test('the fallback base map matches the generated build key map', () => {
  // build/js/message_keys.json is authoritative; the in-module fallback is a
  // mirror kept only so this module is testable outside the Pebble build.
  // build/ is gitignored, so on a clean checkout there is nothing to compare
  // against and this check is a no-op rather than a failure.
  let generated;
  try {
    generated = require('../build/js/message_keys.json');
  } catch (e) {
    return;
  }
  ['P_LABEL', 'P_TEMP', 'P_MIN', 'P_MAX', 'P_RATE', 'P_FLAGS'].forEach((b) => {
    expect(KEYS[b]).toBe(generated[b]);
  });
});
