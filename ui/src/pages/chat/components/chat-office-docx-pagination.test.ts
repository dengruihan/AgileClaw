import { describe, expect, it } from "vitest";
import {
  paginateOfficeDocxPages,
  type OfficeDocxPageMetrics,
} from "./chat-office-docx-pagination.ts";

function page(
  capacity: number,
  blocks: OfficeDocxPageMetrics["blocks"],
  height = 1_000,
): OfficeDocxPageMetrics {
  return { capacity, height, blocks };
}

describe("paginateOfficeDocxPages", () => {
  it("keeps whole blocks on a page until the fixed body is full", () => {
    const cards = paginateOfficeDocxPages([
      page(200, [{ height: 80 }, { height: 80 }, { height: 80 }]),
    ]);
    expect(cards.map((card) => card.slices.map((slice) => slice.block))).toEqual([[0, 1], [2]]);
    expect(cards.every((card) => card.source === 0)).toBe(true);
    expect(cards.every((card) => card.height === 1_000)).toBe(true);
  });

  it("continues a long table row by row instead of clipping it", () => {
    const cards = paginateOfficeDocxPages([page(200, [{ height: 240, rowHeights: [80, 80, 80] }])]);
    expect(cards.map((card) => card.slices.map((slice) => slice.rows))).toEqual([
      [[0, 2]],
      [[2, 3]],
    ]);
    // Every row survives, in order, exactly once.
    expect(cards.flatMap((card) => card.slices.flatMap((slice) => slice.rows ?? []))).toEqual([
      0, 2, 2, 3,
    ]);
  });

  it("places a table row that cannot share a page on the next one", () => {
    const cards = paginateOfficeDocxPages([
      page(200, [{ height: 150 }, { height: 240, rowHeights: [80, 80, 80] }]),
    ]);
    expect(cards[0]?.slices.map((slice) => slice.block)).toEqual([0]);
    expect(cards[1]?.slices.map((slice) => slice.rows)).toEqual([[0, 2]]);
    expect(cards[2]?.slices.map((slice) => slice.rows)).toEqual([[2, 3]]);
  });

  it("grows only the card that holds one oversized unit", () => {
    const cards = paginateOfficeDocxPages([page(200, [{ height: 120 }, { height: 400 }])]);
    expect(cards.map((card) => card.slices.map((slice) => slice.block))).toEqual([[0], [1]]);
    expect(cards[0]?.height).toBe(1_000);
    expect(cards[1]?.height).toBeGreaterThan(1_200);
  });

  it("keeps declared pages, including an empty one, in document order", () => {
    const cards = paginateOfficeDocxPages([
      page(200, [{ height: 20 }]),
      page(200, [], 700),
      page(200, [{ height: 20 }]),
    ]);
    expect(cards.map((card) => card.source)).toEqual([0, 1, 2]);
    expect(cards[1]?.height).toBe(700);
    expect(cards[1]?.slices).toEqual([]);
  });
});
