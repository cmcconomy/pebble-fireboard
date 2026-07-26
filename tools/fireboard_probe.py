#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx", "pydantic-settings"]
# ///
"""Probe the FireBoard Cloud API to answer the open questions in
docs/research/2026-07-26-fireboard-api-research.md.

Credentials come from the environment (or a .env file alongside this script):

    FIREBOARD_USERNAME=you@example.com
    FIREBOARD_PASSWORD=...
    # or, to skip the login exchange entirely:
    FIREBOARD_TOKEN=9944bb...

Subcommands:
    login      Exchange credentials for a token. Costs 1 call.
    capture    Dump devices.json + temps.json response shapes. Costs 2-3 calls.
    ratelimit  Deliberately exhaust the rate limit to find the real threshold.
               Costs 25+ calls and may blind other clients on the same account.
               Requires --confirm-not-cooking.

Every request sends an explicit User-Agent: the API rejects requests without one
(documented requirement, 2025-01-02).
"""

from __future__ import annotations

import argparse
import getpass
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx
from pydantic_settings import BaseSettings, SettingsConfigDict

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("fireboard-probe")

BASE_URL = "https://fireboard.io"
USER_AGENT = "pebble-fireboard-probe/0.1"

# Documented limit: 17 calls per 5 minutes (~204/hour).
DOCUMENTED_LIMIT = 17
DOCUMENTED_WINDOW_SEC = 300


class Settings(BaseSettings):
    """FireBoard credentials, from env or a sibling .env file."""

    model_config = SettingsConfigDict(
        env_prefix="FIREBOARD_",
        env_file=Path(__file__).parent / ".env",
        extra="ignore",
    )

    username: str | None = None
    password: str | None = None
    token: str | None = None


def client(token: str | None = None) -> httpx.Client:
    headers = {"User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = f"Token {token}"
    return httpx.Client(base_url=BASE_URL, headers=headers, timeout=30.0)


def login(username: str, password: str) -> str:
    """Exchange credentials for an API token. Returns the token key."""
    with client() as c:
        resp = c.post(
            "/api/rest-auth/login/", json={"username": username, "password": password}
        )
    resp.raise_for_status()
    key = resp.json()["key"]
    if not key:
        raise RuntimeError(f"login returned no key: {resp.text}")
    return key


ENV_FILE = Path(__file__).parent / ".env"

NO_CREDENTIALS_MSG = (
    "No credentials, and stdin is not a terminal so I cannot prompt.\n"
    "Run this from a real terminal to be prompted, or set FIREBOARD_TOKEN "
    "(or FIREBOARD_USERNAME and FIREBOARD_PASSWORD) in the environment "
    f"or {ENV_FILE}"
)


def prompt_credentials() -> tuple[str, str]:
    """Ask for credentials on the terminal. Password is never echoed.

    Prompting beats env vars here: the password stays in process memory and
    never reaches shell history, the process list, or disk.
    """
    username = input("FireBoard email: ").strip()
    password = getpass.getpass("FireBoard password: ")
    return username, password


def resolve_token(settings: Settings) -> str:
    if settings.token:
        logger.info("Using FIREBOARD_TOKEN from environment.")
        return settings.token

    username, password = settings.username, settings.password
    if not (username and password):
        if not sys.stdin.isatty():
            raise SystemExit(NO_CREDENTIALS_MSG)
        username, password = prompt_credentials()
        if not (username and password):
            raise SystemExit("Empty username or password; aborting.")

    logger.info("Exchanging credentials for a token...")
    return login(username, password)


def save_token(token: str, dest: Path | None = None) -> None:
    """Persist the token to the gitignored .env, replacing any prior value.

    `dest` resolves at call time rather than as a default argument, so the
    destination stays overridable (a default would bind ENV_FILE at import).
    """
    dest = dest or ENV_FILE
    lines = []
    if dest.exists():
        lines = [
            line
            for line in dest.read_text().splitlines()
            if not line.startswith("FIREBOARD_TOKEN=")
        ]
    lines.append(f"FIREBOARD_TOKEN={token}")
    dest.write_text("\n".join(lines) + "\n")
    os.chmod(dest, 0o600)
    logger.info("Saved token to %s (mode 600).", dest)


def summarize(value: Any, depth: int = 0, max_depth: int = 3) -> Any:
    """Reduce a JSON payload to its *shape* (types, not values) for documentation.

    Keeps scalar values only for small, clearly non-sensitive fields so the
    output can be pasted into a design doc without leaking account details.
    """
    pad = "  " * depth
    if isinstance(value, dict):
        if depth >= max_depth:
            return f"{{...{len(value)} keys...}}"
        return {k: summarize(v, depth + 1, max_depth) for k, v in value.items()}
    if isinstance(value, list):
        if not value:
            return "[] (empty)"
        return [summarize(value[0], depth + 1, max_depth), f"...x{len(value)}"]
    if value is None:
        return "null"
    return f"{type(value).__name__}"


# --- subcommands ------------------------------------------------------------


def cmd_login(settings: Settings, args: argparse.Namespace) -> int:
    # --twice needs the credentials themselves, not just a resulting token, so
    # this command resolves them directly rather than going through resolve_token.
    username, password = settings.username, settings.password
    if not (username and password):
        if settings.token and not args.twice:
            logger.info("FIREBOARD_TOKEN is already set; nothing to do.")
            return 0
        if not sys.stdin.isatty():
            raise SystemExit(NO_CREDENTIALS_MSG)
        username, password = prompt_credentials()
        if not (username and password):
            raise SystemExit("Empty username or password; aborting.")

    logger.info("Exchanging credentials for a token...")
    token = login(username, password)
    logger.info("Token acquired: %s...%s (%d chars)", token[:6], token[-4:], len(token))

    if args.twice:
        # If a second login returns the SAME key, the token is account-scoped and
        # singular -- strong evidence the rate limit is per-account, and that the
        # Android app shares our budget.
        logger.info("Logging in a second time to compare keys...")
        second = login(username, password)
        if second == token:
            logger.info(
                "RESULT: SAME key returned. The token is a stable, account-scoped "
                "property -> the rate limit is near-certainly per-account, and any "
                "other client on this account (the phone app) shares our budget. "
                "Stay at a 30s poll interval."
            )
        else:
            logger.info(
                "RESULT: DIFFERENT key returned. Tokens are per-session, so "
                "per-account vs per-token limiting is still open -- settle it with "
                "`ratelimit --confirm-not-cooking` after the cook."
            )

    if args.save_token:
        save_token(token)
    else:
        logger.info("Re-run with --save-token to write it to %s", ENV_FILE)
    return 0


#: `device_log` embeds the user's SSID, both MAC addresses and public IP.
#: It is the one genuinely sensitive part of devices.json -- never capture it.
SENSITIVE_KEYS = frozenset({"device_log"})


def redact(device: dict[str, Any]) -> dict[str, Any]:
    """Drop sensitive blocks from a device object before it is written anywhere."""
    return {k: v for k, v in device.items() if k not in SENSITIVE_KEYS}


def cmd_capture(settings: Settings, args: argparse.Namespace) -> int:
    token = resolve_token(settings)
    out: dict[str, Any] = {}

    with client(token) as c:
        # devices.json is the endpoint the watch app actually polls: it returns
        # channel labels, live temps, alert config, battery and session id in a
        # single call. temps.json (below) is a strict subset with no labels.
        logger.info("GET /api/v1/devices.json")
        devices_resp = c.get("/api/v1/devices.json")
        devices_resp.raise_for_status()
        devices = devices_resp.json()
        # Redact BEFORE summarising: even the key names inside device_log
        # (ssid, macNIC, publicIP...) are noise we never want in a shared doc.
        redacted = [redact(d) for d in devices]
        out["devices.json"] = summarize(redacted)
        logger.info("  %d device(s) on the account", len(devices))

        # Verbatim (minus device_log) -- the channel/alert detail is what the
        # protocol design needs, and none of it is sensitive.
        # Label deliberately avoids naming the redacted key, so that grepping the
        # captured file for sensitive key names yields no false positives.
        out["devices.json verbatim (sensitive block removed)"] = redacted
        for device in devices:
            live = [
                c_["channel"] for c_ in device.get("channels", [])
                if c_.get("current_temp") is not None
            ]
            logger.info(
                "  %r: %d channels, live: %s, session=%s, battery=%.0f%%",
                device.get("title"),
                len(device.get("channels", [])),
                live or "none",
                next(
                    (c_.get("sessionid") for c_ in device.get("channels", [])), None
                ),
                (device.get("last_battery_reading") or 0) * 100,
            )

        if not devices:
            logger.warning("No devices; cannot capture temps.json.")
            return 1

        for device in devices:
            uuid = device.get("uuid") or device.get("hardware_id")
            title = device.get("title", "?")
            logger.info("GET /api/v1/devices/%s/temps.json  (%s)", uuid, title)
            temps_resp = c.get(f"/api/v1/devices/{uuid}/temps.json")
            if temps_resp.status_code != 200:
                logger.warning("  -> HTTP %d %s", temps_resp.status_code, temps_resp.text[:200])
                continue
            temps = temps_resp.json()
            out[f"temps.json ({title})"] = summarize(temps)
            # temps.json is small and the actual values are just temperatures --
            # safe and useful to record verbatim.
            out[f"temps.json ({title}) verbatim"] = temps
            logger.info("  -> %s", json.dumps(temps)[:400])

    dest = Path(args.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=2))
    logger.info("Wrote response shapes to %s", dest)
    return 0


def cmd_ratelimit(settings: Settings, args: argparse.Namespace) -> int:
    if not args.confirm_not_cooking:
        logger.error(
            "Refusing to run: this test deliberately exhausts the API budget.\n"
            "If the limit is per-account (the hypothesis), it will blind the "
            "FireBoard phone app for the rest of the window.\n"
            "Re-run with --confirm-not-cooking once no cook is in progress."
        )
        return 2

    token = resolve_token(settings)
    max_calls = args.max_calls
    logger.info(
        "Firing up to %d rapid calls to find the real threshold (documented: %d/%ds)...",
        max_calls,
        DOCUMENTED_LIMIT,
        DOCUMENTED_WINDOW_SEC,
    )

    started = time.monotonic()
    first_block: int | None = None
    with client(token) as c:
        for i in range(1, max_calls + 1):
            resp = c.get("/api/v1/devices.json")
            elapsed = time.monotonic() - started
            logger.info("  call %2d  t=%5.1fs  HTTP %d", i, elapsed, resp.status_code)
            if resp.status_code in (403, 429) and first_block is None:
                first_block = i
                logger.info(
                    "  -> first block at call %d after %.1fs. Body: %s",
                    i,
                    elapsed,
                    resp.text[:200],
                )
                for header in ("Retry-After", "X-RateLimit-Remaining", "X-RateLimit-Reset"):
                    if header in resp.headers:
                        logger.info("  -> %s: %s", header, resp.headers[header])
                break

    if first_block is None:
        logger.info(
            "No block within %d calls -- the limit is looser than documented, "
            "or is enforced over a longer window.",
            max_calls,
        )
    else:
        logger.info(
            "Blocked after %d successful calls (documented threshold: %d).",
            first_block - 1,
            DOCUMENTED_LIMIT,
        )
        logger.info(
            "NOW: check the FireBoard app on your phone. If it has also stopped "
            "updating, the limit is per-account and the app shares our budget."
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_login = sub.add_parser("login", help="exchange credentials for a token")
    p_login.add_argument(
        "--twice",
        action="store_true",
        help="log in twice and compare keys (probes account- vs session-scoped tokens)",
    )
    p_login.add_argument(
        "--save-token",
        action="store_true",
        help=f"write the token to {ENV_FILE} (mode 600, gitignored)",
    )
    p_login.set_defaults(func=cmd_login)

    p_capture = sub.add_parser("capture", help="dump devices.json + temps.json shapes")
    p_capture.add_argument(
        "--out",
        default="docs/research/api-shapes.json",
        help="where to write the captured response shapes",
    )
    p_capture.set_defaults(func=cmd_capture)

    p_rate = sub.add_parser("ratelimit", help="find the real rate-limit threshold")
    p_rate.add_argument("--max-calls", type=int, default=25)
    p_rate.add_argument(
        "--confirm-not-cooking",
        action="store_true",
        help="required: acknowledges this may blind other clients on the account",
    )
    p_rate.set_defaults(func=cmd_ratelimit)

    args = parser.parse_args(argv)
    settings = Settings()
    try:
        return args.func(settings, args)
    except httpx.HTTPStatusError as exc:
        logger.error("HTTP %d: %s", exc.response.status_code, exc.response.text[:400])
        return 1


if __name__ == "__main__":
    sys.exit(main())
