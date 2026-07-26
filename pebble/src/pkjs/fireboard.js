// ES5 only.
var BASE = 'https://fireboard.io';
var DEVICES_PATH = '/api/v1/devices.json';
var TIMEOUT_MS = 15000;

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

module.exports = { classify: classify, Client: Client };
