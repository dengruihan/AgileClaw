"""Real Tauri controlled-device GUI proof against a synthetic executor CLI.

Covers the fresh all-GUI flow and the review regressions: GUI CLI install with
progress, consent refusal, invalid/expired input, the 0600 handoff, approval
waiting in both run modes, serialized delayed service stop before re-pair,
failed service stop retaining service authority, reconnect/restart with the
fixed command surface, and a self-exiting foreground leader whose TERM-ignoring
descendant forces the real final-exit join window. The join URL and setup code
are bearer secrets: they exist only in the driver's private HOME, and every
proof surface is scanned for them.
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
JOIN_WINDOW_SECONDS = 60


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
        self.state_file = Path.home() / "executor-fixture-state.json"
        self.binary_sha256 = None
        self.passed = False

    def start(self):
        global VALID_CODE, EXPIRED_CODE, SECRETS
        VALID_CODE = setup_code(600_000)
        EXPIRED_CODE = setup_code(-1_000)
        SECRETS = (JOIN_URL, VALID_CODE[len("oc-pair://"):], SETUP_TOKEN)
        self.fixture.start()
        # Fresh-download state: no CLI (the base gateway fixture installs one;
        # the controlled-device GUI must install its own through the staged
        # installer), and the seeded canonical desktop opt-out keeps desktop
        # sharing silent once the CLI exists.
        (Path.home() / ".openclaw/bin/openclaw").unlink(missing_ok=True)
        config = Path.home() / ".openclaw/openclaw.json"
        config.write_text(json.dumps({"desktop": {"host": {"enabled": False}}}))
        config.chmod(0o600)
        # The driver's private copy of the secret; the fixture CLI compares hashes.
        self.secret_file.write_text(JOIN_URL)
        self.secret_file.chmod(0o600)

    def stage_binary(self, binary):
        # Tauri's documented Cargo resource layout is target/<profile> with
        # .cargo-lock; the executor GUI installer resolves its bundled script
        # there, so the fixture installs a reviewed synthetic installer.
        directory = Path.home() / "target/debug"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / ".cargo-lock").touch()
        staged = directory / binary.name
        shutil.copy2(binary, staged)
        self.binary_sha256 = hashlib.sha256(binary.read_bytes()).hexdigest()
        if hashlib.sha256(staged.read_bytes()).hexdigest() != self.binary_sha256:
            raise RuntimeError("Staging changed the native application binary")
        if (binary.parent / "desktop-runtime").exists():
            shutil.copytree(
                binary.parent / "desktop-runtime", directory / "desktop-runtime",
                dirs_exist_ok=True,
            )
        prefix = Path.home() / ".openclaw"
        installer = directory / "install-cli.sh"
        installer.write_text(
            "#!/bin/bash\nset -euo pipefail\n/usr/bin/python3 - \"$@\" <<'PY'\n"
            "import json, shutil, sys\nfrom pathlib import Path\n"
            "prefix = Path.home() / '.openclaw'\n"
            "expected = ['--json', '--no-onboard', '--prefix', str(prefix), '--version', 'main', "
            "'--runtime-only', '--install-method', 'git', '--git-dir', str(prefix / 'dev/openclaw')]\n"
            "assert sys.argv[1:] == expected, 'Unexpected controlled installer arguments'\n"
            "with Path('fixture-installer-calls').open('a') as log: log.write('install\\n')\n"
            "if Path('installer-fail').exists():\n"
            "    print(json.dumps({'event': 'step', 'name': 'openclaw', 'status': 'start'}))\n"
            "    print('Run git -C ' + str(prefix / 'dev/openclaw') + ' rebase --abort', file=sys.stderr)\n"
            "    sys.exit(1)\n"
            "cli = prefix / 'bin/openclaw'\n"
            "cli.parent.mkdir(parents=True, exist_ok=True)\n"
            f"shutil.copy2({str(Path.home() / 'fixture-cli.py')!r}, cli)\n"
            "cli.chmod(0o700)\n"
            "(prefix / 'openclaw.json').write_text(json.dumps({'desktop': {'host': {'enabled': False}}}))\n"
            "Path('fixture-installer-called').touch()\n"
            "print(json.dumps({'event': 'done', 'ok': True, 'version': 'fixture'}))\n"
            "print(json.dumps({'event': 'step', 'name': 'openclaw', 'status': 'ok'}))\n"
            "PY\n"
        )
        installer.chmod(0o700)
        # The reviewed installer copies this private fixture CLI into place.
        shutil.copyfile(Path(__file__).with_name("executor_cli.py"), Path.home() / "fixture-cli.py")
        return staged

    @property
    def chrome(self):
        return self.fixture.chrome

    def set_state(self, **state):
        self.state_file.write_text(json.dumps(state))

    def stage_secret(self, value):
        self.secret_file.write_text(value)
        self.secret_file.chmod(0o600)

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

    def count_events(self, name):
        return sum(1 for item in self.events() if item["event"] == name)

    def capture(self, name):
        if self.artifacts_dir:
            time.sleep(1)
            self.chrome.command(
                "import", "-window", "root",
                str(self.artifacts_dir / f"executor-{name}.png"),
            )

    def exercise(self, app, binary, wait, Atspi, restart):
        def in_active_window(node):
            while node is not None and node.get_localized_role_name() != "application":
                if node.get_state_set().contains(Atspi.StateType.ACTIVE):
                    return True
                node = node.get_parent()
            return False

        def click(label, role=("button", "push button", "toggle button", "check box", "radio button", "combo box"), *, prefix=False, insensitive=False, double=False):
            def usable(node):
                sensitive = node.get_state_set().contains(Atspi.StateType.SENSITIVE)
                return in_active_window(node) and sensitive is not insensitive
            node = wait(label, role, prefix=prefix, predicate=usable)
            component = node.get_component_iface()
            component.scroll_to(Atspi.ScrollType.ANYWHERE)
            bounds = component.get_extents(Atspi.CoordType.SCREEN)
            self.chrome.command("xdotool", "mousemove", str(bounds.x + bounds.width // 2),
                                str(bounds.y + bounds.height // 2), "click", "1")
            if double:
                # A second click races the first before any UI refresh.
                self.chrome.command("xdotool", "click", "1")

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
                              if title.startswith("Controlled Device")), None),
                "the controlled-device window",
            )

        def focus_executor():
            self.chrome.command("wmctrl", "-ia", executor_window())

        def no_handoff_files():
            handoff_dir = Path.home() / ".config/ai.openclaw.linux/executor-node"
            if not handoff_dir.exists():
                return True
            return not any(path.name.startswith("handoff-") for path in handoff_dir.iterdir())

        def window_text(label):
            try:
                node = wait(label, None, prefix=True)
                from gi.repository import Atspi as _Atspi

                text = node.get_text_iface()
                return "" if text is None else _Atspi.Text.get_text(text, 0, -1)
            except RuntimeError:
                return "<absent>"

        def pair(target, mode=None, name="Desk", approval_wait=True, install_assert=False):
            self.stage_secret(target)
            if name is not None:
                fill("Device name (optional)", name)
            fill("Join URL or setup code", target)
            # The radio keeps its previous choice; every pairing selects its
            # intended run mode explicitly.
            click("While this app is open" if mode != "service" else "As a background service")
            click("Pair this computer")
            if approval_wait and not self.approve_file.exists():
                wait("Status: Waiting for approval on the controlling Gateway")
                self.approve_file.touch()
            if install_assert:
                # The authenticated hello precedes installation: the window
                # must hold the preparing state, not claim a running service.
                wait("Status: Installing service…")
                restart_button = wait("Restart", "push button", predicate=in_active_window)
                if restart_button.get_state_set().contains(Atspi.StateType.SENSITIVE):
                    raise RuntimeError("Restart was offered before the service installed")
                self.chrome.record("service hello stays preparing until installed", True)
            wait("Status: Running" if mode != "service" else "Status: Running (background service)")
            if install_assert:
                restart_button = wait("Restart", "push button", predicate=lambda node:
                                      in_active_window(node)
                                      and node.get_state_set().contains(Atspi.StateType.SENSITIVE))
                self.chrome.record("installed service enables restart only after the probe", True)

        wait("Welcome to OpenClaw", "heading")
        click("Get started")
        wait("Where should your assistant live?", "heading")
        click("Be controlled from another computer", prefix=True)
        focus_executor()
        wait("Install the CLI", "heading")
        self.capture("fresh-install")

        # Fresh all-GUI installation: a fresh download pairs nothing until the
        # CLI exists. A failing installer's command-shaped output never reaches
        # this window, a double-click installs exactly once, and progress
        # streams into it. The development channel matches this build.
        click("Release channel", "combo box")
        self.chrome.command("xdotool", "key", "End", "Return")
        Path("installer-fail").write_text("")
        click("Install OpenClaw CLI")
        wait("The CLI install did not finish. Try again", None, prefix=True)
        pane_text = window_text("Install progress")
        if "git -C" in pane_text or "rebase" in pane_text:
            raise RuntimeError(f"Installer raw output reached the window: {pane_text!r}")
        self.chrome.record("failing installer shows only command-free guidance", True)
        Path("installer-fail").unlink()
        calls_file = Path.cwd() / "fixture-installer-calls"
        calls_file.unlink(missing_ok=True)
        click("Install OpenClaw CLI", double=True)
        # The install pane hides on success; the enabled secret field is the
        # observable completion signal.
        self.chrome.until(
            lambda: wait(
                "Join URL or setup code", ("password text", "entry", "text"),
                predicate=lambda node: node.get_state_set().contains(Atspi.StateType.SENSITIVE)
                and in_active_window(node),
            )
            is not None,
            "the GUI CLI install to finish",
        )
        wait("Pair this computer", "heading")
        self.chrome.until(lambda: (Path.home() / "fixture-installer-called").is_file(),
                          "the reviewed installer to run")
        calls = calls_file.read_text().count("install") if calls_file.exists() else 0
        if calls != 1:
            raise RuntimeError(f"A double-click ran {calls} installer invocations")
        self.chrome.record("fresh controlled-device setup installs the CLI once through the GUI", True)
        self.capture("after-install")

        # Consent refusal: pairing and Start stay blocked until the explicit
        # approval, and Start additionally stays blocked without pairing.
        pair_button = wait("Pair this computer", "push button", predicate=in_active_window)
        if pair_button.get_state_set().contains(Atspi.StateType.SENSITIVE):
            raise RuntimeError("Pairing was offered before explicit remote-execution consent")
        start_button = wait("Start", "push button", predicate=in_active_window)
        if start_button.get_state_set().contains(Atspi.StateType.SENSITIVE):
            raise RuntimeError("Start was offered before consent and pairing")
        self.chrome.record("consent refusal keeps pairing and start blocked", True)

        click("Allow remote control of this computer", prefix=True)
        wait("Pair this computer", "push button", predicate=lambda node:
             in_active_window(node) and node.get_state_set().contains(Atspi.StateType.SENSITIVE))
        start_button = wait("Start", "push button", predicate=in_active_window)
        if start_button.get_state_set().contains(Atspi.StateType.SENSITIVE):
            raise RuntimeError("Start ignored the missing canonical pairing")
        self.chrome.record("start requires canonical pairing, not just consent", True)
        self.capture("consent-gates")

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
            lifecycle = [item for item in self.events() if item["event"] in (
                "connect-start", "foreground-run", "service-first-connect",
                "service-install", "service-start", "service-stop", "service-restart",
            )]
            if lifecycle:
                raise RuntimeError(f"Invalid input reached the CLI lifecycle: {lifecycle!r}")
        if not no_handoff_files():
            raise RuntimeError("Invalid input staged a pairing secret")
        self.chrome.record("invalid and expired input never stage secrets or spawn the CLI", True)

        # Real foreground pairing: 0600 handoff, approval wait, then connected.
        pair(JOIN_URL, name="Desk")
        self.expect_connect(1, JOIN_CODE_DIGEST, service=False)
        self.capture("running-foreground")
        self.chrome.record("approval completes the join-URL pairing", True)
        self.set_state(requirePaired=True)
        if not no_handoff_files():
            raise RuntimeError("A redeemed pairing secret remained on disk")

        # Stop joins the observed process tree; reconnect and restart restate
        # the fixed minimal surface without any secret.
        click("Stop")
        wait("Status: Off")
        self.chrome.until(lambda: any(
            item["event"] == "foreground-stop" and item.get("descendantGone")
            for item in self.events()), "the first foreground tree to join")
        self.chrome.record("stop joins the CLI and its descendant", True)
        click("Start")
        try:
            self.chrome.until(lambda: self.count_events("foreground-run") >= 1,
                              "the saved-pairing reconnect")
        except RuntimeError as error:
            status_line = window_text("Status:")
            feedback_line = window_text("Action feedback")
            raise RuntimeError(
                f"{error}; window reports status={status_line!r} feedback={feedback_line!r}"
            ) from None
        wait("Status: Running")
        click("Restart")
        self.chrome.until(lambda: self.count_events("foreground-run") >= 2,
                          "the GUI restart")
        wait("Status: Running")
        self.chrome.until(lambda: self.count_events("foreground-stop") >= 2,
                          "the restarted foreground tree to join")
        self.chrome.record("reconnect and restart never resend a pairing secret", True)

        # Service pairing waits for approval in the supervised install path.
        self.approve_file.unlink(missing_ok=True)
        pair(VALID_CODE, mode="service", install_assert=True)
        self.expect_connect(2, hashlib.sha256(VALID_CODE.encode()).hexdigest(), service=True)
        self.capture("running-service")
        events = self.events()
        install = next(item for item in events if item["event"] == "service-install")
        program = install["programArguments"]
        if "--executor" not in program or "--commands" not in program \
                or "--target-file" in program:
            raise RuntimeError(f"Service install arguments broke the contract: {program!r}")
        self.chrome.record("service approval waiting installs with executor args", True)

        # Delayed service stop: re-pairing to foreground is serialized by the
        # controller — the old service stops and reconciles first, and no
        # foreground node starts beside it.
        self.set_state(stopDelayMs=1500, requirePaired=True)
        foreground_runs = self.count_events("foreground-run")
        pair(JOIN_URL, mode=None)
        events = self.events()
        stops = [index for index, item in enumerate(events) if item["event"] == "service-stop"]
        connects = [index for index, item in enumerate(events) if item["event"] == "connect-start"]
        if not stops or not connects or stops[-1] > connects[-1]:
            raise RuntimeError(f"Service replacement was not serialized: {events!r}")
        if self.count_events("foreground-run") != foreground_runs:
            raise RuntimeError("A foreground node started beside the stopping service")
        wait("Status: Running")
        self.chrome.record("delayed service stop serializes the re-pair", True)
        self.capture("repaired-foreground")

        # Failed service stop retains service authority: Start must not fall
        # back to a foreground node while the old service may still own the
        # canonical identity, and the failed action is shown as Needs
        # attention — never as a service state.
        self.approve_file.unlink(missing_ok=True)
        pair(VALID_CODE, mode="service")
        self.set_state(stopShouldFail=True)
        click("Stop")
        wait("The service change did not finish. Try again.", None, prefix=True)
        if "Needs attention" not in window_text("Status:"):
            raise RuntimeError(
                f"A failed stop was not Needs attention: {window_text('Status:')!r}"
            )
        self.chrome.until(lambda: self.count_events("service-stop-failed") >= 1,
                          "the failing service stop")
        starts = self.count_events("foreground-run")
        click("Start")
        wait("Status: Running (background service)")
        if self.count_events("foreground-run") != starts:
            raise RuntimeError("Start fell back to a foreground node after a failed stop")
        self.chrome.until(lambda: self.count_events("service-start") >= 1,
                          "the service start request")
        self.chrome.record("failed service stop retains service authority", True)

        # An unknown runtime probe after a restart is explicit Needs attention
        # with unknown detail — never collapsed into Stopped.
        self.set_state(statusUnknown=True)
        click("Restart")
        wait("Status: Needs attention")
        self.chrome.record("unknown service probe stays distinct from stopped", True)
        self.set_state(statusUnknown=False)
        click("Start")
        wait("Status: Running (background service)")

        # Consent withdrawal must never block stopping a running service.
        click("Allow remote control of this computer", prefix=True)
        start_button = wait("Start", "push button", predicate=lambda node:
                            in_active_window(node)
                            and not node.get_state_set().contains(Atspi.StateType.SENSITIVE))
        self.chrome.record("withdrawn consent disables start", True)
        stops_before = self.count_events("service-stop")
        click("Stop")
        self.chrome.until(lambda: self.count_events("service-stop") >= stops_before + 1,
                          "the consent-free service stop")
        wait("Status: Stopped (background service)")
        self.chrome.record("clearing consent still stops a running service", True)
        click("Allow remote control of this computer", prefix=True)
        wait("Pair this computer", "push button", predicate=lambda node:
             in_active_window(node) and node.get_state_set().contains(Atspi.StateType.SENSITIVE))

        # Final exit teardown: a self-exiting restart leader leaves a
        # TERM-ignoring descendant, so the real force-kill window is exercised
        # before the controller gives up or replaces it.
        self.set_state(ignoreTermDescendant=True, selfExitAfterMs=1500, stopShouldFail=False)
        self.approve_file.unlink(missing_ok=True)
        pair(JOIN_URL, name="Desk")
        runs_before = self.count_events("foreground-run")
        click("Restart")
        self.chrome.until(
            lambda: self.count_events("foreground-run") >= runs_before + 1,
            "the self-exiting restarted run",
        )
        stable_runs = runs_before + 1
        deadline = time.monotonic() + JOIN_WINDOW_SECONDS

        def status_text():
            node = wait("Status:", None, prefix=True)
            from gi.repository import Atspi as _Atspi

            text = node.get_text_iface()
            return "" if text is None else _Atspi.Text.get_text(text, 0, -1)

        def orphan_identity():
            exits = [item for item in self.events() if item["event"] == "leader-exit"]
            return exits[-1]["descendant"] if exits else None

        def descendant_gone():
            orphan = orphan_identity()
            if orphan is None:
                return False
            current = Path(f"/proc/{orphan['pid']}/stat")
            if not current.exists():
                return True
            fields = current.read_text().rsplit(") ", 1)[1].split()
            return fields[19] != orphan["start"]

        while time.monotonic() < deadline:
            if self.count_events("foreground-run") != stable_runs:
                raise RuntimeError("A replacement started beside an unjoined tree")
            if "Running" not in status_text() and descendant_gone():
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("The unjoined process tree was never joined")
        wait("The controlled device stopped unexpectedly.", None, prefix=True)
        self.chrome.record("final exit retains and joins the unjoined tree", True)
        self.capture("final-exit-teardown")

        if not no_handoff_files():
            raise RuntimeError("A pairing secret outlived its redemption")
        log = Path("app.log")
        if log.exists():
            contents = log.read_text(errors="replace")
            for secret in SECRETS:
                if secret and secret in contents:
                    raise RuntimeError("The app log disclosed a pairing secret")
        self.passed = True
        print("PASS: controlled-device GUI install, consent, secrets, serialized service and teardown", flush=True)

    def expect_connect(self, count, digest, service):
        self.chrome.until(
            lambda: len([item for item in self.events() if item["event"] == "connect-start"]) >= count,
            "the synthetic connect with the staged secret",
        )
        connects = [item for item in self.events() if item["event"] == "connect-start"]
        first = connects[count - 1]
        if first["handoffMode"] != "600" or first["secretSha256"] != digest \
                or first["service"] is not service or first["displayName"] != "Desk" \
                or first["commands"] != COMMANDS_CSV:
            raise RuntimeError("Pairing lost the 0600 handoff contract")

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
                    "boundary": "Real Tauri WebKit GUI, OS vault, 0600 handoff, serialized "
                                "service lifecycle, and joined process tree; not real Gateway "
                                "pairing or systemd",
                }, indent=2) + "\n")
            if leaked:
                message = f"Controlled-device proof leaked process or secret state: {leaked!r}"
                if failure is not None:
                    message = f"{failure}; {message}"
                raise RuntimeError(message) from failure
