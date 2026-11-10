#!/usr/bin/python3
"""Synthetic CLI used only inside first_run.py's private Linux HOME.

This proves the Tauri pairing/teardown boundary, not real Gateway pairing or
systemd. The foreground descendant shares the native-owned process group and
must be joined before the CLI can finish; the final-exit fixture ignores TERM
so the native force window is exercised. The one-time pairing secret is read
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
FIXTURE_STATE = Path.home() / "executor-fixture-state.json"
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


def fixture_state():
    if FIXTURE_STATE.exists():
        return json.loads(FIXTURE_STATE.read_text())
    return {}


def identity(pid):
    try:
        values = (Path("/proc") / str(pid) / "stat").read_text().rsplit(") ", 1)[1].split()
        return {"pid": pid, "start": values[19], "group": int(values[2]), "state": values[0]}
    except FileNotFoundError:
        return None


def still_exists(node):
    current = identity(node["pid"])
    return current is not None and current["start"] == node["start"]


def spawn_descendant(ignore_term=False):
    global DESCENDANT
    if ignore_term:
        DESCENDANT = subprocess.Popen(
            [sys.executable, "-c",
             "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN);"
             "time.sleep(600)"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
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
            DESCENDANT.wait(timeout=45)
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
    # The first authenticated hello saved canonical pairing state in the CLI.
    (Path.home() / "fixture-paired").touch()
    return selected


def wait_for_approval():
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


def print_connected():
    print(f"node host gateway connected: wss://127.0.0.1:{JOIN_PORT}/fixture/", flush=True)


def first_connect_then_install(display_name):
    record("service-first-connect", displayName=display_name)
    program = ["node", "run", "--executor", "--commands", COMMANDS_CSV]
    if display_name:
        program += ["--display-name", display_name]
    if "--target-file" in program or any(SECRET.stem in part for part in program):
        raise RuntimeError("Service program arguments leaked the pairing handoff")
    record("service-install", programArguments=program)
    STATE.write_text(json.dumps({"serviceLoaded": True, "serviceActive": True}))


def service_state():
    # systemd enabled state: installed units stay enabled across stop.
    if STATE.exists():
        return json.loads(STATE.read_text()).get("serviceLoaded", False)
    return False


def service_active():
    # The controller's own running observation, separate from enabled.
    if STATE.exists():
        return json.loads(STATE.read_text()).get("serviceActive", False)
    return False


def wait_forever():
    signal.pause()


def detach_descendant():
    """Hand the descendant to the native teardown and exit without joining."""
    global DESCENDANT
    node = identity(DESCENDANT.pid)
    record("leader-exit", descendant=node)
    atexit.unregister(join_descendant)
    DESCENDANT = None


def main():
    atexit.register(join_descendant)
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "--version":
        print("OpenClaw fixture")
        return
    if command == "config" and sys.argv[2:] == ["file", "--json"]:
        print(json.dumps({"path": str(Path.home() / ".openclaw/openclaw.json")}))
        return
    if command == "config" and sys.argv[2:] == ["get", "desktop.host.enabled", "--json"]:
        # Seeded canonical config keeps the desktop node off during this proof.
        print("false")
        return
    if command == "gateway" and sys.argv[2:] == ["status", "--json"]:
        print(json.dumps({"service": {"loaded": False}, "rpc": {"ok": False}}))
        return
    if command == "browser" and sys.argv[2:] == [
        "extension", "setup", "--action", "install", "--json", "--wait-ms", "1000",
    ]:
        print(json.dumps({"action": "install", "target": {"kind": "local-host", "platform": "linux", "hostname": "fixture", "profile": "chrome", "relayPort": 18799}, "phase": "needs_browser_action", "reason": "extension_missing", "installation": {"nativeHostRegistered": True, "installRequested": False, "installedProfiles": 0, "discoveredProfiles": 0, "awaitingApproval": False, "automaticBootstrapSupported": True}, "connection": {"state": "not_checked"}, "nextAction": "install_from_store"}))
        return
    if command == "connect":
        selected = read_handoff(sys.argv[2:])
        if selected.service:
            # The real CLI emits the connected hello marker before installing;
            # the delay keeps that intermediate UI state observable.
            wait_for_approval()
            print_connected()
            delay = fixture_state().get("installDelayMs", 1500)
            time.sleep(delay / 1000)
            first_connect_then_install(selected.display_name)
            return
        spawn_descendant()
        wait_for_approval()
        print_connected()
        wait_forever()
        return
    if command == "node":
        tail = sys.argv[2:]
        verb = tail[0] if tail else ""
        if verb == "run":
            parser = Arguments(add_help=False)
            parser.add_argument("--executor", action="store_true", required=True)
            parser.add_argument("--commands", required=True)
            selected = parser.parse_args(tail[1:])
            if selected.commands != COMMANDS_CSV:
                raise RuntimeError("Reconnect lost the explicit minimal command surface")
            record("foreground-run")
            state = fixture_state()
            if state.get("requirePaired") and not service_state() \
                    and not (Path.home() / "fixture-paired").exists():
                raise RuntimeError("Reconnect ran without canonical pairing")
            spawn_descendant(ignore_term=bool(state.get("ignoreTermDescendant")))
            print_connected()
            if state.get("selfExitAfterMs") is not None:
                # Simulated crash: the leader exits cleanly and hands the
                # descendant to the native teardown instead of joining it.
                time.sleep(state["selfExitAfterMs"] / 1000)
                detach_descendant()
                return
            wait_forever()
            return
        if verb == "status":
            record("status-probe", loaded=service_state(), active=service_active())
            runtime_status = "stopped"
            if service_active():
                runtime_status = "unknown" if fixture_state().get("statusUnknown") else "running"
            print(json.dumps({"service": {
                "label": "openclaw-node", "loaded": service_state(),
                "loadedText": "loaded", "notLoadedText": "not installed",
                "runtime": {"status": runtime_status},
            }}))
            return
        if verb == "pairing":
            parser = Arguments(add_help=False)
            parser.add_argument("--json", action="store_true")
            parser.parse_args(tail[1:])
            # The real CLI decides this from canonical nodeHost.config, device
            # identity, and a reusable node token; the fixture tracks the same
            # first-authenticated-hello marker and never reads the secret.
            resumable = (Path.home() / "fixture-paired").exists()
            record("pairing-probe", resumable=resumable)
            print(json.dumps({"resumable": resumable}))
            return
        if verb in ("start", "stop", "restart"):
            Arguments(add_help=False).parse_args([])
            if not STATE.exists():
                # systemd rejects service changes with no installed unit.
                print("fixture: service not installed", file=sys.stderr)
                sys.exit(1)
            state = fixture_state()
            if verb == "stop" and state.get("stopDelayMs"):
                record("service-stop-started")
                time.sleep(state["stopDelayMs"] / 1000)
            if verb == "stop" and state.get("stopShouldFail"):
                record("service-stop-failed")
                print("fixture: stop failed", file=sys.stderr)
                sys.exit(1)
            record("service-" + verb)
            state = {"serviceLoaded": True, "serviceActive": verb != "stop"}
            STATE.write_text(json.dumps(state))
            if verb in ("start", "restart"):
                delay = fixture_state().get(verb + "DelayMs")
                if delay:
                    # The service transition may already be live while the CLI
                    # action is still applying; Stop must still issue a stop.
                    time.sleep(delay / 1000)
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
