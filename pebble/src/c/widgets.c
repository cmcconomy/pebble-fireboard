#include "widgets.h"
#include <string.h>

int widget_pct_of(int total, int pct) { return (total * pct) / 100; }

// ASCII only. The flint system font has no degree glyph -- a literal '\xc2\xb0'
// renders as a tofu box -- so the unit letter from DEGREETYPE carries the job
// instead: "234F" / "112C". DEGREETYPE is 1 = Celsius, 2 = Fahrenheit; anything
// else is an unparsed/absent field and falls back to Fahrenheit, matching
// model_init's default.
static char degree_suffix(uint8_t degreetype) {
  return (degreetype == 1) ? 'C' : 'F';
}

static void format_temp(char *buf, size_t cap, int16_t tenths, bool parens,
                        uint8_t degreetype) {
  int whole = tenths / 10;
  char u = degree_suffix(degreetype);
  if (parens) {
    snprintf(buf, cap, "(%d%c)", whole, u);
  } else {
    snprintf(buf, cap, "%d%c", whole, u);
  }
}

// flint/aplite/diorite are 1-bit. Grey must be simulated. Used only for the
// stale band fill — never behind text, where any texture destroys
// legibility at 144x168.
//
// A 45-degree hatch (lines spaced ~2px apart in diagonal offset) reads as
// grey at watch viewing distance while costing O(width+height) draw_line
// calls, versus the O(width*height) draw_pixel calls a checkerboard needs.
// For a realistic band rect this is roughly a dozen line calls instead of
// several hundred pixel calls, which matters because this runs from
// update_proc on every redraw for as long as a probe stays stale (hours).
static void fill_hatched(GContext *ctx, GRect r) {
  graphics_context_set_stroke_color(ctx, GColorWhite);
  int w = r.size.w;
  int h = r.size.h;
  // k is the diagonal offset (x - y) of each hatch line, in rect-local
  // coordinates. Stepping by 2 keeps the lines visibly separated (not solid)
  // while still reading as a filled band (not empty).
  for (int k = -(h - 1); k <= w - 1; k += 2) {
    int x0 = k > 0 ? k : 0;
    int x1 = (k + h - 1) < (w - 1) ? (k + h - 1) : (w - 1);
    if (x0 > x1) continue;
    int y0 = x0 - k;
    int y1 = x1 - k;
    graphics_draw_line(ctx, GPoint(r.origin.x + x0, r.origin.y + y0),
                             GPoint(r.origin.x + x1, r.origin.y + y1));
  }
}

void widget_draw_clock(GContext *ctx, GRect area, bool large) {
  // static: reused across calls to avoid per-frame heap churn; safe only
  // because Pebble's draw path is synchronous and single-threaded.
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
                           bool show_alerts, bool stale, uint8_t degreetype) {
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

  // static: reused across calls; safe only because Pebble's draw path is
  // synchronous and single-threaded (no concurrent writers).
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

  // static: safe only because Pebble's draw path is synchronous and
  // single-threaded.
  static char value[16];
  format_temp(value, sizeof(value), p->temp_tenths, stale, degreetype);

  // Rate is shown only for probes with no band to draw, and never when stale:
  // a stale reading must not look like it is still moving.
  bool show_rate = !stale && !(p->flags & FB_FLAG_HAS_ALERT);
  if (show_rate) {
    // static: safe only because Pebble's draw path is synchronous and
    // single-threaded.
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
  // Guard both dimensions before any fill call: a caller passing a band
  // area shorter than 4px (plausible on a round platform's tightly-inset
  // layout) would otherwise produce a negative-height GRect, whose
  // behaviour in graphics_fill_rect is unspecified/platform-dependent.
  if (fill.size.w <= 0 || fill.size.h <= 0) return;

  if (stale) {
    fill_hatched(ctx, fill);
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
  // static: reused across calls; safe only because Pebble's draw path is
  // synchronous and single-threaded.
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
