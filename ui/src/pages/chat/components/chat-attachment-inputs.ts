// Shared attachment entry point for chat and New Session.
import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";

const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,video/*,application/pdf,text/*,.csv,.json,.md,.txt,.zip," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";
function clickComposerInput(target: HTMLElement, selector: string) {
  target.closest("details")?.removeAttribute("open");
  target
    .closest(".agent-chat__composer-shell, .new-session-page__composer")
    ?.querySelector<HTMLInputElement>(selector)
    ?.click();
}

function handleChatAttachmentFileSelect(e: Event, props: ChatAttachmentControlsProps) {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const files = [...(input.files ?? [])];
  input.value = "";
  appendChatAttachmentFiles(files, props);
}

export function renderChatAttachmentInputs(props: ChatAttachmentControlsProps) {
  if (!uploadsEnabled(props.uploadConfig)) {
    return nothing;
  }
  return html`
    <input
      type="file"
      accept=${CHAT_ATTACHMENT_ACCEPT}
      multiple
      class="agent-chat__file-input"
      ?disabled=${props.disabled}
      @change=${(event: Event) => {
        if (!props.disabled) {
          handleChatAttachmentFileSelect(event, props);
        }
      }}
    />
  `;
}

export function handleChatAttachmentMenuSelection(
  event: CustomEvent<{ item: { value?: string } }>,
): boolean {
  if (event.detail.item.value !== "file") {
    return false;
  }
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    clickComposerInput(target, ".agent-chat__file-input");
  }
  return true;
}

export function renderChatAttachmentMenuTrigger(
  disabled: boolean | undefined,
  hasOverrides = false,
) {
  return html`
    <button
      slot="trigger"
      type="button"
      class="agent-chat__input-btn agent-chat__input-btn--attach ${
        hasOverrides ? "agent-chat__input-btn--has-overrides" : ""
      }"
      aria-label=${t("chat.composer.addAttachment")}
      ?disabled=${disabled}
      title=${t("chat.composer.addAttachment")}
    >
      ${icons.plus}
    </button>
  `;
}

export function renderChatAttachmentMenuOptions() {
  return html`
    <wa-dropdown-item class="agent-chat__attach-menu-option" value="file">
      <span slot="icon" aria-hidden="true">${icons.paperclip}</span>
      <span>${t("chat.composer.attach")}</span>
    </wa-dropdown-item>
  `;
}
