const { buildFrame, estimateFrameBytes, FLAG, STATE } =
  require('../src/pkjs/transform');

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
  expect(f.P_LABEL0).toBe('pit');
  expect(f.P_LABEL1).toBe('boneless butt');
});

test('encodes temperatures as tenths', () => {
  const f = buildFrame(base);
  expect(f.P_TEMP0).toBe(2789);
  expect(f.P_TEMP1).toBe(844);
});

test('encodes rates as tenths', () => {
  const f = buildFrame(base);
  expect(f.P_RATE0).toBe(12);
  expect(f.P_RATE1).toBe(5);
});

test('sets per-probe flags', () => {
  const f = buildFrame(base);
  expect(f.P_FLAGS0 & FLAG.IS_PIT).toBeTruthy();
  expect(f.P_FLAGS0 & FLAG.HAS_ALERT).toBeTruthy();
  expect(f.P_FLAGS0 & FLAG.OUT_OF_BAND).toBeTruthy();
  expect(f.P_FLAGS1 & FLAG.IS_PIT).toBeFalsy();
  expect(f.P_FLAGS1 & FLAG.HAS_ALERT).toBeFalsy();
});

test('sends zero bounds when a probe has no alert', () => {
  const f = buildFrame(base);
  expect(f.P_MIN1).toBe(0);
  expect(f.P_MAX1).toBe(0);
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
  expect(f.P_LABEL3).toBeDefined();
  expect(f.P_LABEL4).toBeUndefined();
});

test('truncates long labels', () => {
  const f = buildFrame(Object.assign({}, base, {
    probes: [{ channel: 4, label: 'an extremely long probe label here',
               temp: 100, min: null, max: null, hasAlert: false }],
    pitChannel: 4, rates: {}, perProbe: {},
  }));
  expect(f.P_LABEL0.length).toBeLessThanOrEqual(16);
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
  expect(f.P_RATE0).toBe(0);
});

test('clamps temperature above int16 ceiling to 32767', () => {
  const f = buildFrame(Object.assign({}, base, {
    probes: [{ channel: 4, label: 'fault', temp: 9999.0,
               min: null, max: null, hasAlert: false }],
    pitChannel: 4, rates: {}, perProbe: {},
  }));
  expect(f.P_TEMP0).toBe(32767);
});

test('clamps value below int16 floor to -32768', () => {
  const f = buildFrame(Object.assign({}, base, {
    probes: [{ channel: 4, label: 'fault', temp: -9999.0,
               min: null, max: null, hasAlert: false }],
    pitChannel: 4, rates: {}, perProbe: {},
  }));
  expect(f.P_TEMP0).toBe(-32768);
});

test('normal temperature passes through clamping unchanged', () => {
  const f = buildFrame(base);
  expect(f.P_TEMP0).toBe(2789);
  expect(f.P_TEMP1).toBe(844);
});

test('null and undefined still yield 0 after clamping', () => {
  const f = buildFrame(Object.assign({}, base, {
    probes: [{ channel: 4, label: 'test', temp: null,
               min: undefined, max: null, hasAlert: false }],
    pitChannel: 4, rates: {}, perProbe: {},
  }));
  expect(f.P_TEMP0).toBe(0);
  expect(f.P_MIN0).toBe(0);
  expect(f.P_MAX0).toBe(0);
});
