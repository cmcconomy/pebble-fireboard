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
      send(body) {
        this.body = body;
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

// --- login -------------------------------------------------------------
//
// The token exchange lives here rather than in the config page because
// FireBoard's login endpoint sends no CORS headers, so a browser XHR from
// github.io can never read the response. pkjs has no origin and is not
// subject to CORS.

const { classifyLogin, login } = require('../src/pkjs/fireboard');

test('classifyLogin calls a rejected credential a bad token', () => {
  expect(classifyLogin(400, 'application/json',
    '{"non_field_errors":["Unable to log in with provided credentials."]}'))
    .toBe('bad_token');
  expect(classifyLogin(401, 'application/json', '{"detail":"x"}')).toBe('bad_token');
});

test('classifyLogin calls the WAF captcha a WAF, not a bad credential', () => {
  // The login endpoint sits behind an AWS WAF that throttles with 405 + HTML.
  // Reporting that as a credentials failure sends the user round the sign-in
  // loop forever while the door is being held shut for reasons of their own.
  expect(classifyLogin(405, 'text/html',
    '<html><body>Human Verification</body></html>')).toBe('waf');
});

test('classifyLogin leaves a healthy response alone', () => {
  expect(classifyLogin(200, 'application/json', '{"key":"t"}')).toBe('ok');
});

// The stub calls back synchronously from inside send(), so `captured` is
// exposed through a box the callback can read while login() is still running.
const box = {};

function loginWith(response, cb) {
  const Xhr = fakeXhr(response);
  login('a@b.com', 'hunter2', cb, {
    xhrFactory: function () { box.xhr = new Xhr(); return box.xhr; },
    userAgent: 'pebble-fireboard/0.1',
  });
}

test('login posts JSON credentials with a User-Agent', (done) => {
  loginWith(
    { status: 200, contentType: 'application/json', body: '{"key":"tok-123"}' },
    (err, token) => {
      const xhr = box.xhr;
      expect(err).toBeNull();
      expect(token).toBe('tok-123');
      expect(xhr.method).toBe('POST');
      expect(xhr.url).toBe('https://fireboard.io/api/rest-auth/login/');
      expect(xhr.headers['User-Agent']).toBe('pebble-fireboard/0.1');
      expect(xhr.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(xhr.body)).toEqual({
        username: 'a@b.com', password: 'hunter2',
      });
      done();
    });
});

test('login reports rejected credentials as bad_token', (done) => {
  loginWith({
    status: 400, contentType: 'application/json',
    body: '{"non_field_errors":["Unable to log in with provided credentials."]}',
  }, (err, token) => {
    expect(err.kind).toBe('bad_token');
    expect(token).toBeNull();
    done();
  });
});

test('login reports a WAF captcha as waf, not a credentials failure', (done) => {
  loginWith({
    status: 405, contentType: 'text/html',
    body: '<html><body>Human Verification</body></html>',
  }, (err, token) => {
    expect(err.kind).toBe('waf');
    expect(token).toBeNull();
    done();
  });
});

test('login reports a transport failure as network', (done) => {
  loginWith({ networkError: true }, (err) => {
    expect(err.kind).toBe('network');
    done();
  });
});

test('login refuses to call a 2xx without a key a credentials failure', (done) => {
  loginWith({
    status: 200, contentType: 'application/json', body: '{"detail":"odd"}',
  }, (err) => {
    expect(err.kind).toBe('unknown_transient');
    done();
  });
});

test('a login error carries no credential material', (done) => {
  loginWith({
    status: 400, contentType: 'application/json', body: '{"non_field_errors":["nope"]}',
  }, (err) => {
    expect(JSON.stringify(err)).not.toContain('hunter2');
    expect(JSON.stringify(err)).not.toContain('a@b.com');
    done();
  });
});
