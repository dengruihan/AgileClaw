import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { renderMessageMarkdown } from "../pages/chat/components/chat-message-text.ts";
import { handleTranscriptContextMenu } from "../pages/chat/components/chat-thread-interactions.ts";
import "../styles/base.css";
import "../styles/chat/text.css";
import { handleMarkdownTableInteraction, releaseMarkdownTables } from "./markdown-tables.ts";

const originalDirection = document.documentElement.getAttribute("dir");
let owner: HTMLElement | undefined;

afterEach(() => {
  if (owner) {
    releaseMarkdownTables(owner);
    render(nothing, owner);
    owner.remove();
    owner = undefined;
  }
  if (originalDirection === null) {
    document.documentElement.removeAttribute("dir");
  } else {
    document.documentElement.setAttribute("dir", originalDirection);
  }
});

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let clipboard = "";
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  clipboard = "";
  writeText.mockReset().mockImplementation(async (text) => {
    clipboard = text;
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

describe("expanded Markdown table direction", () => {
  it.each([
    { pageDirection: "ltr", message: "مرحبا", firstColumnOnRight: true },
    { pageDirection: "rtl", message: "Hello", firstColumnOnRight: false },
  ])("preserves message column order in a $pageDirection page", async (fixture) => {
    document.documentElement.dir = fixture.pageDirection;
    owner = document.body.appendChild(document.createElement("section"));
    owner.addEventListener("click", handleMarkdownTableInteraction);
    render(
      renderMessageMarkdown(
        `${fixture.message}\n\n| First | Second | Third |\n| --- | --- | --- |\n| A | B | C |`,
        "table-direction",
        { role: "assistant", isStreaming: false },
        { tableInteractions: "enabled" },
      ),
      owner,
    );

    const inlineTable = owner.querySelector("table")!;
    const firstColumnOnRight = (table: HTMLTableElement) => {
      const cells = table.rows[0]!.cells;
      return cells[0]!.getBoundingClientRect().left > cells[2]!.getBoundingClientRect().left;
    };
    expect(firstColumnOnRight(inlineTable)).toBe(fixture.firstColumnOnRight);

    await page.elementLocator(owner).getByRole("button", { name: "Expand table" }).click();
    await expect.element(page.getByRole("dialog", { name: "Expanded table" })).toBeVisible();
    const expandedTable = owner.querySelector<HTMLTableElement>(".markdown-table-dialog table")!;
    expect(firstColumnOnRight(expandedTable)).toBe(fixture.firstColumnOnRight);
  });
});

describe("Markdown table copy with typeset math", () => {
  const mathTable = [
    "| Quantity | Formula |",
    "| --- | --- |",
    String.raw`| area | $\pi r^2$ |`,
  ].join("\n");
  const expectedCopy = "Quantity\tFormula\narea\t$\\pi r^2$";

  async function mountMathTable() {
    owner = document.body.appendChild(document.createElement("section"));
    owner.addEventListener("click", handleMarkdownTableInteraction);
    owner.addEventListener("contextmenu", (event) =>
      handleTranscriptContextMenu(event, { paneId: "math-table", onSetReply: vi.fn() }),
    );
    render(
      renderMessageMarkdown(
        mathTable,
        "math-table",
        { role: "assistant", isStreaming: false },
        { tableInteractions: "enabled" },
      ),
      owner,
    );
    await expect
      .poll(() => owner!.querySelectorAll('openclaw-chat-math[data-math-state="rendered"]').length)
      .toBe(1);
    return owner;
  }

  it("copies the delimited formula from the toolbar after typesetting", async () => {
    const section = await mountMathTable();
    await page.elementLocator(section).getByRole("button", { name: "Copy table" }).click();
    await expect.poll(() => clipboard).toBe(expectedCopy);
  });

  it("copies the delimited formula from the expanded-table clone", async () => {
    const section = await mountMathTable();
    await page.elementLocator(section).getByRole("button", { name: "Expand table" }).click();
    await expect.element(page.getByRole("dialog", { name: "Expanded table" })).toBeVisible();

    const clonedMath = section.querySelector<HTMLElement>(
      ".markdown-table-dialog table td:nth-child(2) openclaw-chat-math",
    );
    expect(clonedMath?.getAttribute("data-math-source")).toBe(String.raw`$\pi r^2$`);
    // The clone keeps rendered markup instead of re-typesetting an empty source.
    expect(clonedMath?.querySelector(".katex")).not.toBeNull();
    expect(clonedMath?.getAttribute("data-math-state")).toBe("rendered");

    const clonedCell = clonedMath!.closest("td")!;
    clonedCell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await page.getByRole("menuitem", { name: "Copy table" }).click();
    await expect.poll(() => clipboard).toBe(expectedCopy);
  });
});
