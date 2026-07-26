# Modern Pebble Development — Guardrails for Claude (pebble-fireboard)

Distilled from the sibling project `../pebble-tokenwatch` (built and shipped to real
hardware, May 2026). That repo is the **working reference implementation** — when in
doubt about project layout, build config, or C/pkjs patterns, copy from it rather
than from memory.

## Era check: this is Core Devices Pebble (2024–present), not Pebble Inc. (2013–2016)

Training-data memories of Pebble are mostly about the original company. **Verify
against canonical sources rather than answering from memory** — especially SDK
install commands, platform lists, tool names, and anything "deprecated."

| | Original Pebble Inc. (2013–2016) | Rebble (2016–2024) | Core Devices (2024–present) |
| --- | --- | --- | --- |
| Status | Defunct | Volunteer-run services | **Active commercial entity, new hardware** |
| Canonical docs | `getpebble.com` (gone) | `developer.rebble.io` (stale) | **`developer.repebble.com`** |
| SDK | 3.x/4.x frozen | light maintenance | **SDK 4.9.x, actively updated** |
| Web IDE | CloudPebble (dead) | — | **`cloudpebble.repebble.com`** |
| GitHub org | `pebble-dev` / `pebble` | — | **`coredevices`** |

If `developer.rebble.io` and `developer.repebble.com` disagree, trust repebble.

### Canonical sources

| Resource | URL |
| --- | --- |
| Developer hub | https://developer.repebble.com |
| Hardware information | https://developer.repebble.com/guides/tools-and-resources/hardware-information/ |
| App metadata (package.json/wscript) | https://developer.repebble.com/guides/tools-and-resources/app-metadata/ |
| Building for Every Pebble (layout best practices) | https://developer.repebble.com/guides/best-practices/building-for-every-pebble/ |
| Command line tool | https://developer.repebble.com/guides/tools-and-resources/command-line-tool/ |
| Developer connection (phone installs) | https://developer.repebble.com/guides/tools-and-resources/developer-connection/ |
| SDK install | https://developer.repebble.com/sdk |
| Web IDE | https://cloudpebble.repebble.com |
| App store | https://apps.repebble.com |

## Platform strings (all seven — build for all unless there's a reason not to)

**Verified from the SDK** (`sdk-core/pebble/common/tools/pebble_sdk_platform.py`), not from
memory or from tokenwatch's notes — which had `flint` wrong.

| Platform | Watch | Display | Colour | Notes |
| --- | --- | --- | --- | --- |
| `aplite` | Pebble Classic / Steel | 144×168 rect | **`PBL_BW`** | lowest memory (24 KB) |
| `basalt` | Pebble Time / Time Steel | 144×168 rect | `PBL_COLOR` | |
| `chalk` | Pebble Time Round | 180×180 round | `PBL_COLOR` | |
| `diorite` | Pebble 2 | 144×168 rect | **`PBL_BW`** | reissued by Core Devices |
| `emery` | Pebble Time 2 | 200×228 rect | `PBL_COLOR` | shipping 2026 |
| `flint` | **Pebble 2 Duo** | **144×168 rect** | **`PBL_BW`** | **Craig's actual watch — 1-bit, no colour** |
| `gabbro` | Pebble Round 2 | 260×260 round | `PBL_COLOR` | |

⚠️ **`flint` is 1-bit black and white.** An earlier version of this file (copied from
tokenwatch) claimed "1.5″ rect 64-color". That is **wrong**. Design the UI monochrome-first:
colour is an enhancement for basalt/chalk/emery/gabbro only, and **must never be the sole
carrier of meaning**. On `flint`, `aplite` and `diorite` there are exactly two ink values —
grey has to be faked with dither patterns, and dithered *text* is illegible at watch sizes.

Removing a platform from `targetPlatforms` = no `.pbw` for that watch = silent
install failure. Keep all seven.

## Tooling (macOS, canonical install)

```bash
brew install python node uv
uv tool install pebble-tool --python 3.13   # pebble-tool 5.x — modern Core Devices fork
pebble sdk install latest                    # SDK 4.9.x
```

**Never** install the legacy `pebble-sdk` Homebrew formula (2016-era, incompatible
with new hardware).

## Project bootstrapping rules

1. **Bootstrap with `pebble new-project <name>`** — never hand-write `package.json`
   or `wscript`. A missing `wscript` produces the cryptic error *"This project is
   very outdated, and cannot be handled by this SDK."* If hand-assembling, copy
   `wscript` verbatim from fresh `pebble new-project` output (or from
   `../pebble-tokenwatch/pebble/wscript` — it's the stock one).
2. Then customize in `package.json` → `pebble`:
   - `uuid` (regenerate — don't reuse tokenwatch's)
   - `displayName`
   - `messageKeys` (array of AppMessage key names; auto-numbered at build)
   - `capabilities` (e.g. `["configurable"]` if there's a settings webview)
   - `watchapp: { "watchface": false }` for an app (vs watchface)
   - `sdkVersion` stays `"3"` (still the current value per repebble docs)
3. `enableMultiJS: true` is the default now; declaring it explicitly is fine and
   documents intent.

### Repo layout that worked well (tokenwatch)

```
pebble/
├─ package.json        # pebble metadata + Jest devDependency
├─ wscript             # stock Waf script — required by SDK 4.9
├─ src/c/              # watch app: main .c + model.c/h + ui.c/h + appmsg_keys.h
├─ src/pkjs/           # phone companion: index.js + pure DI-style modules
├─ tests/              # Jest tests for the pure pkjs modules
└─ resources/images/   # PNGs registered under pebble.resources.media
```

## Build / install / debug commands

```bash
cd pebble
pebble build                        # → build/<name>.pbw
pebble install --emulator basalt    # QEMU with SDL window (visual check, no phone)
pebble install --phone <PHONE_IP>   # real watch via Core Devices app Dev Connection
pebble install --cloudpebble        # relay fallback (after `pebble login`)
pebble logs --phone <PHONE_IP>      # tail APP_LOG output from the watch
```

Phone install prerequisites: Core Devices app → Settings → Developer Mode ON →
Developer Connection ON (shows the Server IP). Phone and laptop on the same Wi-Fi
without AP/client isolation. AirDrop-ing the `.pbw` and opening it on the phone
also works with zero network requirements.

## Known pitfalls (all bitten in tokenwatch — do not re-hit)

1. **Developer Connection self-disables** after idle/overnight. Symptom: install
   worked an hour ago, now `libpebble2.exceptions.TimeoutError` — even though
   `nc -zv <ip> 9000` shows the port open (the TCP listener outlives the WebSocket).
   **First move on any hang: ask the user to re-toggle Dev Connection.**
2. **`pebble-tool 5.0.35` + `enableMultiJS: true` breaks `pebble ping`/
   `screenshot`/`send-app-message`** (libpebble2 TimeoutError; open issue
   pebble/pebble-tool#37). Installs still work. Use the QEMU SDL window for visual
   verification, or the richinfante/rebbletool fork.
3. **ICMP ping is not a phone-reachability test** (iOS/Android drop it). And a
   fresh `arp -n` showing `(incomplete)` proves nothing on macOS. The real test is
   just running `pebble install --phone <ip>`.
4. **Wi-Fi client isolation** kills `--phone` installs entirely. Fallbacks:
   `--cloudpebble` or AirDrop.
5. **Call `text_layer_set_text_color()` unconditionally.** Default text is black;
   on a black window background text is invisible. Use `GColorWhite` — it does the
   right thing on both color and mono. Never wrap it in `#ifdef PBL_COLOR`.
6. **Pebble system fonts miss typographic glyphs** (em dash U+2014 renders as tofu
   on flint; assume curly quotes/ellipsis too). Stick to ASCII in watch-rendered
   strings: `--` not `—`.
7. **PebbleKit JS is ES5 only** — stripped JSCore on the phone. No `const`/`let`,
   arrow functions, template literals, `class`, `for…of`, `Promise`. Use `var`,
   function declarations, callbacks, `XMLHttpRequest`. Modules via
   `require('./x')` work when `enableMultiJS` is on.

## Watch-side hard numbers (SDK 4.9.169 headers — verified, not from memory)

| Thing | Value |
| --- | --- |
| `APP_MESSAGE_INBOX_SIZE_MINIMUM` | 124 (guaranteed floor, all platforms) |
| `APP_MESSAGE_OUTBOX_SIZE_MINIMUM` | 636 |
| Practical AppMessage max | ~8 KB each way |
| Dict sizing | `1 + (n_keys * 7) + sum(value sizes)` |
| Strings in dicts | null-terminated, **terminator counts**: budget `len + 1 + 7` |
| Max tuples | 255 (`dict_calc_buffer_size` count is `uint8_t`) |
| Persist | **256 B per value, 4 KB total per app** |
| App RAM | aplite 24 KB · basalt/chalk/diorite/**flint** 64 KB · emery/gabbro 128 KB |
| Free heap (tokenwatch-sized app) | aplite 15.5 KB · flint 56 KB · emery 121 KB |

- **`app_message_open(1024, 256)` is the right default.** Asking for the 8 KB maximum would not fit
  on aplite at all. 1280 B is ~8% of aplite's heap.
- **Overflow loses the message** (`APP_MSG_BUFFER_OVERFLOW = 128`) — it is not queued. Always
  register an inbox-dropped handler that logs; it is how sizing bugs surface.
- **Only one AppMessage send may be in flight.** `APP_MSG_BUSY` = 64. The documented pattern is
  chaining on `Pebble.sendAppMessage()`'s success callback, *not* timers. Fire-and-forget from a
  `setInterval` is only safe when the cadence is slow (≥30 s) and every frame is a complete
  idempotent snapshot — which is how tokenwatch gets away with it.
- **Rolling history belongs in a static array (BSS), not the heap** — 120 samples × 4 × int16 = 960 B.
  It then appears in the build report instead of silently consuming runtime memory.
- **`persist_get_max_size()` does not exist** in SDK 4.9.169 despite being mentioned in the online
  docs. Don't code against it.
- The repebble FAQ's "around 24k" heap figure is the **stale aplite-era number**; trust the per-platform
  build report.
- **`messageKeys` supports array syntax** — `"CH_TEMP[6]"` allocates 6 consecutive keys, with
  `MESSAGE_KEY_CH_TEMP` as the *base* (index it as `MESSAGE_KEY_CH_TEMP + i`). Numbering starts at
  10000. The object form `{"KEY": 100}` works for apps but **not** libraries. Undocumented online;
  confirmed in `sdk-core/pebble/.waf3-*/waflib/extras/process_message_keys.py`.
- **Message keys are `extern uint32_t` variables, NOT `#define` constants.** They cannot appear in
  `switch`/`case` labels, static initialisers, or any constant expression. Use an `if`/`dict_find`
  chain (as tokenwatch does) or a loop over a base key.
- Installed SDK is **4.9.169**, but the toolchain reports **4.17 available** — these constants were
  verified against 4.9.169 only. Re-check if you upgrade.

## Layout rules (Building for Every Pebble)

- **Always** `layer_get_unobstructed_bounds(window_layer)`, never
  `layer_get_bounds()` — it shrinks correctly under Quick View overlays.
- **Never hardcode pixel coordinates.** Screens range 144×168 → 260×260. Derive
  positions as percentages of the fetched bounds (see the proportional-layout
  zone table in `../pebble-tokenwatch/pebble/src/c/ui.c` around line 199), or use
  `PBL_DISPLAY_WIDTH`/`PBL_DISPLAY_HEIGHT`.
- Prefer runtime-ish macros over preprocessor blocks: `PBL_IF_RECT_ELSE()`,
  `PBL_IF_ROUND_ELSE()`, `PBL_IF_COLOR_ELSE()`.
- Round watches (chalk/gabbro) clip corners — inset content or use the round
  macros when they matter.

## Architecture patterns that worked (copy these)

- **Three-tier data flow:** data source → PebbleKit JS on the phone (polls over
  HTTP, transforms, evaluates alerts) → `Pebble.sendAppMessage` → C app on the
  watch (renders only). Keep the watch C dumb; keep policy on the phone.
- **Pure, dependency-injected pkjs modules.** Everything except `index.js` takes
  its effects (xhr factory, clock, storage) as arguments → unit-testable in Node
  with Jest despite shipping to ES5 JSCore. `index.js` alone touches `Pebble`,
  `XMLHttpRequest`, `localStorage`, timers.
- **C separation:** `main.c` (lifecycle, AppMessage, services) / `model.c`
  (dict → struct) / `ui.c` (all drawing) / `appmsg_keys.h` (key enum mirroring
  `messageKeys`).
- **AppMessage:** `app_message_open(1024, 256)` (big inbox, small outbox) was
  ample; register `inbox_dropped` with an `APP_LOG` warning — it catches sizing
  mistakes immediately.
- **AppGlance** (`app_glance_reload` + `app_glance_add_slice`): highest-value
  modern feature for any data-monitoring app — shows a live status line in the
  launcher without opening the app. ~30 lines of C; publish on every fresh
  snapshot; set `expiration_time` so stale data disappears.
- **Vibes on transition, not on state.** Track the last alert level and
  `vibes_enqueue_custom_pattern()` only when the level rises. Buzzing on every
  poll is unbearable.
- **Config webview:** `capabilities: ["configurable"]`, `showConfiguration` →
  `Pebble.openURL(...)`, `webviewclosed` → parse `decodeURIComponent(e.response)`,
  persist to `localStorage`, rebuild clients/timers.
- **Watch battery & clock in-app:** `battery_state_service_peek()` +
  subscribe, `tick_timer_service_subscribe(MINUTE_UNIT, ...)` — prime once at
  window load, then let subscriptions update.

## JS flavors today

- **PebbleKit JS** (phone-side, ES5) — what tokenwatch uses; battle-tested path.
- **Alloy** (Core Devices, 2026) — JS/TS *on the watch* via Moddable XS, full
  ES2025. Out of dev-preview April 2026 but still has C-API gaps. Consider for a
  green-field JS-only app; don't assume an API exists — check current docs.

## FireBoard Cloud API — verified constraints

Full research: [`docs/research/2026-07-26-fireboard-api-research.md`](docs/research/2026-07-26-fireboard-api-research.md).
Everything here was **tested against the live API**, not read from docs. Canonical docs:
<https://docs.fireboard.io/app/api.html>.

**There is an official public REST API. No interception or reverse engineering is needed.**

| Fact | Detail |
| --- | --- |
| Auth | `Authorization: Token <40-hex>` — **not `Bearer`** (Bearer → 403) |
| Get token | `POST /api/rest-auth/login/` with username+password → `{"key": ...}` |
| Token lifetime | stable, non-rotating, no expiry. Log in once, store it. |
| **Rate limit** | **17 calls / 5 min, PER ACCOUNT — shared with the phone app** |
| Poll endpoint | **`GET /api/v1/devices.json`** — ~3.6 KB, constant size |
| Poll interval | **30 s.** One call per cycle. Never faster. |
| `User-Agent` | **mandatory**, any non-empty value. Missing → nginx HTML 403. |
| Errors | **everything is 403** — branch on `content-type` and `detail`, never status |
| Push | **undocumented MQTT** over WebSocket at `wss://fireboard.io/ws` (subprotocol `mqttv3.1`, cookie auth). **pkjs cannot use it** — no WebSocket in ES5 JSCore. Daemon-only, v2. |
| Writes | **probably exist** — `POST /api/v1/devices/{uuid}/mq.json` for Drive control. **Unverified; do not use without hardware testing.** |
| Login endpoint | behind **AWS WAF CAPTCHA** — cache the token, never log in per-poll |
| `degreetype` | `1` = Celsius, `2` = Fahrenheit |

### Gotchas that will bite

1. **Poll `devices.json`, not `temps.json`.** `temps.json` omits `channel_label`, forcing a second
   call to resolve probe names — doubling cost against a shared budget. `devices.json` returns
   labels, temps, alerts, battery and session id in one call.
2. **Never log or forward `devices.json`'s `device_log` object.** It contains the user's **SSID, both
   MAC addresses, and public IP**. Strip it before any logging, caching, or debug dump.
3. **Everything is HTTP 403, and there are three non-JSON failure shapes.** Bad token, missing auth,
   and a missing `User-Agent` all return 403; the login endpoint's WAF returns **405 + HTML +
   `x-amzn-waf-action: captcha`**. Distinguish by `content-type` first (HTML = edge block, not an
   auth problem), then by the JSON `detail` string. **Treat unrecognised 403s as transient and back
   off** — never discard the token on an ambiguous error, and never bounce the user to a
   re-enter-password screen on a WAF block.
4. **No rate-limit headers and no ETag/Last-Modified.** The client must self-track its call budget in
   a rolling 5-minute window. There is no cheap "has anything changed?" request.
5. **Channel liveness is not the `enabled` flag.** A channel is live only if `current_temp` /
   `last_templog` are present. Labels persist for unplugged channels, and labels can be duplicated
   across channels.
6. **Device-offline detection = `last_templog` stops advancing.** Live data is normally ~5 s fresh,
   so >2 min stale means the FireBoard dropped off. A stale-but-plausible temperature is the worst
   failure mode on a cook.
7. **Two different device identifiers.** `devices.json` uses a GUID; `chart.json` and the share page
   use a numeric string. They are not interchangeable.
8. **`sessions[].duration` is a human string** ("1 hour, 28 minutes"). Compute elapsed time from
   `start_time`.
9. **New-cook detection is free** — watch `channels[].sessionid` change in the poll response. Don't
   call `sessions.json` (17 KB) for it.
10. **`chart.json` is a one-shot, not a poll.** The server adaptively downsamples to ~300–350 points
    per series, so the payload is **bounded at ~16 KB even for an 11-hour cook** (measured). Fetch on
    app open or session change only, and downsample hard before sending anything to a watch.
    Points are **not** evenly spaced (gaps 60 s–1440 s) and series can span different periods when
    probes are added mid-cook — align on the `x` timestamps, never on array index.

### Verify before building

**PebbleKit JS must send a non-empty `User-Agent`.** `User-Agent` is a forbidden header in the XHR
spec, so `setRequestHeader` may be ignored. If pkjs sends none, FireBoard's nginx returns an HTML 403
and the phone-direct architecture is dead. Spike this first: one XHR with a deliberately invalid
token, then `pebble logs`. JSON body = fine; HTML body = fall back to a daemon tier.

## Heuristics for Claude in this project

- Any Pebble claim that could date from 2013-era training data: **verify first**
  (install commands, platform lists, tool existence, deprecations).
- Never hand-roll `targetPlatforms` or `wscript` — copy from `pebble new-project`
  output or from tokenwatch.
- Don't claim a pebble command "works" without running it — the modern toolchain
  has rough edges (see pitfalls).
- Prefer `developer.repebble.com` links over `rebble.io` in docs and answers.
- Test the pure logic: Jest for pkjs modules, pytest (via `uv`) for any Python
  companion service. tokenwatch shipped with 23 Jest + 53 pytest tests.
