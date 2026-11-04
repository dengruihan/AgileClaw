import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ browserTabs: vi.fn() }));

// Keep the real tool, dispatch, and projection; isolate only browser I/O and
// node routing from the operator's browser state. browserTabs defaults to the
// real client implementation so the loopback probe exercises the real fetch.
vi.mock("./browser-tool.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browser-tool.runtime.js")>();
  return {
    ...actual,
    browserTabs: mocks.browserTabs,
    getRuntimeConfig: () => ({ browser: {}, gateway: { nodes: { browser: { mode: "off" } } } }),
  };
});

const { createBrowserTool } = await import("./browser-tool.js");
const { browserTabs: realBrowserTabs } = await import("./browser/client.js");
const { BrowserServiceError } = await import("./browser/client-fetch.js");
const { clearAllVaultFillSessions, registerVaultFillSecret } =
  await import("./browser/vault-fill-scrub.js");

const FROZEN_CANARY = "frozen-err-canary-71ac";
const ACCESSOR_CANARY = "accessor-err-canary-4d09";
const NAME_CANARY = "name-err-canary-b2f7";
const CAUSE_CANARY = "cause-err-canary-9e31";
const REGEN_CANARY = "regen-err-canary-6a44";
const LOOPBACK_CANARY = "loopback-err-canary-c3d8";

function collectReachableText(value: unknown, depth = 0): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object" || depth > 6) {
    return "";
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  try {
    const formatted = value instanceof Error ? value.toString() : JSON.stringify(value);
    if (typeof formatted === "string") {
      parts.push(formatted);
    }
  } catch {
    // A throwing formatter cannot return a value to the model.
  }
  for (const key of ["message", "stack", "name", "code", "status", "details", "cause"]) {
    try {
      parts.push(collectReachableText(record[key], depth + 1));
    } catch {
      // Read failures are themselves unreadable values.
    }
  }
  try {
    for (const key of Object.keys(record)) {
      parts.push(collectReachableText(record[key], depth + 1));
    }
  } catch {
    // See above.
  }
  return parts.join("\n");
}

async function executeTabsAction(
  params: Record<string, unknown> = { action: "tabs" },
  toolOpts: { sandboxBridgeUrl?: string } = {},
): Promise<unknown> {
  const tool = createBrowserTool({ allowHostControl: true, ...toolOpts });
  try {
    await tool.execute?.("call-1", params, undefined as never, undefined as never);
  } catch (caught) {
    return caught;
  }
  throw new Error("expected the browser tool to reject");
}

describe("browser tool thrown fill-error scrub (fail closed)", () => {
  beforeEach(() => {
    clearAllVaultFillSessions();
    mocks.browserTabs.mockReset();
    mocks.browserTabs.mockImplementation(realBrowserTabs);
  });

  it("replaces a frozen error instead of rethrowing its secret-bearing message", async () => {
    registerVaultFillSecret("target-1", FROZEN_CANARY, "doc-1");
    const error = Object.assign(
      new BrowserServiceError(`tabs failed ${FROZEN_CANARY}`, undefined, 500),
      { details: { body: FROZEN_CANARY } },
    );
    Object.freeze(error);
    Object.freeze(error.details);
    mocks.browserTabs.mockRejectedValue(error);

    const thrown = await executeTabsAction();

    expect(thrown).not.toBe(error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("***");
    expect((thrown as Error).name).toBe("BrowserServiceError");
    expect((thrown as { status?: number }).status).toBe(500);
    expect(collectReachableText(thrown)).not.toContain(FROZEN_CANARY);
    expect(JSON.stringify(thrown)).not.toContain(FROZEN_CANARY);
    expect(String(thrown)).not.toContain(FROZEN_CANARY);
  });

  it("replaces non-configurable accessors that regenerate the secret", async () => {
    registerVaultFillSecret("target-1", ACCESSOR_CANARY, "doc-1");
    const error = new BrowserServiceError("base", undefined, 500);
    Object.defineProperty(error, "message", {
      get() {
        return `boom ${ACCESSOR_CANARY}`;
      },
      enumerable: false,
      configurable: false,
    });
    Object.defineProperty(error, "details", {
      get() {
        return { body: `fresh ${ACCESSOR_CANARY}` };
      },
      enumerable: true,
      configurable: false,
    });
    mocks.browserTabs.mockRejectedValue(error);

    const thrown = await executeTabsAction();

    expect(thrown).not.toBe(error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toBe("base");
    expect(collectReachableText(thrown)).not.toContain(ACCESSOR_CANARY);
    expect(JSON.stringify(thrown)).not.toContain(ACCESSOR_CANARY);
    // The withheld details keep diagnostics without any live accessor.
    expect((thrown as { details?: { body?: string } }).details?.body).toBe("fresh ***");
    // The untouchable original keeps its secret; it must simply not be rethrown.
    expect(error.message).toContain(ACCESSOR_CANARY);
  });

  it("masks a secret-bearing name and nested cause code while keeping the class", async () => {
    registerVaultFillSecret("target-1", NAME_CANARY, "doc-1");
    const cause = Object.assign(new Error(`upstream ${NAME_CANARY}`), { code: `E_${NAME_CANARY}` });
    const error = Object.assign(
      new BrowserServiceError(`tabs failed ${NAME_CANARY}`, undefined, 500),
      { name: `BrowserServiceError_${NAME_CANARY}`, cause },
    );
    mocks.browserTabs.mockRejectedValue(error);

    const thrown = await executeTabsAction();

    expect(thrown).toBe(error);
    expect(thrown).toBeInstanceOf(BrowserServiceError);
    expect((thrown as Error).name).toBe("BrowserServiceError_***");
    expect((thrown as Error).message).not.toContain(NAME_CANARY);
    expect((thrown as { status?: number }).status).toBe(500);
    expect(((thrown as { cause?: Error }).cause as { code?: string }).code).toBe("E_***");
    expect(collectReachableText(thrown)).not.toContain(NAME_CANARY);
    expect(JSON.stringify(thrown)).not.toContain(NAME_CANARY);
  });

  it("replaces an error whose frozen nested cause cannot be scrubbed", async () => {
    registerVaultFillSecret("target-1", CAUSE_CANARY, "doc-1");
    const cause = Object.assign(new Error(`upstream ${CAUSE_CANARY}`), {
      code: `E_${CAUSE_CANARY}`,
    });
    Object.freeze(cause);
    const error = Object.assign(
      new BrowserServiceError(`tabs failed ${CAUSE_CANARY}`, undefined, 500),
      {
        cause,
      },
    );
    mocks.browserTabs.mockRejectedValue(error);

    const thrown = await executeTabsAction();

    expect(thrown).not.toBe(error);
    expect((thrown as { cause?: unknown }).cause).not.toBe(cause);
    expect(collectReachableText(thrown)).not.toContain(CAUSE_CANARY);
    expect(JSON.stringify(thrown)).not.toContain(CAUSE_CANARY);
    expect((thrown as Error).message).toContain("***");
  });

  it("freezes a configurable accessor at scrub time so it cannot regenerate later", async () => {
    registerVaultFillSecret("target-1", REGEN_CANARY, "doc-1");
    const error = new BrowserServiceError("tabs ok", undefined, 500);
    let reads = 0;
    Object.defineProperty(error, "details", {
      get() {
        reads += 1;
        return reads === 1 ? { body: "clean" } : { body: `late ${REGEN_CANARY}` };
      },
      enumerable: true,
      configurable: true,
    });
    mocks.browserTabs.mockRejectedValue(error);

    const thrown = await executeTabsAction();

    expect(thrown).toBe(error);
    expect((thrown as { details?: { body?: string } }).details?.body).toBe("clean");
    expect(collectReachableText(thrown)).not.toContain(REGEN_CANARY);
    // Later reads must keep returning the scrub-time snapshot, not the getter.
    expect(reads).toBe(1);
    expect((thrown as { details?: { body?: string } }).details?.body).toBe("clean");
  });

  describe("real loopback /tabs rejection", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeEach(async () => {
      for (const key of [
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
      ]) {
        vi.stubEnv(key, "");
      }
      server = http.createServer((req, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`tabs unavailable: session ${LOOPBACK_CANARY} rejected`);
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected loopback server address");
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it("masks a real rejected /tabs body while preserving class and status", async () => {
      registerVaultFillSecret("target-1", LOOPBACK_CANARY, "doc-1");

      const thrown = await executeTabsAction({ action: "tabs" }, { sandboxBridgeUrl: baseUrl });

      expect(thrown).toBeInstanceOf(BrowserServiceError);
      expect((thrown as Error).name).toBe("BrowserServiceError");
      expect((thrown as { status?: number }).status).toBe(500);
      expect((thrown as Error).message).toContain("tabs unavailable");
      expect((thrown as Error).message).toContain("***");
      expect(collectReachableText(thrown)).not.toContain(LOOPBACK_CANARY);
      expect(String(thrown)).not.toContain(LOOPBACK_CANARY);
      expect(JSON.stringify(thrown)).not.toContain(LOOPBACK_CANARY);
    });
  });
});
