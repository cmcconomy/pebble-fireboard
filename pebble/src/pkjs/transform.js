// ES5 only.
var MAX_PROBES = 4;
var MAX_LABEL = 16;
var MAX_BANNER = 64;

var FLAG = { IS_PIT: 1, HAS_ALERT: 2, OUT_OF_BAND: 4, STALLED: 8 };
var STATE = { COOKING: 1, SHOW_ALERT_VISUALS: 2, STALE: 4, MAY_VIBRATE: 8 };

function tenths(v) {
  if (v === null || v === undefined) return 0;
  // Clamp to int16 range [-32768, 32767]. Values cross AppMessage as int16;
  // unclamped overflow wraps to negative on the watch (3276.8° → wrong negative temp),
  // but clamped saturation (3276.7°) reads as obviously broken. Saturation is safer.
  var scaled = Math.round(v * 10);
  return Math.max(-32768, Math.min(32767, scaled));
}

// The watch renders the list as given: pit first, then ascending channel.
function orderProbes(probes, pitChannel) {
  var pit = [];
  var rest = [];
  for (var i = 0; i < probes.length; i++) {
    if (probes[i].channel === pitChannel) pit.push(probes[i]);
    else rest.push(probes[i]);
  }
  rest.sort(function (a, b) { return a.channel - b.channel; });
  return pit.concat(rest).slice(0, MAX_PROBES);
}

function buildFrame(input) {
  var ordered = orderProbes(input.probes || [], input.pitChannel);
  var rates = input.rates || {};
  var perProbe = input.perProbe || {};
  var frame = {};

  for (var i = 0; i < ordered.length; i++) {
    var p = ordered[i];
    var pp = perProbe[p.channel] || { flags: {} };
    var flags = 0;
    if (p.channel === input.pitChannel) flags |= FLAG.IS_PIT;
    if (p.hasAlert) flags |= FLAG.HAS_ALERT;
    if (pp.flags && pp.flags.outOfBand) flags |= FLAG.OUT_OF_BAND;
    if (pp.flags && pp.flags.stalled) flags |= FLAG.STALLED;

    frame['P_LABEL' + i] = String(p.label).substring(0, MAX_LABEL);
    frame['P_TEMP' + i] = tenths(p.temp);
    frame['P_MIN' + i] = tenths(p.min);
    frame['P_MAX' + i] = tenths(p.max);
    frame['P_RATE' + i] = tenths(rates[p.channel]);
    frame['P_FLAGS' + i] = flags;
  }

  var stateFlags = 0;
  if (input.cooking) stateFlags |= STATE.COOKING;
  if (input.showAlertVisuals) stateFlags |= STATE.SHOW_ALERT_VISUALS;
  if (input.stale) stateFlags |= STATE.STALE;
  if (input.mayVibrate) stateFlags |= STATE.MAY_VIBRATE;

  frame.N_PROBES = ordered.length;
  frame.ELAPSED_SEC = Math.max(0, Math.floor(input.elapsedSec || 0));
  frame.STALENESS_SEC = Math.max(0, Math.floor(input.stalenessSec || 0));
  frame.FB_BATTERY = Math.max(0, Math.min(100, Math.floor(input.batteryPct || 0)));
  frame.SESSION_ID = Math.floor(input.sessionId || 0);
  frame.ALERT_LEVEL = input.alertLevel || 0;
  frame.BANNER = String(input.banner || '').substring(0, MAX_BANNER);
  frame.LAYOUT = input.layout || 0;
  frame.DEGREETYPE = input.degreetype || 2;
  frame.STATE_FLAGS = stateFlags;
  return frame;
}

// Mirrors the SDK formula: 1 + (n * 7) + sum of value sizes.
// Strings are null-terminated and the terminator counts.
function estimateFrameBytes(frame) {
  var total = 1;
  for (var k in frame) {
    if (!Object.prototype.hasOwnProperty.call(frame, k)) continue;
    total += 7;
    var v = frame[k];
    total += (typeof v === 'string') ? (v.length + 1) : 4;
  }
  return total;
}

module.exports = {
  FLAG: FLAG,
  STATE: STATE,
  buildFrame: buildFrame,
  estimateFrameBytes: estimateFrameBytes,
};
