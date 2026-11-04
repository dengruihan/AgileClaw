import {
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  BROWSER_ACTION_TRANSPORT_SLACK_MS,
  resolveBrowserActRequestTimeoutMs,
  resolveBrowserNavigationTimeoutMs,
} from "./act-policy.js";
import type {
  BrowserActionOk,
  BrowserActionPathResult,
  BrowserActionTabResult,
  BrowserBatchAbort,
  BrowserBatchActionResult,
} from "./client-actions-types.js";
import type { BrowserActRequest } from "./client-actions.types.js";
import {
  browserClientTimeout,
  postBrowserJson,
  requestBrowserJson,
  type BrowserClientTarget,
} from "./client-request.js";
import {
  DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS,
} from "./constants.js";
import type { BrowserDownloadResult } from "./download-types.js";
import type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserPageError,
} from "./pw-session.js";

type BrowserActResponse = {
  ok: true;
  targetId: string;
  url?: string;
  result?: unknown;
  results?: BrowserBatchActionResult[];
  aborted?: BrowserBatchAbort;
  blockedByDialog?: boolean;
  browserState?: unknown;
  /** Download info when a click/batch/evaluate action triggers a browser download. */
  downloads?: BrowserDownloadResult[];
};

type BrowserDownloadActionResult = BrowserActionTabResult & { download: BrowserDownloadResult };

type BrowserActionOptions = {
  targetId?: string;
  profile?: string;
  signal?: AbortSignal;
};

type BrowserTimedActionOptions = BrowserActionOptions & { timeoutMs?: number };

function resolveBrowserOperationRequestTimeoutMs(timeoutMs: unknown): number {
  const operationTimeoutMs =
    clampPositiveTimerTimeoutMs(timeoutMs) ?? DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS;
  // Let the browser operation report its own timeout/error before the client watchdog fires.
  return addTimerTimeoutGraceMs(operationTimeoutMs, BROWSER_ACTION_TRANSPORT_SLACK_MS) ?? 1;
}

export async function browserNavigate(
  baseUrl: BrowserClientTarget,
  opts: BrowserTimedActionOptions & {
    url: string;
  },
): Promise<BrowserActionTabResult> {
  const timeoutMs = resolveBrowserNavigationTimeoutMs(opts.timeoutMs);
  return await postBrowserJson(
    baseUrl,
    "/navigate",
    { url: opts.url, targetId: opts.targetId, timeoutMs },
    resolveBrowserOperationRequestTimeoutMs(timeoutMs),
    opts,
  );
}

export async function browserArmDialog(
  baseUrl: BrowserClientTarget,
  opts: BrowserTimedActionOptions & {
    accept: boolean;
    promptText?: string;
    dialogId?: string;
  },
): Promise<BrowserActionOk> {
  return await postBrowserJson(
    baseUrl,
    "/hooks/dialog",
    {
      accept: opts.accept,
      promptText: opts.promptText,
      dialogId: opts.dialogId,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    },
    browserClientTimeout(
      baseUrl,
      undefined,
      resolveBrowserOperationRequestTimeoutMs(opts.timeoutMs),
    ),
    opts,
  );
}

export async function browserArmFileChooser(
  baseUrl: BrowserClientTarget,
  opts: BrowserTimedActionOptions & {
    paths: string[];
    ref?: string;
    inputRef?: string;
    element?: string;
  },
): Promise<BrowserActionOk> {
  return await postBrowserJson(
    baseUrl,
    "/hooks/file-chooser",
    {
      paths: opts.paths,
      ref: opts.ref,
      inputRef: opts.inputRef,
      element: opts.element,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    },
    browserClientTimeout(
      baseUrl,
      undefined,
      resolveBrowserOperationRequestTimeoutMs(opts.timeoutMs),
    ),
    opts,
  );
}

export async function browserWaitForDownload(
  baseUrl: BrowserClientTarget,
  opts: BrowserTimedActionOptions & {
    path?: string;
  },
): Promise<BrowserDownloadActionResult> {
  return await postBrowserJson(
    baseUrl,
    "/wait/download",
    {
      targetId: opts.targetId,
      path: opts.path,
      timeoutMs: opts.timeoutMs,
    },
    resolveBrowserOperationRequestTimeoutMs(opts.timeoutMs),
    opts,
  );
}

export async function browserDownload(
  baseUrl: BrowserClientTarget,
  opts: BrowserTimedActionOptions & {
    ref: string;
    path: string;
  },
): Promise<BrowserDownloadActionResult> {
  return await postBrowserJson(
    baseUrl,
    "/download",
    {
      targetId: opts.targetId,
      ref: opts.ref,
      path: opts.path,
      timeoutMs: opts.timeoutMs,
    },
    resolveBrowserOperationRequestTimeoutMs(opts.timeoutMs),
    opts,
  );
}

export async function browserAct(
  baseUrl: BrowserClientTarget,
  req: BrowserActRequest,
  opts?: { profile?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<BrowserActResponse> {
  return await postBrowserJson(
    baseUrl,
    "/act",
    req,
    resolveTimerTimeoutMs(opts?.timeoutMs, resolveBrowserActRequestTimeoutMs(req)),
    opts,
  );
}

export type BrowserVaultOrigin = { scheme: "https" | "http"; host: string; port: number };

export type BrowserVaultObserveResult =
  | {
      ok: true;
      targetId: string;
      origin: BrowserVaultOrigin;
      documentId: string;
      frameId: string;
      fieldSignature: string;
      fields: {
        passwordIndex: number;
        usernameIndex: number;
        passwordName: string;
        passwordAutocomplete: string;
        usernameName: string;
        usernameAutocomplete: string;
      };
    }
  | { ok: false; status: string; reasonCode?: string };

export type BrowserVaultFillResult =
  | { ok: true; status: "filled"; targetId: string }
  | { ok: false; status: string; reasonCode?: string };

export type BrowserHumanControl = {
  owner: "human";
  status: "requested" | "active";
  reason: string;
  requestedBy: "agent" | "human";
  profile: string;
  targetId: string;
  tabId?: string;
  generation: number;
  claimedAtMs: number;
  expiresAtMs: number;
};

export type BrowserHumanControlRequestResult = {
  ok: true;
  targetId: string;
  tabId?: string;
  control: BrowserHumanControl | null;
  humanControlToken?: string;
  handback?: {
    url: string;
    origin: { scheme: string; host: string; port: number };
    documentId: string;
    originChanged: boolean;
    loginStateChanged: boolean;
    revalidated: true;
  };
};

/** Pause agent actions for one tab and route the challenge to the Control UI. */
export async function browserHumanControlRequest(
  baseUrl: BrowserClientTarget,
  opts: BrowserTimedActionOptions & { targetId?: string; reason?: string },
): Promise<BrowserHumanControlRequestResult> {
  const timeoutMs = resolveBrowserNavigationTimeoutMs(opts.timeoutMs);
  return await postBrowserJson(
    baseUrl,
    "/human-control/request",
    { targetId: opts.targetId, reason: opts.reason, timeoutMs },
    resolveBrowserOperationRequestTimeoutMs(timeoutMs),
    opts,
  );
}

export type BrowserVaultIdentityResult =
  | {
      ok: true;
      targetId: string;
      documentId: string;
      frameId: string;
      origin: BrowserVaultOrigin;
    }
  | { ok: false; reasonCode?: string };

export async function browserVaultIdentity(
  baseUrl: BrowserClientTarget,
  opts: BrowserTimedActionOptions & { targetId: string },
): Promise<BrowserVaultIdentityResult> {
  const timeoutMs = resolveBrowserNavigationTimeoutMs(opts.timeoutMs);
  return await postBrowserJson(
    baseUrl,
    "/vault/identity",
    { targetId: opts.targetId, timeoutMs },
    resolveBrowserOperationRequestTimeoutMs(timeoutMs),
    opts,
  );
}

export async function browserVaultObserve(
  baseUrl: BrowserClientTarget,
  opts: BrowserTimedActionOptions & { targetId: string },
): Promise<BrowserVaultObserveResult> {
  const timeoutMs = resolveBrowserNavigationTimeoutMs(opts.timeoutMs);
  return await postBrowserJson(
    baseUrl,
    "/vault/observe",
    { targetId: opts.targetId, timeoutMs },
    resolveBrowserOperationRequestTimeoutMs(timeoutMs),
    opts,
  );
}

export async function browserVaultSubmit(
  baseUrl: BrowserClientTarget,
  opts: BrowserTimedActionOptions & {
    targetId: string;
    expected: {
      origin: BrowserVaultOrigin;
      documentId: string;
      frameId: string;
      fieldSignature: string;
    };
  },
): Promise<BrowserVaultFillResult> {
  const timeoutMs = resolveBrowserNavigationTimeoutMs(opts.timeoutMs);
  return await postBrowserJson(
    baseUrl,
    "/vault/submit",
    { targetId: opts.targetId, expected: opts.expected, timeoutMs },
    resolveBrowserOperationRequestTimeoutMs(timeoutMs),
    opts,
  );
}

export async function browserScreenshotAction(
  baseUrl: BrowserClientTarget,
  opts: BrowserTimedActionOptions & {
    fullPage?: boolean;
    ref?: string;
    element?: string;
    type?: "png" | "jpeg";
    labels?: boolean;
  },
): Promise<BrowserActionPathResult> {
  const timeoutMs = clampPositiveTimerTimeoutMs(opts.timeoutMs);
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS;
  return await postBrowserJson(
    baseUrl,
    "/screenshot",
    {
      targetId: opts.targetId,
      fullPage: opts.fullPage,
      ref: opts.ref,
      element: opts.element,
      type: opts.type,
      labels: opts.labels,
      timeoutMs: effectiveTimeoutMs,
    },
    effectiveTimeoutMs,
    opts,
  );
}

function buildQuery(params: Record<string, string | boolean | undefined>) {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([, value]) => typeof value === "boolean" || (typeof value === "string" && value.length > 0),
    ),
  );
}

function readBrowserPageJson<T>(
  baseUrl: BrowserClientTarget,
  path: string,
  opts: BrowserActionOptions,
  query: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  return requestBrowserJson(baseUrl, path, {
    query,
    profile: opts.profile,
    timeoutMs: browserClientTimeout(baseUrl, undefined, 20000),
    signal: opts.signal,
  });
}

export async function browserConsoleMessages(
  baseUrl: BrowserClientTarget,
  opts: BrowserActionOptions & { level?: string } = {},
): Promise<{ ok: true; messages: BrowserConsoleMessage[]; targetId: string; url?: string }> {
  return await readBrowserPageJson(
    baseUrl,
    "/console",
    opts,
    buildQuery({ level: opts.level, targetId: opts.targetId }),
  );
}

export async function browserRequests(
  baseUrl: BrowserClientTarget,
  opts: BrowserActionOptions & {
    filter?: string;
    clear?: boolean;
  } = {},
): Promise<{ ok: true; requests: BrowserNetworkRequest[]; targetId: string; url?: string }> {
  return await readBrowserPageJson(
    baseUrl,
    "/requests",
    opts,
    buildQuery({ filter: opts.filter, clear: opts.clear, targetId: opts.targetId }),
  );
}

export async function browserErrors(
  baseUrl: BrowserClientTarget,
  opts: BrowserActionOptions & { clear?: boolean } = {},
): Promise<{ ok: true; errors: BrowserPageError[]; targetId: string; url?: string }> {
  return await readBrowserPageJson(
    baseUrl,
    "/errors",
    opts,
    buildQuery({ clear: opts.clear, targetId: opts.targetId }),
  );
}

/** Read bounded visible text without executing page-supplied code. */
export async function browserPageText(
  baseUrl: BrowserClientTarget,
  opts: BrowserActionOptions & {
    selector?: string;
    maxChars: number;
  },
): Promise<{ ok: true; targetId: string; url?: string; text: string; truncated: boolean }> {
  return await readBrowserPageJson(baseUrl, "/text", opts, {
    ...buildQuery({ targetId: opts.targetId, selector: opts.selector }),
    maxChars: opts.maxChars,
  });
}

export async function browserEmulateSetting(
  baseUrl: BrowserClientTarget,
  opts: {
    setting: "device" | "media" | "timezone" | "locale";
    body: Record<string, string | undefined>;
    profile?: string;
    signal?: AbortSignal;
  },
): Promise<{ ok: true; targetId: string }> {
  return await postBrowserJson(
    baseUrl,
    `/set/${opts.setting}`,
    opts.body,
    browserClientTimeout(baseUrl, undefined, 20000),
    opts,
  );
}

export async function browserPdfSave(
  baseUrl: BrowserClientTarget,
  opts: BrowserActionOptions = {},
): Promise<BrowserActionPathResult> {
  return await postBrowserJson(
    baseUrl,
    "/pdf",
    { targetId: opts.targetId },
    browserClientTimeout(baseUrl, undefined, 20000),
    opts,
  );
}
