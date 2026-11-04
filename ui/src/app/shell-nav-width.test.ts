import { describe, expect, it } from "vitest";
import { resolveShellNavWidth } from "./shell-nav-width.ts";

describe("resolveShellNavWidth", () => {
  it("keeps the stored rail on a mouse-driven desktop", () => {
    expect(resolveShellNavWidth({ navWidth: 258, viewportWidth: 1280, coarsePointer: false })).toBe(
      258,
    );
    expect(resolveShellNavWidth({ navWidth: 240, viewportWidth: 1100, coarsePointer: false })).toBe(
      240,
    );
  });

  it("gives a coarse-pointer tablet rail a floor wide enough for titles", () => {
    expect(resolveShellNavWidth({ navWidth: 258, viewportWidth: 1024, coarsePointer: true })).toBe(
      320,
    );
    expect(resolveShellNavWidth({ navWidth: 240, viewportWidth: 1180, coarsePointer: true })).toBe(
      320,
    );
  });

  it("respects a rail the operator widened, and leaves drawers and large screens alone", () => {
    expect(resolveShellNavWidth({ navWidth: 340, viewportWidth: 1024, coarsePointer: true })).toBe(
      340,
    );
    // The drawer owns its own width below the tablet band.
    expect(resolveShellNavWidth({ navWidth: 258, viewportWidth: 768, coarsePointer: true })).toBe(
      258,
    );
    // Large laptop and desktop widths keep the stored rail.
    expect(resolveShellNavWidth({ navWidth: 258, viewportWidth: 1440, coarsePointer: true })).toBe(
      258,
    );
  });

  it("clamps to the supported rail range", () => {
    expect(resolveShellNavWidth({ navWidth: 900, viewportWidth: 1280, coarsePointer: false })).toBe(
      400,
    );
  });
});
