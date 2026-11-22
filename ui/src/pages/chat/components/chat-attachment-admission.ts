// Per-file ceilings come from policy.attachments; one send's total must also fit a
// single frame (maxBatchBytes from policy.maxPayload). Checking at intake names the file
// instead of failing after the whole batch is base64-encoded. Resizable sources reserve
// their per-file ceiling until preparation completes.
import { resolveChatAttachmentFrameBudgetBytes } from "../../../../../src/shared/chat-attachment-frame-budget.ts";
import type { GatewayHelloOk } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { showToast } from "../../../lib/toast.ts";
import { getChatAttachmentDataUrl } from "../attachment-payload-store.ts";
import { canResizeChatAttachment } from "./chat-attachment-image.ts";

export type ChatAttachmentLimits = {
  maxBytes: number;
  maxImageBytes: number;
  maxBatchBytes: number;
};

type ChatAttachmentHelloPolicy = NonNullable<GatewayHelloOk["policy"]>;

const limitsByPolicy = new WeakMap<ChatAttachmentHelloPolicy, ChatAttachmentLimits>();

export function resolveChatAttachmentLimits(
  policy: ChatAttachmentHelloPolicy | undefined,
): ChatAttachmentLimits | undefined {
  if (!policy?.attachments) {
    return undefined;
  }
  let limits = limitsByPolicy.get(policy);
  if (!limits) {
    limits = {
      ...policy.attachments,
      maxBatchBytes: resolveChatAttachmentFrameBudgetBytes(policy.maxPayload ?? Infinity),
    };
    limitsByPolicy.set(policy, limits);
  }
  return limits;
}

function skippedFilesMessage(messageKey: string, names: readonly string[]): string {
  return t(messageKey, {
    names: names
      .slice(0, 3)
      .map((name) => (name.trim() ? name : t("chat.attachments.attachedFile")))
      .join(", "),
    more: names.length > 3 ? ` +${names.length - 3}` : "",
  });
}

function skippedFilesToast(messageKey: string, skipped: readonly File[]): void {
  if (skipped.length === 0) {
    return;
  }
  showToast({
    message: skippedFilesMessage(
      messageKey,
      skipped.map((file) => file.name),
    ),
  });
}

export function admitAttachmentFiles(
  candidates: readonly File[],
  limits: ChatAttachmentLimits | undefined,
  stagedBytes: number,
  options: { resizeImages?: boolean } = {},
): File[] {
  const admitted: File[] = [];
  const empty: File[] = [];
  const oversized: File[] = [];
  let total = stagedBytes;
  for (const file of candidates) {
    const reservation = attachmentReservationBytes(file.size, file.type, limits);
    if (file.size === 0) {
      empty.push(file);
    } else if (
      limits &&
      file.size > reservation &&
      !(options.resizeImages && canResizeChatAttachment(file))
    ) {
      oversized.push(file);
    } else if (
      limits &&
      !attachmentNeedsDirectUpload(file.size, file.type, limits) &&
      total + reservation > limits.maxBatchBytes
    ) {
      // Direct uploads bypass the frame budget: their bytes never ride a frame.
      oversized.push(file);
    } else {
      admitted.push(file);
      if (!limits || !attachmentNeedsDirectUpload(file.size, file.type, limits)) {
        total += reservation;
      }
    }
  }
  skippedFilesToast("chat.attachments.readFailed", empty);
  skippedFilesToast("chat.attachments.tooLarge", oversized);
  return admitted;
}

/**
 * True when a file cannot share one `chat.send` frame, so its bytes are staged
 * on the Gateway instead of base64-encoded in the browser. Images keep the
 * inline path: they are capped by `maxImageBytes`, far below any frame budget.
 */
export function attachmentNeedsDirectUpload(
  sizeBytes: number,
  mimeType: string,
  limits: ChatAttachmentLimits | undefined,
): boolean {
  return Boolean(
    limits &&
    !mimeType.startsWith("image/") &&
    sizeBytes > limits.maxBatchBytes &&
    sizeBytes <= limits.maxBytes,
  );
}

export function attachmentReservationBytes(
  sizeBytes: number,
  mimeType: string,
  limits: ChatAttachmentLimits | undefined,
): number {
  const ceiling = mimeType.startsWith("image/") ? limits?.maxImageBytes : limits?.maxBytes;
  return Math.min(sizeBytes, ceiling ?? Infinity);
}

function attachmentBytes(attachment: ChatAttachment): number {
  // Direct uploads never enter the request frame.
  if (attachment.uploadId) {
    return 0;
  }
  const size = attachment.sizeBytes;
  if (typeof size === "number" && Number.isFinite(size) && size >= 0) {
    return size;
  }
  const dataUrl = getChatAttachmentDataUrl(attachment);
  const payload = dataUrl?.match(/^data:[^,]*;base64,([\s\S]*)$/i)?.[1]?.replace(/\s/g, "");
  return payload
    ? Math.max(0, Math.floor((payload.length * 3) / 4) - (payload.match(/=+$/)?.[0].length ?? 0))
    : 0;
}

export function chatAttachmentBatchBytes(attachments: readonly ChatAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachmentBytes(attachment), 0);
}

export function attachmentBatchRejection(
  attachments: readonly ChatAttachment[],
  policy: ChatAttachmentHelloPolicy | undefined,
): string | undefined {
  const limits = resolveChatAttachmentLimits(policy);
  if (!limits) {
    return undefined;
  }
  let total = 0;
  const oversized = attachments.filter((attachment) => {
    const size = attachmentBytes(attachment);
    const ceiling = attachment.mimeType.startsWith("image/")
      ? limits.maxImageBytes
      : limits.maxBytes;
    if (size > ceiling || total + size > limits.maxBatchBytes) {
      return true;
    }
    total += size;
    return false;
  });
  return oversized.length > 0
    ? skippedFilesMessage(
        "chat.attachments.tooLarge",
        oversized.map((attachment) => attachment.fileName ?? ""),
      )
    : undefined;
}
