// ES5 only.
var POLL_MIN_SEC = 20;
var POLL_MAX_SEC = 300;

function defaultSettings() {
  return {
    token: '',
    layout: 0,
    pitOverride: null,
    units: 'auto',
    showAlertVisuals: true,
    vibrateEnabled: true,
    quietStart: null,
    quietEnd: null,
    pollSec: 30,
  };
}

function buildConfigUrl(baseUrl, settings) {
  var s = settings || defaultSettings();
  var q = [
    'layout=' + encodeURIComponent(s.layout),
    'pitOverride=' + encodeURIComponent(s.pitOverride === null ? '' : s.pitOverride),
    'units=' + encodeURIComponent(s.units),
    'showAlertVisuals=' + (s.showAlertVisuals ? '1' : '0'),
    'vibrateEnabled=' + (s.vibrateEnabled ? '1' : '0'),
    'quietStart=' + (s.quietStart === null ? '' : s.quietStart),
    'quietEnd=' + (s.quietEnd === null ? '' : s.quietEnd),
    'pollSec=' + encodeURIComponent(s.pollSec),
    'hasToken=' + (s.token ? '1' : '0'),
  ];
  return baseUrl + '?' + q.join('&');
}

function clampPoll(v) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return 30;
  if (n < POLL_MIN_SEC) return POLL_MIN_SEC;
  if (n > POLL_MAX_SEC) return POLL_MAX_SEC;
  return n;
}

function parseConfigResponse(raw) {
  var d = defaultSettings();
  var o;
  try {
    o = JSON.parse(raw);
  } catch (e) {
    return d;
  }
  if (!o || typeof o !== 'object') return d;

  if (typeof o.token === 'string' && o.token) d.token = o.token;
  if (o.layout !== undefined) d.layout = parseInt(o.layout, 10) || 0;
  if (o.pitOverride !== undefined && o.pitOverride !== '' && o.pitOverride !== null) {
    d.pitOverride = parseInt(o.pitOverride, 10);
    if (isNaN(d.pitOverride)) d.pitOverride = null;
  }
  if (typeof o.units === 'string') d.units = o.units;
  if (o.showAlertVisuals !== undefined) d.showAlertVisuals = !!o.showAlertVisuals;
  if (o.vibrateEnabled !== undefined) d.vibrateEnabled = !!o.vibrateEnabled;
  if (o.quietStart !== undefined && o.quietStart !== '' && o.quietStart !== null) {
    d.quietStart = parseInt(o.quietStart, 10);
  }
  if (o.quietEnd !== undefined && o.quietEnd !== '' && o.quietEnd !== null) {
    d.quietEnd = parseInt(o.quietEnd, 10);
  }
  d.pollSec = clampPoll(o.pollSec !== undefined ? o.pollSec : 30);
  return d;
}

module.exports = {
  defaultSettings: defaultSettings,
  buildConfigUrl: buildConfigUrl,
  parseConfigResponse: parseConfigResponse,
};
