import http from "node:http";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
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
const TOSTRING_CANARY = "tostring-err-canary-8f13";
const TOJSON_CANARY = "tojson-err-canary-52aa";
const ARRAY_CANARY = "array-err-canary-d6b1";
const FUNC_CANARY = "func-err-canary-r5";
const KEY_CANARY = "property-key-canary-r5";

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

function assertInert(thrown: unknown, canary: string): void {
  expect(String(thrown)).not.toContain(canary);
  expect(JSON.stringify(thrown)).not.toContain(canary);
  expect(formatErrorMessage(thrown)).not.toContain(canary);
  expect(collectReachableText(thrown)).not.toContain(canary);
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

describe("browser tool thrown fill-error scrub (inert projection)", () => {
  beforeEach(() => {
    clearAllVaultFillSessions();
    mocks.browserTabs.mockReset();
    mocks.browserTabs.mockImplementation(realBrowserTabs);
  });

  it("returns a fresh inert error for a frozen secret-bearing error", async () => {
    registerVaultFillSecret("target-1", FROZEN_CANARY, "doc-1");
    const error = Object.assign(
      new BrowserServiceError(`tabs failed ${FROZEN_CANARY}`, undefined, 500),
      { details: { body: FROZEN_CANARY } },
    );
    Object.freeze(error);
    Object.freeze(error.details);
    mocks.browserTabs.mockRejectedValue(error);

    const thrown = await executeTabsAction();

    expect(Object.is(thrown, error)).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("***");
    expect((thrown as Error).name).toBe("BrowserServiceError");
    expect((thrown as { status?: number }).status).toBe(500);
    assertInert(thrown, FROZEN_CANARY);
  });

  it("drops non-configurable accessors instead of reading them once", async () => {
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

    expect(Object.is(thrown, error)).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    // Accessor-carried text is not copied at all: it can never be proven inert.
    expect((thrown as Error).message).not.toBe("base");
    expect((thrown as { details?: unknown }).details).toBeUndefined();
    assertInert(thrown, ACCESSOR_CANARY);
    // The untouchable original keeps its secret; it must simply not be rethrown.
    expect(error.message).toContain(ACCESSOR_CANARY);
  });

  it("masks a secret-bearing name and nested cause code on inert copies", async () => {
    registerVaultFillSecret("target-1", NAME_CANARY, "doc-1");
    const cause = Object.assign(new Error(`upstream ${NAME_CANARY}`), { code: `E_${NAME_CANARY}` });
    const error = Object.assign(
      new BrowserServiceError(`tabs failed ${NAME_CANARY}`, undefined, 500),
      { name: `BrowserServiceError_${NAME_CANARY}`, cause },
    );
    mocks.browserTabs.mockRejectedValue(error);

    const thrown = await executeTabsAction();

    expect(Object.is(thrown, error)).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("BrowserServiceError_***");
    expect((thrown as Error).message).toBe("tabs failed ***");
    expect((thrown as { status?: number }).status).toBe(500);
    const thrownCause = (thrown as { cause?: Error }).cause;
    expect(thrownCause).toBeInstanceOf(Error);
    expect(Object.is(thrownCause, cause)).toBe(false);
    expect((thrownCause as Error).message).toBe("upstream ***");
    expect((thrownCause as { code?: string }).code).toBe("E_***");
    assertInert(thrown, NAME_CANARY);
  });

  it("replaces an error whose frozen nested cause cannot be scrubbed", async () => {
    registerVaultFillSecret("target-1", CAUSE_CANARY, "doc-1");
    const cause = Object.assign(new Error(`upstream ${CAUSE_CANARY}`), {
      code: `E_${CAUSE_CANARY}`,
    });
    Object.freeze(cause);
    const error = Object.assign(
      new BrowserServiceError(`tabs failed ${CAUSE_CANARY}`, undefined, 500),
      { cause },
    );
    mocks.browserTabs.mockRejectedValue(error);

    const thrown = await executeTabsAction();

    expect(Object.is(thrown, error)).toBe(false);
    expect((thrown as { cause?: unknown }).cause).not.toBe(cause);
    expect((thrown as Error).message).toBe("tabs failed ***");
    const thrownCause = (thrown as { cause?: Error }).cause;
    expect((thrownCause as Error).message).toBe("upstream ***");
    assertInert(thrown, CAUSE_CANARY);
  });

  it("drops a configurable accessor without ever invoking it", async () => {
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

    expect(Object.is(thrown, error)).toBe(false);
    expect((thrown as { details?: unknown }).details).toBeUndefined();
    expect(reads).toBe(0);
    assertInert(thrown, REGEN_CANARY);
    // Even the original's later reads cannot reach the tool result anymore.
    expect(reads).toBe(0);
  });

  it("drops a stateful own toString and stays clean on later String() reads", async () => {
    registerVaultFillSecret("target-1", TOSTRING_CANARY, "doc-1");
    const error = new BrowserServiceError(`tabs failed ${TOSTRING_CANARY}`, undefined, 500);
    let toStringCalls = 0;
    Object.assign(error, {
      toString: () => {
        toStringCalls += 1;
        return toStringCalls === 1 ? "BrowserServiceError: looks fine" : `boom ${TOSTRING_CANARY}`;
      },
    });
    mocks.browserTabs.mockRejectedValue(error);

    const thrown = await executeTabsAction();

    expect(Object.is(thrown, error)).toBe(false);
    // The custom formatter is dropped unread; later stringifications are inert.
    expect(toStringCalls).toBe(0);
    expect(String(thrown)).not.toContain(TOSTRING_CANARY);
    expect(String(thrown)).toContain("tabs failed ***");
    assertInert(thrown, TOSTRING_CANARY);
    expect(toStringCalls).toBe(0);
  });

  it("drops a stateful toJSON and stays clean through the downstream error formatter", async () => {
    registerVaultFillSecret("target-1", TOJSON_CANARY, "doc-1");
    let jsonCalls = 0;
    const source = {
      status: 503,
      note: "upstream rejected",
      toJSON: () => {
        jsonCalls += 1;
        return jsonCalls === 1 ? { ok: true } : { leak: TOJSON_CANARY };
      },
    };
    mocks.browserTabs.mockRejectedValue(source);

    const thrown = await executeTabsAction();

    expect(Object.is(thrown, source)).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    // toJSON is dropped unread; the real model-error formatter stays clean.
    expect(jsonCalls).toBe(0);
    expect(formatErrorMessage(thrown)).not.toContain(TOJSON_CANARY);
    assertInert(thrown, TOJSON_CANARY);
    expect(jsonCalls).toBe(0);
  });

  it("drops a non-configurable array-index accessor on later indexed reads", async () => {
    registerVaultFillSecret("target-1", ARRAY_CANARY, "doc-1");
    const error = Object.assign(new BrowserServiceError("tabs failed", undefined, 500), {
      details: ["clean"],
    });
    let indexedReads = 0;
    Object.defineProperty(error.details, "0", {
      get() {
        indexedReads += 1;
        return indexedReads <= 2 ? "clean" : `late ${ARRAY_CANARY}`;
      },
      enumerable: true,
      configurable: false,
    });
    mocks.browserTabs.mockRejectedValue(error);

    const thrown = await executeTabsAction();

    expect(Object.is(thrown, error)).toBe(false);
    const details = (thrown as { details?: unknown[] }).details;
    expect(Array.isArray(details)).toBe(true);
    // The accessor entry is dropped, not snapshotted: indexed reads are inert.
    expect(details?.[0]).toBeUndefined();
    expect(indexedReads).toBe(0);
    assertInert(thrown, ARRAY_CANARY);
    // The original keeps its live stateful accessor; only the thrown copy is inert.
    expect(error.details[0]).toBe("clean");
    expect(error.details[0]).toBe("clean");
    expect(error.details[0]).toContain(ARRAY_CANARY);
    expect(indexedReads).toBe(3);
  });

  it("replaces a root function throw instead of returning it live", async () => {
    registerVaultFillSecret("target-1", FUNC_CANARY, "doc-1");
    const fn = () => "clean";
    let toStringCalls = 0;
    Object.defineProperty(fn, "toString", {
      value: () => {
        toStringCalls += 1;
        return toStringCalls === 1 ? "clean" : `boom ${FUNC_CANARY}`;
      },
      writable: true,
      configurable: true,
    });
    mocks.browserTabs.mockRejectedValue(fn);

    const thrown = await executeTabsAction();

    expect(Object.is(thrown, fn)).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    // The function (and its formatter) is never carried or even read.
    expect(toStringCalls).toBe(0);
    assertInert(thrown, FUNC_CANARY);
  });

  it("returns a root function throw unchanged when no secret applies", async () => {
    const fn = () => "clean";
    mocks.browserTabs.mockRejectedValue(fn);

    const thrown = await executeTabsAction();

    expect(Object.is(thrown, fn)).toBe(true);
  });

  it("masks secret-bearing property names on an inert thrown error", async () => {
    registerVaultFillSecret("target-1", KEY_CANARY, "doc-1");
    const error = Object.assign(new BrowserServiceError("tabs failed", undefined, 500), {
      details: { [KEY_CANARY]: "clean" },
    });
    mocks.browserTabs.mockRejectedValue(error);

    const thrown = await executeTabsAction();

    expect(Object.is(thrown, error)).toBe(false);
    // The final model-bound payload must not carry the raw key anywhere.
    const serialized = JSON.stringify(thrown);
    expect(serialized).not.toContain(KEY_CANARY);
    expect(serialized).toContain("***");
    assertInert(thrown, KEY_CANARY);
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

    it("masks a real rejected /tabs body on an inert error with name and status", async () => {
      registerVaultFillSecret("target-1", LOOPBACK_CANARY, "doc-1");

      const thrown = await executeTabsAction({ action: "tabs" }, { sandboxBridgeUrl: baseUrl });

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("BrowserServiceError");
      expect((thrown as { status?: number }).status).toBe(500);
      expect((thrown as Error).message).toContain("tabs unavailable");
      expect((thrown as Error).message).toContain("***");
      expect((thrown as Error).message).not.toContain(LOOPBACK_CANARY);
      assertInert(thrown, LOOPBACK_CANARY);
    });
  });
});
