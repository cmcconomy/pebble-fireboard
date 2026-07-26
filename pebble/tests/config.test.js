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
  expect(url).not.toContain('secret-token');
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

test('a settings-only response preserves the previous token', () => {
  const previous = Object.assign(defaultSettings(), { token: 'existing-token' });
  const s = parseConfigResponse(JSON.stringify({ layout: 2 }), previous);
  expect(s.token).toBe('existing-token');
});

test('signOut:true clears the previous token', () => {
  const previous = Object.assign(defaultSettings(), { token: 'existing-token' });
  const s = parseConfigResponse(JSON.stringify({ signOut: true }), previous);
  expect(s.token).toBe('');
});

test('a new token in the response replaces the previous one', () => {
  const previous = Object.assign(defaultSettings(), { token: 'old-token' });
  const s = parseConfigResponse(JSON.stringify({ token: 'new-token' }), previous);
  expect(s.token).toBe('new-token');
});

test('a settings-only save preserves the token and applies the new layout', () => {
  const previous = Object.assign(defaultSettings(), { token: 'existing-token', layout: 0 });
  const s = parseConfigResponse(JSON.stringify({ layout: 1 }), previous);
  expect(s.token).toBe('existing-token');
  expect(s.layout).toBe(1);
});

test('parseConfigResponse does not mutate the previous settings object', () => {
  const previous = Object.assign(defaultSettings(), { token: 'existing-token', layout: 0 });
  const snapshot = JSON.stringify(previous);
  parseConfigResponse(JSON.stringify({ layout: 1, signOut: true }), previous);
  expect(JSON.stringify(previous)).toBe(snapshot);
});

test('an invalid units value falls back rather than being accepted', () => {
  const s = parseConfigResponse(JSON.stringify({ units: 'banana' }));
  expect(s.units).toBe('auto');
});

test('an invalid units value falls back to the previous value when supplied', () => {
  const previous = Object.assign(defaultSettings(), { units: 'F' });
  const s = parseConfigResponse(JSON.stringify({ units: 'banana' }), previous);
  expect(s.units).toBe('F');
});

test('showAlertVisuals "false" string resolves to false', () => {
  const s = parseConfigResponse(JSON.stringify({ showAlertVisuals: 'false' }));
  expect(s.showAlertVisuals).toBe(false);
});

test('vibrateEnabled "0" string resolves to false', () => {
  const s = parseConfigResponse(JSON.stringify({ vibrateEnabled: '0' }));
  expect(s.vibrateEnabled).toBe(false);
});
