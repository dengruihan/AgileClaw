const DEFAULT_CLEAR_MS = 30_000;

type ClipboardLike = {
  readText?: () => Promise<string>;
  writeText: (value: string) => Promise<void>;
};

type PendingClear = {
  timer: ReturnType<typeof setTimeout>;
  token: symbol;
  value: string;
};

let pendingClear: PendingClear | undefined;

/**
 * Owns clipboard cleanup outside any page component so SPA navigation cannot
 * cancel it. The timer only clears when the clipboard still equals the value
 * this module wrote; if the user copied something else (or clipboard reads are
 * unavailable), it leaves the clipboard untouched.
 */
export function schedulePasswordClipboardClear(
  value: string,
  options: { delayMs?: number; clipboard?: ClipboardLike } = {},
): void {
  const clipboard =
    options.clipboard ?? (typeof navigator === "undefined" ? undefined : navigator.clipboard);
  if (!clipboard) {
    return;
  }
  const delayMs = Math.max(100, options.delayMs ?? DEFAULT_CLEAR_MS);
  if (pendingClear) {
    clearTimeout(pendingClear.timer);
  }
  const token = Symbol("password-clipboard-clear");
  const timer = setTimeout(() => {
    if (pendingClear?.token !== token) {
      return;
    }
    pendingClear = undefined;
    void (async () => {
      try {
        if (!clipboard.readText) {
          return;
        }
        const current = await clipboard.readText();
        if (current === value) {
          await clipboard.writeText("");
        }
      } catch {
        // Never overwrite content we could not verify.
      }
    })();
  }, delayMs);
  pendingClear = { timer, token, value };
}

export function hasPendingPasswordClipboardClear(): boolean {
  return pendingClear !== undefined;
}

export function cancelPendingPasswordClipboardClearForTests(): void {
  if (pendingClear) {
    clearTimeout(pendingClear.timer);
    pendingClear = undefined;
  }
}
