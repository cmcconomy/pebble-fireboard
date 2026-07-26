#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx", "pydantic-settings", "pytest", "respx"]
# ///
"""Tests for fireboard_probe, using respx to mock the FireBoard API.

Run:  uv run --script tools/test_fireboard_probe.py
  or: uv run pytest tools/test_fireboard_probe.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import httpx
import pytest
import respx

sys.path.insert(0, str(Path(__file__).parent))

import fireboard_probe as fp  # noqa: E402

BASE = fp.BASE_URL
DEVICES_URL = f"{BASE}/api/v1/devices.json"
LOGIN_URL = f"{BASE}/api/rest-auth/login/"

# Shape mirrors what the live share page revealed: numeric-string device uuid,
# channel-keyed temps, degreetype 2 == Fahrenheit.
FAKE_DEVICE = {
    "id": 1234,
    "uuid": "15b1fff2-854f-4204-9a9a-79ba428e6144",
    "title": "FireBoard 2",
    "hardware_id": "FBX11C",
    "last_battery_reading": 0.78,
    "channels": [
        {"id": 3, "channel": 3, "enabled": True, "channel_label": "boneless butt",
         "current_temp": 84.4, "sessionid": 11569055, "alerts": []},
        {"id": 4, "channel": 4, "enabled": True, "channel_label": "pit",
         "current_temp": 278.9, "sessionid": 11569055,
         "alerts": [{"temp_min": 210.0, "temp_max": 240.0, "enabled": True}]},
        # enabled but unplugged: label present, no current_temp
        {"id": 1, "channel": 1, "enabled": True, "channel_label": "Hock",
         "sessionid": 11569055, "alerts": []},
    ],
    # Sensitive: must never be written to disk or logged.
    "device_log": {
        "ssid": "MyHomeNetwork",
        "macNIC": "aa:bb:cc:dd:ee:ff",
        "macAP": "11:22:33:44:55:66",
        "internalIP": "192.168.1.50",
        "publicIP": "203.0.113.7",
    },
}
FAKE_TEMPS = [
    {"temp": 232.6, "channel": 4, "degreetype": 2, "created": "2026-07-26T14:50:00Z"},
    {"temp": 74.8, "channel": 3, "degreetype": 2, "created": "2026-07-26T14:50:05Z"},
]


@pytest.fixture
def settings_with_token() -> fp.Settings:
    return fp.Settings(token="testtoken123456", username=None, password=None)


@pytest.fixture
def settings_with_creds() -> fp.Settings:
    return fp.Settings(token=None, username="cook@example.com", password="hunter2")


# --- request hygiene --------------------------------------------------------


@respx.mock
def test_every_request_sends_user_agent(settings_with_token):
    """The API rejects requests without a User-Agent (documented, 2025-01-02)."""
    route = respx.get(DEVICES_URL).mock(return_value=httpx.Response(200, json=[]))
    with fp.client(settings_with_token.token) as c:
        c.get("/api/v1/devices.json")
    assert route.calls[0].request.headers["User-Agent"] == fp.USER_AGENT


@respx.mock
def test_token_sent_as_token_scheme_not_bearer(settings_with_token):
    """FireBoard uses DRF's `Token <key>`, not `Bearer <key>`."""
    route = respx.get(DEVICES_URL).mock(return_value=httpx.Response(200, json=[]))
    with fp.client(settings_with_token.token) as c:
        c.get("/api/v1/devices.json")
    assert route.calls[0].request.headers["Authorization"] == "Token testtoken123456"


@respx.mock
def test_client_without_token_omits_authorization():
    route = respx.get(DEVICES_URL).mock(return_value=httpx.Response(403))
    with fp.client() as c:
        c.get("/api/v1/devices.json")
    assert "Authorization" not in route.calls[0].request.headers


# --- login ------------------------------------------------------------------


@respx.mock
def test_login_returns_key():
    respx.post(LOGIN_URL).mock(return_value=httpx.Response(200, json={"key": "abc123"}))
    assert fp.login("cook@example.com", "hunter2") == "abc123"


@respx.mock
def test_login_posts_credentials_as_json():
    route = respx.post(LOGIN_URL).mock(
        return_value=httpx.Response(200, json={"key": "abc123"})
    )
    fp.login("cook@example.com", "hunter2")
    body = json.loads(route.calls[0].request.content)
    assert body == {"username": "cook@example.com", "password": "hunter2"}


@respx.mock
def test_login_raises_on_bad_credentials():
    respx.post(LOGIN_URL).mock(
        return_value=httpx.Response(400, json={"non_field_errors": ["bad creds"]})
    )
    with pytest.raises(httpx.HTTPStatusError):
        fp.login("cook@example.com", "wrong")


def test_resolve_token_prefers_explicit_token(settings_with_token):
    """A supplied token must short-circuit login -- no network call, no wasted budget."""
    with respx.mock:
        # Any unexpected call raises, so this passing proves nothing was requested.
        assert fp.resolve_token(settings_with_token) == "testtoken123456"


@respx.mock
def test_resolve_token_logs_in_when_only_creds(settings_with_creds):
    respx.post(LOGIN_URL).mock(return_value=httpx.Response(200, json={"key": "fresh"}))
    assert fp.resolve_token(settings_with_creds) == "fresh"


def test_resolve_token_exits_without_credentials_when_not_a_tty(monkeypatch):
    monkeypatch.setattr(fp.sys.stdin, "isatty", lambda: False)
    with pytest.raises(SystemExit):
        fp.resolve_token(fp.Settings(token=None, username=None, password=None))


@respx.mock
def test_resolve_token_prompts_when_tty_and_no_credentials(monkeypatch):
    """A real terminal should prompt rather than fail -- the `!`-prefix trap."""
    monkeypatch.setattr(fp.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(fp, "prompt_credentials", lambda: ("cook@example.com", "hunter2"))
    respx.post(LOGIN_URL).mock(return_value=httpx.Response(200, json={"key": "prompted"}))
    assert fp.resolve_token(fp.Settings(token=None, username=None, password=None)) == "prompted"


def test_resolve_token_rejects_empty_prompt_input(monkeypatch):
    monkeypatch.setattr(fp.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(fp, "prompt_credentials", lambda: ("", ""))
    with pytest.raises(SystemExit):
        fp.resolve_token(fp.Settings(token=None, username=None, password=None))


def test_prompt_credentials_does_not_echo_password(monkeypatch):
    """Password must go through getpass, never input()."""
    monkeypatch.setattr("builtins.input", lambda _: "cook@example.com")
    monkeypatch.setattr(fp.getpass, "getpass", lambda _: "hunter2")
    assert fp.prompt_credentials() == ("cook@example.com", "hunter2")


# --- token persistence ------------------------------------------------------


def test_save_token_writes_file_with_owner_only_permissions(tmp_path):
    dest = tmp_path / ".env"
    fp.save_token("488af7deadbeef", dest)
    assert dest.read_text() == "FIREBOARD_TOKEN=488af7deadbeef\n"
    assert oct(dest.stat().st_mode)[-3:] == "600"


def test_save_token_replaces_prior_value_without_duplicating(tmp_path):
    dest = tmp_path / ".env"
    dest.write_text("FIREBOARD_TOKEN=old\nOTHER=keepme\n")
    fp.save_token("new", dest)
    text = dest.read_text()
    assert "FIREBOARD_TOKEN=new" in text
    assert "old" not in text
    assert "OTHER=keepme" in text  # unrelated keys survive
    assert text.count("FIREBOARD_TOKEN=") == 1


# --- login command ----------------------------------------------------------


@respx.mock
def test_login_twice_detects_same_key(monkeypatch, tmp_path, caplog):
    """The actual observed FireBoard behaviour: a stable, account-scoped token."""
    monkeypatch.setattr(fp, "ENV_FILE", tmp_path / ".env")
    respx.post(LOGIN_URL).mock(return_value=httpx.Response(200, json={"key": "a" * 40}))
    with caplog.at_level("INFO"):
        rc = fp.cmd_login(
            fp.Settings(token=None, username="cook@example.com", password="hunter2"),
            argparse.Namespace(twice=True, save_token=False),
        )
    assert rc == 0
    assert "SAME key" in caplog.text
    assert "per-account" in caplog.text


@respx.mock
def test_login_twice_detects_rotating_keys(monkeypatch, tmp_path, caplog):
    monkeypatch.setattr(fp, "ENV_FILE", tmp_path / ".env")
    keys = iter([{"key": "first"}, {"key": "second"}])
    respx.post(LOGIN_URL).mock(
        side_effect=lambda request: httpx.Response(200, json=next(keys))
    )
    with caplog.at_level("INFO"):
        rc = fp.cmd_login(
            fp.Settings(token=None, username="cook@example.com", password="hunter2"),
            argparse.Namespace(twice=True, save_token=False),
        )
    assert rc == 0
    assert "DIFFERENT key" in caplog.text


@respx.mock
def test_login_save_token_persists(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    monkeypatch.setattr(fp, "ENV_FILE", env)
    respx.post(LOGIN_URL).mock(return_value=httpx.Response(200, json={"key": "saved123"}))
    fp.cmd_login(
        fp.Settings(token=None, username="cook@example.com", password="hunter2"),
        argparse.Namespace(twice=False, save_token=True),
    )
    assert "FIREBOARD_TOKEN=saved123" in env.read_text()


def test_login_with_existing_token_makes_no_call():
    """Already have a token and not probing? Don't spend a call."""
    with respx.mock:  # any request would raise
        rc = fp.cmd_login(
            fp.Settings(token="existing", username=None, password=None),
            argparse.Namespace(twice=False, save_token=False),
        )
    assert rc == 0


# --- shape summarizer -------------------------------------------------------


def test_summarize_replaces_scalars_with_type_names():
    assert fp.summarize({"temp": 232.6, "channel": 4}) == {
        "temp": "float",
        "channel": "int",
    }


def test_summarize_collapses_lists_to_first_element_and_count():
    assert fp.summarize([1, 2, 3]) == ["int", "...x3"]


def test_summarize_marks_empty_list():
    assert fp.summarize([]) == "[] (empty)"


def test_summarize_preserves_null():
    assert fp.summarize({"drive": None}) == {"drive": "null"}


def test_summarize_truncates_beyond_max_depth():
    deep = {"a": {"b": {"c": {"d": {"e": 1}}}}}
    rendered = json.dumps(fp.summarize(deep))
    assert "keys" in rendered


def test_summarize_does_not_leak_credential_values():
    """The whole point of summarize(): shapes are safe to paste into a doc."""
    payload = {"token": "supersecret", "email": "cook@example.com"}
    assert "supersecret" not in json.dumps(fp.summarize(payload))
    assert "cook@example.com" not in json.dumps(fp.summarize(payload))


# --- redaction (security-relevant) ------------------------------------------


def test_redact_strips_device_log():
    out = fp.redact(FAKE_DEVICE)
    assert "device_log" not in out
    assert out["uuid"] == FAKE_DEVICE["uuid"]  # everything else survives


def test_redact_removes_every_sensitive_value():
    """SSID, MACs and IPs must not appear anywhere in the redacted output."""
    rendered = json.dumps(fp.redact(FAKE_DEVICE))
    for secret in ("MyHomeNetwork", "aa:bb:cc:dd:ee:ff", "11:22:33:44:55:66",
                   "192.168.1.50", "203.0.113.7"):
        assert secret not in rendered, f"leaked {secret}"


def test_redact_does_not_mutate_input():
    fp.redact(FAKE_DEVICE)
    assert "device_log" in FAKE_DEVICE


# --- capture ----------------------------------------------------------------


@respx.mock
def test_capture_writes_shapes_and_hits_temps_endpoint(tmp_path, settings_with_token):
    respx.get(DEVICES_URL).mock(return_value=httpx.Response(200, json=[FAKE_DEVICE]))
    temps_route = respx.get(
        f"{BASE}/api/v1/devices/{FAKE_DEVICE['uuid']}/temps.json"
    ).mock(return_value=httpx.Response(200, json=FAKE_TEMPS))

    out = tmp_path / "shapes.json"
    rc = fp.cmd_capture(settings_with_token, argparse.Namespace(out=str(out)))

    assert rc == 0
    assert temps_route.called
    written = json.loads(out.read_text())
    assert "devices.json" in written
    # Temperature values are not sensitive, so they're kept verbatim for the doc.
    assert written["temps.json (FireBoard 2) verbatim"] == FAKE_TEMPS


@respx.mock
def test_capture_never_writes_device_log_to_disk(tmp_path, settings_with_token):
    """Regression guard: the captured file is pasted into docs and shared."""
    respx.get(DEVICES_URL).mock(return_value=httpx.Response(200, json=[FAKE_DEVICE]))
    respx.get(f"{BASE}/api/v1/devices/{FAKE_DEVICE['uuid']}/temps.json").mock(
        return_value=httpx.Response(200, json=FAKE_TEMPS)
    )
    out = tmp_path / "shapes.json"
    fp.cmd_capture(settings_with_token, argparse.Namespace(out=str(out)))

    text = out.read_text()
    for secret in ("MyHomeNetwork", "aa:bb:cc:dd:ee:ff", "192.168.1.50", "203.0.113.7"):
        assert secret not in text, f"capture leaked {secret} to disk"
    # Not even the key names of the sensitive block should survive -- redaction
    # must happen before summarize(), which would otherwise record the shape.
    for key_name in ("device_log", "ssid", "macNIC", "publicIP"):
        assert key_name not in text, f"capture recorded sensitive key name {key_name}"
    # ...while still capturing the channel detail the protocol design needs.
    assert "boneless butt" in text
    assert "channel_label" in text


@respx.mock
def test_capture_returns_error_when_no_devices(tmp_path, settings_with_token):
    respx.get(DEVICES_URL).mock(return_value=httpx.Response(200, json=[]))
    rc = fp.cmd_capture(
        settings_with_token, argparse.Namespace(out=str(tmp_path / "s.json"))
    )
    assert rc == 1


@respx.mock
def test_capture_survives_stale_temps_endpoint(tmp_path, settings_with_token):
    """temps.json 404s when data is >60s old; that must not abort the capture."""
    respx.get(DEVICES_URL).mock(return_value=httpx.Response(200, json=[FAKE_DEVICE]))
    respx.get(f"{BASE}/api/v1/devices/{FAKE_DEVICE['uuid']}/temps.json").mock(
        return_value=httpx.Response(404, text="no recent data")
    )
    out = tmp_path / "shapes.json"
    rc = fp.cmd_capture(settings_with_token, argparse.Namespace(out=str(out)))
    assert rc == 0
    assert "devices.json" in json.loads(out.read_text())


# --- rate limit safety interlock -------------------------------------------


def test_ratelimit_refuses_without_confirmation(settings_with_token):
    """The safety interlock is the point: never burn the budget during a live cook."""
    with respx.mock:  # any network call would raise
        rc = fp.cmd_ratelimit(
            settings_with_token,
            argparse.Namespace(confirm_not_cooking=False, max_calls=25),
        )
    assert rc == 2


@respx.mock
def test_ratelimit_stops_at_first_block(settings_with_token):
    calls = {"n": 0}

    def responder(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] <= fp.DOCUMENTED_LIMIT:
            return httpx.Response(200, json=[])
        return httpx.Response(429, text="rate limit exceeded", headers={"Retry-After": "180"})

    respx.get(DEVICES_URL).mock(side_effect=responder)
    rc = fp.cmd_ratelimit(
        settings_with_token,
        argparse.Namespace(confirm_not_cooking=True, max_calls=25),
    )
    assert rc == 0
    # Stops immediately on the first block rather than hammering to max_calls.
    assert calls["n"] == fp.DOCUMENTED_LIMIT + 1


@respx.mock
def test_ratelimit_handles_never_blocking(settings_with_token):
    respx.get(DEVICES_URL).mock(return_value=httpx.Response(200, json=[]))
    rc = fp.cmd_ratelimit(
        settings_with_token,
        argparse.Namespace(confirm_not_cooking=True, max_calls=5),
    )
    assert rc == 0


# --- CLI wiring -------------------------------------------------------------


def test_cli_requires_a_subcommand():
    with pytest.raises(SystemExit):
        fp.main([])


def test_cli_ratelimit_defaults_to_refusing():
    assert fp.main(["ratelimit"]) == 2


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v", "--no-header"]))
