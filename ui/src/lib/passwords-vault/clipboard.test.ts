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

  it("survives page teardown because the owner is module-scoped", async () => {
    vi.useFakeTimers();
    const clipboard = createClipboard("synthetic-password");
    schedulePasswordClipboardClear("synthetic-password", { delayMs: 1_000, clipboard });
    // No page component unmount hook can cancel this timer; the module retains it.
    expect(hasPendingPasswordClipboardClear()).toBe(true);
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
