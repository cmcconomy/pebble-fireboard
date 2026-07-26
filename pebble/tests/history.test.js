const fs = require('fs');
const path = require('path');
const { History } = require('../src/pkjs/history');

const MIN = 60000;

function push(h, session, t, temps) {
  h.push(session, Object.keys(temps).map((ch) => ({
    channel: Number(ch), label: 'p' + ch, temp: temps[ch],
  })), t);
}

test('rate is null until there are two samples', () => {
  const h = new History({ maxSamples: 120 });
  push(h, 1, 0, { 3: 80 });
  expect(h.rate(3)).toBeNull();
});

test('computes degrees per minute across the window', () => {
  const h = new History({ maxSamples: 120 });
  push(h, 1, 0, { 3: 80 });
  push(h, 1, 10 * MIN, { 3: 90 });
  expect(h.rate(3)).toBeCloseTo(1.0);
});

test('matches the measured real-world rate', () => {
  // Observed: 87.5 -> 89.0 over 3m16s ≈ 0.46 F/min
  const h = new History({ maxSamples: 120 });
  push(h, 1, 0, { 3: 87.5 });
  push(h, 1, 196000, { 3: 89.0 });
  expect(h.rate(3)).toBeCloseTo(0.46, 1);
});

test('discards history when the session changes', () => {
  const h = new History({ maxSamples: 120 });
  push(h, 1, 0, { 3: 80 });
  push(h, 1, 10 * MIN, { 3: 90 });
  push(h, 2, 20 * MIN, { 3: 60 });
  expect(h.sampleCount(3)).toBe(1);
  expect(h.rate(3)).toBeNull();
});

test('evicts oldest samples beyond maxSamples', () => {
  const h = new History({ maxSamples: 5 });
  for (let i = 0; i < 10; i++) { push(h, 1, i * MIN, { 3: 80 + i }); }
  expect(h.sampleCount(3)).toBe(5);
});

test('a probe climbing steadily is not stalled', () => {
  const h = new History({ maxSamples: 120 });
  for (let i = 0; i <= 30; i++) { push(h, 1, i * MIN, { 3: 150 + i * 0.5 }); }
  expect(h.isStalled(3, 30 * MIN, 240)).toBe(false);
});

test('flat in the stall band with a hot pit is a stall', () => {
  const h = new History({ maxSamples: 120 });
  for (let i = 0; i <= 30; i++) { push(h, 1, i * MIN, { 3: 159 + (i % 2) * 0.05 }); }
  expect(h.isStalled(3, 30 * MIN, 240)).toBe(true);
});

test('flat below the stall band is not a stall', () => {
  // Cold meat that is not moving is a problem, not a stall.
  const h = new History({ maxSamples: 120 });
  for (let i = 0; i <= 30; i++) { push(h, 1, i * MIN, { 3: 80 }); }
  expect(h.isStalled(3, 30 * MIN, 240)).toBe(false);
});

test('flat with a cold pit is not a stall', () => {
  // The fire went out. Do not reassure the user.
  const h = new History({ maxSamples: 120 });
  for (let i = 0; i <= 30; i++) { push(h, 1, i * MIN, { 3: 159 }); }
  expect(h.isStalled(3, 30 * MIN, 120)).toBe(false);
});

test('needs a sustained window before calling a stall', () => {
  const h = new History({ maxSamples: 120 });
  for (let i = 0; i <= 10; i++) { push(h, 1, i * MIN, { 3: 159 }); }
  expect(h.isStalled(3, 10 * MIN, 240)).toBe(false);
});

// The test the design specifically asked for: replay a real cook rather than a
// synthetic curve. This 11.4-hour pork shoulder contains a verified 82-minute
// stall around 157.7F, starting ~3.0h in, with the pit at 203F.
test('detects the stall in a replayed real 11.4-hour cook', () => {
  const chart = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/chart-11h.json'), 'utf8')
  );
  const food = chart.find((s) => s.label.indexOf('shoulder') !== -1);
  const pit = chart.find((s) => s.label === 'pit');
  const pitAt = (t) => pit.y[
    pit.x.reduce((best, xv, i) =>
      Math.abs(xv - t) < Math.abs(pit.x[best] - t) ? i : best, 0)
  ];

  const h = new History({ maxSamples: 120 });
  let sawStall = false;
  let stallTemp = null;

  for (let i = 0; i < food.x.length; i++) {
    const tMs = food.x[i] * 1000;
    h.push(1, [{ channel: 3, label: 'pork shoulder', temp: food.y[i] }], tMs);
    if (h.isStalled(3, tMs, pitAt(food.x[i]))) {
      sawStall = true;
      if (stallTemp === null) stallTemp = food.y[i];
    }
  }

  expect(sawStall).toBe(true);
  expect(stallTemp).toBeGreaterThanOrEqual(150);
  expect(stallTemp).toBeLessThanOrEqual(170);
});

test('does not call a stall during the early climb of the real cook', () => {
  const chart = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/chart-11h.json'), 'utf8')
  );
  const food = chart.find((s) => s.label.indexOf('shoulder') !== -1);
  const h = new History({ maxSamples: 120 });

  // First 90 minutes: meat is climbing steadily from ~48F. Nothing here is a stall.
  const cutoff = food.x[0] + 90 * 60;
  let flagged = false;
  for (let i = 0; i < food.x.length && food.x[i] <= cutoff; i++) {
    const tMs = food.x[i] * 1000;
    h.push(1, [{ channel: 3, label: 'pork shoulder', temp: food.y[i] }], tMs);
    if (h.isStalled(3, tMs, 240)) flagged = true;
  }
  expect(flagged).toBe(false);
});
