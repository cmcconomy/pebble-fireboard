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

// Idle (not-cooking) zones. The clock rides higher when a banner must share
// the screen with it.
#define ZONE_IDLE_CLOCK_Y         28
#define ZONE_IDLE_CLOCK_Y_BANNER  22
// 44px time row + 20px date row + 4px gap. Fixed, because widget_draw_clock's
// fonts are fixed pixel sizes and do not scale with screen height.
#define IDLE_CLOCK_BLOCK_H        68
#define IDLE_BANNER_MIN_H         18

void layout_ledger_draw(GContext *ctx, GRect b, const CookModel *m) {
  bool cooking = model_is_cooking(m);
  bool stale = model_is_stale(m);
  bool show_alerts = model_show_alerts(m);

  if (!cooking) {
    // Idle: a plain, full-size clock. Nothing about FireBoard on screen —
    // UNLESS the phone sent a banner. Every error state (NO SIGNAL, SIGN IN
    // AGAIN, PAUSED, TRY AGAIN LATER) arrives as not-cooking plus a banner;
    // returning early here made all of them render as a bare clock, so a cook
    // could silently vanish for an hour with nothing on screen to say why.
    bool has_banner = (m->banner[0] != '\0');
    int banner_h = widget_pct_of(b.size.h, ZONE_BANNER_H);
    if (banner_h < IDLE_BANNER_MIN_H) banner_h = IDLE_BANNER_MIN_H;
    // Lift the clock when a banner shares the screen so the two cannot
    // overlap. The large clock's glyphs are a FIXED pixel height (a 44px time
    // row over a 20px date row), not a percentage, so the reserved block is a
    // constant too -- a percentage here would collide on the shorter screens.
    int y = b.origin.y + widget_pct_of(b.size.h,
                has_banner ? ZONE_IDLE_CLOCK_Y_BANNER : ZONE_IDLE_CLOCK_Y);
    int clock_h = has_banner ? IDLE_CLOCK_BLOCK_H
                             : (b.size.h - (y - b.origin.y));
    widget_draw_clock(ctx, GRect(b.origin.x, y, b.size.w, clock_h), true);

    if (has_banner) {
      // Same inversion rule as the cooking branch: inverted means "needs you",
      // so SIGN IN AGAIN reads as urgent while PAUSED stays plain information.
      bool invert = show_alerts && m->alert_level >= FB_LEVEL_WARN;
      widget_draw_banner(ctx, GRect(b.origin.x, y + clock_h, b.size.w, banner_h),
                         m->banner, invert);
    }
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
    bool has_flag = !has_band && show_alerts && (p->flags & FB_FLAG_IS_PIT);
    int needed = row_h + (has_band ? band_h + 2 : (has_flag ? 14 : 0));
    if (y + needed > body_limit) break;      // never overflow into the footer

    widget_draw_probe_row(ctx, GRect(b.origin.x, y, b.size.w, row_h), p,
                          show_alerts, stale, m->degreetype);
    y += row_h;

    if (has_band) {
      widget_draw_band(ctx, GRect(b.origin.x + 4, y, b.size.w - 8, band_h), p, stale);
      y += band_h + 2;
    } else if (has_flag) {
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
