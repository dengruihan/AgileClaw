import { html, render } from "lit";
import { afterEach, vi } from "vitest";
import { renderAssistantAttachments as renderAttachmentCards } from "./chat-message-attachments.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import {
  projectMessageMedia,
  releaseChatMediaResourceSubscriber,
  type AttachmentItem,
} from "./chat-message-media.ts";

export function renderAssistantAttachments(
  ...[content, options, ...rest]: Parameters<typeof renderAttachmentCards>
) {
  const { images, attachments } = projectMessageMedia({}, content);
  return html`${renderMessageImages(images, options)}${renderAttachmentCards(attachments, options, ...rest)}`;
}

export function managedAttachment(url: string, artifactId?: string): AttachmentItem {
  return {
    type: "attachment",
    attachment: {
      kind: "document",
      label: "asset.bin",
      mimeType: "application/octet-stream",
      url,
      artifactId,
    },
  };
}

export async function flushAttachmentResolution() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

export function registerChatAttachmentTestCleanup(): Set<() => void> {
  const subscribers = new Set<() => void>();
  afterEach(() => {
    for (const subscriber of subscribers) {
      releaseChatMediaResourceSubscriber(subscriber);
    }
    subscribers.clear();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  return subscribers;
}

export { render };
