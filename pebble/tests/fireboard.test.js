const { classify, Client } = require('../src/pkjs/fireboard');

test('classifies a healthy response', () => {
  expect(classify(200, 'application/json', '[]')).toBe('ok');
});

test('classifies an invalid token', () => {
  expect(classify(403, 'application/json', '{"detail":"Invalid token"}'))
    .toBe('bad_token');
});

test('classifies missing credentials as a bad token', () => {
  expect(classify(403, 'application/json',
    '{"detail":"Authentication credentials were not provided."}')).toBe('bad_token');
});

test('classifies an HTML 403 as a missing User-Agent, not an auth failure', () => {
  expect(classify(403, 'text/html', '<html><head><title>403 Forbidden</title>'))
    .toBe('no_user_agent');
});

test('classifies a WAF captcha', () => {
  expect(classify(405, 'text/html', '<html>Human Verification</html>')).toBe('waf');
});

test('classifies an explicit 429', () => {
  expect(classify(429, 'application/json', '{"detail":"throttled"}')).toBe('rate_limited');
});

test('treats an unrecognised 403 as transient, never as an auth failure', () => {
  // Load-bearing: discarding a good token costs a reconfiguration.
  expect(classify(403, 'application/json', '{"detail":"something new"}'))
    .toBe('unknown_transient');
});

// --- client ---

function fakeXhr(response) {
  return function () {
    return {
      headers: {},
      open(method, url) { this.method = method; this.url = url; },
      setRequestHeader(k, v) { this.headers[k] = v; },
      getResponseHeader(k) {
        return k.toLowerCase() === 'content-type' ? response.contentType : null;
      },
      send() {
        this.status = response.status;
        this.responseText = response.body;
        if (response.networkError) { this.onerror(); } else { this.onload(); }
      },
    };
  };
}

function makeClient(response) {
  return new Client({
    token: 'testtoken',
    xhrFactory: fakeXhr(response),
    userAgent: 'pebble-fireboard/0.1',
  });
}

test('sends Token auth and a User-Agent', (done) => {
  let captured;
  const Xhr = fakeXhr({ status: 200, contentType: 'application/json', body: '[]' });
  const client = new Client({
    token: 'abc123',
    userAgent: 'pebble-fireboard/0.1',
    xhrFactory: function () { captured = new Xhr(); return captured; },
  });
  client.getDevices(() => {
    expect(captured.headers['Authorization']).toBe('Token abc123');
    expect(captured.headers['User-Agent']).toBe('pebble-fireboard/0.1');
    expect(captured.url).toBe('https://fireboard.io/api/v1/devices.json');
    done();
  });
});

test('returns parsed devices on success', (done) => {
  const client = makeClient({
    status: 200, contentType: 'application/json', body: '[{"uuid":"x"}]',
  });
  client.getDevices((err, devices) => {
    expect(err).toBeNull();
    expect(devices[0].uuid).toBe('x');
    done();
  });
});

test('surfaces the classification on the error', (done) => {
  const client = makeClient({
    status: 403, contentType: 'application/json', body: '{"detail":"Invalid token"}',
  });
  client.getDevices((err) => {
    expect(err.kind).toBe('bad_token');
    done();
  });
});

test('reports a network failure', (done) => {
  const client = makeClient({ networkError: true });
  client.getDevices((err) => {
    expect(err.kind).toBe('network');
    done();
  });
});
