import { normalizeRouteBasePath } from "@openclaw/uirouter";
import type { ArtifactOfficePreview } from "../../../api/artifact-download.ts";
import { fetchControlUiResource } from "../../../app/browser-http.ts";
import { buildChatMediaFetchHeaders } from "./chat-media-playback.ts";
import { buildAssistantAttachmentUrl } from "./chat-message-local-media.ts";
import type { ImageRenderOptions } from "./chat-message-media.ts";

type OfficePreviewMetaPayload = {
  available?: boolean;
  officePreview?: ArtifactOfficePreview;
  code?: string;
};

function parseOfficePreviewPayload(
  payload: OfficePreviewMetaPayload | null,
): ArtifactOfficePreview | null {
  if (payload?.code === "office-preview-too-large") {
    return { kind: "office", state: "too-large" };
  }
  if (payload?.available !== true || !payload.officePreview) {
    return null;
  }
  return payload.officePreview;
}

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
  return parseOfficePreviewPayload(payload);
}

/**
 * Previews optimistic/outbox Office uploads whose bytes exist only in this
 * client: the retained data:/blob: source is handed to the Gateway's bounded
 * parser through the assistant-media owner, and nothing is persisted.
 */
export async function loadUploadedAttachmentOfficePreview(
  source: string,
  label: string,
  options: ImageRenderOptions,
  signal: AbortSignal,
): Promise<ArtifactOfficePreview | null> {
  const bytes = await fetch(source, { signal });
  if (!bytes.ok) {
    return null;
  }
  const blob = await bytes.blob();
  const params = new URLSearchParams({
    meta: "1",
    preview: "office",
    upload: "1",
    filename: label,
  });
  const response = await fetchControlUiResource(
    `${normalizeRouteBasePath(options.resourceBasePath ?? "")}/__openclaw__/assistant-media?${params.toString()}`,
    {
      method: "POST",
      headers: buildChatMediaFetchHeaders(options.authToken),
      credentials: "same-origin",
      body: blob,
      signal,
    },
  );
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json().catch(() => null)) as OfficePreviewMetaPayload | null;
  return parseOfficePreviewPayload(payload);
}
