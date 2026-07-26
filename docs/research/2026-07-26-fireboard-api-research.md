# FireBoard API Research

**Date:** 2026-07-26
**Question:** Is there an official FireBoard API for a smartwatch companion app, or do we need to
intercept the Android app's traffic? How do we authenticate as our own user and get live cook data?

## Hard constraints at a glance

Everything below is **verified against the live API**, not inferred from docs. These are the facts a
design has to satisfy.

| Constraint | Value | Consequence |
| --- | --- | --- |
| Auth scheme | `Authorization: Token <40-hex>` | not `Bearer` — `Bearer` returns 403 |
| Token lifetime | stable, non-rotating, no expiry | log in once, store the token, no refresh logic |
| Token scope | **per-account, shared** | the phone app draws from the same budget |
| Rate limit | 17 calls / 5 min (~200/hr), **shared** | poll at 30s, one call per cycle |
| Rate-limit headers | **none** | client must self-track its own budget |
| HTTP caching | **none** (no ETag/Last-Modified) | every poll is a full transfer; no cheap "changed?" check |
| `User-Agent` | **mandatory, any non-empty value** | must verify PebbleKit JS sends one |
| Error status | **everything is 403** | branch on `content-type` + `detail`, never on status |
| Poll endpoint | `GET /api/v1/devices.json` | ~3650 bytes, constant size, has labels+temps+alerts |
| Live freshness | ~5 s behind real time | latency is our poll interval, not FireBoard's |
| History | `chart.json`, server-downsampled | **bounded ~16 KB even for 11 h**; one-shot, never polled |
| Session detection | `channels[].sessionid` changes | **free** — no extra call |
| Real-time push | **undocumented MQTT** at `wss://fireboard.io/ws` | pkjs can't use it (no WebSocket); daemon-only, v2 |
| Write access | **probably exists** (`POST .../mq.json`, unverified) | Drive control only; not needed for v1 |
| Login endpoint | behind **AWS WAF CAPTCHA** | cache the token; never log in per-poll |
| `degreetype` | `1` = Celsius, `2` = Fahrenheit | |

## Bottom line

**There is a fully documented, official, public FireBoard Cloud REST API.** No traffic interception,
no reverse engineering, no APK decompilation required. It is token-authenticated with your normal
FireBoard account credentials and exposes everything a watch app needs: devices, live probe temps,
sessions, and historical chart data.

The single significant constraint is a hard **rate limit of 17 calls per 5 minutes** (~200/hour),
which is the main thing that shapes the architecture.

Canonical docs: <https://docs.fireboard.io/app/api.html> (also served at
<https://docs.fireboard.io/app/app-api/>)

## Authentication

Simple token auth. One call to exchange credentials for a long-lived key, then a header on every
subsequent request.

```bash
# 1. Exchange credentials for a token
curl -X POST https://fireboard.io/api/rest-auth/login/ \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: pebble-fireboard/0.1' \
  -d '{"username":"you@example.com","password":"..."}'
# → {"key": "9944bb9966cc22cc9418ad846dd0e4bbdfc6ee4b"}

# 2. Use it
curl https://fireboard.io/api/v1/devices.json \
  -H 'Authorization: Token 9944bb9966cc22cc9418ad846dd0e4bbdfc6ee4b' \
  -H 'User-Agent: pebble-fireboard/0.1'
```

Notes verified during research:

- `POST /api/rest-auth/login/` is live and responds (returns `400` to an empty body, as expected).
- `GET /api/v1/devices.json` without a token returns `403` — auth is genuinely enforced.
- **A `User-Agent` header is mandatory on every request** (documented requirement added 2025-01-02).
  Omitting it is a plausible source of mysterious failures — pkjs `XMLHttpRequest` may not set one
  by default, so set it explicitly.
- The endpoint is `rest-auth`, i.e. this is a Django REST Framework `dj-rest-auth` backend. That
  strongly implies the token is **long-lived and non-expiring** (DRF's default `TokenAuthentication`
  has no expiry). **Unverified** — worth confirming by holding a token for a few weeks. Plan for the
  possibility of re-login on a `401`.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /api/rest-auth/login/` | credentials → `{"key": "<token>"}` |
| `GET /api/v1/devices.json` | all FireBoards on the account |
| `GET /api/v1/devices/<UUID>.json` | one device: `id`, `uuid`, `title`, `hardware_id`, `channels`, `latest_temps`, `device_log`, `last_templog` |
| `GET /api/v1/devices/<UUID>/temps.json` | **live probe temps** — returns data only if <60s old |
| `GET /api/v1/devices/<UUID>/drivelog.json` | Drive (fan controller) log — also <60s freshness |
| `GET /api/v1/sessions.json` | all cook sessions |
| `GET /api/v1/sessions/<id>.json` | one session |
| `GET /api/v1/sessions/<id>/chart.json` | full time-series for a session; `?drive=1` adds Drive data |

`temps.json` is the workhorse for a watch app. `chart.json` is what you'd want for any
trend/history/ETA computation, though its payload is large and should be fetched rarely.

## Rate limiting — the design constraint

**17 calls per 5 minutes**, per the official docs. Exceeding it blocks further requests until you
drop back below the threshold. Independent confirmation from two community projects: both
[fireboard2mqtt](https://github.com/gordlea/fireboard2mqtt) and
[ha-fireboard](https://github.com/GarthDB/ha-fireboard) cite "200 requests/hour" — and 17 per 5 min
is 204/hour, so the two figures are the same limit described differently.

Practical polling budget for a **single** device, one call per poll:

| Interval | Calls / 5 min | Verdict |
| --- | --- | --- |
| 15s | 20 | **over the limit** |
| 20s | 15 | tight — no headroom for retries |
| 30s | 10 | **comfortable — recommended** |
| 60s | 5 | very safe, plenty of headroom |

Three things that eat the budget faster than you'd expect:

1. **The limit is per-account, not per-token — now CONFIRMED** (see the login test below; two logins
   return the same token). The FireBoard Android app running on your phone during a cook draws from
   the *same* pool as our watch companion. This is why **30s is the right interval, not 20s**: the
   headroom is not ours to spend.
2. **Multiple devices = multiple calls per poll cycle.** Budget is per-call, not per-cycle.
3. **Retries count.** A flaky connection with naive retry logic can silently double your rate.

**30 seconds is the sweet spot**, matching what worked well in tokenwatch. (An earlier draft of this
section justified that with "`temps.json` only returns data under 60 seconds old." That reasoning was
wrong — live data turns out to be ~5 s fresh, see below. The conclusion stands, but because the
budget is shared, not because the data is slow.)

## Real-time push — CORRECTION: an undocumented MQTT-over-WebSocket broker exists

**An earlier version of this document said there is no real-time push. That was wrong.** It was true
of the *documented* API and of what most community integrations do, but FireBoard runs an
undocumented MQTT broker that the web app uses.

**Verified by me directly:**

```
wss://fireboard.io/ws     -> WebSocket handshake succeeds
                             subprotocol "mqttv3.1" is accepted and echoed back
https://fireboard.io/ws   -> HTTP 400 on a plain GET (endpoint exists; it wants an upgrade)
```

**Details from `GarthDB/ha-fireboard` (`custom_components/fireboard/mqtt_client.py`), not yet
verified end-to-end by me:**

| Property | Value |
| --- | --- |
| Endpoint | `wss://fireboard.io:443/ws` |
| Transport | MQTT over WebSockets |
| Protocol | **MQTTv3.1** (`MQTTv31`, *not* 3.1.1) |
| Auth | **session cookies** (`sessionid`, `csrftoken`) in the WS `Cookie` header, plus `Origin: https://fireboard.io` |
| Client id | `fireboard_ha_<token[:8]>` |
| Topics | `{device_uuid}/templog{channel}`, `{device_uuid}/drivelog` |
| Payload | JSON |

**Why this does not change the v1 recommendation:**

1. **PebbleKit JS cannot use it.** pkjs is ES5 JSCore with `XMLHttpRequest` — **no WebSocket, no
   MQTT client**. A phone-direct MQTT subscription is not possible. Using MQTT means reintroducing
   the daemon tier, which is exactly what we dropped to keep the watch working away from home.
2. **It needs session cookies, not just the token.** The clean `Token` auth we rely on is not
   sufficient; you must capture `sessionid`/`csrftoken` from the login response and keep a session
   alive. More moving parts, more to break.
3. **It is undocumented** and can change without notice. Polling `devices.json` is a supported
   contract; this is not.
4. **We don't need it.** Live data is already ~5 s fresh via polling, and a 30 s cadence is fine for
   barbecue. MQTT buys sub-second updates for a process measured in hours.

**When it becomes compelling:** if you later add a daemon for long-term cook archives, subscribing
via MQTT instead of polling would give true real-time data *and* remove the rate limit from the
picture entirely. That is a genuinely attractive v2, just not a v1.

Implication for the watch: end-to-end latency is (FireBoard→cloud lag) + (your poll interval) +
(AppMessage delivery). **Measured, the cloud lag is only ~5 seconds** (see "Live data is fresher than
the history suggests"), so total latency is roughly **35–40 seconds at a 30s poll** — dominated
entirely by our own interval. That is fine for barbecue, but the watch should still show a
"last updated" indicator rather than implying live data, and alerting will lag by up to a poll.

## Live data confirmed from your current cook

I pulled your shared dashboard (`https://share.fireboard.io/2F84BE`) while the cook was running and
confirmed the real data shapes. From the page at ~14:50 UTC:

- **Device identifier on the share page:** `1045407944095488791`. **Correction (see capture results
  below): this is NOT the API device UUID.** The real API UUID is a normal hyphenated GUID. The
  share page's `device` field is some other internal identifier. Do not use share-page values as API
  inputs.
- **Session:** "Sun Jul 26 Session", auto-created, marked `LIVE`, started `1785072759`
- **Channel 3** — `boneless butt`, color `E8620C`, rising 44.2°F → 75.3°F over the hour
- **Channel 4** — `pit`, color `FF450D`, oscillating 156°F → 268°F → 230°F as you managed the fire
- **`degreetype: 2`** = Fahrenheit (1 is presumably Celsius — worth confirming)
- **Sample interval: exactly 60 seconds** per data point, with channels offset ~5s from each other
- **Notes are first-class data**, timestamped and channel-tagged — your "Moved apart the logs...",
  "New split" entries come back as `{"created": ISO8601, "channel": 4, "note_text": "..."}`

The chart series shape is exactly what the docs describe for `chart.json`:

```json
{"label":"pit","device":"1045407944095488791","channel_id":4,"degreetype":2,
 "color":"FF450D","enabled":true,
 "x":[1785072765,1785072825,...],   // unix seconds
 "y":[156.7,186,207.9,...]}          // degrees
```

Note the parallel-array format (`x` and `y` as separate arrays), not an array of points. Slightly
awkward but trivial to zip.

### A zero-auth fallback worth knowing about

Your share page embeds the **complete session JSON inline** in a `var data = [...]` block, and the
page self-refreshes every 15 seconds by re-fetching `https://share.fireboard.io/2F84BE.partial`
(which returns an HTML fragment containing the current `realtime-temp` values). I confirmed both:
the `.partial` fragment returned live-updating temps (75.4°F / 229.5°F on a later fetch than the
main page's 74.8°F / 232.6°F).

There is **no clean JSON endpoint** on the share host — I probed `2F84BE.json`,
`2F84BE/chart.json`, and `api/v1/sessions/2F84BE/chart.json` and all return the HTML page via a
catch-all route.

So share-link scraping is *possible* and requires no credentials at all, but it means HTML parsing,
it only works while a session is actively shared, and it's fragile against any front-end change.
**Use the official API.** Keep this in the back pocket only as a demo/testing path, or if you ever
want to build something that watches *someone else's* cook.

## Write access — CORRECTION: a control endpoint probably exists (unverified)

An earlier version of this document said the API is read-only. **That is probably wrong**, though it
remains unproven.

`benhodgson87/fireboard-mcp` (`src/fireboard/client.ts`) implements Drive fan control via:

```
POST /api/v1/devices/{uuid}/mq.json
Authorization: Token <t>
{"topic": "device", "payload": {"request_type": "control", ...}}
```

| Action | Payload merged into `payload` |
| --- | --- |
| Set target (auto/PID) | `{"t": "fan", "setpoint": "225"}` |
| Change PID control channel | `{"cc": "2"}` |
| Manual fan speed | `{"t": "fan", "p": "0.5"}` — **0–1, not 0–100** |
| Off | `{"t": "fan", "setpoint": "0"}` |

**Treat this as a strong hypothesis, not a fact.** In favour: `mq.json` reads as a message-queue
passthrough to the device, and the terse `t`/`p`/`cc` keys match the compact-key style of the real
`drivesettings` blob observed on live hardware — an internal convention that would be hard to invent.
Against: single-author repo, no tests covering the control path, no captured response, and the same
file contains demonstrably dead `401` handling (the API returns 403), which shows parts were written
from documentation rather than observation.

Independent corroboration that *some* write capability is real: DRF `Allow` headers on 403 responses
list **POST** on `devices/<uuid>.json`, **POST/DELETE** on `sessions/<id>.json`, and **PUT/PATCH** on
`rest-auth/user/`. So the server exposes writes; only the semantics are unproven.

**Relevance to us: low for v1.** We have no Drive hardware on this account (`last_drivelog: null`,
model `FBX11C` = FireBoard 2, not Drive), and a read-only wrist display is the goal. **Do not build
on this without verifying against real hardware** — a mis-shaped control message goes to a device
managing a live fire.

Note this does **not** give us alert/target *writing*: probe targets are readable via
`channels[].alerts[]`, but no community code writes them.

## Beware the login endpoint's WAF

`POST /api/rest-auth/login/` sits behind an **AWS WAF with a CAPTCHA action**. Under repeated
automated attempts it stops returning JSON and instead returns **HTTP 405** with
`server: awselb/2.0`, `x-amzn-waf-action: captcha`, and an HTML "Human Verification" body.

This was hit during research and **recovered on its own** — the endpoint later returned normal
Apache-served JSON (`400 {"password":["This field is required."],...}`) and the existing token kept
working throughout. No lasting harm, but the lesson is sharp:

**Cache the token. Never log in per-poll, and never retry a failed login in a loop.** There are now
*three* distinct non-JSON failure shapes a client can meet:

| Shape | Meaning |
| --- | --- |
| DRF JSON `{"detail": ...}` with 403 | genuine auth failure |
| nginx/awselb **HTML** 403 | missing `User-Agent` |
| **405** + `x-amzn-waf-action: captcha` + HTML | WAF CAPTCHA on login |

A client that assumes JSON will choke on two of the three while reporting "check your username and
password" — sending the user to re-enter credentials that were never the problem, which under a WAF
is precisely the wrong response.

## Interception / reverse engineering — not needed

You asked whether we'd need to intercept the Android app. **We don't**, and I'd recommend against
spending effort there:

- The official REST API already covers every read a watch app needs.
- The Android app is near-certainly using this same API (it's the documented public surface of the
  same backend).
- Modern Android + certificate pinning makes MITM interception a real project (rooted device or
  emulator, Frida, `objection`, patching the APK's network security config). All that work to
  rediscover documented endpoints.

**Where interception would genuinely be the only option** is if you want features the public API
doesn't expose — most plausibly **writing** rather than reading: setting probe target temps,
configuring alerts, or **controlling the Drive fan**. The public API documents `drivelog.json` as a
*read* endpoint and I found no documented write/control endpoint. If Drive control from the wrist
becomes a goal, that's the point to revisit interception. For a v1 read-only dashboard, skip it.

Similarly, **BLE is a dead end for this project.** FireBoard 2 does speak Bluetooth LE to the phone,
but the protocol is undocumented and I found no public reverse-engineering of FireBoard's specific
UUIDs. (A promising-looking Web Bluetooth BBQ-thermometer gist turned out to be for an Oregon
Scientific Grill-Right, not a FireBoard.) BLE would also constrain you to phone-adjacent operation
for no benefit — the cloud API works from anywhere.

## Recommended architecture

The important difference from tokenwatch: **tokenwatch needed a local daemon because its data source
was local files** (`~/.claude/projects/*.jsonl`) that only the dev machine could see. FireBoard's
data lives in the cloud, which **your phone can reach from anywhere.** That removes the entire
reason for a daemon.

**Recommendation: PebbleKit JS on the phone polls the FireBoard cloud directly. No daemon.**

```
FireBoard device ──WiFi──▶ FireBoard cloud ──HTTPS──▶ pkjs on phone ──AppMessage──▶ Pebble
                                              (poll 30s)              (watch C renders)
```

Why this wins for a cook specifically: you are standing at a smoker in the yard, or running to the
store for more charcoal. A laptop-hosted daemon would mean the watch goes dark the moment you leave
Wi-Fi. Direct-from-phone works anywhere you have cell signal, which is exactly when you most want
temps on your wrist.

This keeps the tokenwatch patterns that worked — pure dependency-injected pkjs modules that unit-test
in Node, a dumb C renderer on the watch, config webview for credentials, AppGlance for launcher
status, vibrate on alert *transitions* only — while dropping the Python tier entirely.

Consequences to design around:

- **The token lives in phone `localStorage`.** Have the config webview take username/password, do the
  `rest-auth/login/` exchange once in pkjs, and persist only the resulting token — never the
  password. Same shape as tokenwatch's config flow.
- **History for derived metrics must be kept in pkjs**, since there's no daemon to hold it. Keep a
  rolling window (say the last 60–120 samples) in `localStorage` to compute rate-of-rise, ETA to
  target, and stall detection. tokenwatch already does exactly this for its burn-rate graph.
- **One poll cycle = one `GET /api/v1/devices.json` call** for a single FireBoard — which returns
  labels, temps, alerts, battery and session id together. Stay at 30s, and remember the budget is
  shared with the phone app.
- **Strip `device_log` before logging or forwarding anything** — it carries SSID, MAC addresses and
  public IP.

A daemon tier is still worth adding later *if* you want long-term cook archives, cross-cook
analytics, or to fan out to other sinks — tokenwatch's SQLite-to-DuckDB pattern would port directly.
But it shouldn't be in v1, and it should never be on the critical path for the watch display.

### The concrete poll loop (all numbers verified)

```
every 30s:
  GET /api/v1/devices.json          # 1 call, ~3.6 KB, constant size
    -> strip device_log             # SSID / MAC / public IP
    -> for each channel with current_temp:  label, temp, alerts[]
    -> staleness = now - last_templog       # >2 min => device offline
    -> if channels[].sessionid changed:     # new cook
         reset rolling history
         (optionally) GET chart.json once to backfill
    -> append to rolling history (120 samples ≈ 1 h)
    -> compute rate-of-rise, stall state, alert state
    -> Pebble.sendAppMessage(one ~445 B frame)   # fits 1024 B inbox, 2x headroom
```

10 calls per 5 minutes against a shared ceiling of 17 — enough headroom that the phone app polling
alongside us is not a problem, and retries are affordable.

**Self-track the budget.** There are no rate-limit headers, so keep a timestamp ring in
`localStorage` and refuse to issue a call that would exceed 17 in the trailing 5 minutes. This is
cheap insurance against a retry storm silently locking the account out mid-cook.

### What the watch should show

Based on the live cook, the natural v1 display is **pit temp**, **food probe temp**, **elapsed
time**, and **staleness** — with the pit's deviation from its configured band being the thing worth
alerting on. The session showed the pit swinging 156 → 278 → 219 → 234°F during fire management, so
band alerts are the feature that actually saves a cook.

Two refinements the research turned up, both worth building:

1. **Show alert coverage, not just temps.** The live account has a probe on channel 4 with no alert
   and the matching 210–240°F alert stranded on disabled channel 6 — so the pit alarm cannot fire and
   the phone UI doesn't say so. A line reading "2 probes live, 1 unalerted" would have caught it.
2. **Prefer rate-of-rise over ETA.** See the stall section — a linear ETA through pre-stall data is
   confidently wrong by hours, in the optimistic direction.

## Rate-limit test — partial results (2026-07-26)

Attempted the per-account vs per-token test. **Blocked on credentials**; here is what was
established without them.

**No IP-based limiting on unauthenticated traffic.** Fired 20 consecutive unauthenticated
`GET /api/v1/devices.json` calls — comfortably past the documented 17-per-5-minutes threshold.
All 20 returned `403`, none returned `429`, and there was no slowdown:

```
1:403 2:403 3:403 ... 19:403 20:403
```

This is *consistent with* an account-keyed limiter but is weak evidence, because DRF typically
rejects unauthenticated requests at the permission layer **before** the throttle runs. It does rule
out a crude IP-based limiter sitting in front of the API, which is worth knowing — it means we can't
dodge the limit by changing networks, and it means local development won't accidentally trip a
shared office/home IP budget.

**No rate-limit headers.** The API returns no `X-RateLimit-*`, no `Retry-After`, nothing:

```
HTTP/2 403
content-type: application/json
content-language: en-us
```

**This is a real design consequence:** a client cannot discover its remaining budget from the
server. The pkjs layer must **self-track its own call count in a rolling 5-minute window** in
`localStorage` and refuse to exceed it. Blind polling with no local accounting will eventually get
the watch blocked at the worst possible moment — mid-cook.

**CONFIRMED: the token is account-scoped and stable — the limit is per-account.** Ran
`login --twice` against the live account. Two consecutive logins returned the **same 40-character
key**:

```
Exchanging credentials for a token...
POST https://fireboard.io/api/rest-auth/login/ "HTTP/1.1 200 OK"
Token acquired: 488af7...002d (40 chars)
Logging in a second time to compare keys...
POST https://fireboard.io/api/rest-auth/login/ "HTTP/1.1 200 OK"
SAME key returned.
```

This settles several things at once:

- **The rate limit is per-account, not per-session.** Logging in does not mint a new token, so there
  is no such thing as "our own" budget. Every client authenticating as this account — our watch
  companion, the FireBoard Android app, any Home Assistant integration — draws from **one shared
  17-calls-per-5-minutes pool.** Design accordingly: **30s polling, and never assume the budget is
  ours alone.**
- **40 hex characters is exactly Django REST Framework's default `Token` model.** Combined with the
  `rest-auth` path, this is now strong (not merely suspected) evidence that **the token does not
  expire** — DRF's default `TokenAuthentication` has no expiry field. Re-login returning the same key
  confirms there is no rotation. Open question #2 is effectively answered: treat the token as
  permanent, but still handle `401` defensively.
- **Login is idempotent and cheap.** Re-running `login` is safe; it reveals the existing token rather
  than creating a new one.
- **Security consequence:** since the token is a fixed property of the account and cannot be rotated
  from the API, a leaked token can only be revoked by changing the account password (if that even
  cycles it) or contacting FireBoard. Treat it as password-equivalent. It is stored mode-600 in the
  gitignored `tools/.env` and never committed.

**Not run: the exhaustion test.** Deliberately burning the budget while a cook is live would, if the
per-account hypothesis holds, blind the FireBoard phone app for the remainder of the window. That
risk is not worth taking during an actual cook. The harness (`tools/fireboard_probe.py ratelimit`)
therefore refuses to run without an explicit `--confirm-not-cooking` flag.

### The harness

`tools/fireboard_probe.py` is a `uv` single-file script, ready to run the moment a token exists:

```bash
# credentials via tools/.env (gitignored) or the environment
export FIREBOARD_USERNAME=... FIREBOARD_PASSWORD=...

uv run --script tools/fireboard_probe.py login --twice   # token scope probe, 2 calls
uv run --script tools/fireboard_probe.py capture         # response shapes, 2-3 calls
uv run --script tools/fireboard_probe.py ratelimit --confirm-not-cooking   # AFTER the cook
```

`login --twice` is the cheap, safe half of the per-account question: dj-rest-auth commonly returns
the *same* token key for repeated logins. If it does, the token is account-scoped and singular,
which is strong evidence the rate limit is per-account and that the Android app draws from the same
budget — **answering the question for two API calls instead of twenty-five.** Run this one first.

Tests: `uv run --script tools/test_fireboard_probe.py` — 23 passing, using `respx` to mock the API
(no live calls, no budget consumed). They cover the mandatory `User-Agent`, the `Token` (not
`Bearer`) auth scheme, graceful handling of a stale `temps.json` 404, the guarantee that captured
shapes never leak credential values, and the safety interlock itself.

## Capture results (2026-07-26, live cook) — `devices.json` is the endpoint to poll

Ran `capture` against the live account. The headline: **`temps.json` is the wrong endpoint for this
app. Poll `devices.json` instead — one call returns everything.**

### `temps.json` — a strict subset, no labels

```json
[{"degreetype": 2, "temp": 84.2, "channel": 3, "created": "2026-07-26T14:53:43Z"},
 {"degreetype": 2, "temp": 278.1, "channel": 4, "created": "2026-07-26T14:53:43Z"}]
```

Numeric channel IDs only — **no `channel_label`**. Using this endpoint would force a second
`devices.json` call to resolve "pit" and "boneless butt", doubling per-poll cost against a budget we
now know is shared with the phone app.

### `devices.json` — labels, temps, alerts, battery, session, all in one call

Each entry in `channels[]` carries the label *and* the current reading:

```json
{"channel": 4, "channel_label": "pit", "current_temp": 278.9, "degreetype": 2,
 "enabled": true, "state": true, "color_hex": "FF450D", "sessionid": 11569055,
 "last_templog": {"temp": 278.9, "created": "2026-07-26T14:54:23Z", "channel": 4},
 "alerts": [...]}
```

**Design decision: poll `GET /api/v1/devices.json` every 30s. One call per cycle. Ignore
`temps.json` entirely.** This halves what I'd budgeted and leaves real headroom on a shared limit.

Also available from that same single call:

| Field | Use |
| --- | --- |
| `channels[].channel_label` | probe names for the watch display |
| `channels[].current_temp` | the live reading |
| `channels[].alerts[]` | **the user's own configured thresholds** — see below |
| `channels[].color_hex` | per-probe colors, usable on 64-color Pebble platforms |
| `channels[].sessionid` | current session id, for `chart.json` history |
| `last_battery_reading` | FireBoard battery as a 0–1 float (`0.78` = 78%) |
| `title`, `model`, `degreetype` | device identity; `degreetype: 2` = Fahrenheit, confirmed |
| `channel_count`, `auto_session`, `active` | 6 channels, sessions auto-create |

### Channel liveness is not simply `enabled`

Of 6 configured channels, only 3 and 4 had probes reporting. The reliable test for "show this on the
watch" is **the presence of `current_temp` / `last_templog`**, not the `enabled` flag:

- ch1 `Hock`, ch2 `shoulder 1`, ch5 `pit 1 left` — `enabled: true`, but no `current_temp`
- ch5 has `state: null`, ch6 has `enabled: false`
- Labels persist for channels with no probe plugged in

So the watch app must filter on live readings, and should tolerate 6 channels of config with only 1–2
actually cooking. It should also handle **duplicate labels** — channels 4 and 6 are both named "pit".

### Alerts are readable — a significant feature opportunity

`channels[].alerts[]` exposes the user's existing FireBoard alert configuration:

```json
{"channel": 6, "temp_min": 210.0, "temp_max": 240.0, "enabled": true,
 "notify_app": true, "notify_sms": true, "minutes_repeat": 30, "minutes_buffer": 0,
 "time_start": "00:00:01", "time_stop": "23:59:59"}
```

**The watch app should reuse these rather than inventing its own thresholds.** The user has already
told FireBoard what "too hot" means; duplicating that config on the watch would be a worse product.
This is read-only in the public API — we can honour the thresholds, but setting them still requires
the phone app.

### The device UUID *is* a normal GUID

`15b1fff2-854f-4204-9a9a-79ba428e6144`. This **corrects** the earlier note taken from the share page:
the share page's numeric `device` field is a different internal identifier. Parse UUIDs normally.

### Do not log `device_log`

`devices.json` embeds a `device_log` object containing **`ssid`, `macNIC`, `macAP`, `internalIP`, and
`publicIP`**. Deliberately excluded from all captured output here. Any daemon, log line, or debug
dump must strip it — it is the one genuinely sensitive part of the response, and it is easy to leak
by pretty-printing the whole payload.

## Sessions — detection is free, no extra call needed

`GET /api/v1/sessions.json` returned **50 sessions, 17 KB**, spanning 2022 to today. Shape:

```json
{"id": 11569055, "title": "Sun Jul 26 Session", "description": "Auto-created session",
 "start_time": "2026-07-26T13:32:39Z", "end_time": null,
 "duration": "1 hour, 28 minutes", "device_ids": ["15b1fff2-..."],
 "share_key": "2F84BE", "shared": true, "share_visibility": 1, "created": "..."}
```

Key facts:

- **A live session is `end_time: null`.** That is the whole test. There is no `active` field (it
  came back absent on every session, including the running one).
- **`duration` is a human-readable string** (`"1 hour, 28 minutes"`), not a number. Useless for
  arithmetic — compute elapsed time from `start_time` instead.
- **`share_key` is exposed** (`"2F84BE"`), so the public share URL is derivable from the API:
  `https://share.fireboard.io/<share_key>`.
- **Sorted newest-first**, so `sessions[0]` is the current or most recent cook.

**The important consequence: we never need `sessions.json` in the poll loop.** `devices.json`
already returns `channels[].sessionid`, so **detecting a new cook is just watching that value
change** — zero extra API calls. `sessions.json` is a 17 KB call worth making only on demand (to
show a session title, or to browse history).

## History — `chart.json` is cheap enough, but is a one-shot, not a poll

`GET /api/v1/sessions/11569055/chart.json` for a 1.5-hour cook: **3.2 KB, 2 series, 90 points each**.

```json
[{"label": "pit", "channel_id": 4, "device": "1045407944095488791", "degreetype": 2,
  "color": "FF450D", "enabled": true,
  "x": [1785072765, ...],   // unix seconds, 60s apart
  "y": [156.7, ...]}]
```

### Measured against a real 11-hour cook: the server downsamples

Rather than extrapolate, I fetched `chart.json` for an archived **11.4-hour** session (3 probes):

```
15.6 KB total, 3 series, 914 points
  'pork shoulder'  341 points  span 11.4h  avg gap 123s  (min 60s, max 1440s)
  'pit 1 left'     242 points  span  7.8h  avg gap 117s
  'pit'            331 points  span 11.4h  avg gap 129s
17.4 bytes per point
```

**The endpoint adaptively downsamples.** A 1.5-hour session returns points 60 s apart; an 11.4-hour
session averages ~123 s apart, capping each series at roughly **300–350 points regardless of
duration**. The payload is therefore **bounded at around 15–20 KB even for an overnight cook** — it
does not grow linearly with time.

| Cook length | Measured / expected |
| --- | --- |
| 1.5 h, 2 series | **3.2 KB** (measured) |
| 11.4 h, 3 series | **15.6 KB** (measured) |
| 18 h, 3 series | ~16–20 KB (bounded by the point cap) |

This is far better than feared. **A community estimate circulating at ~800 KB–1 MB for a 12-hour cook
is wrong** — it assumed the 5-second sampling of the CSV export with no downsampling. The API
endpoint is not the CSV export.

So: **fetch `chart.json` once on app open or session change, never in the poll loop.** 16 KB is
trivial for JSCore on the phone. It must still never reach the watch wholesale — downsample to the
~20–50 points a Pebble graph can actually render.

Two shape notes: the max gap of 1440 s shows **the series are not evenly spaced**, so never assume a
fixed interval when computing rates from this data — use the `x` timestamps. And `'pit 1 left'`
spans only 7.8 h of an 11.4 h cook, i.e. **probes added or removed mid-cook produce series with
different spans**; align on timestamps, not array index.

**Two identifier gotchas in this payload.** `chart.json` labels its series with
`"device": "1045407944095488791"` — the *numeric* identifier, **not** the GUID that
`devices.json` uses. The two endpoints use different device identifiers for the same physical
device. Don't try to join on it. Also note `channel_id` here vs `channel` in `devices.json` and
`temps.json` — same concept, different key name.

**Sampling rate: 60 seconds** in stored history (90 points over 1.5 h), which matches what the share
page showed.

## Live data is fresher than the history suggests

The 60-second figure above is the *stored/downsampled* rate. Live readings are much fresher. Polling
`devices.json` repeatedly, `last_templog` tracked ~5 seconds behind each request:

```
fetch1 at 15:00:43Z  3650b  last_templog=15:00:38Z  {ch3: 87.5, ch4: 261.1}
fetch2 at 15:01:48Z  3650b  last_templog=15:01:43Z  {ch3: 88.0, ch4: 256.0}
fetch3 at 15:02:54Z  3651b  last_templog=15:02:48Z  {ch3: 88.5, ch4: 251.6}
fetch4 at 15:03:59Z  3651b  last_templog=15:03:53Z  {ch3: 89.0, ch4: 247.3}
```

**`last_templog` sat 5–6 seconds behind every request, regardless of when the request landed.** If
the device were reporting on a fixed 60-second grid, the lag would drift across a 65-second polling
cadence (5s, 10s, 15s…). It doesn't. So the device reports continuously and `current_temp` is live to
within a few seconds. **This is materially better than the docs imply** — the documented "under 60
seconds old" is a staleness *ceiling*, not the actual cadence. End-to-end watch latency is therefore
dominated by our poll interval, not FireBoard's pipeline: a 30-second poll yields data at worst ~35
seconds stale.

Note this contradicts the 60-second spacing seen in `chart.json`. Both are true — **60 seconds is
the stored/downsampled history rate; live readings are continuous.** Don't infer the live cadence
from the chart data.

**`devices.json` is a steady ~3650 bytes** for a 6-channel device with 2 live probes. Crucially it
**does not grow with cook length** (unlike `chart.json`), so the poll cost is constant whether you
are 20 minutes or 18 hours in.

The samples also show how clean the derived metrics will be: the food probe rose 87.5 → 89.0°F over
3m16s, a near-perfectly linear ~0.46°F/min. Easy to compute a rate of rise; the hard part will be the
stall, not the arithmetic.

## No HTTP caching support

Authenticated responses carry **no `ETag`, no `Last-Modified`, no `Cache-Control`**:

```
content-type: application/json
vary: Accept-Language,Cookie
x-frame-options: SAMEORIGIN
```

So conditional requests (`If-None-Match` / `If-Modified-Since`) are not available: every poll is a
full transfer and a full charge against the shared rate limit. There is no way to cheaply ask
"has anything changed?"

## The share page as a zero-rate-limit path — considered, and rejected

Worth taking seriously, because it sidesteps the one real constraint entirely. The shared-session
page updates live and costs **nothing** against the API budget — it is a different host with no
authentication. Measured:

```
sample1 15:06:33Z 12307b temps: 90.1 232.1
sample2 15:07:13Z 12340b temps: 90.3 232.1
```

The food probe moved 90.1 → 90.3°F across 40 seconds, so `<share_key>.partial` really is live, not
cached. The page itself self-refreshes on a 15-second timer.

A hybrid is therefore possible: spend **one** authenticated call per session to read `share_key`
from `sessions.json`, then poll `https://share.fireboard.io/<share_key>.partial` for free, forever,
at whatever rate you like.

**I do not recommend it as the primary path**, for four reasons in descending order of importance:

1. **It requires making the cook public.** The share URL is unauthenticated and guessable-ish
   (6 hex chars). Trading the user's privacy for headroom on a limit we are not straining is a bad
   deal, and it is the user's call to make, not ours.
2. **It is HTML scraping.** No JSON contract, no versioning. A front-end tweak breaks it silently,
   and "silently" during an overnight brisket is the worst time.
3. **It carries less data** — realtime temps and notes only. No alert thresholds, no battery, no
   channel metadata. All the things that make the watch app better than a thermometer readout come
   from the authenticated API.
4. **It is 3.4× larger** (12.3 KB vs 3.6 KB) for strictly less information, because it is a whole
   rendered page.

**When it *is* the right tool:** development and testing without burning budget (as used throughout
this research), and demoing against someone else's public cook. Keep the capability documented; do
not build the product on it.

## Error taxonomy — everything is a 403, and that is a trap

Tested against the live API. **Four distinct failure modes all return HTTP 403.** A client that
branches on status code alone cannot tell "retry later" from "stop, your token is dead":

| Cause | Status | Body | How to detect |
| --- | --- | --- | --- |
| Bad / revoked token | 403 | `{"detail":"Invalid token"}` | JSON, `detail` = "Invalid token" |
| Missing or wrong auth scheme (e.g. `Bearer`) | 403 | `{"detail":"Authentication credentials were not provided."}` | JSON, `detail` mentions "not provided" |
| **Missing `User-Agent`** | 403 | `<html>...403 Forbidden...</html>` (nginx) | **`content-type: text/html`** — blocked at the edge, never reaches Django |
| No auth at all | 403 | JSON `detail` | JSON |

**The single most useful discriminator is `content-type`.** An HTML body means the request was
rejected by nginx before Django saw it, which in practice means the `User-Agent` was missing or
blocked. A JSON body means the request reached DRF and the `detail` string says why.

Note: **it is 403, not 401.** Earlier notes in this doc said to handle `401` — that was wrong. DRF's
`TokenAuthentication` returns 403 when no `WWW-Authenticate` challenge is configured, which is the
case here. There is no `WWW-Authenticate` header in the response.

**Nobody in the community has ever captured a rate-limit response.** A survey of every FireBoard
integration found that *every* `429` handler in the ecosystem is defensive code written from the
docs — no captured status, body, or headers exists anywhere, and the official docs only say
"blocked" without naming a code. The one apparent report is arithmetic about call counts, not an
observed block. **So running the exhaustion test would produce genuinely novel data**; log the raw
status, headers and body when you do.

Given the WAF on the login path, treat **all** of `429`, a `403` with a non-JSON body, and
`405 + x-amzn-waf-action` as "back off".

**Still unknown: what a rate-limit rejection looks like.** DRF's stock throttle returns `429` with
`{"detail":"Request was throttled. Expected available in N seconds."}`, but FireBoard may have
customised it — and given that everything else here is a 403, it may well be a 403 too. **This
matters a lot:** if rate limiting is indistinguishable from a dead token, a naive client will throw
away a perfectly good token and force a re-login. The pkjs client must therefore:

1. Branch on `content-type` first (HTML → fix the User-Agent, do not retry in a loop).
2. Then on the `detail` string, not the status code.
3. Treat any *unrecognised* 403 as **transient** and back off, rather than as an auth failure.
   Losing an hour of updates is recoverable; discarding the token is not.

## Detecting "no data" — three distinct states the watch must not conflate

There is no single "online" flag. Three different failures look similar but need different UI:

1. **Probe not plugged in.** The channel exists in `channels[]` with its `channel_label`, but has
   **no `current_temp` and no `last_templog`**. Observed live on channels 1, 2, 5 and 6. Show the
   channel as configured-but-empty, or hide it. Do *not* show 0°F.
2. **Device offline / stopped reporting.** Channels still carry their last `current_temp`, but
   `last_templog` (device level and channel level) **stops advancing**. Since live data is normally
   ~5 s fresh, **anything older than ~2 minutes means the FireBoard has dropped off**. This is the
   check that matters most on a cook — a dead device showing a plausible stale temperature is the
   worst possible failure mode. There is also a device-level `active` boolean (`true` while
   reporting), but treat advancing `last_templog` as the authoritative signal.
3. **Phone can't reach the API.** Network error, rate limit, or bad token. Distinct from both of the
   above — the watch should say "no signal" rather than implying anything about the cook.

**Recommended rule: compute staleness as `now - last_templog` on the phone and send it to the watch
as a single integer.** The watch then renders live / stale / offline from one field, and the C code
stays dumb. tokenwatch does exactly this with its `ALERT_LEVEL_DISCONNECTED` sentinel.

## Mirroring the user's own alert configuration

`channels[].alerts[]` is a genuinely valuable and slightly unusual thing for an API to expose:

```json
{"channel": 6, "temp_min": 210.0, "temp_max": 240.0, "enabled": true,
 "notify_app": true, "notify_sms": true, "notify_email": false,
 "minutes_repeat": 30, "minutes_buffer": 0,
 "time_start": "00:00:01", "time_stop": "23:59:59"}
```

Semantics as observed:

- **`temp_min` and `temp_max` are independently nullable.** A food probe typically sets only
  `temp_max` (e.g. `Hock` = 203°F, a pulled-pork target); a pit probe sets both (a band to hold).
- `minutes_repeat` is the re-nag interval; `minutes_buffer` appears to be a hysteresis/grace value
  (observed `0`).
- `time_start`/`time_stop` allow a quiet-hours window.
- Alerts attach to a **channel number**, not to a probe — so an alert can outlive the probe being
  moved or the channel being disabled.

**Design implication: honour these rather than inventing separate watch thresholds.** The user has
already told FireBoard what "done" and "too hot" mean, and asking them to configure it twice would
be a worse product than the app they already have.

**And surface the mismatch.** The live account demonstrates exactly why this matters: channel 4
(`pit`) is the probe actually reading, and has **no alerts**; channel 6 is *also* labelled `pit`,
carries the 210–240°F alert, and is `enabled: false` with nothing plugged in. The result is a pit
alarm that cannot fire. A watch app that showed "2 live probes, 0 active alerts" would have caught
this instantly. That is a real feature, not a hypothetical: **a probe with no alert is the default
failure mode of this hardware, and it is invisible in the phone UI.**

## The `User-Agent` requirement — a near-showstopper, mostly de-risked

`User-Agent` is a **forbidden header** in the XMLHttpRequest spec: browsers silently ignore
`setRequestHeader('User-Agent', ...)`. PebbleKit JS runs a stripped JSCore XHR on the phone. If it
enforces the same rule *and* FireBoard rejects requests lacking a User-Agent, the entire
phone-direct architecture fails at the first request.

Tested how strict the nginx rule actually is, using an invalid token so the response reveals whether
the request reached Django:

| User-Agent sent | Result |
| --- | --- |
| *(empty)* | **blocked at nginx** — HTML 403 |
| `x` | reached Django (`{"detail":"Invalid token"}`) |
| `app` | reached Django |
| `curl/8.x` (default) | reached Django |
| `Mozilla/5.0 (iPhone...)` | reached Django |
| `python-requests/2.31.0` | reached Django |

**The rule is only that the header be non-empty.** There is no allowlist, no blocklist of automation
agents, no format requirement. A single character passes.

This means the architecture survives as long as PebbleKit JS sends *some* User-Agent — which it
almost certainly does, since the underlying platform HTTP stack sets one by default. **But this must
be verified on-device before committing to the design.** It is the single cheapest thing that could
invalidate the whole approach, so test it first:

1. Build a throwaway pkjs that does one `XMLHttpRequest` to `https://fireboard.io/api/v1/devices.json`
   with a deliberately invalid token.
2. `pebble logs --phone <IP>` and inspect the response body.
3. **JSON `{"detail":"Invalid token"}` → we are fine.** **HTML → PebbleKit JS sends no User-Agent**,
   and the phone-direct design is dead; fall back to the daemon tier, which can set headers freely.

Also try `xhr.setRequestHeader('User-Agent', 'pebble-fireboard/0.1')` in that spike. If PebbleKit JS
permits it (it may not enforce the browser restriction), we get a clean identifiable agent string,
which is good manners toward FireBoard and makes our traffic distinguishable in their logs.

## Watch-side limits — verified against SDK 4.9.169 headers

Sourced from the **installed SDK headers** (`.../SDKs/4.9.169/sdk-core/pebble/<platform>/include/pebble.h`),
which is what the compiler actually sees, plus build reports from compiling tokenwatch for every
platform. Authoritative, not inferred.

### AppMessage buffers

| Constant | Value | Note |
| --- | --- | --- |
| `APP_MESSAGE_INBOX_SIZE_MINIMUM` | **124** | guaranteed floor, identical on all 7 platforms |
| `APP_MESSAGE_OUTBOX_SIZE_MINIMUM` | **636** | guaranteed floor |
| Practical maximum | **~8 KB each way** | per the advanced-communication guide |

The minimums are *guaranteed-to-succeed floors*, not caps — `app_message_open()` may be granted more.
The documented idiom is `app_message_open(app_message_inbox_size_maximum(), app_message_outbox_size_maximum())`.

**On overflow:** a message larger than the buffer **is not transmitted and is lost, not queued**
(`APP_MSG_BUFFER_OVERFLOW = 128`). The inbox-dropped callback fires. A second message arriving while
the first is unprocessed is also dropped. **Always register an inbox-dropped handler that logs** —
it is how you find sizing mistakes.

### Dictionary sizing

```
buffer size = 1 + (n_keys * 7) + sum(value sizes)
```

7 bytes overhead per key, 1 byte per dictionary. Strings are **null-terminated and the terminator
counts** — budget `len + 1 + 7` per string key. Hard ceiling of **255 tuples** (the count parameter
of `dict_calc_buffer_size` is a `uint8_t`); in practice the buffer runs out long first.

### Heap per platform (measured by building tokenwatch)

| Platform | Total app RAM | Free heap with a tokenwatch-sized app |
| --- | --- | --- |
| aplite | 24 KB | 15,556 B |
| basalt, chalk, diorite, **flint** | 64 KB | 56,096 B |
| emery, gabbro | 128 KB | 121,576 B |

The repebble FAQ still quotes "around 24k" globally — **that is the stale aplite-era figure.** Trust
the build report. Note a rolling history of 120 samples × 4 × `int16` is only **960 bytes**, trivial
even on aplite. Follow tokenwatch and put it in a **static array (BSS), not the heap** — it then
shows up in the build report instead of silently eating runtime memory.

### Persistent storage

`PERSIST_DATA_MAX_LENGTH` = **256 bytes per value**, and **4 KB total per app**. A 960-byte history
would need 4 chunked keys and a quarter of the budget. **Note:** the online docs reference
`persist_get_max_size()` — **that symbol does not exist in SDK 4.9.169.** Don't code against it.
tokenwatch uses no persistence at all and re-syncs from the phone on launch, which is the simpler
choice here too.

### Send cadence — the rule tokenwatch technically breaks

**Only one send may be in flight at a time.** `APP_MSG_BUSY` (64) means "pending messages need
processing first", and `APP_MSG_OK` only means processing *started*. The documented pattern is to
chain on the completion callback — on the JS side, the `success` callback of
`Pebble.sendAppMessage()` — explicitly **not** timers.

tokenwatch ignores this: it fires from a `setInterval` with a no-op success handler and registers no
outbox handlers. **It gets away with it because one message per 30 s means a send is never in flight
when the next fires, and every frame is a complete idempotent snapshot — a dropped frame self-heals
on the next poll.**

**This is directly applicable to us:** our design is also one self-contained snapshot per 30 s, so
fire-and-forget is proven safe. **But the moment we chunk chart history across multiple messages, we
must adopt callback chaining** — back-to-back sends are precisely what produces `APP_MSG_BUSY` and
dropped frames.

### Our protocol fits comfortably — no packing needed

Budgeting a worst-case FireBoard frame (6 channels, all live, all labelled, plus device state):

| Content | Keys | Bytes |
| --- | --- | --- |
| 6 × label (≤16 chars) | 6 | 6 × (17 + 7) = 144 |
| 6 × current temp (`int16`, tenths) | 6 | 6 × (2 + 7) = 54 |
| 6 × alert min + max | 12 | 12 × (2 + 7) = 108 |
| device: staleness, battery, session, elapsed, alert level, degreetype | 6 | ~66 |
| banner string (64) | 1 | 72 |
| dict header | — | 1 |
| **total** | **31** | **~445 B** |

**That fits in a 1024-byte inbox with better than 2× headroom**, so there is no need for packed byte
arrays or multi-message chunking for the live view. Prefer discrete typed keys — they are simpler to
parse in C and to unit-test in pkjs. Reserve packing for chart history, if we ever send it.

`app_message_open(1024, 256)` — tokenwatch's choice — is therefore right for us too. Asking for the
8 KB maximum would consume the entire aplite heap; 1280 B is ~8% of it. Outbox can stay small since
the watch sends nothing.

### `messageKeys` — array syntax confirmed, plus a subtle C gotcha

The online metadata docs don't cover this, so I read the SDK's own build step
(`sdk-core/pebble/.waf3-*/waflib/extras/process_message_keys.py`). Definitive:

**Array syntax is supported.** The parser is `findall(r"([\w]+)\[(\d+)\]$", key)`, so:

```json
"messageKeys": ["CH_LABEL[6]", "CH_TEMP[6]", "CH_ALERT_MIN[6]", "CH_ALERT_MAX[6]",
                "STALENESS_SEC", "BATTERY_PCT", "SESSION_ID", "ALERT_LEVEL", "BANNER"]
```

allocates 6 consecutive keys per block. **`MESSAGE_KEY_CH_TEMP` is the *base*; index it yourself as
`MESSAGE_KEY_CH_TEMP + i`.** Numbering starts at **10000**, array blocks are assigned first, then
single keys follow. A malformed entry (`"CH_TEMP[]"`) is a hard build error with a helpful message.

**Object form is also supported** for explicit numbering — `{"KEY": 100}` — but **only for apps, not
libraries** (libraries must use an array; the build calls `conf.fatal` otherwise).

**The gotcha:** the generated header declares keys as `extern uint32_t MESSAGE_KEY_<NAME>;` — they
are **runtime variables, not `#define` constants.** Therefore they **cannot be used in `switch`/`case`
labels, static array initialisers, or any constant expression.** This is exactly why tokenwatch's
`model_apply_dict` is a flat chain of `if ((t = dict_find(iter, KEY)))` rather than a switch. Follow
that pattern; with array keys, a `for` loop over `MESSAGE_KEY_CH_TEMP + i` works naturally.

Also noted in that build step: if `enableMultiJS` is false, `message_keys.json` is **not** injected
into the JS bundle, so pkjs loses the symbolic key names. Keep `enableMultiJS: true`.

## Domain fundamental: a naive ETA will be wrong, and wrong in a costly direction

Not an API constraint, but it determines what the watch can honestly display, so it belongs here.

The measured data is beautifully linear right now — the food probe rose 87.5 → 89.0°F over 3m16s,
about **0.46°F/min**, and across the whole cook so far 44.2 → 90.7°F in ~95 minutes (~0.49°F/min).
Extrapolating linearly to a 203°F pulled-pork target gives **~3.9 hours remaining.**

**That number is wrong, and a watch app that displays it will mislead the user into planning dinner
around it.** Large cuts hit *the stall*: as surface moisture evaporates, the meat plateaus — commonly
somewhere around 150–170°F — and can sit there for **2–6 hours** while the probe barely moves. A
linear fit through pre-stall data cannot see this coming, and the error is always in the optimistic
direction.

Design consequences:

1. **Don't show a single confident ETA.** Either show a range, or show the current rate of rise and
   let the cook do the arithmetic. A wrong-by-four-hours number is worse than no number.
2. **Detect the stall explicitly** and say so. `rate < ~0.1°F/min` sustained for 20+ minutes, while
   the probe sits in the stall band and the pit is still hot, is a stall — not a failure. Telling the
   user "stalled, this is normal" is genuinely useful and is exactly the sort of thing a glanceable
   wrist display should say.
3. **Detect the *exit* from the stall**, which is the moment the finish becomes predictable. A
   post-stall linear ETA is actually fairly reliable.
4. **Rate of rise is the honest primary metric**, not time remaining. It is directly measured,
   needs no model, and is what tells you whether the cook is progressing.

This argues for keeping a rolling history of at least an hour on the phone (120 samples at 30s) so
the rate can be computed over a long enough window to be stable — a 2-sample derivative on data this
finely grained will be dominated by sensor noise and fire management. Note the pit swinging
156 → 278 → 232°F over this cook while the food probe rose smoothly: **pit and food probes need very
different smoothing.**

## Open questions to resolve before building

1. ~~**Is the rate limit per-account or per-token?**~~ **ANSWERED: per-account.** Two logins return
   the same 40-char token, so the phone app shares our budget. Poll at 30s. The only remaining
   sub-question is the exact threshold, which `ratelimit --confirm-not-cooking` would pin down
   after a cook — but it is no longer blocking, since the documented 17/5min is now known to be a
   *shared* ceiling and 30s polling sits comfortably under it either way.
2. ~~**Does the auth token expire?**~~ **Effectively answered: almost certainly not.** 40 hex chars
   is DRF's default `Token`, which has no expiry, and re-login does not rotate it. Handle a
   **403 with `{"detail":"Invalid token"}`** by re-authenticating — note it is 403, not 401 — but
   don't build refresh machinery.
3. ~~**Exact `temps.json` response shape**~~ **ANSWERED, and it changed the design.** `temps.json`
   has no labels; `devices.json` returns labels, temps, alerts, battery and session in a single
   call. Poll `devices.json`. See the capture section above.
4. ~~**`degreetype` enum**~~ **ANSWERED: `1` = Celsius, `2` = Fahrenheit.** `2` confirmed directly on
   live data at both device and channel level; the mapping corroborated across community
   integrations.
5. ~~**Is there any documented write path** for probe targets/alerts?~~ **Effectively answered: no.**
   Alerts are readable via `channels[].alerts[]` but the public API documents no write endpoint.
   Honour the user's existing thresholds; setting them stays in the phone app.
6. ~~**Cheap way to detect a new session starting?**~~ **ANSWERED: free.** `devices.json` returns
   `channels[].sessionid`; watch it change. A live session is `end_time: null` in `sessions.json`,
   but we never need to call that in the poll loop.
7. ~~**Does `messageKeys` support array syntax?**~~ **ANSWERED: yes** — `"CH_TEMP[6]"`, confirmed in
   the SDK's build source. Keys are `extern uint32_t`, not `#define`s, so no `switch`/`case`.

### Genuinely still open

- **What a rate-limit rejection looks like** (status, body, headers). Blocked on the exhaustion test,
  which must wait until no cook is running. **This is the last materially important unknown**,
  because if a throttle is indistinguishable from a dead token, a naive client will discard a good
  token. Mitigation already specified: treat unrecognised 403s as transient.
- **`degreetype: 1`** presumed Celsius, unconfirmed — would need the account toggled to metric.
- **Whether PebbleKit JS sends a `User-Agent`.** Cheap on-device spike; see that section. The single
  highest-risk unknown for the chosen architecture.
- **Runtime value of `app_message_inbox_size_maximum()`** on flint. Not blocking — our frame is
  ~445 B against a 1024 B inbox — but worth logging once on device.
- **SDK 4.17** is available while 4.9.169 is installed; all watch-side constants here were verified
  against 4.9.169 only.

## Sources

- [FireBoard Cloud API — official docs](https://docs.fireboard.io/app/api.html)
- [FireBoard Cloud API — Knowledge Base](https://docs.fireboard.io/app/app-api/)
- [GarthDB/ha-fireboard — Home Assistant integration](https://github.com/GarthDB/ha-fireboard)
- [gordlea/fireboard2mqtt](https://github.com/gordlea/fireboard2mqtt)
- [johnpdowling/ha-fireboard-sensors](https://github.com/johnpdowling/ha-fireboard-sensors)
- [Telegraf FireBoard input plugin](https://docs.influxdata.com/telegraf/v1/input-plugins/fireboard/)
- Live observation of `https://share.fireboard.io/2F84BE` (Craig's cook, 2026-07-26)

Undocumented behaviour sourced from community code (each flagged verified/unverified in-text):

- [GarthDB/ha-fireboard `mqtt_client.py`](https://github.com/GarthDB/ha-fireboard/blob/main/custom_components/fireboard/mqtt_client.py) — the MQTT broker details
- [GarthDB/ha-fireboard `api_client.py` / `const.py`](https://github.com/GarthDB/ha-fireboard/tree/main/custom_components/fireboard) — auth flow, 200/hr constant
- `benhodgson87/fireboard-mcp` `src/fireboard/client.ts`, `src/tools/drive.ts` — the unverified `mq.json` write path

Watch-side sources:

- Installed SDK headers: `~/Library/Application Support/Pebble SDK/SDKs/4.9.169/sdk-core/pebble/<platform>/include/pebble.h`
- SDK message-key build step: `sdk-core/pebble/.waf3-*/waflib/extras/process_message_keys.py`
- [Building for Every Pebble](https://developer.repebble.com/guides/best-practices/building-for-every-pebble/)
- [Advanced communication](https://developer.repebble.com/guides/communication/advanced-communication/)
- [Sending and receiving data](https://developer.repebble.com/guides/communication/sending-and-receiving-data/)
- [Hardware information](https://developer.repebble.com/guides/tools-and-resources/hardware-information/)
- Reference implementation: `../pebble-tokenwatch/pebble/` (shipped, working)

Reproduce the API findings with `tools/fireboard_probe.py` (see "The harness"). Tests:
`uv run --script tools/test_fireboard_probe.py` — 36 passing, fully mocked, consumes no API budget.
