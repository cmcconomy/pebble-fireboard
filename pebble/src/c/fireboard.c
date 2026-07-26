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
  // s_model deliberately survives a window reload (the OS can unload/reload
  // this window's layers behind a modal or notification while the app keeps
  // running). Re-initializing it here would blank a live cook mid-alert.
  // ui_create() just reset the UI's own copy, so this repaints it with the
  // still-live data rather than resetting it.
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
