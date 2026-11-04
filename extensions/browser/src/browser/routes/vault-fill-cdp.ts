/**
 * Password insertion bound to the approved document.
 *
 * A locator re-resolves by index against whatever document is current, so a
 * navigation that commits between approval and insertion would hand the value
 * to the replacement origin. These helpers resolve the input once, inside the
 * approved loader, and then insert into that exact node handle.
 */
import type { CDPSession, Page } from "playwright-core";

export type BackendFillResult = "filled" | "stale" | "error";

export function isNavigationRaceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /execution context was destroyed|target closed|navigat/iu.test(message);
}

/**
 * Resolve the n-th `input` to a backend node id while the approved loader still
 * owns the frame. A commit during enumeration would return a node from the
 * replacement document, so the loader is checked on both sides.
 */
export async function resolveInputBackendNodeId(
  page: Page,
  inputIndex: number,
  expectedDocumentId: string,
): Promise<number | undefined> {
  let session: CDPSession;
  try {
    session = await page.context().newCDPSession(page);
  } catch {
    return undefined;
  }
  const readDocumentId = async () => {
    const tree = (await session.send("Page.getFrameTree")) as {
      frameTree?: { frame?: { loaderId?: string } };
    };
    return tree.frameTree?.frame?.loaderId;
  };
  try {
    if ((await readDocumentId()) !== expectedDocumentId) {
      return undefined;
    }
    const { root } = (await session.send("DOM.getDocument", { depth: -1 })) as {
      root?: { nodeId?: number };
    };
    if (!root?.nodeId) {
      return undefined;
    }
    const { nodeIds } = (await session.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: "input",
    })) as { nodeIds?: number[] };
    const nodeId = nodeIds?.[inputIndex];
    if (!nodeId) {
      return undefined;
    }
    const { node } = (await session.send("DOM.describeNode", { nodeId })) as {
      node?: { nodeName?: string; backendNodeId?: number };
    };
    if ((await readDocumentId()) !== expectedDocumentId) {
      return undefined;
    }
    return node?.nodeName === "INPUT" ? node.backendNodeId : undefined;
  } catch {
    return undefined;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/**
 * Insert into the exact backend node captured from the approved document. A
 * navigation destroys that node object, so resolution fails closed instead of
 * selecting an index in the replacement DOM.
 */
export async function fillInputByBackendNode(
  page: Page,
  backendNodeId: number,
  value: string,
): Promise<BackendFillResult> {
  let session: CDPSession;
  try {
    session = await page.context().newCDPSession(page);
  } catch (error) {
    return isNavigationRaceError(error) ? "stale" : "error";
  }
  try {
    let objectId: string | undefined;
    try {
      const resolved = (await session.send("DOM.resolveNode", { backendNodeId })) as {
        object?: { objectId?: string };
      };
      objectId = resolved.object?.objectId;
    } catch {
      // The approved node (and its document) no longer exists.
      return "stale";
    }
    if (!objectId) {
      return "stale";
    }
    let filled: unknown = undefined;
    try {
      const call = (await session.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function (value) {
          const input = this;
          if (!input.isConnected) return false;
          if (input.disabled || input.readOnly || input.type !== "password") {
            throw new Error("not editable");
          }
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          if (!setter) throw new Error("unsupported input");
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }`,
        arguments: [{ value }],
        returnByValue: true,
      })) as {
        result?: { value?: unknown };
        exceptionDetails?: { text?: string };
      };
      if (call.exceptionDetails) {
        return "error";
      }
      filled = call.result?.value;
    } catch {
      // A protocol failure here means the approved context is gone.
      return "stale";
    }
    return filled === true ? "filled" : "stale";
  } finally {
    await session.detach().catch(() => undefined);
  }
}
