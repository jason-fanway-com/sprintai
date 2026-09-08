import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildMenuExtractionNote,
  mergeMenuChunkResults,
  shouldFlagMenuExtractionIncomplete,
  type MenuItem,
} from "./menu-extraction.ts";

function item(name: string, price_cents: number): MenuItem {
  return { name, price_cents, category: "", description: "" };
}

Deno.test("mergeMenuChunkResults: a null chunk (timed out/errored) is counted as a failure, not silently dropped", () => {
  const chunkResults = [
    [item("Cheese Pizza", 1200)],
    null, // this chunk's items must not just vanish
    [item("Garlic Knots", 599)],
  ];
  const result = mergeMenuChunkResults(chunkResults, 300);
  assertEquals(result.chunksTotal, 3);
  assertEquals(result.chunksFailed, 1);
  assertEquals(result.truncated, false);
  assertEquals(result.items?.length, 2);
});

Deno.test("mergeMenuChunkResults: all chunks null reports full failure and returns no items", () => {
  const result = mergeMenuChunkResults([null, null], 300);
  assertEquals(result.chunksTotal, 2);
  assertEquals(result.chunksFailed, 2);
  assertEquals(result.items, null);
  assertEquals(result.truncated, false);
});

Deno.test("mergeMenuChunkResults: merged count over the cap sets truncated=true and slices to the cap", () => {
  const chunk = Array.from({ length: 310 }, (_, i) => item(`Item ${i}`, 100 + i));
  const result = mergeMenuChunkResults([chunk], 300);
  assertEquals(result.chunksFailed, 0);
  assertEquals(result.truncated, true);
  assertEquals(result.items?.length, 300);
});

Deno.test("mergeMenuChunkResults: happy path (no failures, under cap) is not flagged in any way", () => {
  const result = mergeMenuChunkResults([[item("Cheese Pizza", 1200)], [item("Garlic Knots", 599)]], 300);
  assertEquals(result.chunksFailed, 0);
  assertEquals(result.truncated, false);
  assertEquals(result.items?.length, 2);
});

Deno.test("mergeMenuChunkResults: dedupes identical name+price across chunks (existing behavior, unchanged)", () => {
  const result = mergeMenuChunkResults([[item("Cheese Pizza", 1200)], [item("Cheese Pizza", 1200)]], 300);
  assertEquals(result.items?.length, 1);
  assertEquals(result.chunksFailed, 0);
});

Deno.test("shouldFlagMenuExtractionIncomplete: usable items + a failed chunk -> flagged", () => {
  assert(shouldFlagMenuExtractionIncomplete(true, 1, false));
});

Deno.test("shouldFlagMenuExtractionIncomplete: usable items + truncation -> flagged", () => {
  assert(shouldFlagMenuExtractionIncomplete(true, 0, true));
});

Deno.test("shouldFlagMenuExtractionIncomplete: happy path (usable items, no failures, not truncated) -> NOT flagged", () => {
  assertEquals(shouldFlagMenuExtractionIncomplete(true, 0, false), false);
});

Deno.test("shouldFlagMenuExtractionIncomplete: no usable items at all -> NOT flagged (nothing to call incomplete)", () => {
  assertEquals(shouldFlagMenuExtractionIncomplete(false, 1, true), false);
});

Deno.test("buildMenuExtractionNote: describes chunk failures and truncation together", () => {
  const note = buildMenuExtractionNote(1, 4, true);
  assert(note.includes("1/4"));
  assert(note.includes("truncated"));
});

Deno.test("buildMenuExtractionNote: chunk failures only", () => {
  const note = buildMenuExtractionNote(2, 4, false);
  assert(note.includes("2/4"));
  assertEquals(note.includes("truncated"), false);
});
