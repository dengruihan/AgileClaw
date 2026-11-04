import type { ArtifactOfficePreview } from "../../../api/artifact-download.ts";
import { fetchControlUiResource } from "../../../app/browser-http.ts";
import { buildChatMediaFetchHeaders } from "./chat-media-playback.ts";
import { buildAssistantAttachmentUrl } from "./chat-message-local-media.ts";
import type { ImageRenderOptions } from "./chat-message-media.ts";

type OfficePreviewMetaPayload = {
  available?: boolean;
  officePreview?: ArtifactOfficePreview;
};

/**
 * Asks the assistant-media owner for an opt-in Office preview of a local or
 * uploaded attachment. Ordinary metadata requests stay preview-free.
 */
export async function loadAssistantAttachmentOfficePreview(
  source: string,
  options: ImageRenderOptions,
  signal: AbortSignal,
): Promise<ArtifactOfficePreview | null> {
  const url = buildAssistantAttachmentUrl(source, options.resourceBasePath, undefined, options);
  const response = await fetchControlUiResource(`${url}&meta=1&preview=office`, {
    headers: buildChatMediaFetchHeaders(options.authToken),
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json().catch(() => null)) as OfficePreviewMetaPayload | null;
  if (payload?.available !== true || !payload.officePreview) {
    return null;
  }
  return payload.officePreview;
}
