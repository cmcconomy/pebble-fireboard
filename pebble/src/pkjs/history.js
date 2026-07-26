// ES5 only.
// Stall thresholds are defined in Fahrenheit. Callers pass Fahrenheit values;
// conversion happens upstream in index.js so this module stays unit-agnostic
// in its arithmetic and unit-specific only in these constants.
var STALL_MAX_RATE_F_PER_MIN = 0.1;
var STALL_MIN_WINDOW_MS = 20 * 60000;
var STALL_BAND_LOW_F = 150;
var STALL_BAND_HIGH_F = 170;
// 180, not 200. Measured against a real 11.4h cook whose 82-minute stall
// occurred with the pit at 203F — only 3F of margin above a 200 threshold.
// A genuinely dead fire falls well below 180, so this stays safe while being
// robust to a cook running cooler than nominal.
var PIT_HOT_F = 180;

function History(opts) {
  this._max = (opts && opts.maxSamples) || 120;
  this._session = null;
  this._byChannel = {};
}

History.prototype.reset = function () {
  this._byChannel = {};
};

History.prototype.push = function (sessionId, probes, nowMs) {
  if (this._session !== null && sessionId !== this._session) {
    this.reset();
  }
  this._session = sessionId;
  for (var i = 0; i < probes.length; i++) {
    var p = probes[i];
    var key = String(p.channel);
    if (!this._byChannel[key]) this._byChannel[key] = [];
    var series = this._byChannel[key];
    series.push({ t: nowMs, v: p.temp });
    while (series.length > this._max) series.shift();
  }
};

History.prototype.sampleCount = function (channel) {
  var s = this._byChannel[String(channel)];
  return s ? s.length : 0;
};

History.prototype.rate = function (channel) {
  var s = this._byChannel[String(channel)];
  if (!s || s.length < 2) return null;
  var first = s[0];
  var last = s[s.length - 1];
  var minutes = (last.t - first.t) / 60000;
  if (minutes <= 0) return null;
  return (last.v - first.v) / minutes;
};

History.prototype.isStalled = function (channel, nowMs, pitTemp) {
  var s = this._byChannel[String(channel)];
  if (!s || s.length < 2) return false;

  var span = s[s.length - 1].t - s[0].t;
  if (span < STALL_MIN_WINDOW_MS) return false;

  var r = this.rate(channel);
  if (r === null || Math.abs(r) >= STALL_MAX_RATE_F_PER_MIN) return false;

  var temp = s[s.length - 1].v;
  if (temp < STALL_BAND_LOW_F || temp > STALL_BAND_HIGH_F) return false;

  // A flat probe with a dead fire is a failure, not a stall — never reassure.
  if (pitTemp === null || pitTemp === undefined || pitTemp < PIT_HOT_F) return false;

  return true;
};

module.exports = { History: History };
