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
  // Contract: only probes[0 .. n_probes-1] are meaningful. Consumers MUST
  // iterate `i < n_probes` and never read beyond it. Slots at or above
  // n_probes are explicitly zeroed by model_apply_dict on every update (so a
  // frame with fewer probes than the previous one cannot leave stale data
  // behind) and carry no meaning.
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
