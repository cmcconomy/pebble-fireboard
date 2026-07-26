// ES5 only.
var LEVEL = { OK: 0, INFO: 1, WARN: 2, CRITICAL: 3 };

function evaluateProbe(probe, isPit, stalled) {
  var flags = { outOfBand: false, stalled: !!stalled };
  var level = LEVEL.OK;

  var hasMin = probe.min !== null && probe.min !== undefined;
  var hasMax = probe.max !== null && probe.max !== undefined;

  if (hasMin && hasMax) {
    // Both bounds means a band to hold — leaving it needs attention.
    if (probe.temp < probe.min || probe.temp > probe.max) {
      flags.outOfBand = true;
      level = LEVEL.WARN;
    }
  } else if (hasMax) {
    // Max alone means a target — reaching it means done.
    if (probe.temp >= probe.max) level = LEVEL.CRITICAL;
  } else if (hasMin) {
    if (probe.temp < probe.min) {
      flags.outOfBand = true;
      level = LEVEL.WARN;
    }
  }

  if (level === LEVEL.OK && flags.stalled) level = LEVEL.INFO;
  return { level: level, flags: flags };
}

function shortLabel(s) {
  return String(s || '').toUpperCase().substring(0, 10);
}

function evaluate(state) {
  var probes = state.probes || [];
  var stalled = state.stalledChannels || {};
  var top = LEVEL.OK;
  var banner = '';
  var perProbe = {};

  for (var i = 0; i < probes.length; i++) {
    var p = probes[i];
    var isPit = p.channel === state.pitChannel;
    var r = evaluateProbe(p, isPit, !!stalled[p.channel]);
    perProbe[p.channel] = r;

    if (r.level > top) {
      top = r.level;
      if (r.level === LEVEL.WARN) {
        var dir = (p.max !== null && p.max !== undefined && p.temp > p.max)
          ? 'HIGH' : 'LOW';
        banner = shortLabel(p.label) + ' ' + dir + ' ' + Math.round(p.temp);
      } else if (r.level === LEVEL.CRITICAL) {
        banner = shortLabel(p.label) + ' DONE ' + Math.round(p.temp);
      } else if (r.level === LEVEL.INFO) {
        banner = shortLabel(p.label) + ' STALLED';
      }
    }
  }
  return { level: top, banner: banner, perProbe: perProbe };
}

function inQuietHours(quiet, nowLocalMinutes) {
  if (!quiet) return false;
  var s = quiet.startMinutes;
  var e = quiet.endMinutes;
  if (s === e) return false;
  if (s < e) return nowLocalMinutes >= s && nowLocalMinutes < e;
  return nowLocalMinutes >= s || nowLocalMinutes < e;   // spans midnight
}

function shouldVibrate(level, prevLevel, opts) {
  if (!opts.vibrateEnabled) return false;
  if (level <= prevLevel) return false;          // transitions only
  if (level < LEVEL.WARN) return false;          // INFO never buzzes
  if (inQuietHours(opts.quietHours, opts.nowLocalMinutes)) return false;
  return true;
}

module.exports = {
  LEVEL: LEVEL,
  evaluateProbe: evaluateProbe,
  evaluate: evaluate,
  shouldVibrate: shouldVibrate,
};
