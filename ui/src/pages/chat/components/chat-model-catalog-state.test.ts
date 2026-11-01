/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ChatModelCatalogState } from "../../../lib/model-catalog-store.ts";
import { renderChatModelCatalogState } from "./chat-model-catalog-state.ts";

describe("model catalog refresh presentation", () => {
  it.each(["loading", "ready"] as const)(
    "shows initial loading instead of an empty %s catalog",
    (status) => {
      const container = document.createElement("div");
      render(
        renderChatModelCatalogState(
          { hasSnapshot: false, status, pendingProviders: ["clawrouter"] },
          false,
          false,
        ),
        container,
      );
      expect(container.textContent).toContain("Loading models…");
      expect(container.querySelector(".btn__spinner")).not.toBeNull();
      expect(container.textContent).not.toContain("No models available");
    },
  );

  it.each([
    { status: "error", label: "Some models could not be refreshed." },
    { status: "offline", label: "Offline" },
  ] as const)("keeps $status visible even with retained models", ({ status, label }) => {
    const container = document.createElement("div");
    const state: ChatModelCatalogState = {
      hasSnapshot: true,
      status,
      pendingProviders: ["clawrouter"],
    };
    render(renderChatModelCatalogState(state, true, true), container);
    expect(container.querySelector("[role=status]")?.textContent).toContain(label);
    expect(container.querySelector(".btn__spinner")).toBeNull();
  });

  it("preserves the empty-catalog setup action", () => {
    const container = document.createElement("div");
    const setup = vi.fn();
    render(
      renderChatModelCatalogState({ hasSnapshot: true, status: "ready" }, false, false, setup),
      container,
    );
    expect(container.textContent).toContain("No models available");
    container.querySelector<HTMLButtonElement>("[data-chat-model-setup]")?.click();
    expect(setup).toHaveBeenCalledOnce();
  });
});
