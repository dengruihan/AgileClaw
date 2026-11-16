/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApplicationConfigCapability } from "../../../app/config.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import {
  handleChatAttachmentMenuSelection,
  renderChatAttachmentInputs,
  renderChatAttachmentMenuOptions,
} from "./chat-attachment-inputs.ts";
import { ChatAttachmentReadLifecycle } from "./chat-attachment-reads.ts";

const ATTACHMENT_ACCEPT =
  "image/*,audio/*,video/*,application/pdf,text/*,.csv,.json,.md,.txt,.zip," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";

let host: HTMLDivElement;
let reads: ChatAttachmentReadLifecycle;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  reads = new ChatAttachmentReadLifecycle(() => {});
});

afterEach(() => {
  reads.abortReads();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function selectFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

it("renders one multi-file attachment input without camera or photo paths", () => {
  render(renderChatAttachmentInputs({ onAttachmentsChange: vi.fn() }), host);

  const inputs = host.querySelectorAll<HTMLInputElement>('input[type="file"]');
  expect(inputs).toHaveLength(1);
  const input = inputs[0]!;
  expect(input.className).toBe("agent-chat__file-input");
  expect(input.accept).toBe(ATTACHMENT_ACCEPT);
  expect(input.multiple).toBe(true);
  expect(input.hasAttribute("capture")).toBe(false);
  expect(input.disabled).toBe(false);
  expect(host.querySelector(".agent-chat__camera-input")).toBeNull();
  expect(host.querySelector(".agent-chat__photo-input")).toBeNull();
  expect(host.querySelector("openclaw-chat-camera-capture")).toBeNull();
});

it("renders no attachment input when the Gateway upload policy disables uploads", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ uploadsEnabled: false })),
  );
  const uploadConfig = createApplicationConfigCapability({ resourceBasePath: "" });
  await uploadConfig.refresh();

  render(renderChatAttachmentInputs({ uploadConfig, onAttachmentsChange: vi.fn() }), host);

  expect(host.querySelector('input[type="file"]')).toBeNull();
});

it("renders a single Attachment menu option", () => {
  render(html`${renderChatAttachmentMenuOptions()}`, host);

  const options = host.querySelectorAll(".agent-chat__attach-menu-option");
  expect(options).toHaveLength(1);
  expect(options[0]!.getAttribute("value")).toBe("file");
  expect(options[0]!.textContent?.trim()).toBe("Attachment");
});

it.each(["agent-chat__composer-shell", "new-session-page__composer"])(
  "opens the scoped file input from the attachment menu in %s and retires camera/photo values",
  (composerClass) => {
    const props: ChatAttachmentControlsProps = { onAttachmentsChange: vi.fn() };
    render(
      html`<details open>
        <div class=${composerClass}>
          ${renderChatAttachmentInputs(props)}
          <div class="attachment-menu" @wa-select=${handleChatAttachmentMenuSelection}></div>
        </div>
      </details>`,
      host,
    );
    const input = host.querySelector<HTMLInputElement>(".agent-chat__file-input")!;
    const menu = host.querySelector(".attachment-menu")!;
    const click = vi.spyOn(input, "click").mockImplementation(() => undefined);

    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "file" } } }));
    expect(click).toHaveBeenCalledOnce();
    expect(host.querySelector("details")?.hasAttribute("open")).toBe(false);

    for (const value of ["camera", "photo", "unknown"]) {
      menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value } } }));
    }
    expect(click).toHaveBeenCalledOnce();
  },
);

it("appends selected files through the change handler and resets the input", async () => {
  const onAttachmentsChange = vi.fn();
  render(renderChatAttachmentInputs({ onAttachmentsChange, attachmentReads: reads }), host);
  const input = host.querySelector<HTMLInputElement>(".agent-chat__file-input")!;

  selectFiles(input, [new File(["notes"], "notes.txt", { type: "text/plain" })]);

  expect(input.value).toBe("");
  await vi.waitFor(() => expect(onAttachmentsChange).toHaveBeenCalledOnce());
  const attachments = onAttachmentsChange.mock.calls[0]![0] as Array<{ fileName?: string }>;
  expect(attachments).toHaveLength(1);
  expect(attachments[0]?.fileName).toBe("notes.txt");
});

it("disables the input and ignores selection while the composer is disabled", () => {
  const onAttachmentsChange = vi.fn();
  render(
    renderChatAttachmentInputs({ onAttachmentsChange, attachmentReads: reads, disabled: true }),
    host,
  );
  const input = host.querySelector<HTMLInputElement>(".agent-chat__file-input")!;
  expect(input.disabled).toBe(true);

  selectFiles(input, [new File(["notes"], "notes.txt", { type: "text/plain" })]);

  expect(onAttachmentsChange).not.toHaveBeenCalled();
});
