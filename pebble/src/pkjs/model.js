// ES5 only.
var PIT_PATTERN = /pit|grill|smoker|chamber/i;
var SENSITIVE_KEY = 'device_log';   // SSID, MAC addresses, public IP

function redact(device) {
  var out = {};
  for (var k in device) {
    if (Object.prototype.hasOwnProperty.call(device, k) && k !== SENSITIVE_KEY) {
      out[k] = device[k];
    }
  }
  return out;
}

// A channel is live only if it is actually reporting a temperature. The
// `enabled` flag stays true for configured-but-unplugged probes.
function liveProbes(device) {
  var channels = device.channels || [];
  var out = [];
  for (var i = 0; i < channels.length; i++) {
    var c = channels[i];
    if (c.current_temp === null || c.current_temp === undefined) continue;
    var alerts = c.alerts || [];
    var active = null;
    for (var j = 0; j < alerts.length; j++) {
      if (alerts[j].enabled) { active = alerts[j]; break; }
    }
    out.push({
      channel: c.channel,
      label: c.channel_label || ('ch' + c.channel),
      temp: c.current_temp,
      min: active && active.temp_min !== null && active.temp_min !== undefined
        ? active.temp_min : null,
      max: active && active.temp_max !== null && active.temp_max !== undefined
        ? active.temp_max : null,
      hasAlert: active !== null,
      minutesRepeat: active ? (active.minutes_repeat || 0) : 0,
      created: c.created || null,
    });
  }
  out.sort(function (a, b) { return a.channel - b.channel; });
  return out;
}

function detectPit(probes, overrideChannel) {
  var i;
  var lowest = null;

  if (overrideChannel !== null && overrideChannel !== undefined) {
    for (i = 0; i < probes.length; i++) {
      if (probes[i].channel === overrideChannel) return overrideChannel;
    }
    // Override points at a channel that is not live — fall through to auto.
  }

  for (i = 0; i < probes.length; i++) {
    if (PIT_PATTERN.test(probes[i].label)) {
      if (lowest === null || probes[i].channel < lowest) {
        lowest = probes[i].channel;
      }
    }
  }
  return lowest;
}

function parseMs(s) {
  if (!s) return null;
  var t = Date.parse(s);
  return isNaN(t) ? null : t;
}

function normalise(devices, opts) {
  var options = opts || {};
  if (!devices || devices.length === 0) {
    return { probes: [], pitChannel: null, sessionId: null, batteryPct: 0,
             degreetype: 2, lastTemplogMs: null, startedMs: null };
  }
  var device = redact(devices[0]);
  var probes = liveProbes(device);
  var channels = device.channels || [];
  var sessionId = channels.length ? (channels[0].sessionid || null) : null;
  var startedMs = channels.length ? parseMs(channels[0].created) : null;
  var battery = device.last_battery_reading;

  return {
    probes: probes,
    pitChannel: detectPit(probes, options.pitOverride),
    sessionId: sessionId,
    batteryPct: battery ? Math.round(battery * 100) : 0,
    degreetype: device.degreetype || 2,
    lastTemplogMs: parseMs(device.last_templog),
    startedMs: startedMs,
  };
}

module.exports = {
  redact: redact,
  liveProbes: liveProbes,
  detectPit: detectPit,
  normalise: normalise,
};
