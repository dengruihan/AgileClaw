import { expect, it } from "vitest";
import { buildXaiCatalogModels, resolveXaiCatalogEntry } from "./model-definitions.js";

it.each([
  { id: "grok-3", reasoning: false, input: ["text"], maxTokens: 64_000 },
  { id: "grok-3-mini-fast", reasoning: true, input: ["text"], maxTokens: 64_000 },
  { id: "grok-4.20-reasoning", reasoning: true, input: ["text", "image"], maxTokens: 30_000 },
  { id: "grok-4.20-non-reasoning", reasoning: false, input: ["text", "image"], maxTokens: 30_000 },
  { id: "grok-4.8", reasoning: true, input: ["text", "image"], maxTokens: 64_000 },
])(
  "keeps supported capabilities separate from inventory and pricing for $id",
  ({ id, ...capabilities }) => {
    expect(resolveXaiCatalogEntry(id)).toMatchObject({
      id,
      ...capabilities,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(buildXaiCatalogModels().some((model) => model.id === id)).toBe(false);
  },
);
