#pragma once
#include <pebble.h>
#include "model.h"

void ui_create(Window *window);
void ui_set_model(const CookModel *m);
void ui_destroy(void);
