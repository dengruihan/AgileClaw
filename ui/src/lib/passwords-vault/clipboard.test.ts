import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingPasswordClipboardClearForTests,
  hasPendingPasswordClipboardClear,
  schedulePasswordClipboardClear,
} from "./clipboard.ts";

function createClipboard(initial: string) {
  let value = initial;
  return {
    get value() {
      return value;
    },
    set value(next: string) {
      value = next;
    },
    readText: vi.fn(async () => value),
    writeText: vi.fn(async (next: string) => {
      value = next;
    }),
  };
}

afterEach(() => {
  cancelPendingPasswordClipboardClearForTests();
  vi.useRealTimers();
});

describe("password clipboard cleanup", () => {
  it("clears a copied value after the delay", async () => {
    vi.useFakeTimers();
    const clipboard = createClipboard("synthetic-password");
    schedulePasswordClipboardClear("synthetic-password", { delayMs: 1_000, clipboard });
    expect(hasPendingPasswordClipboardClear()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clipboard.writeText).toHaveBeenCalledWith("");
    expect(hasPendingPasswordClipboardClear()).toBe(false);
  });

  it("never overwrites a later unrelated clipboard value", async () => {
    vi.useFakeTimers();
    const clipboard = createClipboard("synthetic-password");
    schedulePasswordClipboardClear("synthetic-password", { delayMs: 1_000, clipboard });
    clipboard.value = "something the user copied later";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("survives real page teardown and navigation because the owner is module-scoped", async () => {
    vi.useFakeTimers();
    const clipboard = createClipboard("synthetic-password");
    const page = document.createElement("div");
    document.body.append(page);
    schedulePasswordClipboardClear("synthetic-password", { delayMs: 1_000, clipboard });
    page.remove();
    window.history.pushState({}, "", "/settings/general");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(hasPendingPasswordClipboardClear()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clipboard.writeText).toHaveBeenCalledWith("");
  });

  it("does not let an in-flight older cleanup erase a newer vault copy", async () => {
    vi.useFakeTimers();
    let resolveFirstRead: ((value: string) => void) | undefined;
    let readCount = 0;
    const clipboard = {
      value: "first-password",
      readText: vi.fn(() => {
        readCount += 1;
        if (readCount === 1) {
          return new Promise<string>((resolve) => {
            resolveFirstRead = resolve;
          });
        }
        return Promise.resolve(clipboard.value);
      }),
      writeText: vi.fn(async (next: string) => {
        clipboard.value = next;
      }),
    };
    schedulePasswordClipboardClear("first-password", { delayMs: 1_000, clipboard });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolveFirstRead).toBeTypeOf("function");

    clipboard.value = "second-password";
    schedulePasswordClipboardClear("second-password", { delayMs: 1_000, clipboard });
    resolveFirstRead?.("first-password");
    await Promise.resolve();
    await Promise.resolve();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(clipboard.value).toBe("second-password");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(clipboard.writeText).toHaveBeenCalledWith("");
  });

  it("leaves clipboard content untouched when reads are unavailable", async () => {
    vi.useFakeTimers();
    const clipboard = {
      writeText: vi.fn(async () => undefined),
    };
    schedulePasswordClipboardClear("synthetic-password", { delayMs: 1_000, clipboard });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});
