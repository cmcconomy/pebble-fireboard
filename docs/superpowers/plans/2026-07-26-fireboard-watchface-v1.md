# FireBoard Watchface v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working Pebble watchface that shows live FireBoard cook temperatures, mirrors FireBoard's own alerts, and buzzes when a probe needs attention.

**Architecture:** PebbleKit JS on the phone polls `GET /api/v1/devices.json` every 30s, derives rate-of-rise and alert state, and pushes one self-contained AppMessage frame to a dumb C renderer on the watch. No daemon — the phone reaches the cloud from anywhere, which is the point during a cook. All pkjs modules are pure and dependency-injected so they unit-test in Node.

**Tech Stack:** PebbleKit JS (ES5), Pebble C SDK 4.9.169, Jest, `uv`/Python (probe tooling only).

**Spec:** [`docs/superpowers/specs/2026-07-26-fireboard-watchface-design.md`](../specs/2026-07-26-fireboard-watchface-design.md)
**Research:** [`docs/research/2026-07-26-fireboard-api-research.md`](../../research/2026-07-26-fireboard-api-research.md)

**Out of scope for this plan (deferred to Plan 2):** Hero and Progress layouts, colour treatment for basalt/chalk/emery/gabbro, round-platform layout work. This plan builds the Ledger layout in monochrome only. The `LAYOUT` message key is still sent and parsed so Plan 2 is additive.

## Global Constraints

- **pkjs source is ES5 only.** No `const`, `let`, arrow functions, template literals, `class`, `for…of`, `Promise`, or default parameters in `src/pkjs/**`. Use `var`, function declarations, and callbacks. Test files run in Node and may use modern syntax.
- **Every HTTP request must set a non-empty `User-Agent`.** Missing it returns an nginx HTML 403.
- **Auth header is `Authorization: Token <key>`** — never `Bearer`.
- **Poll interval default 30s, floor 20s**, enforced by a shared-budget guard of **17 calls per rolling 5 minutes**.
- **Never write, log, or forward `device_log`** from `devices.json` — it contains SSID, both MAC addresses, and public IP.
- **Target platform is `flint`: 144×168, `PBL_BW`, 1 bit per pixel.** Monochrome-first. Colour is never the sole carrier of meaning.
- **`targetPlatforms` must list all seven platforms.** Removing one causes silent install failure on that watch.
- **Temperatures and rates cross AppMessage as `int16` tenths of a degree** (92.1° → `921`).
- **Message keys are `extern uint32_t` variables, not `#define`s.** They cannot appear in `switch`/`case` or static initialisers. Use `dict_find` chains.
- **Call `text_layer_set_text_color()` unconditionally** with `GColorWhite`. Never wrap it in `#ifdef PBL_COLOR`.
- **Derive all geometry from `layer_get_unobstructed_bounds()`.** No hardcoded pixel coordinates.
- Commit after every task.

## File Structure

| File | Responsibility |
| --- | --- |
| `pebble/package.json` | App metadata, `messageKeys`, all 7 `targetPlatforms` |
| `pebble/wscript` | Stock Waf build script, copied verbatim from `pebble new-project` |
| `pebble/src/pkjs/budget.js` | Rolling 5-minute API call ledger |
| `pebble/src/pkjs/fireboard.js` | HTTP client, auth, 403 taxonomy, backoff |
| `pebble/src/pkjs/model.js` | `devices.json` → normalised probes; redaction; pit detection |
| `pebble/src/pkjs/history.js` | Rolling sample window; rate of rise; stall detection |
| `pebble/src/pkjs/alerts.js` | Probe state → alert level, banner, transitions |
| `pebble/src/pkjs/transform.js` | Normalised state → AppMessage frame |
| `pebble/src/pkjs/config.js` | Config URL building and response parsing |
| `pebble/src/pkjs/index.js` | Wiring: Pebble events, timers, storage. Only file touching globals. |
| `pebble/src/c/appmsg_keys.h` | Short aliases for generated `MESSAGE_KEY_*` |
| `pebble/src/c/model.h` / `model.c` | `CookModel` struct; dictionary → struct |
| `pebble/src/c/widgets.h` / `widgets.c` | Clock header, probe row, band gauge, banner, footer |
| `pebble/src/c/layout_ledger.h` / `.c` | Compose widgets into the Ledger layout |
| `pebble/src/c/ui.h` / `ui.c` | Layout dispatch |
| `pebble/src/c/fireboard.c` | Lifecycle, AppMessage, services, vibration |
| `pebble/tests/*.test.js` | Jest tests for pkjs modules |
| `pebble/tests/fixtures/*.json` | Real captured API responses, `device_log` stripped |
| `config/index.html` | Static config page |

---

### Task 1: Bootstrap the Pebble project and prove the User-Agent question

This is a **gate**. If PebbleKit JS cannot send a `User-Agent`, FireBoard's nginx returns an HTML 403 and the entire phone-direct architecture is dead. Everything downstream depends on the answer, so it is the first thing built.

**Files:**
- Create: `pebble/` (via `pebble new-project`)
- Modify: `pebble/package.json`
- Create: `pebble/src/pkjs/index.js` (temporary spike content)

- [ ] **Step 1: Create the project**

```bash
cd /Users/cmcconomyfwig/dev/github/cmcconomy/pebble-fireboard
pebble new-project --javascript pebble
```

If `pebble` is not on PATH: `uv tool install pebble-tool --python 3.13 && pebble sdk install latest`.

- [ ] **Step 2: Confirm the generated project has a wscript**

```bash
ls pebble/wscript
```

Expected: the file exists. If it does not, the build will fail later with the misleading error *"This project is very outdated, and cannot be handled by this SDK."* Re-run `pebble new-project` rather than hand-writing it.

- [ ] **Step 3: Set metadata and all seven platforms**

Replace the `pebble` block in `pebble/package.json`. Generate a fresh UUID with `uuidgen | tr 'A-Z' 'a-z'` and paste it in — do not reuse the one below.

```json
{
  "name": "fireboard",
  "author": "Craig McConomy",
  "version": "0.1.0",
  "private": true,
  "keywords": ["pebble-app"],
  "scripts": { "test": "jest" },
  "devDependencies": { "jest": "^29.7.0" },
  "pebble": {
    "displayName": "FireBoard",
    "uuid": "PASTE-FRESH-UUID-HERE",
    "sdkVersion": "3",
    "enableMultiJS": true,
    "targetPlatforms": ["aplite", "basalt", "chalk", "diorite", "emery", "flint", "gabbro"],
    "watchapp": { "watchface": true },
    "capabilities": ["configurable"],
    "messageKeys": [
      "P_LABEL[4]", "P_TEMP[4]", "P_MIN[4]", "P_MAX[4]", "P_RATE[4]", "P_FLAGS[4]",
      "N_PROBES", "ELAPSED_SEC", "STALENESS_SEC", "FB_BATTERY",
      "SESSION_ID", "ALERT_LEVEL", "BANNER", "LAYOUT", "DEGREETYPE", "STATE_FLAGS"
    ],
    "resources": { "media": [] }
  }
}
```

> ⚠️ **`resources.media` is mandatory even when empty.** An earlier version of this plan omitted
> it. The build still succeeds and produces a structurally valid `.pbw`, but **the watch refuses to
> install it**, reporting only `App install failed.` — no reason code, nothing more under `-v`, and
> `pebble ping` keeps returning `Pong!` so the connection looks healthy. Found by bisecting against
> a pristine `pebble new-project`, which installed fine.

`"watchface": true` is what makes this a watchface rather than an app. Watchfaces receive no button input.

- [ ] **Step 4: Write the spike pkjs**

Replace `pebble/src/pkjs/index.js` entirely:

```js
// TEMPORARY SPIKE — replaced in Task 9.
// Sends one request with a deliberately invalid token. We do not care about
// auth; we care whether the response is JSON (we reached Django, so a
// User-Agent was present) or HTML (nginx blocked us for having none).
Pebble.addEventListener('ready', function () {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', 'https://fireboard.io/api/v1/devices.json');
  xhr.setRequestHeader('Authorization', 'Token 0000000000000000000000000000000000000000');
  try {
    xhr.setRequestHeader('User-Agent', 'pebble-fireboard/0.1');
    console.log('SPIKE: setRequestHeader(User-Agent) did not throw');
  } catch (e) {
    console.log('SPIKE: setRequestHeader(User-Agent) threw: ' + e.message);
  }
  xhr.onload = function () {
    var body = xhr.responseText || '';
    console.log('SPIKE status=' + xhr.status);
    console.log('SPIKE body[0:120]=' + body.substring(0, 120));
    if (body.indexOf('<html') !== -1 || body.indexOf('<HTML') !== -1) {
      console.log('SPIKE RESULT: HTML -> NO User-Agent sent. ARCHITECTURE BLOCKED.');
    } else if (body.indexOf('detail') !== -1) {
      console.log('SPIKE RESULT: JSON -> User-Agent present. PROCEED.');
    } else {
      console.log('SPIKE RESULT: unexpected body, inspect manually.');
    }
  };
  xhr.onerror = function () { console.log('SPIKE: network error'); };
  xhr.send(null);
});
```

- [ ] **Step 5: Build and install to the watch**

```bash
cd pebble
pebble build
pebble install --phone <YOUR_PHONE_IP>
```

If the install hangs with `libpebble2.exceptions.TimeoutError`, the Developer Connection toggle in the Core Devices app has gone idle. Toggle it off and on, then retry. Do not debug further until you have confirmed it is on.

- [ ] **Step 6: Read the verdict**

```bash
pebble logs --phone <YOUR_PHONE_IP>
```

Expected: `SPIKE RESULT: JSON -> User-Agent present. PROCEED.`

**If instead you see `HTML -> NO User-Agent sent`:** stop. Do not continue this plan. The phone-direct architecture is not viable and the design must fall back to a daemon tier that can set headers freely. Record the finding in the research doc and escalate.

- [ ] **Step 7: Commit**

```bash
cd /Users/cmcconomyfwig/dev/github/cmcconomy/pebble-fireboard
git add pebble/
git commit -m "feat: bootstrap pebble watchface project, prove User-Agent reaches FireBoard"
```

---

### Task 2: Test fixtures from real captures

**Files:**
- Create: `pebble/tests/fixtures/devices.json`
- Create: `pebble/tests/fixtures/README.md`

**Interfaces:**
- Produces: fixture files consumed by every later test task.

- [ ] **Step 1: Write the fixture**

Create `pebble/tests/fixtures/devices.json`. This is a real capture with `device_log` removed and identifiers altered. It deliberately includes the awkward cases: a live probe with no alert, an enabled-but-unplugged probe, and a disabled probe holding a stranded alert.

```json
[
  {
    "id": 2333,
    "uuid": "15b1fff2-854f-4204-9a9a-79ba428e6144",
    "title": "Fireboard",
    "hardware_id": "FBX11C",
    "model": "FBX11C",
    "model_name": "FireBoard",
    "degreetype": 2,
    "active": true,
    "channel_count": 6,
    "auto_session": true,
    "last_templog": "2026-07-26T14:54:23Z",
    "last_battery_reading": 0.7816,
    "last_drivelog": null,
    "channels": [
      { "id": 55302196, "channel": 1, "channel_label": "Hock", "enabled": true,
        "state": true, "sessionid": 11569055, "created": "2026-07-26T13:32:45Z",
        "alerts": [ { "id": 11443439, "channel": 1, "temp_min": null, "temp_max": 203.0,
                      "enabled": true, "notify_app": true, "notify_sms": true,
                      "notify_email": false, "minutes_repeat": 30, "minutes_buffer": 0,
                      "time_start": "00:00:01", "time_stop": "23:59:59" } ] },
      { "id": 55302197, "channel": 2, "channel_label": "shoulder 1", "enabled": true,
        "state": true, "sessionid": 11569055, "created": "2026-07-26T13:32:45Z",
        "alerts": [] },
      { "id": 55302198, "channel": 3, "channel_label": "boneless butt", "enabled": true,
        "state": true, "sessionid": 11569055, "created": "2026-07-26T13:32:45Z",
        "degreetype": 2, "current_temp": 84.4,
        "last_templog": { "temp": 84.4, "created": "2026-07-26T14:54:23Z",
                          "degreetype": 2, "channel": 3 },
        "alerts": [] },
      { "id": 55302199, "channel": 4, "channel_label": "pit", "enabled": true,
        "state": true, "sessionid": 11569055, "created": "2026-07-26T13:32:45Z",
        "degreetype": 2, "current_temp": 278.9,
        "last_templog": { "temp": 278.9, "created": "2026-07-26T14:54:23Z",
                          "degreetype": 2, "channel": 4 },
        "alerts": [] },
      { "id": 55302200, "channel": 5, "channel_label": "pit 1 left", "enabled": true,
        "state": null, "sessionid": 11569055, "created": "2026-07-26T13:32:45Z",
        "alerts": [] },
      { "id": 55302201, "channel": 6, "channel_label": "pit", "enabled": false,
        "state": false, "sessionid": 11569055, "created": "2026-07-26T13:32:45Z",
        "alerts": [ { "id": 11443440, "channel": 6, "temp_min": 210.0, "temp_max": 240.0,
                      "enabled": true, "notify_app": true, "notify_sms": true,
                      "notify_email": false, "minutes_repeat": 30, "minutes_buffer": 0,
                      "time_start": "00:00:01", "time_stop": "23:59:59" } ] }
    ]
  }
]
```

- [ ] **Step 2: Document why the fixture looks like this**

Create `pebble/tests/fixtures/README.md`:

```markdown
# Test fixtures

`devices.json` is a real `GET /api/v1/devices.json` capture with `device_log`
removed (it contains SSID, MAC addresses, and public IP — never commit it).

It deliberately preserves four awkward real-world conditions:

- **ch3, ch4 are live** (`current_temp` present) — the only two that should render.
- **ch4 "pit" is live but has no alert.** This is the real configuration that
  produced a pit alarm that could never fire.
- **ch6 is also labelled "pit"**, is disabled, and holds the stranded 210–240°F
  alert. Pit detection must not choose it.
- **ch1, ch2, ch5 are enabled but unplugged** — labels present, no `current_temp`.
  Liveness is `current_temp`, never the `enabled` flag.
```

- [ ] **Step 3: Copy in the 11-hour cook fixture**

Already captured and committed at `docs/research/fixtures/chart-11h.json` (17.5 KB, 3 series,
device identifier stripped). It is a real `sessions/<id>/chart.json` for an 11.4-hour pork shoulder
and contains a **verified 82-minute stall around 157.7°F starting ~3.0h in, with the pit at 203°F**.
Task 6 replays it.

```bash
cp docs/research/fixtures/chart-11h.json pebble/tests/fixtures/chart-11h.json
```

Do not regenerate it from the API — the assertions in Task 6 are calibrated to this exact data.

- [ ] **Step 4: Install Jest and verify it runs**

```bash
cd pebble && npm install && npx jest --passWithNoTests
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add pebble/tests/fixtures pebble/package.json pebble/package-lock.json
git commit -m "test: add real-capture fixtures with documented edge cases"
```

---

### Task 3: `budget.js` — the shared rate-limit ledger

The 17-calls-per-5-minutes ceiling is **shared with the FireBoard phone app**, and the API returns no rate-limit headers, so the client must track its own usage.

**Files:**
- Create: `pebble/src/pkjs/budget.js`
- Test: `pebble/tests/budget.test.js`

**Interfaces:**
- Produces: `Budget(opts)` where `opts = {now: fn->ms, storage: {getItem, setItem}, limit: int, windowMs: int}`. Methods: `allow() -> bool`, `record() -> void`, `used() -> int`.

- [ ] **Step 1: Write the failing test**

```js
const { Budget } = require('../src/pkjs/budget');

function fakeStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

function makeBudget(clock, storage) {
  return new Budget({ now: () => clock.t, storage, limit: 17, windowMs: 300000 });
}

test('allows calls up to the limit then refuses', () => {
  const clock = { t: 1000000 };
  const b = makeBudget(clock, fakeStorage());
  for (let i = 0; i < 17; i++) {
    expect(b.allow()).toBe(true);
    b.record();
  }
  expect(b.allow()).toBe(false);
  expect(b.used()).toBe(17);
});

test('allows again once calls age out of the window', () => {
  const clock = { t: 1000000 };
  const b = makeBudget(clock, fakeStorage());
  for (let i = 0; i < 17; i++) { b.record(); }
  expect(b.allow()).toBe(false);
  clock.t += 300001;
  expect(b.allow()).toBe(true);
  expect(b.used()).toBe(0);
});

test('ages out calls individually, not all at once', () => {
  const clock = { t: 1000000 };
  const b = makeBudget(clock, fakeStorage());
  b.record();
  clock.t += 200000;
  for (let i = 0; i < 16; i++) { b.record(); }
  expect(b.allow()).toBe(false);
  clock.t += 100001;          // first call now older than 5 min, rest are not
  expect(b.used()).toBe(16);
  expect(b.allow()).toBe(true);
});

test('survives a storage round trip', () => {
  const clock = { t: 1000000 };
  const storage = fakeStorage();
  const a = makeBudget(clock, storage);
  for (let i = 0; i < 17; i++) { a.record(); }
  const b = makeBudget(clock, storage);
  expect(b.allow()).toBe(false);
});

test('treats corrupt storage as an empty ledger', () => {
  const clock = { t: 1000000 };
  const storage = fakeStorage();
  storage.setItem('fb.budget', 'not json');
  const b = makeBudget(clock, storage);
  expect(b.allow()).toBe(true);
  expect(b.used()).toBe(0);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd pebble && npx jest tests/budget.test.js`
Expected: FAIL — `Cannot find module '../src/pkjs/budget'`.

- [ ] **Step 3: Implement**

```js
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
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `cd pebble && npx jest tests/budget.test.js`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add pebble/src/pkjs/budget.js pebble/tests/budget.test.js
git commit -m "feat(pkjs): add shared rate-limit budget ledger"
```

---

### Task 4: `fireboard.js` — HTTP client and the three-way 403 taxonomy

Every failure mode returns HTTP 403. Status code alone cannot distinguish a dead token from a missing header from a throttle, so classification is by `content-type` first and the JSON `detail` string second.

**Files:**
- Create: `pebble/src/pkjs/fireboard.js`
- Test: `pebble/tests/fireboard.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `classify(status, contentType, body) -> string` returning one of `'ok' | 'bad_token' | 'no_user_agent' | 'waf' | 'rate_limited' | 'network' | 'unknown_transient'`. `Client(opts)` where `opts = {token, xhrFactory, userAgent}`, method `getDevices(cb)` with `cb(err, devices)`; on error `err.kind` is one of the classify values.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd pebble && npx jest tests/fireboard.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
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
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `cd pebble && npx jest tests/fireboard.test.js`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add pebble/src/pkjs/fireboard.js pebble/tests/fireboard.test.js
git commit -m "feat(pkjs): add FireBoard client with three-way 403 classification"
```

---

### Task 5: `model.js` — normalise devices, redact, detect the pit

**Files:**
- Create: `pebble/src/pkjs/model.js`
- Test: `pebble/tests/model.test.js`

**Interfaces:**
- Consumes: fixture from Task 2.
- Produces: `redact(device) -> device` (no `device_log`); `liveProbes(device) -> [probe]` where `probe = {channel, label, temp, min, max, hasAlert, created}` (`min`/`max` are `null` when absent); `detectPit(probes, overrideChannel) -> channel|null`; `normalise(devices, opts) -> {probes, pitChannel, sessionId, batteryPct, degreetype, lastTemplogMs, startedMs}`.

- [ ] **Step 1: Write the failing test**

```js
const fs = require('fs');
const path = require('path');
const { redact, liveProbes, detectPit, normalise } = require('../src/pkjs/model');

const devices = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/devices.json'), 'utf8')
);

test('redact removes device_log entirely', () => {
  const withLog = Object.assign({}, devices[0], {
    device_log: { ssid: 'MyNet', macNIC: 'aa:bb', publicIP: '203.0.113.7' },
  });
  const out = redact(withLog);
  expect(out.device_log).toBeUndefined();
  expect(JSON.stringify(out)).not.toContain('MyNet');
  expect(JSON.stringify(out)).not.toContain('203.0.113.7');
  expect(out.uuid).toBe(devices[0].uuid);
});

test('redact does not mutate its input', () => {
  const withLog = Object.assign({}, devices[0], { device_log: { ssid: 'MyNet' } });
  redact(withLog);
  expect(withLog.device_log).toBeDefined();
});

test('liveness is current_temp, not the enabled flag', () => {
  const probes = liveProbes(devices[0]);
  expect(probes.map((p) => p.channel)).toEqual([3, 4]);
});

test('probe carries label, temp and alert bounds', () => {
  const probes = liveProbes(devices[0]);
  const butt = probes.find((p) => p.channel === 3);
  expect(butt.label).toBe('boneless butt');
  expect(butt.temp).toBeCloseTo(84.4);
  expect(butt.hasAlert).toBe(false);
  expect(butt.min).toBeNull();
  expect(butt.max).toBeNull();
});

test('detectPit ignores a matching label on a channel that is not live', () => {
  // ch6 is also "pit" but disabled and unplugged; ch4 is the live one.
  const probes = liveProbes(devices[0]);
  expect(detectPit(probes, null)).toBe(4);
});

test('detectPit honours an explicit override', () => {
  const probes = liveProbes(devices[0]);
  expect(detectPit(probes, 3)).toBe(3);
});

test('detectPit ignores an override pointing at a dead channel', () => {
  const probes = liveProbes(devices[0]);
  expect(detectPit(probes, 6)).toBe(4);
});

test('detectPit matches grill, smoker and chamber too', () => {
  const probes = [
    { channel: 2, label: 'brisket', hasAlert: false },
    { channel: 5, label: 'Smoker Chamber', hasAlert: false },
  ];
  expect(detectPit(probes, null)).toBe(5);
});

test('detectPit returns null when nothing matches', () => {
  const probes = [{ channel: 1, label: 'brisket', hasAlert: false }];
  expect(detectPit(probes, null)).toBeNull();
});

test('detectPit breaks ties on the lowest channel', () => {
  const probes = [
    { channel: 4, label: 'pit', hasAlert: false },
    { channel: 2, label: 'pit left', hasAlert: false },
  ];
  expect(detectPit(probes, null)).toBe(2);
});

test('normalise produces the full frame input', () => {
  const out = normalise(devices, { pitOverride: null });
  expect(out.probes.length).toBe(2);
  expect(out.pitChannel).toBe(4);
  expect(out.sessionId).toBe(11569055);
  expect(out.batteryPct).toBe(78);
  expect(out.degreetype).toBe(2);
  expect(out.lastTemplogMs).toBe(Date.parse('2026-07-26T14:54:23Z'));
  expect(out.startedMs).toBe(Date.parse('2026-07-26T13:32:45Z'));
});

test('normalise on an empty account yields no probes', () => {
  const out = normalise([], { pitOverride: null });
  expect(out.probes).toEqual([]);
  expect(out.pitChannel).toBeNull();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd pebble && npx jest tests/model.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
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
  if (overrideChannel !== null && overrideChannel !== undefined) {
    for (i = 0; i < probes.length; i++) {
      if (probes[i].channel === overrideChannel) return overrideChannel;
    }
    // Override points at a channel that is not live — fall through to auto.
  }
  for (i = 0; i < probes.length; i++) {
    if (PIT_PATTERN.test(probes[i].label)) return probes[i].channel;
  }
  return null;
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
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `cd pebble && npx jest tests/model.test.js`
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add pebble/src/pkjs/model.js pebble/tests/model.test.js
git commit -m "feat(pkjs): normalise devices, redact device_log, detect pit probe"
```

---

### Task 6: `history.js` — rate of rise and stall detection

The stall is the one derived metric that can be confidently wrong, so it gets the most careful test.

**Files:**
- Create: `pebble/src/pkjs/history.js`
- Test: `pebble/tests/history.test.js`

**Interfaces:**
- Consumes: probe objects from Task 5.
- Produces: `History(opts)` with `opts = {maxSamples: int}`. Methods: `push(sessionId, probes, nowMs)`, `rate(channel) -> number|null` (degrees per minute over the retained window), `isStalled(channel, nowMs, pitTemp) -> bool`, `reset()`, `sampleCount(channel) -> int`.

- [ ] **Step 1: Write the failing test**

```js
const { History } = require('../src/pkjs/history');

const MIN = 60000;

function push(h, session, t, temps) {
  h.push(session, Object.keys(temps).map((ch) => ({
    channel: Number(ch), label: 'p' + ch, temp: temps[ch],
  })), t);
}

test('rate is null until there are two samples', () => {
  const h = new History({ maxSamples: 120 });
  push(h, 1, 0, { 3: 80 });
  expect(h.rate(3)).toBeNull();
});

test('computes degrees per minute across the window', () => {
  const h = new History({ maxSamples: 120 });
  push(h, 1, 0, { 3: 80 });
  push(h, 1, 10 * MIN, { 3: 90 });
  expect(h.rate(3)).toBeCloseTo(1.0);
});

test('matches the measured real-world rate', () => {
  // Observed: 87.5 -> 89.0 over 3m16s ≈ 0.46 F/min
  const h = new History({ maxSamples: 120 });
  push(h, 1, 0, { 3: 87.5 });
  push(h, 1, 196000, { 3: 89.0 });
  expect(h.rate(3)).toBeCloseTo(0.46, 1);
});

test('discards history when the session changes', () => {
  const h = new History({ maxSamples: 120 });
  push(h, 1, 0, { 3: 80 });
  push(h, 1, 10 * MIN, { 3: 90 });
  push(h, 2, 20 * MIN, { 3: 60 });
  expect(h.sampleCount(3)).toBe(1);
  expect(h.rate(3)).toBeNull();
});

test('evicts oldest samples beyond maxSamples', () => {
  const h = new History({ maxSamples: 5 });
  for (let i = 0; i < 10; i++) { push(h, 1, i * MIN, { 3: 80 + i }); }
  expect(h.sampleCount(3)).toBe(5);
});

test('a probe climbing steadily is not stalled', () => {
  const h = new History({ maxSamples: 120 });
  for (let i = 0; i <= 30; i++) { push(h, 1, i * MIN, { 3: 150 + i * 0.5 }); }
  expect(h.isStalled(3, 30 * MIN, 240)).toBe(false);
});

test('flat in the stall band with a hot pit is a stall', () => {
  const h = new History({ maxSamples: 120 });
  for (let i = 0; i <= 30; i++) { push(h, 1, i * MIN, { 3: 159 + (i % 2) * 0.05 }); }
  expect(h.isStalled(3, 30 * MIN, 240)).toBe(true);
});

test('flat below the stall band is not a stall', () => {
  // Cold meat that is not moving is a problem, not a stall.
  const h = new History({ maxSamples: 120 });
  for (let i = 0; i <= 30; i++) { push(h, 1, i * MIN, { 3: 80 }); }
  expect(h.isStalled(3, 30 * MIN, 240)).toBe(false);
});

test('flat with a cold pit is not a stall', () => {
  // The fire went out. Do not reassure the user.
  const h = new History({ maxSamples: 120 });
  for (let i = 0; i <= 30; i++) { push(h, 1, i * MIN, { 3: 159 }); }
  expect(h.isStalled(3, 30 * MIN, 120)).toBe(false);
});

test('needs a sustained window before calling a stall', () => {
  const h = new History({ maxSamples: 120 });
  for (let i = 0; i <= 10; i++) { push(h, 1, i * MIN, { 3: 159 }); }
  expect(h.isStalled(3, 10 * MIN, 240)).toBe(false);
});

// The test the design specifically asked for: replay a real cook rather than a
// synthetic curve. This 11.4-hour pork shoulder contains a verified 82-minute
// stall around 157.7F, starting ~3.0h in, with the pit at 203F.
test('detects the stall in a replayed real 11.4-hour cook', () => {
  const chart = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/chart-11h.json'), 'utf8')
  );
  const food = chart.find((s) => s.label.indexOf('shoulder') !== -1);
  const pit = chart.find((s) => s.label === 'pit');
  const pitAt = (t) => pit.y[
    pit.x.reduce((best, xv, i) =>
      Math.abs(xv - t) < Math.abs(pit.x[best] - t) ? i : best, 0)
  ];

  const h = new History({ maxSamples: 120 });
  let sawStall = false;
  let stallTemp = null;

  for (let i = 0; i < food.x.length; i++) {
    const tMs = food.x[i] * 1000;
    h.push(1, [{ channel: 3, label: 'pork shoulder', temp: food.y[i] }], tMs);
    if (h.isStalled(3, tMs, pitAt(food.x[i]))) {
      sawStall = true;
      if (stallTemp === null) stallTemp = food.y[i];
    }
  }

  expect(sawStall).toBe(true);
  expect(stallTemp).toBeGreaterThanOrEqual(150);
  expect(stallTemp).toBeLessThanOrEqual(170);
});

test('does not call a stall during the early climb of the real cook', () => {
  const chart = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/chart-11h.json'), 'utf8')
  );
  const food = chart.find((s) => s.label.indexOf('shoulder') !== -1);
  const h = new History({ maxSamples: 120 });

  // First 90 minutes: meat is climbing steadily from ~48F. Nothing here is a stall.
  const cutoff = food.x[0] + 90 * 60;
  let flagged = false;
  for (let i = 0; i < food.x.length && food.x[i] <= cutoff; i++) {
    const tMs = food.x[i] * 1000;
    h.push(1, [{ channel: 3, label: 'pork shoulder', temp: food.y[i] }], tMs);
    if (h.isStalled(3, tMs, 240)) flagged = true;
  }
  expect(flagged).toBe(false);
});
```

Add these requires at the top of the test file:

```js
const fs = require('fs');
const path = require('path');
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd pebble && npx jest tests/history.test.js`
Expected: FAIL — module not found (after fixing the paste error above).

- [ ] **Step 3: Implement**

```js
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
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `cd pebble && npx jest tests/history.test.js`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add pebble/src/pkjs/history.js pebble/tests/history.test.js
git commit -m "feat(pkjs): add rolling history with rate of rise and stall detection"
```

---

### Task 7: `alerts.js` — levels, banners, transitions

**Files:**
- Create: `pebble/src/pkjs/alerts.js`
- Test: `pebble/tests/alerts.test.js`

**Interfaces:**
- Consumes: probes from Task 5, `History` from Task 6.
- Produces: constants `LEVEL = {OK:0, INFO:1, WARN:2, CRITICAL:3}`; `evaluateProbe(probe, isPit, stalled) -> {level, flags}` where `flags` has `outOfBand` and `stalled` booleans; `evaluate(state) -> {level, banner, perProbe}`; `shouldVibrate(level, prevLevel, opts) -> bool`.

- [ ] **Step 1: Write the failing test**

```js
const { LEVEL, evaluateProbe, evaluate, shouldVibrate } = require('../src/pkjs/alerts');

const pit = (temp, min, max) => ({
  channel: 4, label: 'pit', temp, min, max, hasAlert: min !== null || max !== null,
});

test('a probe inside its band is OK', () => {
  const r = evaluateProbe(pit(230, 210, 240), true, false);
  expect(r.level).toBe(LEVEL.OK);
  expect(r.flags.outOfBand).toBe(false);
});

test('a probe above its max is WARN', () => {
  const r = evaluateProbe(pit(278, 210, 240), true, false);
  expect(r.level).toBe(LEVEL.WARN);
  expect(r.flags.outOfBand).toBe(true);
});

test('a probe below its min is WARN', () => {
  const r = evaluateProbe(pit(190, 210, 240), true, false);
  expect(r.level).toBe(LEVEL.WARN);
});

test('a food probe reaching its max is CRITICAL, not WARN', () => {
  // Max with no min means a target, not a band: reaching it means done.
  const food = { channel: 3, label: 'butt', temp: 204, min: null, max: 203,
                 hasAlert: true };
  expect(evaluateProbe(food, false, false).level).toBe(LEVEL.CRITICAL);
});

test('a probe with no alert is never WARN', () => {
  const bare = { channel: 4, label: 'pit', temp: 278, min: null, max: null,
                 hasAlert: false };
  expect(evaluateProbe(bare, true, false).level).toBe(LEVEL.OK);
});

test('a stall is INFO and sets its flag', () => {
  const r = evaluateProbe(
    { channel: 3, label: 'butt', temp: 159, min: null, max: 203, hasAlert: true },
    false, true
  );
  expect(r.level).toBe(LEVEL.INFO);
  expect(r.flags.stalled).toBe(true);
});

test('evaluate reports the highest level across probes', () => {
  const out = evaluate({
    probes: [
      { channel: 3, label: 'butt', temp: 92, min: null, max: 203, hasAlert: true },
      pit(278, 210, 240),
    ],
    pitChannel: 4,
    stalledChannels: {},
  });
  expect(out.level).toBe(LEVEL.WARN);
  expect(out.banner).toBe('PIT HIGH 278');
});

test('banner names the stall when that is the highest level', () => {
  const out = evaluate({
    probes: [{ channel: 3, label: 'butt', temp: 159, min: null, max: 203,
               hasAlert: true }],
    pitChannel: 4,
    stalledChannels: { 3: true },
  });
  expect(out.level).toBe(LEVEL.INFO);
  expect(out.banner).toContain('STALLED');
});

test('banner is empty when everything is OK', () => {
  const out = evaluate({
    probes: [{ channel: 3, label: 'butt', temp: 92, min: null, max: 203,
               hasAlert: true }],
    pitChannel: 4,
    stalledChannels: {},
  });
  expect(out.banner).toBe('');
});

// --- vibration ---

const opts = (over) => Object.assign(
  { vibrateEnabled: true, quietHours: null, nowLocalMinutes: 12 * 60 }, over
);

test('vibrates when the level rises', () => {
  expect(shouldVibrate(LEVEL.WARN, LEVEL.OK, opts())).toBe(true);
});

test('does not vibrate while the level is unchanged', () => {
  expect(shouldVibrate(LEVEL.WARN, LEVEL.WARN, opts())).toBe(false);
});

test('does not vibrate when the level falls', () => {
  expect(shouldVibrate(LEVEL.OK, LEVEL.WARN, opts())).toBe(false);
});

test('never vibrates for INFO', () => {
  // A stall is reassurance, not an alarm.
  expect(shouldVibrate(LEVEL.INFO, LEVEL.OK, opts())).toBe(false);
});

test('respects the vibration toggle', () => {
  expect(shouldVibrate(LEVEL.WARN, LEVEL.OK, opts({ vibrateEnabled: false })))
    .toBe(false);
});

test('respects quiet hours spanning midnight', () => {
  const quiet = { startMinutes: 22 * 60, endMinutes: 6 * 60 };
  expect(shouldVibrate(LEVEL.WARN, LEVEL.OK,
    opts({ quietHours: quiet, nowLocalMinutes: 23 * 60 }))).toBe(false);
  expect(shouldVibrate(LEVEL.WARN, LEVEL.OK,
    opts({ quietHours: quiet, nowLocalMinutes: 3 * 60 }))).toBe(false);
  expect(shouldVibrate(LEVEL.WARN, LEVEL.OK,
    opts({ quietHours: quiet, nowLocalMinutes: 12 * 60 }))).toBe(true);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd pebble && npx jest tests/alerts.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
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
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `cd pebble && npx jest tests/alerts.test.js`
Expected: 15 passed.

- [ ] **Step 5: Commit**

```bash
git add pebble/src/pkjs/alerts.js pebble/tests/alerts.test.js
git commit -m "feat(pkjs): add alert evaluation with transition-only vibration"
```

---

### Task 8: `transform.js` — build the AppMessage frame

**Files:**
- Create: `pebble/src/pkjs/transform.js`
- Test: `pebble/tests/transform.test.js`

**Interfaces:**
- Consumes: normalised state (Task 5), `History` (Task 6), alert result (Task 7).
- Produces: `FLAG = {IS_PIT:1, HAS_ALERT:2, OUT_OF_BAND:4, STALLED:8}`; `STATE = {COOKING:1, SHOW_ALERT_VISUALS:2, STALE:4}`; `buildFrame(input) -> object`; `estimateFrameBytes(frame) -> int`.

- [ ] **Step 1: Write the failing test**

```js
const { buildFrame, estimateFrameBytes, FLAG, STATE } =
  require('../src/pkjs/transform');

const base = {
  probes: [
    { channel: 4, label: 'pit', temp: 278.9, min: 210, max: 240, hasAlert: true },
    { channel: 3, label: 'boneless butt', temp: 84.4, min: null, max: null,
      hasAlert: false },
  ],
  pitChannel: 4,
  rates: { 4: 1.2, 3: 0.5 },
  perProbe: {
    4: { flags: { outOfBand: true, stalled: false } },
    3: { flags: { outOfBand: false, stalled: false } },
  },
  alertLevel: 2,
  banner: 'PIT HIGH 279',
  elapsedSec: 15120,
  stalenessSec: 12,
  batteryPct: 78,
  sessionId: 11569055,
  degreetype: 2,
  layout: 0,
  cooking: true,
  showAlertVisuals: true,
  stale: false,
};

test('sends the pit first regardless of channel order', () => {
  const f = buildFrame(base);
  expect(f.P_LABEL0).toBe('pit');
  expect(f.P_LABEL1).toBe('boneless butt');
});

test('encodes temperatures as tenths', () => {
  const f = buildFrame(base);
  expect(f.P_TEMP0).toBe(2789);
  expect(f.P_TEMP1).toBe(844);
});

test('encodes rates as tenths', () => {
  const f = buildFrame(base);
  expect(f.P_RATE0).toBe(12);
  expect(f.P_RATE1).toBe(5);
});

test('sets per-probe flags', () => {
  const f = buildFrame(base);
  expect(f.P_FLAGS0 & FLAG.IS_PIT).toBeTruthy();
  expect(f.P_FLAGS0 & FLAG.HAS_ALERT).toBeTruthy();
  expect(f.P_FLAGS0 & FLAG.OUT_OF_BAND).toBeTruthy();
  expect(f.P_FLAGS1 & FLAG.IS_PIT).toBeFalsy();
  expect(f.P_FLAGS1 & FLAG.HAS_ALERT).toBeFalsy();
});

test('sends zero bounds when a probe has no alert', () => {
  const f = buildFrame(base);
  expect(f.P_MIN1).toBe(0);
  expect(f.P_MAX1).toBe(0);
});

test('sets state flags', () => {
  const f = buildFrame(base);
  expect(f.STATE_FLAGS & STATE.COOKING).toBeTruthy();
  expect(f.STATE_FLAGS & STATE.SHOW_ALERT_VISUALS).toBeTruthy();
  expect(f.STATE_FLAGS & STATE.STALE).toBeFalsy();
});

test('idle frame reports no probes and is not cooking', () => {
  const f = buildFrame(Object.assign({}, base, { probes: [], cooking: false }));
  expect(f.N_PROBES).toBe(0);
  expect(f.STATE_FLAGS & STATE.COOKING).toBeFalsy();
});

test('caps at four probes', () => {
  const many = [];
  for (let i = 1; i <= 6; i++) {
    many.push({ channel: i, label: 'p' + i, temp: 100, min: null, max: null,
                hasAlert: false });
  }
  const f = buildFrame(Object.assign({}, base, {
    probes: many, pitChannel: 1, rates: {}, perProbe: {},
  }));
  expect(f.N_PROBES).toBe(4);
  expect(f.P_LABEL3).toBeDefined();
  expect(f.P_LABEL4).toBeUndefined();
});

test('truncates long labels', () => {
  const f = buildFrame(Object.assign({}, base, {
    probes: [{ channel: 4, label: 'an extremely long probe label here',
               temp: 100, min: null, max: null, hasAlert: false }],
    pitChannel: 4, rates: {}, perProbe: {},
  }));
  expect(f.P_LABEL0.length).toBeLessThanOrEqual(16);
});

test('worst-case frame fits the 1024-byte inbox', () => {
  const many = [];
  for (let i = 1; i <= 4; i++) {
    many.push({ channel: i, label: 'sixteen chars ok', temp: 999.9,
                min: 100, max: 200, hasAlert: true });
  }
  const f = buildFrame(Object.assign({}, base, {
    probes: many, pitChannel: 1,
    banner: 'X'.repeat(63),
  }));
  const bytes = estimateFrameBytes(f);
  expect(bytes).toBeLessThan(1024);
});

test('handles a missing rate as zero', () => {
  const f = buildFrame(Object.assign({}, base, { rates: {} }));
  expect(f.P_RATE0).toBe(0);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd pebble && npx jest tests/transform.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// ES5 only.
var MAX_PROBES = 4;
var MAX_LABEL = 16;
var MAX_BANNER = 64;

var FLAG = { IS_PIT: 1, HAS_ALERT: 2, OUT_OF_BAND: 4, STALLED: 8 };
var STATE = { COOKING: 1, SHOW_ALERT_VISUALS: 2, STALE: 4 };

function tenths(v) {
  if (v === null || v === undefined) return 0;
  return Math.round(v * 10);
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
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `cd pebble && npx jest tests/transform.test.js`
Expected: 11 passed. The frame-size test should report well under 1024.

- [ ] **Step 5: Commit**

```bash
git add pebble/src/pkjs/transform.js pebble/tests/transform.test.js
git commit -m "feat(pkjs): build AppMessage frame with size guarantee"
```

---

### Task 9: `config.js` and the config page

**Files:**
- Create: `pebble/src/pkjs/config.js`
- Create: `config/index.html`
- Test: `pebble/tests/config.test.js`

**Interfaces:**
- Produces: `defaultSettings() -> object`; `buildConfigUrl(baseUrl, settings) -> string`;
  `parseConfigResponse(json, previous?) -> settings`. When `previous` is supplied the result
  is merged onto it, so a key absent from the response keeps its prior value. This is what
  stops a settings-only save from wiping the token: the page cannot know the token (it never
  travels in the URL), so it omits the key rather than sending an empty string. An explicit
  sign-out is `signOut: true`.

Settings shape: `{token, layout, pitOverride, units, showAlertVisuals, vibrateEnabled, quietStart, quietEnd, pollSec}`. `pitOverride` is `null` for auto. `quietStart`/`quietEnd` are minutes past midnight or `null`.

- [ ] **Step 1: Write the failing test**

```js
const { defaultSettings, buildConfigUrl, parseConfigResponse } =
  require('../src/pkjs/config');

test('defaults are safe for a fresh install', () => {
  const d = defaultSettings();
  expect(d.token).toBe('');
  expect(d.layout).toBe(0);
  expect(d.pitOverride).toBeNull();
  expect(d.pollSec).toBe(30);
  expect(d.vibrateEnabled).toBe(true);
  expect(d.showAlertVisuals).toBe(true);
});

test('config url carries current settings', () => {
  const url = buildConfigUrl('https://example.com/config/', defaultSettings());
  expect(url).toContain('https://example.com/config/');
  expect(url).toContain('pollSec=30');
});

test('config url never carries a password field', () => {
  const url = buildConfigUrl('https://example.com/config/',
    Object.assign(defaultSettings(), { token: 'secret-token' }));
  expect(url).not.toContain('password');
});

test('parses a full response', () => {
  const s = parseConfigResponse(JSON.stringify({
    token: 'abc', layout: 1, pitOverride: 4, units: 'F',
    showAlertVisuals: false, vibrateEnabled: false,
    quietStart: 1320, quietEnd: 360, pollSec: 60,
  }));
  expect(s.token).toBe('abc');
  expect(s.layout).toBe(1);
  expect(s.pitOverride).toBe(4);
  expect(s.vibrateEnabled).toBe(false);
  expect(s.quietStart).toBe(1320);
});

test('clamps the poll interval to the 20 second floor', () => {
  // 20s is 15 calls per 5 min against a ceiling of 17 shared with the phone app.
  const s = parseConfigResponse(JSON.stringify({ pollSec: 5 }));
  expect(s.pollSec).toBe(20);
});

test('caps the poll interval at five minutes', () => {
  const s = parseConfigResponse(JSON.stringify({ pollSec: 9999 }));
  expect(s.pollSec).toBe(300);
});

test('treats a malformed response as defaults', () => {
  const s = parseConfigResponse('not json');
  expect(s.pollSec).toBe(30);
  expect(s.token).toBe('');
});

test('auto pit override round-trips as null', () => {
  const s = parseConfigResponse(JSON.stringify({ pitOverride: '' }));
  expect(s.pitOverride).toBeNull();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd pebble && npx jest tests/config.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `config.js`**

```js
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
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `cd pebble && npx jest tests/config.test.js`
Expected: 8 passed.

- [ ] **Step 5: Write the config page**

Create `config/index.html`. It exchanges credentials for a token in the browser so the password never reaches storage, then hands back only the token.

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FireBoard Watchface</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0;
         padding: 16px; background: #f4f4f6; color: #111; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em;
       color: #666; margin: 22px 0 8px; }
  .card { background: #fff; border-radius: 10px; padding: 14px; margin-bottom: 10px; }
  label { display: block; margin: 10px 0 4px; font-size: 14px; }
  input[type=text], input[type=password], input[type=time], select {
    width: 100%; padding: 10px; font-size: 16px; border: 1px solid #ccd;
    border-radius: 7px; box-sizing: border-box; background: #fff; }
  .row { display: flex; align-items: center; gap: 10px; margin: 12px 0; }
  .row input { width: auto; }
  button { width: 100%; padding: 14px; font-size: 16px; font-weight: 600;
           border: 0; border-radius: 9px; background: #d9480f; color: #fff; }
  button.secondary { background: #495057; }
  .status { font-size: 14px; margin-top: 9px; min-height: 19px; }
  .ok { color: #2b8a3e; } .err { color: #c92a2a; }
  .hint { font-size: 12px; color: #777; margin-top: 5px; line-height: 1.45; }
</style>
</head>
<body>

<h2>Account</h2>
<div class="card">
  <div id="signed-out">
    <label>FireBoard email</label>
    <input type="text" id="email" autocomplete="username">
    <label>Password</label>
    <input type="password" id="password" autocomplete="current-password">
    <div style="height:12px"></div>
    <button id="signin">Sign in</button>
    <div class="status" id="auth-status"></div>
    <div class="hint">Your password is used once to fetch an access token and is
      never stored on the watch or the phone.</div>
  </div>
  <div id="signed-in" style="display:none">
    <div class="status ok">Signed in.</div>
    <div style="height:10px"></div>
    <button class="secondary" id="signout">Sign out</button>
  </div>
</div>

<h2>Display</h2>
<div class="card">
  <label>Layout</label>
  <select id="layout">
    <option value="0">Ledger</option>
    <option value="1">Hero pit</option>
    <option value="2">Progress bars</option>
  </select>
  <div class="hint">Hero and Progress arrive in a later release; both currently
    render as Ledger.</div>

  <label>Pit probe</label>
  <select id="pitOverride"><option value="">Auto-detect</option></select>
  <div class="hint">Auto matches labels containing pit, grill, smoker or chamber.</div>

  <label>Units</label>
  <select id="units">
    <option value="auto">Follow FireBoard</option>
    <option value="F">Always &deg;F</option>
    <option value="C">Always &deg;C</option>
  </select>
</div>

<h2>Alerts</h2>
<div class="card">
  <div class="row"><input type="checkbox" id="showAlertVisuals" checked>
    <span>Show alert state on the watchface</span></div>
  <div class="row"><input type="checkbox" id="vibrateEnabled" checked>
    <span>Vibrate when alerts fire</span></div>
  <div class="row"><input type="checkbox" id="quietEnabled">
    <span>Quiet hours</span></div>
  <div id="quiet-times" style="display:none">
    <label>From</label><input type="time" id="quietStart" value="22:00">
    <label>To</label><input type="time" id="quietEnd" value="06:00">
  </div>
  <div class="hint">Thresholds come from the alerts you already set in the
    FireBoard app. Probes with no alert are flagged on the watchface.</div>
</div>

<h2>Advanced</h2>
<div class="card">
  <label>Poll interval</label>
  <select id="pollSec">
    <option value="20">20 seconds</option>
    <option value="30" selected>30 seconds</option>
    <option value="60">60 seconds</option>
    <option value="120">2 minutes</option>
  </select>
  <div class="hint">FireBoard allows about 17 requests every 5 minutes
    <em>per account</em>, shared with the FireBoard phone app. 20 seconds leaves
    little headroom; 30 is recommended.</div>
</div>

<div style="height:8px"></div>
<button id="save">Save</button>
<div style="height:24px"></div>

<script>
function qs(name) {
  var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
  return m ? decodeURIComponent(m[1]) : null;
}
function minutesToTime(m) {
  if (m === null || m === '') return null;
  var h = Math.floor(m / 60), mm = m % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
}
function timeToMinutes(v) {
  if (!v) return null;
  var parts = v.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

var token = '';

// Restore from query string
(function restore() {
  if (qs('layout')) document.getElementById('layout').value = qs('layout');
  if (qs('units')) document.getElementById('units').value = qs('units');
  if (qs('pollSec')) document.getElementById('pollSec').value = qs('pollSec');
  document.getElementById('showAlertVisuals').checked = qs('showAlertVisuals') !== '0';
  document.getElementById('vibrateEnabled').checked = qs('vibrateEnabled') !== '0';
  var qStart = qs('quietStart'), qEnd = qs('quietEnd');
  if (qStart) {
    document.getElementById('quietEnabled').checked = true;
    document.getElementById('quiet-times').style.display = 'block';
    document.getElementById('quietStart').value = minutesToTime(parseInt(qStart, 10));
    if (qEnd) document.getElementById('quietEnd').value = minutesToTime(parseInt(qEnd, 10));
  }
  if (qs('hasToken') === '1') {
    document.getElementById('signed-out').style.display = 'none';
    document.getElementById('signed-in').style.display = 'block';
  }
})();

document.getElementById('quietEnabled').addEventListener('change', function () {
  document.getElementById('quiet-times').style.display = this.checked ? 'block' : 'none';
});

document.getElementById('signout').addEventListener('click', function () {
  token = '';
  document.getElementById('signed-in').style.display = 'none';
  document.getElementById('signed-out').style.display = 'block';
});

document.getElementById('signin').addEventListener('click', function () {
  var status = document.getElementById('auth-status');
  status.className = 'status';
  status.textContent = 'Signing in...';
  var xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://fireboard.io/api/rest-auth/login/');
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onload = function () {
    var ct = (xhr.getResponseHeader('Content-Type') || '').toLowerCase();
    if (ct.indexOf('text/html') !== -1) {
      // WAF captcha or edge block — not a credentials problem.
      status.className = 'status err';
      status.textContent = 'FireBoard is temporarily blocking sign-in. Wait a few minutes and try again.';
      return;
    }
    try {
      var body = JSON.parse(xhr.responseText);
      if (body.key) {
        token = body.key;
        document.getElementById('password').value = '';
        document.getElementById('signed-out').style.display = 'none';
        document.getElementById('signed-in').style.display = 'block';
      } else {
        status.className = 'status err';
        status.textContent = 'Sign-in failed. Check your email and password.';
      }
    } catch (e) {
      status.className = 'status err';
      status.textContent = 'Unexpected response from FireBoard.';
    }
  };
  xhr.onerror = function () {
    status.className = 'status err';
    status.textContent = 'Network error.';
  };
  xhr.send(JSON.stringify({
    username: document.getElementById('email').value,
    password: document.getElementById('password').value
  }));
});

document.getElementById('save').addEventListener('click', function () {
  var quietOn = document.getElementById('quietEnabled').checked;
  var out = {
    token: token,
    layout: parseInt(document.getElementById('layout').value, 10),
    pitOverride: document.getElementById('pitOverride').value,
    units: document.getElementById('units').value,
    showAlertVisuals: document.getElementById('showAlertVisuals').checked,
    vibrateEnabled: document.getElementById('vibrateEnabled').checked,
    quietStart: quietOn ? timeToMinutes(document.getElementById('quietStart').value) : null,
    quietEnd: quietOn ? timeToMinutes(document.getElementById('quietEnd').value) : null,
    pollSec: parseInt(document.getElementById('pollSec').value, 10)
  };
  document.location = 'pebblejs://close#' + encodeURIComponent(JSON.stringify(out));
});
</script>
</body>
</html>
```

> The page must be served over HTTPS for the phone to load it. Host it on GitHub Pages from this repo, or any static host. Record the final URL — Task 10 needs it.

- [ ] **Step 6: Commit**

```bash
git add pebble/src/pkjs/config.js pebble/tests/config.test.js config/index.html
git commit -m "feat(config): add settings module and config webview"
```

---

### Task 10: `index.js` — wire it together

**Files:**
- Modify: `pebble/src/pkjs/index.js` (replaces the Task 1 spike entirely)

**Interfaces:**
- Consumes: every pkjs module from Tasks 3–9.
- Produces: the running application. No exports.

- [ ] **Step 1: Replace the spike**

Set `CONFIG_URL` to the HTTPS URL where you hosted `config/index.html` in Task 9.

```js
// ES5 only. The only file that touches Pebble globals.
var Budget = require('./budget').Budget;
var fireboard = require('./fireboard');
var model = require('./model');
var History = require('./history').History;
var alertsMod = require('./alerts');
var transform = require('./transform');
var configMod = require('./config');

var CONFIG_URL = 'https://REPLACE-ME.example.com/config/';
var SETTINGS_KEY = 'fb.settings';
var USER_AGENT = 'pebble-fireboard/0.1';
var STALE_AFTER_SEC = 120;
var MAX_BACKOFF_MS = 600000;

var state = {
  settings: null,
  client: null,
  budget: null,
  history: new History({ maxSamples: 120 }),
  timer: null,
  prevLevel: 0,
  failures: 0,
};

function now() { return Date.now(); }

function loadSettings() {
  try {
    var raw = localStorage.getItem(SETTINGS_KEY);
    if (raw == null) return configMod.defaultSettings();
    return configMod.parseConfigResponse(raw);
  } catch (e) {
    return configMod.defaultSettings();
  }
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}

function toF(v, degreetype) {
  // degreetype 1 = Celsius, 2 = Fahrenheit. Stall thresholds are Fahrenheit.
  if (degreetype === 1) return (v * 9 / 5) + 32;
  return v;
}

function send(frame) {
  Pebble.sendAppMessage(frame, function () {}, function (e) {
    console.log('send failed: ' + JSON.stringify(e));
  });
}

function sendStatus(bannerText, cooking) {
  send(transform.buildFrame({
    probes: [], pitChannel: null, rates: {}, perProbe: {},
    alertLevel: 0, banner: bannerText, elapsedSec: 0, stalenessSec: 0,
    batteryPct: 0, sessionId: 0, degreetype: 2,
    layout: state.settings ? state.settings.layout : 0,
    cooking: !!cooking, showAlertVisuals: true, stale: true,
  }));
}

function bannerForError(kind) {
  if (kind === 'bad_token') return 'SIGN IN AGAIN';
  if (kind === 'no_user_agent') return 'APP ERROR';
  if (kind === 'waf') return 'TRY AGAIN LATER';
  if (kind === 'rate_limited') return 'PAUSED';
  if (kind === 'network') return 'NO SIGNAL';
  return 'RETRYING';
}

function backoffMs() {
  if (state.failures === 0) return 0;
  var ms = 2000 * Math.pow(2, state.failures - 1);
  return ms > MAX_BACKOFF_MS ? MAX_BACKOFF_MS : ms;
}

function poll() {
  if (!state.client) { sendStatus('SIGN IN', false); return; }
  if (!state.budget.allow()) { sendStatus('PAUSED', false); return; }

  state.budget.record();
  state.client.getDevices(function (err, devices) {
    if (err) {
      state.failures += 1;
      // A dead token is terminal; everything else is worth retrying.
      if (err.kind === 'bad_token') { stopTimer(); }
      sendStatus(bannerForError(err.kind), false);
      return;
    }
    state.failures = 0;

    var norm = model.normalise(devices, { pitOverride: state.settings.pitOverride });
    var t = now();

    if (norm.probes.length === 0) {
      send(transform.buildFrame({
        probes: [], pitChannel: null, rates: {}, perProbe: {},
        alertLevel: 0, banner: '', elapsedSec: 0, stalenessSec: 0,
        batteryPct: norm.batteryPct, sessionId: norm.sessionId || 0,
        degreetype: norm.degreetype, layout: state.settings.layout,
        cooking: false, showAlertVisuals: state.settings.showAlertVisuals,
        stale: false,
      }));
      return;
    }

    state.history.push(norm.sessionId, norm.probes, t);

    var pitTempF = null;
    var i;
    for (i = 0; i < norm.probes.length; i++) {
      if (norm.probes[i].channel === norm.pitChannel) {
        pitTempF = toF(norm.probes[i].temp, norm.degreetype);
      }
    }

    var rates = {};
    var stalledChannels = {};
    for (i = 0; i < norm.probes.length; i++) {
      var ch = norm.probes[i].channel;
      rates[ch] = state.history.rate(ch);
      if (ch !== norm.pitChannel) {
        stalledChannels[ch] = state.history.isStalled(ch, t, pitTempF);
      }
    }

    var evaluated = alertsMod.evaluate({
      probes: norm.probes,
      pitChannel: norm.pitChannel,
      stalledChannels: stalledChannels,
    });

    var stalenessSec = norm.lastTemplogMs
      ? Math.floor((t - norm.lastTemplogMs) / 1000) : 0;
    var elapsedSec = norm.startedMs ? Math.floor((t - norm.startedMs) / 1000) : 0;

    send(transform.buildFrame({
      probes: norm.probes,
      pitChannel: norm.pitChannel,
      rates: rates,
      perProbe: evaluated.perProbe,
      alertLevel: evaluated.level,
      banner: evaluated.banner,
      elapsedSec: elapsedSec,
      stalenessSec: stalenessSec,
      batteryPct: norm.batteryPct,
      sessionId: norm.sessionId || 0,
      degreetype: norm.degreetype,
      layout: state.settings.layout,
      cooking: true,
      showAlertVisuals: state.settings.showAlertVisuals,
      stale: stalenessSec > STALE_AFTER_SEC,
    }));

    var d = new Date();
    var vibrate = alertsMod.shouldVibrate(evaluated.level, state.prevLevel, {
      vibrateEnabled: state.settings.vibrateEnabled,
      quietHours: state.settings.quietStart === null ? null : {
        startMinutes: state.settings.quietStart,
        endMinutes: state.settings.quietEnd,
      },
      nowLocalMinutes: d.getHours() * 60 + d.getMinutes(),
    });
    // The watch owns the buzz: it already has ALERT_LEVEL and vibrates on a
    // rising edge. This flag exists so quiet hours are honoured phone-side.
    if (!vibrate && evaluated.level > state.prevLevel) {
      send({ ALERT_LEVEL: 0 });
    }
    state.prevLevel = evaluated.level;
  });
}

function stopTimer() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

function restartTimer() {
  stopTimer();
  var ms = (state.settings.pollSec || 30) * 1000;
  var delay = backoffMs();
  state.timer = setInterval(poll, ms);
  if (delay === 0) poll();
}

function rebuild() {
  state.budget = new Budget({
    now: now, storage: localStorage, limit: 17, windowMs: 300000,
  });
  if (!state.settings.token) { state.client = null; return; }
  state.client = new fireboard.Client({
    token: state.settings.token,
    xhrFactory: XMLHttpRequest,
    userAgent: USER_AGENT,
  });
}

Pebble.addEventListener('ready', function () {
  state.settings = loadSettings();
  rebuild();
  restartTimer();
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(configMod.buildConfigUrl(CONFIG_URL, state.settings));
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  // Pass the CURRENT settings as the merge base. The config page deliberately
  // never receives the token (it must not travel in a URL), so it omits the
  // token key entirely when the user did not re-authenticate. Parsing against
  // defaults instead of current settings would read that absence as an empty
  // token and silently sign the user out on every settings save.
  // An explicit sign-out arrives as `signOut: true`, not as an empty token.
  var updated = configMod.parseConfigResponse(decodeURIComponent(e.response),
                                              state.settings);
  state.settings = updated;
  saveSettings(updated);
  state.history.reset();
  state.prevLevel = 0;
  state.failures = 0;
  rebuild();
  restartTimer();
});
```

- [ ] **Step 2: Run the whole pkjs suite**

Run: `cd pebble && npx jest`
Expected: all suites pass (budget, fireboard, model, history, alerts, transform, config).

- [ ] **Step 3: Verify it builds**

```bash
cd pebble && pebble build
```

Expected: build succeeds for all seven platforms.

- [ ] **Step 4: Commit**

```bash
git add pebble/src/pkjs/index.js
git commit -m "feat(pkjs): wire poll loop, backoff, config and alert plumbing"
```

---

### Task 11: Watch C — model and message keys

**Files:**
- Create: `pebble/src/c/appmsg_keys.h`
- Create: `pebble/src/c/model.h`
- Create: `pebble/src/c/model.c`

**Interfaces:**
- Produces: `CookModel` struct and `void model_init(CookModel*)`, `void model_apply_dict(CookModel*, DictionaryIterator*)`.

- [ ] **Step 1: Write `appmsg_keys.h`**

```c
#pragma once
#include <pebble.h>

// Pebble generates MESSAGE_KEY_<NAME> as `extern uint32_t` VARIABLES, not
// #defines. They cannot appear in switch/case labels or static initialisers.
// Array keys ("P_TEMP[4]") produce a single base symbol; index it as
// MESSAGE_KEY_P_TEMP + i.

#define FB_MAX_PROBES   4
#define FB_LABEL_MAX    17   // 16 chars + NUL
#define FB_BANNER_MAX   65   // 64 chars + NUL

// P_FLAGS bits
#define FB_FLAG_IS_PIT       (1 << 0)
#define FB_FLAG_HAS_ALERT    (1 << 1)
#define FB_FLAG_OUT_OF_BAND  (1 << 2)
#define FB_FLAG_STALLED      (1 << 3)

// STATE_FLAGS bits
#define FB_STATE_COOKING      (1 << 0)
#define FB_STATE_SHOW_ALERTS  (1 << 1)
#define FB_STATE_STALE        (1 << 2)
// The phone owns vibration POLICY (quiet hours, user toggle); the watch owns the
// buzz. Vibrate on a rising ALERT_LEVEL only when this bit is set. Never send a
// second AppMessage to suppress a buzz -- it arrives after the watch has already
// buzzed, and back-to-back sends risk APP_MSG_BUSY.
#define FB_STATE_MAY_VIBRATE  (1 << 3)

// ALERT_LEVEL values
#define FB_LEVEL_OK        0
#define FB_LEVEL_INFO      1
#define FB_LEVEL_WARN      2
#define FB_LEVEL_CRITICAL  3

// LAYOUT values
#define FB_LAYOUT_LEDGER    0
#define FB_LAYOUT_HERO      1
#define FB_LAYOUT_PROGRESS  2
```

- [ ] **Step 2: Write `model.h`**

```c
#pragma once
#include <pebble.h>
#include "appmsg_keys.h"

typedef struct {
  char    label[FB_LABEL_MAX];
  int16_t temp_tenths;
  int16_t min_tenths;
  int16_t max_tenths;
  int16_t rate_tenths;
  uint8_t flags;
} ProbeView;

typedef struct {
  ProbeView probes[FB_MAX_PROBES];
  uint8_t   n_probes;
  uint32_t  elapsed_sec;
  uint16_t  staleness_sec;
  uint8_t   fb_battery;
  uint32_t  session_id;
  uint8_t   alert_level;
  uint8_t   layout;
  uint8_t   degreetype;
  uint8_t   state_flags;
  char      banner[FB_BANNER_MAX];
  bool      has_data;
} CookModel;

void model_init(CookModel *m);
void model_apply_dict(CookModel *m, DictionaryIterator *iter);

static inline bool model_is_cooking(const CookModel *m) {
  return (m->state_flags & FB_STATE_COOKING) != 0;
}
static inline bool model_is_stale(const CookModel *m) {
  return (m->state_flags & FB_STATE_STALE) != 0;
}
static inline bool model_show_alerts(const CookModel *m) {
  return (m->state_flags & FB_STATE_SHOW_ALERTS) != 0;
}
static inline bool model_may_vibrate(const CookModel *m) {
  return (m->state_flags & FB_STATE_MAY_VIBRATE) != 0;
}
```

- [ ] **Step 3: Write `model.c`**

```c
#include "model.h"
#include <string.h>

static void copy_string(char *dst, size_t cap, const char *src) {
  if (!src) { dst[0] = '\0'; return; }
  size_t n = strlen(src);
  if (n >= cap) n = cap - 1;
  memcpy(dst, src, n);
  dst[n] = '\0';
}

void model_init(CookModel *m) {
  memset(m, 0, sizeof(*m));
  m->degreetype = 2;
  m->layout = FB_LAYOUT_LEDGER;
  m->has_data = false;
}

void model_apply_dict(CookModel *m, DictionaryIterator *iter) {
  Tuple *t;

  // IMPORTANT: PebbleKit JS serialises every plain number as a 32-bit integer.
  // Reading `t->value->int16` on a tuple that was written as int32 returns
  // garbage. Always read int32/uint32 here and narrow in C.
  if ((t = dict_find(iter, MESSAGE_KEY_N_PROBES))) {
    int32_t n = t->value->int32;
    m->n_probes = (n < 0) ? 0 : (n > FB_MAX_PROBES ? FB_MAX_PROBES : (uint8_t)n);
  }

  // Array keys share a base symbol; walk it with an offset. A switch is not
  // possible here because the keys are variables, not constants.
  for (uint8_t i = 0; i < FB_MAX_PROBES; i++) {
    ProbeView *p = &m->probes[i];
    if ((t = dict_find(iter, MESSAGE_KEY_P_LABEL + i))) {
      copy_string(p->label, FB_LABEL_MAX, t->value->cstring);
    }
    if ((t = dict_find(iter, MESSAGE_KEY_P_TEMP + i)))  p->temp_tenths = (int16_t)t->value->int32;
    if ((t = dict_find(iter, MESSAGE_KEY_P_MIN + i)))   p->min_tenths  = (int16_t)t->value->int32;
    if ((t = dict_find(iter, MESSAGE_KEY_P_MAX + i)))   p->max_tenths  = (int16_t)t->value->int32;
    if ((t = dict_find(iter, MESSAGE_KEY_P_RATE + i)))  p->rate_tenths = (int16_t)t->value->int32;
    if ((t = dict_find(iter, MESSAGE_KEY_P_FLAGS + i))) p->flags       = (uint8_t)t->value->int32;
  }

  if ((t = dict_find(iter, MESSAGE_KEY_ELAPSED_SEC)))   m->elapsed_sec   = (uint32_t)t->value->int32;
  if ((t = dict_find(iter, MESSAGE_KEY_STALENESS_SEC))) m->staleness_sec = (uint16_t)t->value->int32;
  if ((t = dict_find(iter, MESSAGE_KEY_FB_BATTERY)))    m->fb_battery    = (uint8_t)t->value->int32;
  if ((t = dict_find(iter, MESSAGE_KEY_SESSION_ID)))    m->session_id    = (uint32_t)t->value->int32;
  if ((t = dict_find(iter, MESSAGE_KEY_ALERT_LEVEL)))   m->alert_level   = (uint8_t)t->value->int32;
  if ((t = dict_find(iter, MESSAGE_KEY_LAYOUT)))        m->layout        = (uint8_t)t->value->int32;
  if ((t = dict_find(iter, MESSAGE_KEY_DEGREETYPE)))    m->degreetype    = (uint8_t)t->value->int32;
  if ((t = dict_find(iter, MESSAGE_KEY_STATE_FLAGS)))   m->state_flags   = (uint8_t)t->value->int32;
  if ((t = dict_find(iter, MESSAGE_KEY_BANNER))) {
    copy_string(m->banner, FB_BANNER_MAX, t->value->cstring);
  }

  m->has_data = true;
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd pebble && pebble build
```

Expected: build succeeds. (`fireboard.c` still contains the generated template at this point; that is fine.)

- [ ] **Step 5: Commit**

```bash
git add pebble/src/c/appmsg_keys.h pebble/src/c/model.h pebble/src/c/model.c
git commit -m "feat(watch): add cook model and AppMessage dictionary parsing"
```

---

### Task 12: Watch C — shared widgets

Every awkward case lives here so the later layouts inherit the fixes rather than repeating them.

**Files:**
- Create: `pebble/src/c/widgets.h`
- Create: `pebble/src/c/widgets.c`

**Interfaces:**
- Consumes: `CookModel`, `ProbeView` from Task 11.
- Produces: `widget_draw_clock`, `widget_draw_rule`, `widget_draw_probe_row`, `widget_draw_band`, `widget_draw_banner`, `widget_draw_footer`, `widget_pct_of`.

- [ ] **Step 1: Write `widgets.h`**

```c
#pragma once
#include <pebble.h>
#include "model.h"

int  widget_pct_of(int total, int pct);

void widget_draw_clock(GContext *ctx, GRect area, bool large);
void widget_draw_rule(GContext *ctx, GRect bounds, int y);
void widget_draw_probe_row(GContext *ctx, GRect area, const ProbeView *p,
                           bool show_alerts, bool stale);
void widget_draw_band(GContext *ctx, GRect area, const ProbeView *p, bool stale);
void widget_draw_banner(GContext *ctx, GRect area, const char *text, bool invert);
void widget_draw_footer(GContext *ctx, GRect area, uint32_t elapsed_sec,
                        uint16_t staleness_sec, bool stale);
```

- [ ] **Step 2: Write `widgets.c`**

```c
#include "widgets.h"
#include <string.h>

int widget_pct_of(int total, int pct) { return (total * pct) / 100; }

static void format_temp(char *buf, size_t cap, int16_t tenths, bool parens) {
  int whole = tenths / 10;
  if (parens) {
    snprintf(buf, cap, "(%d)", whole);
  } else {
    snprintf(buf, cap, "%d", whole);
  }
}

// flint/aplite/diorite are 1-bit. Grey must be dithered. Used only for the
// stale band fill — never behind text, where a checkerboard destroys
// legibility at 144x168.
static void fill_dithered(GContext *ctx, GRect r) {
  graphics_context_set_stroke_color(ctx, GColorWhite);
  for (int y = r.origin.y; y < r.origin.y + r.size.h; y++) {
    for (int x = r.origin.x; x < r.origin.x + r.size.w; x++) {
      if (((x + y) & 1) == 0) {
        graphics_draw_pixel(ctx, GPoint(x, y));
      }
    }
  }
}

void widget_draw_clock(GContext *ctx, GRect area, bool large) {
  static char s_time[8];
  static char s_date[24];
  time_t now = time(NULL);
  struct tm *tm = localtime(&now);

  strftime(s_time, sizeof(s_time), clock_is_24h_style() ? "%H:%M" : "%l:%M", tm);
  char *t = s_time;
  while (*t == ' ') t++;             // strip %l's leading space
  strftime(s_date, sizeof(s_date), "%a %b %e", tm);

  graphics_context_set_text_color(ctx, GColorWhite);
  const char *time_font = large ? FONT_KEY_BITHAM_42_LIGHT : FONT_KEY_BITHAM_30_BLACK;
  int time_h = large ? 44 : 32;

  graphics_draw_text(ctx, t, fonts_get_system_font(time_font),
                     GRect(area.origin.x, area.origin.y, area.size.w, time_h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  graphics_draw_text(ctx, s_date, fonts_get_system_font(FONT_KEY_GOTHIC_18),
                     GRect(area.origin.x, area.origin.y + time_h, area.size.w, 20),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

void widget_draw_rule(GContext *ctx, GRect bounds, int y) {
  graphics_context_set_stroke_color(ctx, GColorWhite);
  graphics_draw_line(ctx, GPoint(bounds.origin.x + 4, y),
                     GPoint(bounds.origin.x + bounds.size.w - 5, y));
}

void widget_draw_probe_row(GContext *ctx, GRect area, const ProbeView *p,
                           bool show_alerts, bool stale) {
  bool alarm = show_alerts && (p->flags & FB_FLAG_OUT_OF_BAND);

  // Inversion is the alert language on 1-bit. It reads harder than any colour
  // and degrades to itself on every platform.
  if (alarm) {
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_rect(ctx, area, 0, GCornerNone);
    graphics_context_set_text_color(ctx, GColorBlack);
  } else {
    graphics_context_set_text_color(ctx, GColorWhite);
  }

  static char label[FB_LABEL_MAX];
  strncpy(label, p->label, FB_LABEL_MAX - 1);
  label[FB_LABEL_MAX - 1] = '\0';
  for (int i = 0; label[i]; i++) {
    if (label[i] >= 'a' && label[i] <= 'z') label[i] -= 32;
  }

  graphics_draw_text(ctx, label, fonts_get_system_font(FONT_KEY_GOTHIC_18),
                     GRect(area.origin.x + 3, area.origin.y - 2,
                           area.size.w / 2, area.size.h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

  static char value[16];
  format_temp(value, sizeof(value), p->temp_tenths, stale);

  // Rate is shown only for probes with no band to draw, and never when stale:
  // a stale reading must not look like it is still moving.
  bool show_rate = !stale && !(p->flags & FB_FLAG_HAS_ALERT);
  if (show_rate) {
    static char combined[28];
    int r = p->rate_tenths;
    snprintf(combined, sizeof(combined), "%s  %s%d.%d", value,
             r < 0 ? "-" : "+", (r < 0 ? -r : r) / 10, (r < 0 ? -r : r) % 10);
    graphics_draw_text(ctx, combined, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                       GRect(area.origin.x + area.size.w / 2 - 3, area.origin.y - 4,
                             area.size.w / 2, area.size.h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
  } else {
    graphics_draw_text(ctx, value, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                       GRect(area.origin.x + area.size.w / 2 - 3, area.origin.y - 4,
                             area.size.w / 2 - 3, area.size.h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
  }
}

void widget_draw_band(GContext *ctx, GRect area, const ProbeView *p, bool stale) {
  if (!(p->flags & FB_FLAG_HAS_ALERT)) return;      // nothing meaningful to draw
  if (p->min_tenths == 0 && p->max_tenths == 0) return;

  graphics_context_set_stroke_color(ctx, GColorWhite);
  graphics_draw_rect(ctx, area);

  int lo = p->min_tenths;
  int hi = p->max_tenths;
  if (hi <= lo) return;

  int pos = p->temp_tenths;
  if (pos < lo) pos = lo;
  if (pos > hi) pos = hi;
  int frac = ((pos - lo) * (area.size.w - 4)) / (hi - lo);
  if (frac < 0) frac = 0;

  GRect fill = GRect(area.origin.x + 2, area.origin.y + 2, frac, area.size.h - 4);
  if (fill.size.w <= 0) return;

  if (stale) {
    fill_dithered(ctx, fill);
  } else {
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_rect(ctx, fill, 0, GCornerNone);
  }
}

void widget_draw_banner(GContext *ctx, GRect area, const char *text, bool invert) {
  if (!text || text[0] == '\0') return;
  if (invert) {
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_rect(ctx, area, 0, GCornerNone);
    graphics_context_set_text_color(ctx, GColorBlack);
  } else {
    graphics_context_set_text_color(ctx, GColorWhite);
  }
  graphics_draw_text(ctx, text, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(area.origin.x, area.origin.y - 2, area.size.w, area.size.h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

void widget_draw_footer(GContext *ctx, GRect area, uint32_t elapsed_sec,
                        uint16_t staleness_sec, bool stale) {
  static char left[16];
  static char right[16];
  graphics_context_set_text_color(ctx, GColorWhite);

  uint32_t h = elapsed_sec / 3600;
  uint32_t m = (elapsed_sec / 60) % 60;
  snprintf(left, sizeof(left), "%luh%02lum", (unsigned long)h, (unsigned long)m);

  // ASCII only: the system font has no em dash or bullet on flint.
  if (stale) {
    uint16_t sm = staleness_sec / 60;
    snprintf(right, sizeof(right), "x%um", sm);
  } else {
    snprintf(right, sizeof(right), ".%us", staleness_sec);
  }

  GFont f = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  graphics_draw_text(ctx, left, f,
                     GRect(area.origin.x + 3, area.origin.y, area.size.w / 2, area.size.h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_draw_text(ctx, right, f,
                     GRect(area.origin.x + area.size.w / 2, area.origin.y,
                           area.size.w / 2 - 3, area.size.h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd pebble && pebble build
```

Expected: build succeeds for all seven platforms.

- [ ] **Step 4: Commit**

```bash
git add pebble/src/c/widgets.h pebble/src/c/widgets.c
git commit -m "feat(watch): add shared 1-bit widget layer with dithered stale fill"
```

---

### Task 13: Watch C — Ledger layout and dispatch

**Files:**
- Create: `pebble/src/c/layout_ledger.h`
- Create: `pebble/src/c/layout_ledger.c`
- Create: `pebble/src/c/ui.h`
- Create: `pebble/src/c/ui.c`

**Interfaces:**
- Consumes: widgets (Task 12), `CookModel` (Task 11).
- Produces: `void ui_create(Window*)`, `void ui_set_model(const CookModel*)`, `void ui_destroy(void)`.

- [ ] **Step 1: Write `layout_ledger.h`**

```c
#pragma once
#include <pebble.h>
#include "model.h"

void layout_ledger_draw(GContext *ctx, GRect bounds, const CookModel *m);
```

- [ ] **Step 2: Write `layout_ledger.c`**

```c
#include "layout_ledger.h"
#include "widgets.h"

// Vertical zones as percentages of the UNOBSTRUCTED height, so the layout
// survives Quick View overlays and every screen from 144x168 to 260x260.
#define ZONE_CLOCK_Y      2
#define ZONE_CLOCK_H     36
#define ZONE_RULE_Y      40
#define ZONE_BODY_Y      43
#define ZONE_FOOTER_Y    90
#define ZONE_FOOTER_H    10
#define ZONE_BANNER_H    12

void layout_ledger_draw(GContext *ctx, GRect b, const CookModel *m) {
  bool cooking = model_is_cooking(m);
  bool stale = model_is_stale(m);
  bool show_alerts = model_show_alerts(m);

  if (!cooking) {
    // Idle: a plain, full-size clock. Nothing about FireBoard on screen.
    int y = b.origin.y + widget_pct_of(b.size.h, 28);
    widget_draw_clock(ctx, GRect(b.origin.x, y, b.size.w, b.size.h), true);
    return;
  }

  widget_draw_clock(ctx, GRect(b.origin.x,
                               b.origin.y + widget_pct_of(b.size.h, ZONE_CLOCK_Y),
                               b.size.w,
                               widget_pct_of(b.size.h, ZONE_CLOCK_H)), false);

  widget_draw_rule(ctx, b, b.origin.y + widget_pct_of(b.size.h, ZONE_RULE_Y));

  int y = b.origin.y + widget_pct_of(b.size.h, ZONE_BODY_Y);
  int row_h = 22;
  int band_h = 9;
  int footer_y = b.origin.y + widget_pct_of(b.size.h, ZONE_FOOTER_Y);
  int banner_h = widget_pct_of(b.size.h, ZONE_BANNER_H);
  int body_limit = (m->banner[0] != '\0') ? (footer_y - banner_h) : footer_y;

  for (uint8_t i = 0; i < m->n_probes; i++) {
    const ProbeView *p = &m->probes[i];
    bool has_band = show_alerts && (p->flags & FB_FLAG_HAS_ALERT);
    int needed = row_h + (has_band ? band_h + 2 : 0);
    if (y + needed > body_limit) break;      // never overflow into the footer

    widget_draw_probe_row(ctx, GRect(b.origin.x, y, b.size.w, row_h), p,
                          show_alerts, stale);
    y += row_h;

    if (has_band) {
      widget_draw_band(ctx, GRect(b.origin.x + 4, y, b.size.w - 8, band_h), p, stale);
      y += band_h + 2;
    } else if (show_alerts && (p->flags & FB_FLAG_IS_PIT)) {
      // A live pit with no alert is worth saying out loud — it is the default
      // failure mode of this hardware and invisible in the phone app.
      graphics_context_set_text_color(ctx, GColorWhite);
      GRect box = GRect(b.origin.x + 4, y, 12, 12);
      graphics_draw_rect(ctx, box);
      graphics_draw_text(ctx, "!", fonts_get_system_font(FONT_KEY_GOTHIC_14),
                         GRect(box.origin.x + 3, box.origin.y - 3, 10, 14),
                         GTextOverflowModeFill, GTextAlignmentLeft, NULL);
      graphics_draw_text(ctx, "NO ALERT SET",
                         fonts_get_system_font(FONT_KEY_GOTHIC_14),
                         GRect(b.origin.x + 20, y - 2, b.size.w - 24, 14),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
      y += 14;
    }
  }

  if (m->banner[0] != '\0') {
    // Inversion means "needs you". A stall is information, so it stays plain.
    bool invert = show_alerts && m->alert_level >= FB_LEVEL_WARN;
    widget_draw_banner(ctx, GRect(b.origin.x, footer_y - banner_h,
                                  b.size.w, banner_h), m->banner, invert);
  }

  widget_draw_footer(ctx, GRect(b.origin.x, footer_y, b.size.w,
                                widget_pct_of(b.size.h, ZONE_FOOTER_H)),
                     m->elapsed_sec, m->staleness_sec, stale);
}
```

- [ ] **Step 3: Write `ui.h` and `ui.c`**

`ui.h`:

```c
#pragma once
#include <pebble.h>
#include "model.h"

void ui_create(Window *window);
void ui_set_model(const CookModel *m);
void ui_destroy(void);
```

`ui.c`:

```c
#include "ui.h"
#include "layout_ledger.h"

static Layer     *s_canvas;
static CookModel  s_model;

static void canvas_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_unobstructed_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  // Plan 2 adds Hero and Progress dispatch here on s_model.layout. Until then
  // every layout value renders as Ledger, which is why the LAYOUT key is
  // already parsed and carried through the frame.
  layout_ledger_draw(ctx, b, &s_model);
}

void ui_create(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_unobstructed_bounds(root);
  model_init(&s_model);
  s_canvas = layer_create(b);
  layer_set_update_proc(s_canvas, canvas_update);
  layer_add_child(root, s_canvas);
}

void ui_set_model(const CookModel *m) {
  s_model = *m;
  if (s_canvas) layer_mark_dirty(s_canvas);
}

void ui_destroy(void) {
  if (s_canvas) { layer_destroy(s_canvas); s_canvas = NULL; }
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd pebble && pebble build
```

Expected: build succeeds with no warnings.

- [ ] **Step 5: Commit**

```bash
git add pebble/src/c/layout_ledger.h pebble/src/c/layout_ledger.c \
        pebble/src/c/ui.h pebble/src/c/ui.c
git commit -m "feat(watch): add Ledger layout and layout dispatch"
```

---

### Task 14: Watch C — lifecycle, AppMessage, vibration

**Files:**
- Modify: `pebble/src/c/fireboard.c` (replaces the generated template)

**Interfaces:**
- Consumes: everything from Tasks 11–13.

- [ ] **Step 1: Write the entry point**

Delete the generated `pebble/src/c/<name>.c` if it has a different filename, and create `pebble/src/c/fireboard.c`:

```c
#include <pebble.h>
#include "appmsg_keys.h"
#include "model.h"
#include "ui.h"

static Window    *s_window;
static CookModel  s_model;
static uint8_t    s_last_level = FB_LEVEL_OK;

static void vibe_for_level(uint8_t level) {
  if (level == FB_LEVEL_WARN) {
    static const uint32_t seg[] = { 80, 80, 80 };
    VibePattern p = { .durations = seg, .num_segments = 3 };
    vibes_enqueue_custom_pattern(p);
  } else if (level == FB_LEVEL_CRITICAL) {
    static const uint32_t seg[] = { 150, 80, 150, 80, 150 };
    VibePattern p = { .durations = seg, .num_segments = 5 };
    vibes_enqueue_custom_pattern(p);
  }
  // FB_LEVEL_INFO never buzzes: a stall is reassurance, not an alarm.
}

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  ui_set_model(&s_model);        // redraws the clock
}

static void inbox_received(DictionaryIterator *iter, void *ctx) {
  model_apply_dict(&s_model, iter);
  ui_set_model(&s_model);

  // Vibrate only on a rising edge, and only when the phone says we may.
  // MAY_VIBRATE carries the quiet-hours / user-toggle decision, which is made
  // phone-side. Note s_last_level is still updated below regardless, so a
  // suppressed alert does not re-buzz on the next poll once quiet hours end.
  if (s_model.alert_level > s_last_level && model_may_vibrate(&s_model)) {
    vibe_for_level(s_model.alert_level);
  }
  s_last_level = s_model.alert_level;
}

static void inbox_dropped(AppMessageResult reason, void *ctx) {
  // How buffer-sizing mistakes surface. Do not remove.
  APP_LOG(APP_LOG_LEVEL_WARNING, "inbox dropped: %d", (int)reason);
}

static void window_load(Window *w) {
  window_set_background_color(w, GColorBlack);
  ui_create(w);
  model_init(&s_model);
  ui_set_model(&s_model);
  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
}

static void window_unload(Window *w) {
  tick_timer_service_unsubscribe();
  ui_destroy();
}

static void init(void) {
  model_init(&s_model);
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  // Worst-case frame measured at ~424 bytes; 1024 gives >2x headroom.
  // Asking for the 8K maximum would not fit in aplite's heap at all.
  app_message_open(1024, 256);
  window_stack_push(s_window, true);
}

static void deinit(void) {
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
```

- [ ] **Step 2: Build and check the memory report**

```bash
cd pebble && pebble clean && pebble build
```

Expected: build succeeds for all seven platforms. Read the per-platform memory report — free heap on aplite must be comfortably positive. If aplite fails to fit, that is the platform to shrink for, not flint.

- [ ] **Step 3: Verify in the emulator**

```bash
pebble install --emulator basalt
```

Expected: the SDL window shows a clock. With no phone attached there is no data, so the idle state is correct.

- [ ] **Step 4: Commit**

```bash
git add pebble/src/c/
git commit -m "feat(watch): add lifecycle, AppMessage handling and transition vibration"
```

---

### Task 15: End-to-end verification on hardware

**Files:** none — this task verifies.

- [ ] **Step 1: Confirm Developer Connection is on**

In the Core Devices app: Settings → Developer Mode ON → Developer Connection ON. Note the Server IP. It disables itself after idle periods; if any step below hangs with `libpebble2.exceptions.TimeoutError`, re-toggle it before debugging anything else.

- [ ] **Step 2: Install**

```bash
cd pebble && pebble build && pebble install --phone <YOUR_PHONE_IP>
```

- [ ] **Step 3: Configure**

Open the FireBoard watchface settings in the Core Devices app. Sign in with your FireBoard credentials. Confirm the page switches to "Signed in." Save.

- [ ] **Step 4: Verify the idle state**

With no cook running, the watchface shows only a large clock and date. Nothing FireBoard-related is visible.

- [ ] **Step 5: Verify the cooking state**

Start a session, or plug in a probe. Within one poll interval the probe rows should appear. Check against `pebble logs --phone <IP>` and the FireBoard app that the temperatures agree.

- [ ] **Step 6: Verify the awkward cases**

| Check | How | Expected |
| --- | --- | --- |
| No-alert flag | Use a probe with no alert configured | Boxed `!` and `NO ALERT SET` under the pit row |
| Band gauge | Configure a min and max on the pit channel | Band appears, fill tracks the temperature |
| Alert + vibration | Set a max just below the current pit temp | Row inverts, banner appears, watch buzzes **once** |
| No re-buzz | Wait through several polls while still out of band | No further vibration |
| Stale | Power off the FireBoard | Within ~2 min: values in parentheses, `NO DATA`, footer `x` |
| Recovery | Power the FireBoard back on | Returns to normal within one poll |

- [ ] **Step 7: Verify budget behaviour**

```bash
pebble logs --phone <YOUR_PHONE_IP>
```

Let it run 10 minutes at the 30s default. Expect roughly 20 requests and no `PAUSED` banner. If `PAUSED` appears, the FireBoard phone app is consuming the shared budget — confirm by closing it and re-observing.

- [ ] **Step 8: Commit any fixes and tag**

```bash
git add -A
git commit -m "fix: corrections from on-device verification"
git tag v0.1.0-watchface
```

---

## Plan 2 preview (not in scope here)

1. Hero and Progress layouts behind the existing `LAYOUT` key.
2. Colour treatment via `PBL_IF_COLOR_ELSE()` — identical geometry, ink values only.
3. Round-platform layout for `chalk` and `gabbro`: circular safe area, inset banner, no footer.
4. AppGlance so the launcher shows cook status without opening anything.
5. Run `tools/fireboard_probe.py ratelimit --confirm-not-cooking` after a cook and record the first rate-limit response anyone has captured.
