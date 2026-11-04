import { beforeEach, describe, expect, it } from "vitest";
import {
  assertVaultFillActAllowed,
  clearVaultFillSession,
  clearVaultFillSessionIfDocumentChanged,
  hasActiveVaultFill,
  hasAnyActiveVaultFill,
  registerVaultFillSecret,
  scrubVaultFillError,
  scrubVaultFillText,
  scrubVaultFillValue,
  scrubVaultFillValueAll,
} from "./vault-fill-scrub.js";

const CANARY = "canary-fill-0f9c2a7d";

describe("vault fill scrub", () => {
  beforeEach(() => {
    clearVaultFillSession("target-1");
    clearVaultFillSession("target-2");
  });

  it("fully masks raw, URL-encoded, JSON-escaped, and base64 values", () => {
    registerVaultFillSecret("target-1", CANARY);
    const encoded = encodeURIComponent(CANARY);
    const base64 = Buffer.from(CANARY, "utf8").toString("base64");
    const jsonEscaped = JSON.stringify(CANARY).slice(1, -1);
    const text = `raw=${CANARY} url=${encoded} b64=${base64} json=${jsonEscaped}`;
    const scrubbed = scrubVaultFillText("target-1", text);
    expect(scrubbed).not.toContain(CANARY);
    expect(scrubbed).not.toContain(encoded);
    expect(scrubbed).not.toContain(base64);
    expect(scrubbed).toContain("***");
  });

  it("scrubs nested tool results regardless of logging.redact", () => {
    registerVaultFillSecret("target-1", CANARY);
    const result = scrubVaultFillValue("target-1", {
      result: { value: CANARY, nested: [CANARY, "safe"] },
      content: [{ type: "text", text: `value ${CANARY}` }],
    });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result.result.nested[1]).toBe("safe");
  });

  it("keeps masking until the session is explicitly cleared, not by TTL", () => {
    registerVaultFillSecret("target-1", CANARY);
    expect(hasActiveVaultFill("target-1")).toBe(true);
    expect(hasAnyActiveVaultFill()).toBe(true);
    expect(scrubVaultFillText("target-1", CANARY)).toBe("***");
    clearVaultFillSession("target-1");
    expect(hasActiveVaultFill("target-1")).toBe(false);
    expect(hasAnyActiveVaultFill()).toBe(false);
    expect(scrubVaultFillText("target-1", CANARY)).toBe(CANARY);
  });

  it("blocks scripts and every mutation path at any batch depth", () => {
    registerVaultFillSecret("target-1", CANARY);
    expect(() =>
      assertVaultFillActAllowed("target-1", {
        kind: "batch",
        actions: [
          {
            kind: "batch",
            actions: [{ kind: "evaluate", fn: "() => document.querySelector('input').value" }],
          },
        ],
      }),
    ).toThrow(/evaluate/u);
    expect(() =>
      assertVaultFillActAllowed("target-1", {
        kind: "batch",
        actions: [{ kind: "batch", actions: [{ kind: "press", key: "Enter" }] }],
      }),
    ).toThrow(/interactions are blocked/u);
    expect(() => assertVaultFillActAllowed("target-1", { kind: "click", ref: "1" })).toThrow(
      /interactions are blocked/u,
    );
    expect(() =>
      assertVaultFillActAllowed("target-2", { kind: "press", key: "Enter" }),
    ).not.toThrow();
  });

  it("clears only when the approved document is proven replaced", () => {
    registerVaultFillSecret("target-1", CANARY, "doc-1");
    expect(clearVaultFillSessionIfDocumentChanged("target-1", "doc-1")).toBe(false);
    expect(hasActiveVaultFill("target-1")).toBe(true);
    expect(clearVaultFillSessionIfDocumentChanged("target-1", undefined)).toBe(false);
    expect(hasActiveVaultFill("target-1")).toBe(true);
    expect(clearVaultFillSessionIfDocumentChanged("target-1", "doc-2")).toBe(true);
    expect(hasActiveVaultFill("target-1")).toBe(false);
    expect(scrubVaultFillText("target-1", CANARY)).toBe(CANARY);
  });

  it("masks every active fill secret for aggregate or uncertain results", () => {
    registerVaultFillSecret("target-1", "canary-one", "doc-1");
    registerVaultFillSecret("target-2", "canary-two", "doc-2");
    const result = scrubVaultFillValueAll({
      tabs: [{ title: "canary-one" }, { title: "canary-two" }],
      text: "canary-one and canary-two",
    });
    expect(JSON.stringify(result)).not.toContain("canary-one");
    expect(JSON.stringify(result)).not.toContain("canary-two");
    expect(JSON.stringify(result)).toContain("***");
  });

  it("never re-attaches an original shared or cyclic object to a scrubbed result", () => {
    registerVaultFillSecret("target-1", CANARY);
    const shared = { title: `login ${CANARY}` };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = scrubVaultFillValueAll({ first: shared, second: shared, third: cyclic });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(result)).toContain("[Circular]");
  });

  it("masks secret-bearing property names at every depth of a scrubbed result", () => {
    registerVaultFillSecret("target-1", CANARY);
    const result = scrubVaultFillValueAll({
      [CANARY]: { nested: { [`prefix-${CANARY}`]: "clean" } },
      safe: "clean",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).toContain("***");
    expect((result as Record<string, unknown>).safe).toBe("clean");
  });

  it("sets an own data property for __proto__-shaped keys instead of mutating the prototype", () => {
    registerVaultFillSecret("target-1", CANARY);
    const hostile = JSON.parse(`{"__proto__":{"polluted":"${CANARY}"},"safe":"clean"}`) as Record<
      string,
      unknown
    >;
    const result = scrubVaultFillValueAll(hostile) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(Object.prototype.polluted).toBeUndefined();
    expect((result as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({
      polluted: "***",
    });
  });

  it("masks secret-bearing property names on an inert thrown error", () => {
    registerVaultFillSecret("target-1", CANARY);
    const error = Object.assign(new Error("clean"), {
      details: { [CANARY]: "clean" },
    });
    const scrubbed = scrubVaultFillError(error) as { details?: Record<string, unknown> };
    expect(Object.is(scrubbed, error)).toBe(false);
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).toContain("***");
    expect(scrubbed.details).toEqual({ "***": "clean" });
  });

  it("replaces a root function throw with a value-free error", () => {
    registerVaultFillSecret("target-1", CANARY);
    const fn = () => "clean";
    let toStringCalls = 0;
    Object.defineProperty(fn, "toString", {
      value: () => {
        toStringCalls += 1;
        return toStringCalls === 1 ? "clean" : `boom ${CANARY}`;
      },
      writable: true,
      configurable: true,
    });
    const scrubbed = scrubVaultFillError(fn);
    expect(Object.is(scrubbed, fn)).toBe(false);
    expect(scrubbed).toBeInstanceOf(Error);
    expect(String(scrubbed)).not.toContain(CANARY);
    expect(toStringCalls).toBe(0);
    // With no active secret the control keeps identity.
    clearVaultFillSession("target-1");
    expect(scrubVaultFillError(fn)).toBe(fn);
  });

  it("withholds a thrown proxy whose prototype trap throws the canary", () => {
    registerVaultFillSecret("target-1", CANARY);
    const trapError = new Error(`trap ${CANARY}`);
    const evil = new Proxy(
      { clean: "value" },
      {
        getPrototypeOf() {
          throw trapError;
        },
      },
    );
    const scrubbed = scrubVaultFillError(evil);
    expect(Object.is(scrubbed, evil)).toBe(false);
    expect(Object.is(scrubbed, trapError)).toBe(false);
    expect(scrubbed).toBeInstanceOf(Error);
    expect(String(scrubbed as Error)).not.toContain(CANARY);
    expect(JSON.stringify(scrubbed)).not.toContain(CANARY);
  });

  it("never invokes result getters while scrubbing a tool result", () => {
    registerVaultFillSecret("target-1", CANARY);
    let calls = 0;
    const source: Record<string, unknown> = { safe: "clean" };
    Object.defineProperty(source, "hostile", {
      get() {
        calls += 1;
        throw new Error(`late ${CANARY}`);
      },
      enumerable: true,
      configurable: true,
    });
    const result = scrubVaultFillValueAll({ tab: source });
    expect(calls).toBe(0);
    expect(JSON.stringify(result)).toEqual(JSON.stringify({ tab: { safe: "clean" } }));
  });

  it("withholds the result instead of throwing when a revoked proxy is scrubbed", () => {
    registerVaultFillSecret("target-1", CANARY);
    const revocable = Proxy.revocable({ title: CANARY }, {});
    revocable.revoke();
    const result = scrubVaultFillValueAll(revocable.proxy);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(result)).toContain("withheld");
  });

  it("replaces an error with unreadable fields instead of rethrowing it", () => {
    registerVaultFillSecret("target-1", CANARY);
    const error = new Error("clean");
    Object.defineProperty(error, "details", {
      get() {
        throw new Error(`locked ${CANARY}`);
      },
      enumerable: true,
      configurable: true,
    });
    const scrubbed = scrubVaultFillError(error);
    // Identity only: a structural not.toBe would read the hostile getter for
    // Vitest's serialization hint and throw inside the assertion machinery.
    expect(Object.is(scrubbed, error)).toBe(false);
    expect((scrubbed as Error).message).toBe("clean");
    expect(() => JSON.stringify(scrubbed)).not.toThrow();
    expect(JSON.stringify(scrubbed)).not.toContain(CANARY);
  });

  it("can be cleared explicitly on navigation or close", () => {
    registerVaultFillSecret("target-1", CANARY);
    expect(hasAnyActiveVaultFill()).toBe(true);
    clearVaultFillSession("target-1");
    expect(hasAnyActiveVaultFill()).toBe(false);
    expect(scrubVaultFillText("target-1", CANARY)).toBe(CANARY);
  });
});
