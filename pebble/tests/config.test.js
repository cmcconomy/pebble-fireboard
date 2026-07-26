const { defaultSettings, buildConfigUrl, parseConfigResponse } =
  require('../src/pkjs/config');

test('defaults are safe for a fresh install', () => {
  const d = defaultSettings();
  expect(d.token).toBe('');
  expect(d.layout).toBe(0);
  expect(d.pitOverride).toBeNull();
  expect(d.pollSec).toBe(30);
  expect(d.vibrateEnabled).toBe(true);
  expect(d.showAlertVisuals).toBe(true);
});

test('config url carries current settings', () => {
  const url = buildConfigUrl('https://example.com/config/', defaultSettings());
  expect(url).toContain('https://example.com/config/');
  expect(url).toContain('pollSec=30');
});

test('config url never carries a password field', () => {
  const url = buildConfigUrl('https://example.com/config/',
    Object.assign(defaultSettings(), { token: 'secret-token' }));
  expect(url).not.toContain('password');
});

test('parses a full response', () => {
  const s = parseConfigResponse(JSON.stringify({
    token: 'abc', layout: 1, pitOverride: 4, units: 'F',
    showAlertVisuals: false, vibrateEnabled: false,
    quietStart: 1320, quietEnd: 360, pollSec: 60,
  }));
  expect(s.token).toBe('abc');
  expect(s.layout).toBe(1);
  expect(s.pitOverride).toBe(4);
  expect(s.vibrateEnabled).toBe(false);
  expect(s.quietStart).toBe(1320);
});

test('clamps the poll interval to the 20 second floor', () => {
  // 20s is 15 calls per 5 min against a ceiling of 17 shared with the phone app.
  const s = parseConfigResponse(JSON.stringify({ pollSec: 5 }));
  expect(s.pollSec).toBe(20);
});

test('caps the poll interval at five minutes', () => {
  const s = parseConfigResponse(JSON.stringify({ pollSec: 9999 }));
  expect(s.pollSec).toBe(300);
});

test('treats a malformed response as defaults', () => {
  const s = parseConfigResponse('not json');
  expect(s.pollSec).toBe(30);
  expect(s.token).toBe('');
});

test('auto pit override round-trips as null', () => {
  const s = parseConfigResponse(JSON.stringify({ pitOverride: '' }));
  expect(s.pitOverride).toBeNull();
});
