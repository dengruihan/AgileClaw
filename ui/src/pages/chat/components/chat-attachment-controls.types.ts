import type { ApplicationConfigCapability } from "../../../app/config.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import type { ChatAttachmentLimits } from "./chat-attachment-admission.ts";
import type { ChatAttachmentReadLifecycle } from "./chat-attachment-reads.ts";
import type { ChatAttachmentUploadTarget } from "./chat-attachment-upload.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

export type ChatAttachmentControlsProps = {
  uploadConfig?: ApplicationConfigCapability;
  /** Decoded-size ceilings from hello policy; absent means no client-side cap. */
  attachmentLimits?: ChatAttachmentLimits;
  /** Side chat sends selection metadata as text context, without a file payload. */
  selectionContextOnly?: boolean;
  /** Direct upload endpoint for files that cannot fit one chat.send frame. */
  attachmentUpload?: ChatAttachmentUploadTarget;
  attachmentReads?: ChatAttachmentReadLifecycle;
  attachments?: ChatAttachment[];
  disabled?: boolean;
  imagesOnly?: boolean;
  getAttachments?: () => ChatAttachment[];
  draft?: string;
  getDraft?: () => string;
  onAttachmentsChange?: (attachments: ChatAttachment[]) => boolean | void;
  onRemoveAttachment?: (attachment: ChatAttachment) => void;
  onDraftChange?: (next: string) => void;
  onPendingReadsChange?: (delta: 1 | -1) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onRequestUpdate?: () => void;
  readSignal?: AbortSignal;
};
