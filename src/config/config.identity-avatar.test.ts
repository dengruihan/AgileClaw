import path from "node:path";
import { expect, it } from "vitest";
import { withTempHome } from "./test-helpers.js";
import { validateConfigObject } from "./validation.js";

it("rejects avatar paths outside the agent workspace", async () => {
  await withTempHome(async (home) => {
    expect(
      validateConfigObject({
        agents: {
          entries: {
            main: {
              workspace: path.join(home, "openclaw"),
              identity: { avatar: "../oops.png" },
            },
          },
        },
      }),
    ).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "agents.entries.main.identity.avatar",
          pathSegments: ["agents", "entries", "main", "identity", "avatar"],
        }),
      ],
    });
  });
});

it("rejects persisted base64 data URI avatars with doctor guidance", async () => {
  await withTempHome(async (home) => {
    const result = validateConfigObject({
      agents: {
        entries: {
          main: {
            workspace: path.join(home, "openclaw"),
            identity: { avatar: "data:image/png;base64,AQID" },
          },
        },
      },
    });
    if (result.ok) {
      throw new Error("expected the avatar config to be rejected");
    }
    expect(result.issues[0]?.message).toMatch(
      /no longer accepts base64 data URIs.*openclaw doctor --fix/s,
    );
  });
});

it("still accepts workspace-relative and http avatars", async () => {
  await withTempHome(async (home) => {
    const workspace = path.join(home, "openclaw");
    expect(
      validateConfigObject({
        agents: {
          ownership: "explicit",
          entries: {
            main: { workspace, identity: { avatar: "avatars/main.png" } },
            remote: { workspace, identity: { avatar: "https://example.test/a.png" } },
          },
        },
      }),
    ).toMatchObject({ ok: true });
  });
});
