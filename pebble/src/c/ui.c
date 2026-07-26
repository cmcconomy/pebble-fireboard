#include "ui.h"
#include "layout_ledger.h"

static Layer     *s_canvas;
static CookModel  s_model;

static void canvas_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_unobstructed_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  // Plan 2 adds Hero and Progress dispatch here on s_model.layout. Until then
  // every layout value renders as Ledger, which is why the LAYOUT key is
  // already parsed and carried through the frame.
  layout_ledger_draw(ctx, b, &s_model);
}

void ui_create(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_unobstructed_bounds(root);
  model_init(&s_model);
  s_canvas = layer_create(b);
  layer_set_update_proc(s_canvas, canvas_update);
  layer_add_child(root, s_canvas);
}

void ui_set_model(const CookModel *m) {
  s_model = *m;
  if (s_canvas) layer_mark_dirty(s_canvas);
}

void ui_destroy(void) {
  if (s_canvas) { layer_destroy(s_canvas); s_canvas = NULL; }
}
