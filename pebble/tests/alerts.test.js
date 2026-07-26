const { LEVEL, evaluateProbe, evaluate, shouldVibrate } = require('../src/pkjs/alerts');

const pit = (temp, min, max) => ({
  channel: 4, label: 'pit', temp, min, max, hasAlert: min !== null || max !== null,
});

test('a probe inside its band is OK', () => {
  const r = evaluateProbe(pit(230, 210, 240), true, false);
  expect(r.level).toBe(LEVEL.OK);
  expect(r.flags.outOfBand).toBe(false);
});

test('a probe above its max is WARN', () => {
  const r = evaluateProbe(pit(278, 210, 240), true, false);
  expect(r.level).toBe(LEVEL.WARN);
  expect(r.flags.outOfBand).toBe(true);
});

test('a probe below its min is WARN', () => {
  const r = evaluateProbe(pit(190, 210, 240), true, false);
  expect(r.level).toBe(LEVEL.WARN);
});

test('a food probe reaching its max is CRITICAL, not WARN', () => {
  // Max with no min means a target, not a band: reaching it means done.
  const food = { channel: 3, label: 'butt', temp: 204, min: null, max: 203,
                 hasAlert: true };
  expect(evaluateProbe(food, false, false).level).toBe(LEVEL.CRITICAL);
});

test('a probe with no alert is never WARN', () => {
  const bare = { channel: 4, label: 'pit', temp: 278, min: null, max: null,
                 hasAlert: false };
  expect(evaluateProbe(bare, true, false).level).toBe(LEVEL.OK);
});

test('a stall is INFO and sets its flag', () => {
  const r = evaluateProbe(
    { channel: 3, label: 'butt', temp: 159, min: null, max: 203, hasAlert: true },
    false, true
  );
  expect(r.level).toBe(LEVEL.INFO);
  expect(r.flags.stalled).toBe(true);
});

test('evaluate reports the highest level across probes', () => {
  const out = evaluate({
    probes: [
      { channel: 3, label: 'butt', temp: 92, min: null, max: 203, hasAlert: true },
      pit(278, 210, 240),
    ],
    pitChannel: 4,
    stalledChannels: {},
  });
  expect(out.level).toBe(LEVEL.WARN);
  expect(out.banner).toBe('PIT HIGH 278');
});

test('banner names the stall when that is the highest level', () => {
  const out = evaluate({
    probes: [{ channel: 3, label: 'butt', temp: 159, min: null, max: 203,
               hasAlert: true }],
    pitChannel: 4,
    stalledChannels: { 3: true },
  });
  expect(out.level).toBe(LEVEL.INFO);
  expect(out.banner).toContain('STALLED');
});

test('banner is empty when everything is OK', () => {
  const out = evaluate({
    probes: [{ channel: 3, label: 'butt', temp: 92, min: null, max: 203,
               hasAlert: true }],
    pitChannel: 4,
    stalledChannels: {},
  });
  expect(out.banner).toBe('');
});

// --- vibration ---

const opts = (over) => Object.assign(
  { vibrateEnabled: true, quietHours: null, nowLocalMinutes: 12 * 60 }, over
);

test('vibrates when the level rises', () => {
  expect(shouldVibrate(LEVEL.WARN, LEVEL.OK, opts())).toBe(true);
});

test('does not vibrate while the level is unchanged', () => {
  expect(shouldVibrate(LEVEL.WARN, LEVEL.WARN, opts())).toBe(false);
});

test('does not vibrate when the level falls', () => {
  expect(shouldVibrate(LEVEL.OK, LEVEL.WARN, opts())).toBe(false);
});

test('never vibrates for INFO', () => {
  // A stall is reassurance, not an alarm.
  expect(shouldVibrate(LEVEL.INFO, LEVEL.OK, opts())).toBe(false);
});

test('respects the vibration toggle', () => {
  expect(shouldVibrate(LEVEL.WARN, LEVEL.OK, opts({ vibrateEnabled: false })))
    .toBe(false);
});

test('respects quiet hours spanning midnight', () => {
  const quiet = { startMinutes: 22 * 60, endMinutes: 6 * 60 };
  expect(shouldVibrate(LEVEL.WARN, LEVEL.OK,
    opts({ quietHours: quiet, nowLocalMinutes: 23 * 60 }))).toBe(false);
  expect(shouldVibrate(LEVEL.WARN, LEVEL.OK,
    opts({ quietHours: quiet, nowLocalMinutes: 3 * 60 }))).toBe(false);
  expect(shouldVibrate(LEVEL.WARN, LEVEL.OK,
    opts({ quietHours: quiet, nowLocalMinutes: 12 * 60 }))).toBe(true);
});
