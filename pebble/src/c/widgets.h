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
