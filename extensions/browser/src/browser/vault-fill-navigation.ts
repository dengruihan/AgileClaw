/**
 * Navigation-boundary retirement for sensitive-input masking.
 *
 * A real document replacement (new CDP loader id) ends the masking session.
 * Same-document/hash navigation and downloads keep it because the original
 * field may still hold the value. If identity cannot be proven, protection is
 * retained (fail closed).
 */
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import type { Page } from "playwright-core";
import { getPageForTargetId } from "./pw-session-connection.js";
import { documentIdentity } from "./vault-fill-document.js";
import { clearVaultFillSessionIfDocumentChanged } from "./vault-fill-scrub.js";

export async function retireSensitiveDocumentForPage(
  page: Page,
  targetId: string,
): Promise<boolean> {
  const identity = await documentIdentity(page);
  return clearVaultFillSessionIfDocumentChanged(targetId, identity?.documentId);
}

export async function retireSensitiveDocumentAfterNavigation(params: {
  cdpUrl: string;
  /** Session owner target id used when the sensitive value was registered. */
  targetId: string;
  /** Current target after target replacement, when different from the owner. */
  nextTargetId?: string;
  download?: boolean;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (params.download) {
    return false;
  }
  try {
    const page = await getPageForTargetId({
      cdpUrl: params.cdpUrl,
      targetId: params.nextTargetId ?? params.targetId,
      ...(params.ssrfPolicy ? { ssrfPolicy: params.ssrfPolicy } : {}),
    });
    params.signal?.throwIfAborted();
    return await retireSensitiveDocumentForPage(page, params.targetId);
  } catch {
    return false;
  }
}
