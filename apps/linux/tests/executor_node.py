"""Real Tauri controlled-device GUI proof against a synthetic executor CLI.

The driver pairs through the actual window: consent refusal, invalid and
expired input, the 0600 handoff, approval waiting, stop/restart, service
install arguments, an app restart with durable service status, and joined
teardown. The join URL and setup code are bearer secrets: they exist only in
the driver's private HOME, and every proof surface is scanned for them.
"""

import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
import sys

from executor_cli import COMMANDS_CSV, JOIN_PORT


JOIN_URL = f"https://127.0.0.1:{JOIN_PORT}/j/abcdefghijklmnopqrstuv"
SETUP_TOKEN = "synthetic-executor-bootstrap-token"
JOIN_CODE_DIGEST = hashlib.sha256(JOIN_URL.encode()).hexdigest()
VALID_CODE = None
EXPIRED_CODE = None
SECRETS = ()


def setup_code(expires_in_ms):
    payload = {
        "url": f"wss://127.0.0.1:{JOIN_PORT}",
        "bootstrapToken": SETUP_TOKEN,
        "expiresAtMs": int(time.time() * 1000) + expires_in_ms,
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return "oc-pair://" + encoded


class ExecutorNodeFixture:
    def __init__(self, artifacts_dir):
        from gateway_switch import GatewaySwitchFixture

        self.fixture = GatewaySwitchFixture(artifacts_dir)
        self.artifacts_dir = artifacts_dir
        self.events_file = Path.home() / "executor-cli-events.jsonl"
        self.secret_file = Path.home() / "executor-secret.txt"
        self.approve_file = Path.home() / "executor-approve"
        self.binary_sha256 = None
        self.passed = False

    def start(self):
        global VALID_CODE, EXPIRED_CODE, SECRETS
        VALID_CODE = setup_code(600_000)
        EXPIRED_CODE = setup_code(-1_000)
        SECRETS = (JOIN_URL, VALID_CODE[len("oc-pair://"):], SETUP_TOKEN)
        self.fixture.start()
        # The flow boots into first-run choices: no configured Gateway, and the
        # seeded canonical desktop opt-out keeps the desktop node silent while
        # the synthetic executor CLI replaces the gateway one.
        config = Path.home() / ".openclaw/openclaw.json"
        config.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        config.write_text(json.dumps({"desktop": {"host": {"enabled": False}}}))
        config.chmod(0o600)
        cli = Path.home() / ".openclaw/bin/openclaw"
        shutil.copyfile(Path(__file__).with_name("executor_cli.py"), cli)
        cli.chmod(0o700)
        # The driver's private copy of the secret; the fixture CLI compares hashes.
        self.secret_file.write_text(JOIN_URL)
        self.secret_file.chmod(0o600)

    @property
    def chrome(self):
        return self.fixture.chrome

    @property
    def config(self):
        return self.fixture.config

    def events(self):
        if not self.events_file.exists():
            return []
        lines = self.events_file.read_text().splitlines()
        if len(lines) > 512:
            raise RuntimeError("Executor fixture exceeded its event bound")
        result = [json.loads(line) for line in lines]
        if any(item["event"] == "fixture-failure" for item in result):
            detail = next(item for item in result if item["event"] == "fixture-failure")
            raise RuntimeError(f"Synthetic executor CLI rejected its contract: {detail!r}")
        return result

    def expect_events(self, count, label):
        self.chrome.until(
            lambda: self.events()[count - 1] if len(self.events()) >= count else None,
            label,
        )

    def capture(self, name):
        if self.artifacts_dir:
            time.sleep(1)
            self.chrome.command(
                "import", "-window", "root",
                str(self.artifacts_dir / f"executor-{name}.png"),
            )

    def exercise(self, app, binary, wait, Atspi, restart):
        self.binary_sha256 = hashlib.sha256(binary.read_bytes()).hexdigest()

        def in_active_window(node):
            while node is not None and node.get_localized_role_name() != "application":
                if node.get_state_set().contains(Atspi.StateType.ACTIVE):
                    return True
                node = node.get_parent()
            return False

        def click(label, role=("button", "push button", "toggle button", "check box", "radio button"), *, prefix=False):
            node = wait(label, role, prefix=prefix, predicate=in_active_window)
            component = node.get_component_iface()
            component.scroll_to(Atspi.ScrollType.ANYWHERE)
            bounds = component.get_extents(Atspi.CoordType.SCREEN)
            self.chrome.command("xdotool", "mousemove", str(bounds.x + bounds.width // 2),
                                str(bounds.y + bounds.height // 2), "click", "1")

        def fill(label, value):
            node = wait(label, ("entry", "text", "password text"), predicate=lambda node:
                        node.get_state_set().contains(Atspi.StateType.EDITABLE) and in_active_window(node))
            component = node.get_component_iface()
            component.scroll_to(Atspi.ScrollType.ANYWHERE)
            bounds = component.get_extents(Atspi.CoordType.SCREEN)
            self.chrome.command("xdotool", "mousemove", str(bounds.x + bounds.width // 2),
                                str(bounds.y + bounds.height // 2), "click", "1")
            self.chrome.command("xdotool", "key", "ctrl+a")
            try:
                self.chrome.command("xdotool", "type", "--clearmodifiers", "--delay", "10", value)
            except subprocess.SubprocessError:
                raise RuntimeError("Could not enter the controlled-device form") from None

        def executor_window():
            return self.chrome.until(
                lambda: next((window for window, title in self.fixture.windows(app).items()
                              if title == "Controlled Device"), None),
                "the controlled-device window",
            )

        def focus_executor():
            self.chrome.command("wmctrl", "-ia", executor_window())

        def no_handoff_files():
            handoff_dir = Path.home() / ".config/ai.openclaw.linux/executor-node"
            if not handoff_dir.exists():
                return True
            return not any(path.name.startswith("handoff-") for path in handoff_dir.iterdir())

        wait("Welcome to OpenClaw", "heading")
        click("Get started")
        wait("Where should your assistant live?", "heading")
        click("Be controlled from another computer", prefix=True)
        focus_executor()
        wait("Pair this computer", "heading")
        self.capture("form")

        # Consent refusal: pairing stays blocked until the explicit approval.
        pair = wait("Pair this computer", "push button", predicate=in_active_window)
        if pair.get_state_set().contains(Atspi.StateType.SENSITIVE):
            raise RuntimeError("Pairing was offered before explicit remote-execution consent")
        self.chrome.record("consent refusal keeps pairing blocked", True)

        click("Allow remote control of this computer", prefix=True)
        wait("Pair this computer", "push button", predicate=lambda node:
             in_active_window(node) and node.get_state_set().contains(Atspi.StateType.SENSITIVE))
        self.chrome.record("explicit consent enables pairing only in the GUI", True)

        # Invalid join URL and invalid/expired setup codes never reach the CLI.
        for index, (wrong, message) in enumerate((
            ("not-a-join-url", "Paste the whole join URL, ending in /j/<code>."),
            ("oc-pair://!!!", "That setup code is not valid."),
            (EXPIRED_CODE, "That setup code has expired."),
        )):
            fill("Join URL or setup code", wrong)
            click("Pair this computer")
            self.capture(f"invalid-{index}")
            wait(message, None, prefix=True)
            if self.events():
                raise RuntimeError(f"Invalid input reached the CLI: {self.events()!r}")
        if not no_handoff_files():
            raise RuntimeError("Invalid input staged a pairing secret")
        self.chrome.record("invalid and expired input never stage secrets or spawn the CLI", True)
        self.capture("invalid-input")

        # Real pairing: 0600 handoff, approval wait, then connected.
        fill("Device name (optional)", "Desk")
        fill("Join URL or setup code", JOIN_URL)
        click("Pair this computer")
        self.expect_events(1, "the synthetic connect with the staged secret")
        first = self.events()[0]
        if first["event"] != "connect-start" or first["handoffMode"] != "600" \
                or first["secretSha256"] != JOIN_CODE_DIGEST or first["service"] \
                or first["displayName"] != "Desk" or first["commands"] != COMMANDS_CSV:
            raise RuntimeError("Foreground pairing lost the 0600 handoff contract")
        wait("Status: Waiting for approval on the controlling Gateway")
        self.capture("waiting-approval")
        self.chrome.record("pairing waits for Gateway approval through the GUI", True)
        self.approve_file.touch()
        wait("Status: Running")
        self.capture("running-foreground")
        self.chrome.record("approval completes the join-URL pairing", True)

        # Stop joins the observed process tree.
        click("Stop")
        wait("Status: Off")
        self.chrome.until(lambda: any(
            item["event"] == "foreground-stop" and item.get("descendantGone")
            for item in self.events()), "the first foreground tree to join")
        if not no_handoff_files():
            raise RuntimeError("A redeemed pairing secret remained on disk")
        self.chrome.record("stop joins the CLI and its descendant", True)

        # Reconnect and restart use the saved pairing without any secret.
        click("Start")
        self.chrome.until(
            lambda: any(item["event"] == "foreground-run" for item in self.events()),
            "the saved-pairing reconnect",
        )
        wait("Status: Running")
        click("Restart")
        self.chrome.until(
            lambda: sum(1 for item in self.events() if item["event"] == "foreground-run") >= 2,
            "the GUI restart",
        )
        wait("Status: Running")
        self.chrome.until(lambda: any(
            item["event"] == "foreground-stop" for item in self.events()),
            "the restarted foreground tree to join")
        self.chrome.record("reconnect and restart never resend a pairing secret", True)

        # Service mode: first connect stores durable auth, install carries the
        # executor selection without any secret material.
        self.secret_file.write_text(VALID_CODE)
        fill("Join URL or setup code", VALID_CODE)
        click("As a background service")
        click("Pair this computer")
        wait("Status: Running (background service)")
        self.capture("running-service")
        events = self.events()
        service_connect = next(item for item in events if item["event"] == "connect-start"
                               and item.get("service"))
        install = next(item for item in events if item["event"] == "service-install")
        if service_connect["secretSha256"] != hashlib.sha256(VALID_CODE.encode()).hexdigest():
            raise RuntimeError("Service pairing staged the wrong secret")
        program = install["programArguments"]
        if "--executor" not in program or "--commands" not in program \
                or "--target-file" in program:
            raise RuntimeError(f"Service install arguments broke the contract: {program!r}")
        self.chrome.record("service pairing installs with executor args and durable credentials", True)

        click("Stop")
        wait("Status: Stopped (background service)")
        self.chrome.until(lambda: any(item["event"] == "service-stop" for item in self.events()),
                          "the service stop request")
        click("Start")
        wait("Status: Running (background service)")
        self.chrome.until(lambda: any(item["event"] == "service-start" for item in self.events()),
                          "the service start request")
        self.chrome.record("service start/stop stay GUI-only", True)

        # Durable service status survives an app restart; the tray opens the window.
        self.fixture.open_native_menu(app, "Quit OpenClaw")
        app.wait(timeout=10)
        if app.returncode != 0:
            raise RuntimeError("The native Quit action did not finish cleanly")
        app = restart()
        wait("Welcome to OpenClaw", "heading")
        self.fixture.open_native_menu(app, "Controlled Device…")
        focus_executor()
        wait("Status: Service installed")
        click("Start")
        wait("Status: Running (background service)")
        self.capture("after-restart-service")
        self.chrome.record("durable service status survives an app restart", True)

        if not no_handoff_files():
            raise RuntimeError("A pairing secret outlived its redemption")
        log = Path("app.log")
        if log.exists():
            contents = log.read_text(errors="replace")
            for secret in SECRETS:
                if secret and secret in contents:
                    raise RuntimeError("The app log disclosed a pairing secret")
        self.passed = True
        print("PASS: real controlled-device GUI pairing, consent, secrets, service mode and teardown", flush=True)

    def close(self):
        failure = sys.exc_info()[1]
        try:
            self.fixture.close()
        finally:
            leaked = [
                item for item in self.events()
                if item["event"] == "foreground-stop" and not item.get("descendantGone")
            ]
            log = Path("app.log")
            if log.exists():
                contents = log.read_text(errors="replace")
                for secret in SECRETS:
                    if secret and secret in contents:
                        leaked.append({"event": "secret-leak", "where": "app.log"})
            if self.artifacts_dir:
                (self.artifacts_dir / "gateway-switch-results.json").unlink(missing_ok=True)
                (self.artifacts_dir / "executor-results.json").write_text(json.dumps({
                    "passed": self.passed and not leaked,
                    "binarySha256": self.binary_sha256,
                    "checks": self.fixture.chrome.checks,
                    "cliEvents": self.events(),
                    "syntheticCli": True, "syntheticGateway": False,
                    "boundary": "Real Tauri WebKit GUI, OS vault, 0600 handoff, and joined "
                                "process tree; not real Gateway pairing or systemd",
                }, indent=2) + "\n")
            if leaked:
                message = f"Controlled-device proof leaked process or secret state: {leaked!r}"
                if failure is not None:
                    message = f"{failure}; {message}"
                raise RuntimeError(message) from failure
