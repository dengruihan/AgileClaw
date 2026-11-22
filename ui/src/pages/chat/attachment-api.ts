import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const commaIndex = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || commaIndex < 0) {
    return null;
  }
  // FileReader may include MIME parameters. Validate metadata separately from
  // the payload, so neither repeated parameters nor image bytes need a capture regex.
  const [mimeType, ...parameters] = dataUrl.slice(5, commaIndex).split(";");
  if (
    !mimeType ||
    parameters.pop() !== "base64" ||
    parameters.some((parameter) => !/^[^=]+=[\s\S]*$/.test(parameter))
  ) {
    return null;
  }
  const content = dataUrl.slice(commaIndex + 1);
  return content && !/[\r\n\u2028\u2029]/.test(content) ? { mimeType, content } : null;
}

/** Wire shape for one `chat.send` attachment: inline base64 or a direct upload reference. */
export type ChatApiAttachment = {
  type: string;
  mimeType: string;
  fileName?: string;
  origin?: "paste" | "file";
  content?: string;
  uploadId?: string;
  sizeBytes?: number;
};

/** Converts composer attachments into the payload accepted by chat.send. */
export function buildChatApiAttachments(
  attachments?: readonly ChatAttachment[],
): ChatApiAttachment[] | undefined {
  return attachments?.length
    ? attachments.map((attachment): ChatApiAttachment => {
        // Direct uploads already own their bytes on the Gateway; the send only
        // references them and never encodes them into this frame.
        if (attachment.uploadId) {
          return {
            type: attachment.mimeType.startsWith("image/") ? "image" : "file",
            mimeType: attachment.mimeType,
            fileName: attachment.fileName,
            ...(attachment.origin ? { origin: attachment.origin } : {}),
            uploadId: attachment.uploadId,
            ...(typeof attachment.sizeBytes === "number"
              ? { sizeBytes: attachment.sizeBytes }
              : {}),
          };
        }
        const dataUrl = getChatAttachmentDataUrl(attachment);
        const parsed = dataUrl ? dataUrlToBase64(dataUrl) : null;
        if (!parsed) {
          throw new Error(t("chat.sendErrors.outboxPayloadMissing"));
        }
        return {
          type: parsed.mimeType.startsWith("image/") ? "image" : "file",
          mimeType: parsed.mimeType,
          fileName: attachment.fileName,
          ...(attachment.origin ? { origin: attachment.origin } : {}),
          content: parsed.content,
        };
      })
    : undefined;
}
