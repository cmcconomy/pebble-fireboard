// ES5 only — runs in a stripped JSCore on the phone.
var STORAGE_KEY = 'fb.budget';

function Budget(opts) {
  this._now = opts.now;
  this._storage = opts.storage;
  this._limit = opts.limit;
  this._windowMs = opts.windowMs;
}

Budget.prototype._load = function () {
  try {
    var raw = this._storage.getItem(STORAGE_KEY);
    if (raw == null) return [];
    var parsed = JSON.parse(raw);
    return Object.prototype.toString.call(parsed) === '[object Array]' ? parsed : [];
  } catch (e) {
    return [];
  }
};

Budget.prototype._save = function (stamps) {
  try {
    this._storage.setItem(STORAGE_KEY, JSON.stringify(stamps));
  } catch (e) { /* quota — the cap degrades to per-process, acceptable */ }
};

Budget.prototype._live = function () {
  var cutoff = this._now() - this._windowMs;
  var stamps = this._load();
  var out = [];
  for (var i = 0; i < stamps.length; i++) {
    if (stamps[i] > cutoff) out.push(stamps[i]);
  }
  return out;
};

Budget.prototype.used = function () { return this._live().length; };

Budget.prototype.allow = function () { return this._live().length < this._limit; };

Budget.prototype.record = function () {
  var stamps = this._live();
  stamps.push(this._now());
  this._save(stamps);
};

module.exports = { Budget: Budget };
