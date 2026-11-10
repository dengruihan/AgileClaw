"""Real Tauri first-run admission proof for the controlled-device GUI.

Starts with no CLI, installs the CLI through the main window's GUI installer,
and verifies that admission immediately returns to Welcome so the user can
choose "Be controlled from another computer". The fixture CLI and installer are
the same reviewed synthetic boundary used by executor_node.py; pairing against
a real Gateway is proven separately.
"""

import json
import time
from pathlib import Path

from executor_node import ExecutorNodeFixture


class ExecutorFirstRunFixture(ExecutorNodeFixture):
    def start(self):
        super().start()
        # A configured local Gateway without a CLI is the main window's
        # CLI-required admission state; the fixture must not auto-install a CLI.
        config = Path.home() / ".openclaw/openclaw.json"
        config.write_text(json.dumps({"gateway": {"mode": "local", "port": 18791}}))
        config.chmod(0o600)

    def stage_binary(self, binary):
        staged = super().stage_binary(binary)
        installer = staged.parent / "install-cli.sh"
        installer.write_text(
            "#!/bin/bash\n"
            "set -euo pipefail\n"
            'prefix="$HOME/.openclaw"\n'
            'mkdir -p "$prefix/bin"\n'
            'cp "$HOME/fixture-cli.py" "$prefix/bin/openclaw"\n'
            'chmod 700 "$prefix/bin/openclaw"\n'
            "printf '{\"event\":\"done\",\"ok\":true}\\n'\n"
        )
        installer.chmod(0o700)
        return staged

    def exercise_first_run(self, app, binary, wait, Atspi):
        def in_active_window(node):
            while node is not None and node.get_localized_role_name() != "application":
                if node.get_state_set().contains(Atspi.StateType.ACTIVE):
                    return True
                node = node.get_parent()
            return False

        def click(label, role=("button", "push button"), *, prefix=False):
            node = wait(label, role, prefix=prefix)
            component = node.get_component_iface()
            component.scroll_to(Atspi.ScrollType.ANYWHERE)
            bounds = component.get_extents(Atspi.CoordType.SCREEN)
            self.chrome.command(
                "xdotool",
                "mousemove",
                str(bounds.x + bounds.width // 2),
                str(bounds.y + bounds.height // 2),
                "click",
                "1",
            )

        def executor_window():
            return self.chrome.until(
                lambda: next(
                    (
                        window
                        for window, title in self.fixture.windows(app).items()
                        if title.startswith("Controlled Device")
                    ),
                    None,
                ),
                "the controlled-device window",
            )

        wait("OpenClaw needs the CLI", ("heading",))
        self.capture("first-run-cli-required")
        click("Install OpenClaw")

        # A successful GUI install must re-run admission and return to Welcome,
        # without a restart or a local Gateway.
        wait("Welcome to OpenClaw", ("heading",), timeout=90)
        self.capture("first-run-welcome")
        click("Get started")
        wait("Where should your assistant live?", ("heading",))
        click("Be controlled from another computer", prefix=True)
        self.chrome.command("wmctrl", "-ia", executor_window())
        wait("Pair this computer", ("heading",))

        pair_button = wait(
            "Pair this computer",
            "push button",
            predicate=lambda node: in_active_window(node),
        )
        if pair_button.get_state_set().contains(Atspi.StateType.SENSITIVE):
            raise RuntimeError(
                "Pairing was offered before the controlled-side consent checkbox"
            )
        self.capture("first-run-controlled-device")
        self.chrome.record(
            "GUI CLI install returns to Welcome and opens the controlled-device pane",
            True,
        )
        self.passed = True

    def close(self):
        failure = __import__("sys").exc_info()[1]
        try:
            self.fixture.close()
        finally:
            if self.artifacts_dir:
                (self.artifacts_dir / "executor-first-run-results.json").write_text(
                    __import__("json").dumps(
                        {
                            "passed": failure is None,
                            "checks": self.fixture.chrome.checks,
                            "boundary": "Real Tauri first-run GUI admission with a "
                            "synthetic CLI installer; not real Gateway pairing",
                        },
                        indent=2,
                    )
                    + "\n"
                )
