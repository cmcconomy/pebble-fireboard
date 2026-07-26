// ES5 only.
var BASE = 'https://fireboard.io';
var DEVICES_PATH = '/api/v1/devices.json';
var LOGIN_PATH = '/api/rest-auth/login/';
var TIMEOUT_MS = 15000;
var DEFAULT_USER_AGENT = 'pebble-fireboard/0.1';

// Everything the API rejects comes back as 403, so branch on shape, not status.
function classify(status, contentType, body) {
  var ct = (contentType || '').toLowerCase();
  var text = body || '';

  if (status >= 200 && status < 300) return 'ok';
  if (status === 429) return 'rate_limited';

  // An HTML body means we were stopped at the edge, before Django saw the
  // request. In practice that means the User-Agent was missing.
  var isHtml = ct.indexOf('text/html') !== -1 ||
               text.indexOf('<html') !== -1 || text.indexOf('<HTML') !== -1;
  if (status === 405 && isHtml) return 'waf';
  if (isHtml) return 'no_user_agent';

  if (status === 403) {
    if (text.indexOf('Invalid token') !== -1) return 'bad_token';
    if (text.indexOf('credentials were not provided') !== -1) return 'bad_token';
    // Unrecognised 403: assume transient. Throwing away a working token is
    // far more expensive than an unnecessary backoff.
    return 'unknown_transient';
  }
  return 'unknown_transient';
}

function Client(opts) {
  this._token = opts.token;
  this._Xhr = opts.xhrFactory;
  this._userAgent = opts.userAgent || 'pebble-fireboard/0.1';
}

Client.prototype.getDevices = function (cb) {
  var self = this;
  var xhr = new this._Xhr();
  var done = false;
  function finish(err, data) {
    if (done) return;
    done = true;
    cb(err, data);
  }

  xhr.open('GET', BASE + DEVICES_PATH);
  xhr.setRequestHeader('Authorization', 'Token ' + this._token);
  // May be a no-op if the runtime forbids it; the platform default also passes,
  // since nginx only requires the header to be non-empty. Verified in Task 1.
  try { xhr.setRequestHeader('User-Agent', this._userAgent); } catch (e) {}
  xhr.timeout = TIMEOUT_MS;

  xhr.onload = function () {
    var ct = xhr.getResponseHeader ? xhr.getResponseHeader('Content-Type') : '';
    var kind = classify(xhr.status, ct, xhr.responseText);
    if (kind !== 'ok') {
      finish({ kind: kind, status: xhr.status }, null);
      return;
    }
    try {
      finish(null, JSON.parse(xhr.responseText));
    } catch (e) {
      finish({ kind: 'unknown_transient', status: xhr.status }, null);
    }
  };
  xhr.onerror = function () { finish({ kind: 'network', status: 0 }, null); };
  xhr.ontimeout = function () { finish({ kind: 'network', status: 0 }, null); };
  xhr.send(null);
};

// The login endpoint is a different animal from the data endpoint: it is the
// one place where a 4xx really can mean "these credentials are wrong", and it
// is the one place sitting behind an AWS WAF that answers a throttle with
// HTTP 405 + an HTML body + `x-amzn-waf-action: captcha`. classify() already
// recognises that pair as 'waf', which is exactly why it is reused here --
// reporting a CAPTCHA as a credentials failure would send the user round the
// sign-in loop forever while the WAF holds the door shut.
//
// django-rest-auth rejects bad credentials with 400 and a JSON body
// (`{"non_field_errors":["Unable to log in with provided credentials."]}`),
// which classify() -- tuned for the token-authenticated data endpoint -- can
// only call 'unknown_transient'. Only that specific case is promoted to
// 'bad_token'; everything else keeps classify()'s verdict.
function classifyLogin(status, contentType, body) {
  var kind = classify(status, contentType, body);
  if (kind !== 'unknown_transient') return kind;
  if (status === 400 || status === 401) return 'bad_token';
  if ((body || '').indexOf('Unable to log in') !== -1) return 'bad_token';
  return kind;
}

// Exchange a username/password for an API token.
//
// PASSWORD DISCIPLINE. `password` is an argument and nothing else: it is never
// assigned to module state, never stored, and never appears in a log line or
// an error object. The error handed to `cb` carries only a kind and a status.
// `opts` is for tests (xhrFactory/userAgent); on device the globals are used.
//
// cb(err, token): err.kind uses the same taxonomy as the data client --
// 'waf' | 'bad_token' | 'network' | 'unknown_transient' | ...
function login(username, password, cb, opts) {
  var o = opts || {};
  var Xhr = o.xhrFactory || XMLHttpRequest;
  var userAgent = o.userAgent || DEFAULT_USER_AGENT;
  var xhr = new Xhr();
  var done = false;
  function finish(err, token) {
    if (done) return;
    done = true;
    cb(err, token);
  }

  xhr.open('POST', BASE + LOGIN_PATH);
  xhr.setRequestHeader('Content-Type', 'application/json');
  // nginx/WAF only requires the header to be non-empty; may be a no-op if the
  // runtime forbids setting it, in which case the platform default also passes.
  try { xhr.setRequestHeader('User-Agent', userAgent); } catch (e) {}
  xhr.timeout = TIMEOUT_MS;

  xhr.onload = function () {
    var ct = xhr.getResponseHeader ? xhr.getResponseHeader('Content-Type') : '';
    var kind = classifyLogin(xhr.status, ct, xhr.responseText);
    if (kind !== 'ok') {
      finish({ kind: kind, status: xhr.status }, null);
      return;
    }
    var body;
    try {
      body = JSON.parse(xhr.responseText);
    } catch (e2) {
      finish({ kind: 'unknown_transient', status: xhr.status }, null);
      return;
    }
    if (!body || typeof body.key !== 'string' || !body.key) {
      // A 2xx with no key is not a rejection -- do not tell the user their
      // password is wrong on the strength of an unexpected body shape.
      finish({ kind: 'unknown_transient', status: xhr.status }, null);
      return;
    }
    finish(null, body.key);
  };
  xhr.onerror = function () { finish({ kind: 'network', status: 0 }, null); };
  xhr.ontimeout = function () { finish({ kind: 'network', status: 0 }, null); };
  xhr.send(JSON.stringify({ username: username, password: password }));
}

module.exports = {
  classify: classify,
  classifyLogin: classifyLogin,
  Client: Client,
  login: login,
};
