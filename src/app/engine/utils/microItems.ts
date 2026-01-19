import type { Chunk } from "../types";

export function computeMicroItemsWithoutLlm(batchChunks: Chunk[]): string[] {
  const items = batchChunks
    .map((c) => (c.content ?? "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((c) => c.slice(0, 300));
  if (items.length > 0) {
    return items;
  }
  return ["(empty batch)"];
}

