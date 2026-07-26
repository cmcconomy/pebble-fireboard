# Test fixtures

`devices.json` is a real `GET /api/v1/devices.json` capture with `device_log`
removed (it contains SSID, MAC addresses, and public IP — never commit it).

It deliberately preserves four awkward real-world conditions:

- **ch3, ch4 are live** (`current_temp` present) — the only two that should render.
- **ch4 "pit" is live but has no alert.** This is the real configuration that
  produced a pit alarm that could never fire.
- **ch6 is also labelled "pit"**, is disabled, and holds the stranded 210–240°F
  alert. Pit detection must not choose it.
- **ch1, ch2, ch5 are enabled but unplugged** — labels present, no `current_temp`.
  Liveness is `current_temp`, never the `enabled` flag.
