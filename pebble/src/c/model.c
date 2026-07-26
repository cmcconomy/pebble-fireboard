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
