/**
 * Document identity for vault fill and human-takeover masking.
 *
 * The CDP loader id changes on a real document replacement but not on a
 * same-URL hash navigation or an unchanged download. A URL-derived token would
 * miss a same-URL reload, so an unavailable loader id fails closed.
 */
import type { Page } from "playwright-core";

export async function documentIdentity(
  page: Page,
): Promise<{ documentId: string; frameId: string } | undefined> {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const tree = (await session.send("Page.getFrameTree")) as {
        frameTree?: { frame?: { id?: string; loaderId?: string; url?: string } };
      };
      const frame = tree.frameTree?.frame;
      if (frame?.id && frame.loaderId) {
        return { documentId: frame.loaderId, frameId: frame.id };
      }
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    // Fail closed: a URL-derived token does not change on a same-URL reload,
    // so it cannot prove that the approved document is still current.
  }
  return undefined;
}
