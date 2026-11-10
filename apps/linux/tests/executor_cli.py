#!/usr/bin/python3
"""Synthetic CLI used only inside first_run.py's private Linux HOME.

This proves the Tauri pairing/teardown boundary, not real Gateway pairing or
systemd. The foreground descendant shares the native-owned process group and
must be joined before the CLI can finish. The one-time pairing secret is read
from a private file, compared by hash against the driver's copy, and never
recorded in events or echoed anywhere.
"""

import argparse
import atexit
import hashlib
import json
import os
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path


EVENTS = Path.home() / "executor-cli-events.jsonl"
SECRET = Path.home() / "executor-secret.txt"
APPROVE = Path.home() / "executor-approve"
STATE = Path.home() / "executor-service-state.json"
JOIN_PORT = 18790

# Must match the Rust controller's explicit minimal executor surface: an
# explicit list REPLACES the profile defaults, so command execution and the
# whole occupancy lease lifecycle must be present on their own.
COMMANDS_CSV = (
    "system.run.prepare,system.run,system.which,system.execApprovals.get,"
    "system.execApprovals.set,occupancy.acquire.v1,occupancy.renew.v1,"
    "occupancy.release.v1,occupancy.status.v1,occupancy.revoke.v1"
)

DESCENDANT = None


def record(event, **details):
    payload = json.dumps({"event": event, "at": time.monotonic_ns(), **details}) + "\n"
    descriptor = os.open(EVENTS, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(descriptor, payload.encode())
    finally:
        os.close(descriptor)


def identity(pid):
    try:
        values = (Path("/proc") / str(pid) / "stat").read_text().rsplit(") ", 1)[1].split()
        return {"pid": pid, "start": values[19], "group": int(values[2]), "state": values[0]}
    except FileNotFoundError:
        return None


def still_exists(node):
    current = identity(node["pid"])
    return current is not None and current["start"] == node["start"]


def spawn_descendant():
    global DESCENDANT
    DESCENDANT = subprocess.Popen(
        ["sleep", "300"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def join_descendant():
    global DESCENDANT
    if DESCENDANT is None:
        return
    node = identity(DESCENDANT.pid)
    if node is not None:
        DESCENDANT.terminate()
        try:
            DESCENDANT.wait(timeout=10)
        except subprocess.TimeoutExpired:
            DESCENDANT.kill()
            DESCENDANT.wait(timeout=5)
    gone = node is None or not still_exists(node)
    record("foreground-stop", pid=DESCENDANT.pid, descendantGone=gone)
    DESCENDANT = None


class Arguments(argparse.ArgumentParser):
    def error(self, _message):
        # A regressed caller could put the secret in an unknown option. Never echo it.
        raise RuntimeError("Unexpected controlled CLI arguments")


def read_handoff(arguments):
    parser = Arguments(add_help=False)
    parser.add_argument("--target-file", required=True)
    parser.add_argument("--executor", action="store_true", required=True)
    parser.add_argument("--commands", required=True)
    parser.add_argument("--service", action="store_true")
    parser.add_argument("--display-name")
    selected = parser.parse_args(arguments)
    if selected.commands != COMMANDS_CSV:
        raise RuntimeError("Controlled CLI lost the explicit minimal command surface")
    path = Path(selected.target_file)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    mode = stat.S_IMODE(path.stat().st_mode)
    os.remove(path)
    expected = None
    if SECRET.exists():
        expected = hashlib.sha256(SECRET.read_bytes()).hexdigest()
    if expected is None or digest != expected:
        raise RuntimeError("The staged pairing secret did not match the driver's copy")
    record(
        "connect-start", secretSha256=digest, handoffMode=format(mode, "03o"),
        commands=selected.commands, service=bool(selected.service),
        displayName=selected.display_name,
    )
    return selected


def run_connected_foreground():
    print(
        "node host gateway reconnect paused after close (4000): device pairing required"
        " detail=PAIRING_REQUIRED; waiting for operator action",
        file=sys.stderr, flush=True,
    )
    deadline = time.monotonic() + 120
    while not APPROVE.exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("Fixture approval never arrived")
        time.sleep(0.1)
    print(f"node host gateway connected: wss://127.0.0.1:{JOIN_PORT}/fixture/", flush=True)
    signal.pause()


def first_connect_then_install(display_name):
    record("service-first-connect", displayName=display_name)
    program = ["node", "run", "--executor", "--commands", COMMANDS_CSV]
    if display_name:
        program += ["--display-name", display_name]
    if "--target-file" in program or any(SECRET.stem in part for part in program):
        raise RuntimeError("Service program arguments leaked the pairing handoff")
    record("service-install", programArguments=program)
    STATE.write_text(json.dumps({"serviceLoaded": True}))


def service_state():
    if STATE.exists():
        return json.loads(STATE.read_text()).get("serviceLoaded", False)
    return False


def wait_forever():
    signal.pause()


CANONICAL_CONFIG = Path.home() / ".openclaw/openclaw.json"
CHROME_SETUP = "browser extension setup --action install --json --wait-ms 1000"


def handle_startup(command, arguments):
    if command == "config" and arguments == ["file", "--json"]:
        print(json.dumps({"path": str(CANONICAL_CONFIG)}))
        return True
    if command == "config" and arguments == ["get", "desktop.host.enabled", "--json"]:
        # Seeded canonical config keeps the desktop node off during this proof.
        print("false")
        return True
    if command == "gateway" and arguments == ["status", "--json"]:
        print(json.dumps({"service": {"loaded": False}, "rpc": {"ok": False}}))
        return True
    if command == "browser" and arguments == [
        "extension", "setup", "--action", "install", "--json", "--wait-ms", "1000",
    ]:
        print(json.dumps({"action": "install", "target": {"kind": "local-host", "platform": "linux", "hostname": "fixture", "profile": "chrome", "relayPort": 18799}, "phase": "needs_browser_action", "reason": "extension_missing", "installation": {"nativeHostRegistered": True, "installRequested": False, "installedProfiles": 0, "discoveredProfiles": 0, "awaitingApproval": False, "automaticBootstrapSupported": True}, "connection": {"state": "not_checked"}, "nextAction": "install_from_store"}))
        return True
    return False


def main():
    atexit.register(join_descendant)
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "--version":
        print("OpenClaw fixture")
        return
    if handle_startup(command, sys.argv[2:]):
        return
    if command == "connect":
        selected = read_handoff(sys.argv[2:])
        if selected.service:
            first_connect_then_install(selected.display_name)
            return
        spawn_descendant()
        run_connected_foreground()
        return
    if command == "node":
        tail = sys.argv[2:]
        verb = tail[0] if tail else ""
        if verb == "run":
            parser = Arguments(add_help=False)
            parser.add_argument("--executor", action="store_true", required=True)
            parser.parse_args(tail[1:])
            record("foreground-run")
            spawn_descendant()
            print(f"node host gateway connected: wss://127.0.0.1:{JOIN_PORT}/fixture/", flush=True)
            wait_forever()
            return
        if verb == "status":
            print(json.dumps({"service": {
                "label": "openclaw-node", "loaded": service_state(),
                "loadedText": "loaded", "notLoadedText": "not installed",
            }}))
            return
        if verb in ("start", "stop", "restart"):
            Arguments(add_help=False).parse_args([])
            record("service-" + verb)
            # systemd enabled state survives stop; only the controller's own
            # observation distinguishes running from stopped.
            if verb != "stop" and not service_state():
                STATE.write_text(json.dumps({"serviceLoaded": True}))
            return
        if verb == "install":
            raise RuntimeError("Direct node install is not the GUI pairing path")
    raise RuntimeError("Unexpected controlled CLI command")


def handle_term(_signum, _frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, handle_term)

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        # Never echo argument values; only their shape reaches the events file.
        record(
            "fixture-failure",
            flags=[arg for arg in sys.argv[1:] if arg.startswith("--")],
            argCount=len(sys.argv),
            verb=sys.argv[1] if len(sys.argv) > 1 else None,
        )
        sys.exit(1)
