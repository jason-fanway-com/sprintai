// Item 2 (2026-09-09, module extraction): unit tests for sequencer.ts.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { groupChoicesAlreadySaid, renderMissingOptionsPrompt } from "./sequencer.ts";

Deno.test("renderMissingOptionsPrompt: single item, single group", () => {
  const prompt = renderMissingOptionsPrompt([{ name: "Chicken Caesar", missingGroups: ["Dressing"] }]);
  assertEquals(prompt, "I still need to know what dressing you'd like on the Chicken Caesar. What'll it be?");
});

Deno.test("renderMissingOptionsPrompt: single item, multiple groups joined with 'and'", () => {
  const prompt = renderMissingOptionsPrompt([{ name: "Turkey Sub", missingGroups: ["Size", "Bread"] }]);
  assertEquals(prompt, "I still need to know what size and bread you'd like on the Turkey Sub. What'll it be?");
});

Deno.test("renderMissingOptionsPrompt: multiple items joined with ', and'", () => {
  const prompt = renderMissingOptionsPrompt([
    { name: "Turkey Sub", missingGroups: ["Size"] },
    { name: "Wings", missingGroups: ["Flavor"] },
  ]);
  assertEquals(
    prompt,
    "I still need to know what size you'd like on the Turkey Sub, and what flavor you'd like on the Wings. What'll it be?",
  );
});

Deno.test("groupChoicesAlreadySaid: structural match via compiledRenderedGroups", () => {
  const rendered = new Map([["item-1", new Set(["Size"])]]);
  assertEquals(groupChoicesAlreadySaid("item-1", "Size", ["Medium", "Large"], "", rendered, "Turkey Sub"), true);
});

Deno.test("groupChoicesAlreadySaid: textual match, straight vs curly quote does not break the stem match", () => {
  const rendered = new Map<string, Set<string>>();
  assertEquals(
    groupChoicesAlreadySaid("item-1", "Size", ["12''"], "What size — medium 12\" or large 16\"?", rendered, "Turkey Sub"),
    true,
  );
});

Deno.test("groupChoicesAlreadySaid: choice names absent from the text are not already said", () => {
  const rendered = new Map<string, Set<string>>();
  assertEquals(
    groupChoicesAlreadySaid("item-1", "Flavor", ["Buffalo", "BBQ"], "What size would you like?", rendered, "Wings"),
    false,
  );
});

// D2 fix (2026-09-09, Vito's "House" salad repro — see sequencer.ts's own
// doc on groupChoicesAlreadySaid for the full incident).
Deno.test("groupChoicesAlreadySaid: D2 fix — a real choice that happens to start with the item's own name is still recognized when genuinely stated", () => {
  const rendered = new Map<string, Set<string>>();
  const reply = "House added. What dressing would you like? Options: French, Bleu Cheese, House Balsamic.";
  assertEquals(
    groupChoicesAlreadySaid("vito-house", "Dressing", ["French", "Bleu Cheese", "House Balsamic"], reply, rendered, "House"),
    true,
  );
});

Deno.test("groupChoicesAlreadySaid: D2 fix — a choice wholly contained in the item's own name is never trusted from text-presence alone", () => {
  const rendered = new Map<string, Set<string>>();
  const reply = "Chicken Caesar added! What dressing would you like?";
  assertEquals(
    groupChoicesAlreadySaid("vito-caesar", "Dressing", ["Caesar"], reply, rendered, "Chicken Caesar"),
    false,
  );
});
