const fs = require('fs');
const path = require('path');
const { redact, liveProbes, detectPit, normalise } = require('../src/pkjs/model');

const devices = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/devices.json'), 'utf8')
);

test('redact removes device_log entirely', () => {
  const withLog = Object.assign({}, devices[0], {
    device_log: { ssid: 'MyNet', macNIC: 'aa:bb', publicIP: '203.0.113.7' },
  });
  const out = redact(withLog);
  expect(out.device_log).toBeUndefined();
  expect(JSON.stringify(out)).not.toContain('MyNet');
  expect(JSON.stringify(out)).not.toContain('203.0.113.7');
  expect(out.uuid).toBe(devices[0].uuid);
});

test('redact does not mutate its input', () => {
  const withLog = Object.assign({}, devices[0], { device_log: { ssid: 'MyNet' } });
  redact(withLog);
  expect(withLog.device_log).toBeDefined();
});

test('liveness is current_temp, not the enabled flag', () => {
  const probes = liveProbes(devices[0]);
  expect(probes.map((p) => p.channel)).toEqual([3, 4]);
});

test('probe carries label, temp and alert bounds', () => {
  const probes = liveProbes(devices[0]);
  const butt = probes.find((p) => p.channel === 3);
  expect(butt.label).toBe('boneless butt');
  expect(butt.temp).toBeCloseTo(84.4);
  expect(butt.hasAlert).toBe(false);
  expect(butt.min).toBeNull();
  expect(butt.max).toBeNull();
});

test('detectPit ignores a matching label on a channel that is not live', () => {
  // ch6 is also "pit" but disabled and unplugged; ch4 is the live one.
  const probes = liveProbes(devices[0]);
  expect(detectPit(probes, null)).toBe(4);
});

test('detectPit honours an explicit override', () => {
  const probes = liveProbes(devices[0]);
  expect(detectPit(probes, 3)).toBe(3);
});

test('detectPit ignores an override pointing at a dead channel', () => {
  const probes = liveProbes(devices[0]);
  expect(detectPit(probes, 6)).toBe(4);
});

test('detectPit matches grill, smoker and chamber too', () => {
  const probes = [
    { channel: 2, label: 'brisket', hasAlert: false },
    { channel: 5, label: 'Smoker Chamber', hasAlert: false },
  ];
  expect(detectPit(probes, null)).toBe(5);
});

test('detectPit returns null when nothing matches', () => {
  const probes = [{ channel: 1, label: 'brisket', hasAlert: false }];
  expect(detectPit(probes, null)).toBeNull();
});

test('detectPit breaks ties on the lowest channel', () => {
  const probes = [
    { channel: 4, label: 'pit', hasAlert: false },
    { channel: 2, label: 'pit left', hasAlert: false },
  ];
  expect(detectPit(probes, null)).toBe(2);
});

test('normalise produces the full frame input', () => {
  const out = normalise(devices, { pitOverride: null });
  expect(out.probes.length).toBe(2);
  expect(out.pitChannel).toBe(4);
  expect(out.sessionId).toBe(11569055);
  expect(out.batteryPct).toBe(78);
  expect(out.degreetype).toBe(2);
  expect(out.lastTemplogMs).toBe(Date.parse('2026-07-26T14:54:23Z'));
  expect(out.startedMs).toBe(Date.parse('2026-07-26T13:32:45Z'));
});

test('normalise on an empty account yields no probes', () => {
  const out = normalise([], { pitOverride: null });
  expect(out.probes).toEqual([]);
  expect(out.pitChannel).toBeNull();
});
