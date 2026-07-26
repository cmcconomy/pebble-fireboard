# pebble-fireboard — Watchface Design

**Date:** 2026-07-26
**Status:** Approved for planning
**Research basis:** [`docs/research/2026-07-26-fireboard-api-research.md`](../../research/2026-07-26-fireboard-api-research.md)
**Reference implementation:** `../pebble-tokenwatch/pebble/`

A Pebble **watchface** showing live FireBoard cook data. Idle it is a plain clock; when a cook
starts, probe rows appear automatically. Data comes from the official FireBoard Cloud API, polled
by PebbleKit JS on the phone.

## Goals

1. Answer "is the cook OK?" from a wrist flick, without launching anything.
2. Buzz when something needs attention — reusing the thresholds already configured in FireBoard.
3. Be a good everyday watchface the other 95% of the time.
4. Never present stale data as live.

## Non-goals

- Controlling the FireBoard (fan/Drive, setting targets). Read-only. See the research doc's
  unverified `mq.json` write path — explicitly out of scope.
- Long-term cook archives or analytics. No daemon tier.
- Replacing the FireBoard phone app.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Form factor | **Watchface**, not watchapp | Cook data on every wrist-check; no launching. Costs button input entirely. |
| Idle state | **Plain clock**, cook UI appears automatically | Must earn its place as a daily driver. |
| Probe selection | **All live probes** (max 4), pit distinguished | No magic selection; what's plugged in is what you see. |
| Layouts | **Ledger (default)**, Hero pit, Progress — user-selectable | User chose the full picker over a single tunable layout. |
| Alert source | **FireBoard's own `channels[].alerts[]`** | No duplicate config to drift. |
| Alert control | **Separate toggles** for visual and vibration, plus quiet hours | Silence the buzz overnight without losing the display. |
| Pit detection | **Auto by label, overridable in config** | Zero setup, never traps you. |
| Colour | **Mono-first; colour additive** | Target watch (`flint`) is 1-bit. |
| Architecture | **pkjs polls cloud directly; no daemon** | Works away from home, which is when you need it. |

## Architecture

```
FireBoard device ──WiFi──▶ FireBoard cloud ──HTTPS 30s──▶ pkjs (phone) ──AppMessage──▶ watchface (C)
                                                          polls, derives,               renders, buzzes
                                                          decides alerts
```

All policy lives in pkjs. The watch renders what it is given and never filters, sorts, or decides
which probe is the pit. This matters more than usual because a watchface has no buttons and no way
out of a bad state except the next redraw.

**Why no daemon** (unlike tokenwatch): tokenwatch's data source was local files only its host could
see. FireBoard's data is in the cloud, so the phone can reach it from anywhere — which is precisely
the situation that matters, standing at a smoker or out buying more charcoal.

### pkjs modules

Pure and dependency-injected so they unit-test in Node. Only `index.js` touches `Pebble`,
`XMLHttpRequest`, `localStorage`, or timers.

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `fireboard.js` | HTTP client: `Token` auth, User-Agent, 403 taxonomy, backoff | injected xhr factory |
| `budget.js` | Rolling 5-min call ledger; refuses calls over the cap | injected clock + storage |
| `model.js` | `devices.json` → normalised probes; strips `device_log`; resolves pit | — |
| `history.js` | 120-sample window; rate of rise; stall detect; session reset | injected clock |
| `alerts.js` | Probe state + `alerts[]` → level, banner, transition | injected clock |
| `transform.js` | Normalised state → AppMessage frame | — |
| `config.js` | Config URL building and response parsing | — |
| `index.js` | Wiring, timers, Pebble events | all of the above |

### Watch C files

| File | Responsibility |
| --- | --- |
| `fireboard.c` | Lifecycle, AppMessage, tick/battery services, vibration |
| `model.c` | Dictionary → `CookModel` struct |
| `widgets.c` | Shared primitives: clock header, probe row, band gauge, banner, footer |
| `layout_ledger.c`, `layout_hero.c`, `layout_progress.c` | Compose widgets; one small vtable each |
| `ui.c` | Dispatch to selected layout; owns nothing else |

Each layout file should stay under ~120 lines because the widgets do the drawing. This is what keeps
three layouts from tripling the work: the awkward cases (probe with no alert, 4 probes, offline,
round screens) live in the widget layer and are fixed once.

## Data flow

```
every 30s (pkjs):
  budget.check()                     → skip if 17 calls in trailing 5 min
  GET /api/v1/devices.json           → ~3.6 KB, constant size
  strip device_log                   → SSID / MACs / public IP never leave the client
  live = channels with current_temp  → typically 2–3 of 6
  pit  = auto-detect or config override
  if sessionid changed → history.reset()
  history.push(live)
  alerts.evaluate(live, prev)
  sendAppMessage(frame)              → ~424 B
```

**Elapsed time is free.** `devices.json` has no session `start_time`, but `channels[].created`
(`13:32:45Z`) tracks the session's actual start (`13:32:39Z`) within seconds. No extra call.

**Poll interval is 30s**, one call per cycle — 10 calls per 5 minutes against a **shared** ceiling of
17. The budget is shared with the FireBoard phone app, so the headroom is not ours alone.

## AppMessage frame

```json
"messageKeys": [
  "P_LABEL[4]", "P_TEMP[4]", "P_MIN[4]", "P_MAX[4]", "P_RATE[4]", "P_FLAGS[4]",
  "N_PROBES", "ELAPSED_SEC", "STALENESS_SEC", "FB_BATTERY",
  "SESSION_ID", "ALERT_LEVEL", "BANNER", "LAYOUT", "DEGREETYPE", "STATE_FLAGS"
]
```

- Temperatures and rates are `int16` in **tenths of a degree** (92.1°F → `921`). No floats on the watch.
- **All conversion happens in pkjs.** The watch renders whatever `DEGREETYPE` says the values
  already are; it never converts. Stall thresholds are defined in °F and converted alongside the
  readings, so a Celsius account gets a correctly-scaled stall band rather than a nonsensical one.
- `P_FLAGS` bitfield per probe: `IS_PIT`, `HAS_ALERT`, `OUT_OF_BAND`, `STALLED`.
- `STATE_FLAGS`: `COOKING`, `SHOW_ALERT_VISUALS`, `STALE`.
- pkjs sends **only live probes, pre-sorted, pit first**, capped at 4.

**Budget: 34 tuples, ~424 bytes** against a 1024-byte inbox — better than 2× headroom, so no
chunking and no callback-chaining. `app_message_open(1024, 256)`.

Sizing rule (verified against SDK 4.9.169 headers): `1 + (n_keys × 7) + Σ value sizes`, strings
null-terminated with the terminator counted.

> ⚠️ Message keys are `extern uint32_t` **variables**, not `#define` constants — they cannot appear
> in `switch`/`case` or static initialisers. Use `dict_find` chains, and loop over
> `MESSAGE_KEY_P_TEMP + i` for array keys.

## Display

Target is **`flint`: 144×168, `PBL_BW`, 1 bit per pixel** (verified in the SDK platform
definitions). Colour begins at `basalt`.

### Layout A — Ledger (default)

```
    3:47          clock, full size
  SUN JUL 26
─────────────
PIT     234°      pit row + band gauge
[███████░░░]
210      240
BUTT     92° +0.5 food rows: temp + rate of rise
4h12m      ·12s   footer: elapsed | data age
```

Layouts B (hero pit) and C (per-probe progress bars) share every state and widget; only composition
differs. Selected via `LAYOUT` in the frame.

### States

| State | Trigger | Treatment |
| --- | --- | --- |
| Idle | no live probes | clock + date only, clock enlarged |
| Cooking | ≥1 live probe, fresh | full layout |
| Pit out of band | live temp outside `temp_min`/`temp_max` | **pit row inverted**, band solid, banner inverted, buzz on entry |
| No alert set | live probe with empty `alerts[]` | boxed `!` + `NO ALERT SET`, rate shown instead of band, **silent** |
| Offline | `last_templog` > 2 min | values in **parentheses**, dithered band fill, inverted `NO DATA 7m`, footer `×` |
| Stall | rate < 0.1°F/min for 20+ min, probe in 150–170°F, pit still above 200°F | banner `STALLED 40m — NORMAL`, **not inverted, no buzz** |

### Visual language

| Meaning | 1-bit | Colour |
| --- | --- | --- |
| Needs you now | inverted block (black on white) | `GColorOrange` block |
| Information | plain banner, not inverted | same |
| Stale value | parentheses + 50% dither fill + `×` | same, plus `GColorDarkGray` |
| Missing config | boxed `!` | boxed `!`, orange |
| Hierarchy | size + weight + caps | same |

Rules:

- **Geometry is identical across colour and mono.** Only ink values change, via
  `PBL_IF_COLOR_ELSE()` at each call site — never `#ifdef` around whole layout functions, which is
  how the two renders drift apart.
- **Inversion is reserved for "needs you".** If everything inverts, nothing does.
- **Never dither text.** Illegible at 144×168, and large dithered areas shimmer on refresh. Dither
  is used only for the stale band fill.
- `text_layer_set_text_color()` is called **unconditionally** with `GColorWhite` — the tokenwatch
  pitfall that produced an all-black screen.
- Derive all geometry from `layer_get_unobstructed_bounds()`; no hardcoded coordinates.

### Round platforms (`chalk`, `gabbro`)

In scope at basic quality: content inset to a circular safe area, banner not full-bleed, band
numbers dropped, footer omitted. The `.pbw` ships for all seven platforms so no watch gets a silent
install failure. Not a polish target for v1.

## Alerting

Levels: `OK`, `INFO` (stall), `WARN` (probe outside `temp_min`/`temp_max`), `CRITICAL` (food probe
reached its `temp_max`, i.e. done).

**Staleness is deliberately not an alert level.** It is carried by `STALENESS_SEC` plus
`STATE_FLAGS.STALE`, because it describes the *whole frame* rather than one probe, and because it
must be able to coexist with a pending alert — a pit that was 278°F when the device dropped off is
both stale and alarming. `ALERT_LEVEL` therefore only ever describes probe conditions.

- **Thresholds come from FireBoard**, never from watch-local config.
- **Vibrate on upward transition only.** Re-nag honours FireBoard's `minutes_repeat`.
- Patterns: INFO single short pulse; WARN triple; CRITICAL long-short-long.
- Quiet hours suppress vibration only; visuals remain.

**Unalerted-probe flagging is a first-class feature.** The live account demonstrates why: the pit
probe on channel 4 has no alert, while a 210–240°F alert sits stranded on disabled channel 6. The
pit alarm cannot fire and the phone UI does not say so.

## Error handling

Everything from the API is HTTP 403; status code alone cannot distinguish these.

| Condition | Detection | Watch shows | Recovery |
| --- | --- | --- | --- |
| Bad token | JSON `detail: "Invalid token"` | `SIGN IN AGAIN` | stop polling, await reconfig |
| Missing User-Agent | `content-type: text/html` | `APP ERROR` | log loudly — our bug |
| WAF CAPTCHA on login | 405 + `x-amzn-waf-action` | `TRY AGAIN LATER` | hard backoff, never retry-loop |
| Rate limited | 429 **or unrecognised 403** | `PAUSED` + resume time | exponential backoff, keep token |
| Network failure | XHR error/timeout | `NO SIGNAL` | backoff, keep last frame |
| Device offline | `last_templog` > 2 min | `NO DATA Xm` | keep polling |

**Load-bearing rule: an unrecognised 403 is transient, never an auth failure.** Discarding a good
token costs a reconfiguration; an unnecessary backoff costs one poll.

**Never log or forward `device_log`** — it carries SSID, both MAC addresses, and public IP.

## Configuration

`capabilities: ["configurable"]`, static config page, `showConfiguration` → `Pebble.openURL`,
`webviewclosed` → parse → `localStorage`.

```
Account    email / password → token exchanged once; only the token is stored
Display    Layout: (•) Ledger  ( ) Hero pit  ( ) Progress
           Pit probe: [auto: pit (ch4) ▾]
           Units: [Follow FireBoard ▾]  (Follow FireBoard | Always °F | Always °C)
Alerts     [x] Show alert state on face
           [x] Vibrate when alerts fire
           [ ] Quiet hours [22:00]–[06:00]
Advanced   Poll interval: [30s ▾]   (20s minimum, budget-guarded)

```

The password is never persisted. The token is long-lived and non-rotating, so re-login is rare —
and must never happen per-poll, given the WAF.

**On the 20s floor:** 20s is 15 calls per 5 minutes against a ceiling of 17 that is *shared with the
FireBoard phone app*. `budget.js` enforces the cap regardless of the configured interval, so the
worst case is skipped polls rather than a lockout — but the setting should be labelled as such in
the UI rather than presented as free.

## Testing

**pkjs under Jest**, all in Node, no device:

- `budget.js` refuses the 18th call in a window; allows it after expiry.
- `fireboard.js` maps each 403 shape to the correct state; unrecognised 403 → transient.
- `model.js` strips `device_log`; filters to live probes; resolves pit with duplicate labels.
- `history.js` resets on session change; computes rate; **detects the stall on the replayed
  11.4-hour cook** — the one derived metric that can be confidently wrong.
- `alerts.js` fires on transition only, honours `minutes_repeat` and quiet hours.
- `transform.js` frame stays under 1024 bytes with 4 probes and maximum-length labels.

**Fixtures from real captures** already on disk: today's `devices.json` and the 11.4-hour
`chart.json`, `device_log` stripped.

**Watch C**: frame-size assertion, inbox-dropped handler that logs, and manual emulator screenshots
per platform. No C unit-test harness — the logic that matters lives in pkjs by design.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **PebbleKit JS sends no `User-Agent`** | Fatal to the architecture — nginx returns HTML 403 | **Spike this first**: one XHR with a deliberately invalid token, check `pebble logs`. JSON = fine, HTML = fall back to a daemon tier. Any non-empty UA passes. |
| Rate-limit response shape unknown | Client may misclassify a throttle | Treat unrecognised 403 as transient; log raw status/headers/body on first occurrence |
| Three layouts triple the work | Schedule | Shared widget layer; each layout ≤120 lines |
| Round platforms underspecified | Poor UX on chalk/gabbro | Explicitly basic-quality for v1 |
| Watchface has no buttons | No in-app recovery | All state changes come from the next frame; config lives on the phone |

## Build order

1. **Spike the `User-Agent` question.** Everything else depends on it.
2. pkjs pure modules with Jest, against captured fixtures.
3. Watch C: model + widgets + Ledger layout, mono only.
4. Config page and token exchange.
5. Alerts and vibration.
6. Hero and Progress layouts.
7. Colour treatment, then round platforms.

## Open items carried from research

- Exact rate-limit response shape — run `tools/fireboard_probe.py ratelimit --confirm-not-cooking`
  after a cook. No one in the community has captured one.
- Runtime value of `app_message_inbox_size_maximum()` on flint. Not blocking.
- SDK 4.17 is available; all constants here verified against 4.9.169 only.
