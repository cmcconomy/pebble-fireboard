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
