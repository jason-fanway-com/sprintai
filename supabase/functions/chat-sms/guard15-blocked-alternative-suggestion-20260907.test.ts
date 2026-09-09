// P0 (2026-09-07, Jason, relayed via PO session): "double burger" on Zio's
// -> the bot correctly declined the item (bot_state='blocked', a real owner
// question pending on Temp for the whole Burgers category) — then its own
// free-text reply suggested "Burger, Cheese Burger, Zio's Deluxe Burger,
// Mamma Mia Burger, BBQ Cheese Burger" as alternatives. Verified live: every
// single item in the Burgers category was bot_state='blocked' at the time
// (one pending owner question blocks a whole category at once). The model
// drew these names from its own recall of the full menu text in the system
// prompt, which carries zero bot_state signal — it can suggest by category
// membership alone, never by orderability.
//
// TWO-LAYER FIX, general pattern (not Burgers-specific — "anywhere the bot
// offers alternatives, it must check orderability first"):
//   1. executeTool's add_item case (compiled-engine branch) now enriches a
//      decline result with a real, code-computed `orderable_alternatives`
//      list (bot_state='orderable' siblings in the same category) and an
//      explicit instruction to use ONLY that list — never the model's own
//      menu recall.
//   2. GUARD 15 (this file) is the deterministic backstop matching this
//      codebase's established pattern (GUARD 8, GUARD 12: a prompt
//      instruction alone is not trusted, unchecked, on a ~17k-token system
//      prompt resent every turn) — it scans the finalized reply for any
//      OTHER same-category item that is ALSO bot_state='blocked' and, if
//      found, appends a correction naming the real orderable list (append-
//      only, never edits the model's own sentence, same convention GUARD 12
//      uses and for the same reason: surgically detecting "which sentence is
//      the false claim" in free text is fragile regex surgery). The
//      declined item(s) themselves are excluded from the "blocked sibling"
//      scan — the reply necessarily names what it just honestly declined
//      ("the Double Burger isn't available..."), which is correct, not a
//      false suggestion.
//
// GUARD 15 lives inline in index.ts (Deno.serve() at module scope, not
// importable — same constraint as every other *.test.ts file in this
// directory). This mirrors its pure matching logic verbatim, with a
// source-text regression check at the bottom.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

interface MenuItemLike { name: string; category: string; bot_state: string | null }
interface DeclinedItem { category: string; name: string }

function flaggedBlockedNamesMirror(
  declinedBlockedItems: DeclinedItem[],
  effectiveMenu: MenuItemLike[],
  reply: string,
): string[] {
  const declinedNames = new Set(declinedBlockedItems.map(d => d.name.toLowerCase()));
  const declinedCategories = [...new Set(declinedBlockedItems.map(d => d.category))];
  // Greedy longest-name-first match+consume — see the header comment: many
  // items in one category share a trailing word ("Burger"), so a naive
  // per-name regex over the raw reply false-positives on the declined item's
  // own name or a genuinely orderable sibling. Consuming longest names first
  // (any bot_state) removes their span before the shorter generic name is
  // tested.
  const categoryItems = declinedCategories
    .flatMap(category => effectiveMenu.filter(m => m.category === category))
    .sort((a, b) => b.name.length - a.name.length);
  const flagged = new Set<string>();
  let working = reply.toLowerCase();
  for (const itemC of categoryItems) {
    const nameRe = new RegExp(`\\b${itemC.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    if (!nameRe.test(working)) continue;
    if (itemC.bot_state === "blocked" && !declinedNames.has(itemC.name.toLowerCase())) flagged.add(itemC.name);
    working = working.replace(nameRe, " ");
  }
  return [...flagged];
}

function orderableSiblingsMirror(declinedBlockedItems: DeclinedItem[], effectiveMenu: MenuItemLike[]): string[] {
  const declinedCategories = [...new Set(declinedBlockedItems.map(d => d.category))];
  return [...new Set(
    declinedCategories.flatMap(category =>
      effectiveMenu.filter(m => m.category === category && m.bot_state === "orderable").map(m => m.name),
    ),
  )];
}

const BURGERS: MenuItemLike[] = [
  { name: "Double Burger", category: "Burgers", bot_state: "blocked" },
  { name: "Burger", category: "Burgers", bot_state: "blocked" },
  { name: "Cheese Burger", category: "Burgers", bot_state: "blocked" },
  { name: "Zio's Deluxe Burger", category: "Burgers", bot_state: "blocked" },
  { name: "Mamma Mia Burger", category: "Burgers", bot_state: "blocked" },
  { name: "BBQ Cheese Burger", category: "Burgers", bot_state: "blocked" },
];
const DOUBLE_BURGER_DECLINED: DeclinedItem[] = [{ category: "Burgers", name: "Double Burger" }];

Deno.test("GUARD 15: the exact repro — every other Burgers item blocked, model suggests siblings, all get flagged", () => {
  const reply = "Sorry, the Double Burger isn't available to order by text yet — but I can suggest the Burger, Cheese Burger, Zio's Deluxe Burger, Mamma Mia Burger, or BBQ Cheese Burger instead!";
  const flagged = flaggedBlockedNamesMirror(DOUBLE_BURGER_DECLINED, BURGERS, reply);
  assertEquals(flagged.sort(), ["BBQ Cheese Burger", "Burger", "Cheese Burger", "Mamma Mia Burger", "Zio's Deluxe Burger"].sort());
});

Deno.test("GUARD 15: naming the declined item itself in the honest decline sentence is NOT flagged", () => {
  const reply = "Sorry, the Double Burger isn't available to order by text yet — you can call the shop directly.";
  const flagged = flaggedBlockedNamesMirror(DOUBLE_BURGER_DECLINED, BURGERS, reply);
  assertEquals(flagged, []);
});

Deno.test("GUARD 15: an ORDERABLE sibling suggested is never flagged (real, valid alternative)", () => {
  const menu: MenuItemLike[] = [...BURGERS, { name: "Veggie Burger", category: "Burgers", bot_state: "orderable" }];
  const reply = "Sorry, the Double Burger isn't available to order by text yet — how about a Veggie Burger instead?";
  const flagged = flaggedBlockedNamesMirror(DOUBLE_BURGER_DECLINED, menu, reply);
  assertEquals(flagged, []);
});

Deno.test("GUARD 15: a blocked item from a DIFFERENT category is never flagged (category-scoped, not menu-wide)", () => {
  const menu: MenuItemLike[] = [...BURGERS, { name: "Buffalo Chicken Pizza", category: "Pizza", bot_state: "blocked" }];
  const reply = "Sorry, the Double Burger isn't available to order by text yet — maybe a Buffalo Chicken Pizza?";
  const flagged = flaggedBlockedNamesMirror(DOUBLE_BURGER_DECLINED, menu, reply);
  assertEquals(flagged, []);
});

Deno.test("GUARD 15: no decline this turn -> nothing to check (declinedBlockedItems empty)", () => {
  const flagged = flaggedBlockedNamesMirror([], BURGERS, "Any reply text at all, even naming Burger");
  assertEquals(flagged, []);
});

Deno.test("orderableSiblingsMirror: real orderable siblings surface for the correction text", () => {
  const menu: MenuItemLike[] = [...BURGERS, { name: "Veggie Burger", category: "Burgers", bot_state: "orderable" }];
  assertEquals(orderableSiblingsMirror(DOUBLE_BURGER_DECLINED, menu), ["Veggie Burger"]);
});

Deno.test("orderableSiblingsMirror: empty when the whole category is blocked (correction falls back to phone-only)", () => {
  assertEquals(orderableSiblingsMirror(DOUBLE_BURGER_DECLINED, BURGERS), []);
});

Deno.test("regression: index.ts's add_item decline branch enriches the result with orderable_alternatives", () => {
  assert(INDEX_SOURCE.includes("orderable_alternatives"), "add_item's compiled-engine decline branch must compute orderable_alternatives");
  assert(
    INDEX_SOURCE.includes('m.bot_state === "orderable"') && INDEX_SOURCE.includes("m.category === menuItem.category"),
    "orderable_alternatives must be scoped to the declined item's own category and bot_state='orderable' only",
  );
});

Deno.test("regression: GUARD 15 exists, excludes the declined item(s) from its own sibling scan, and is append-only", () => {
  assert(INDEX_SOURCE.includes("declinedBlockedItems"), "GUARD 15 must track which item(s)/category were declined this turn");
  assert(
    /itemC\.bot_state === "blocked" && !declinedNames15\.has\(itemC\.name\.toLowerCase\(\)\)/.test(INDEX_SOURCE),
    "GUARD 15 must exclude the just-declined item itself from being flagged — otherwise the honest decline sentence would falsely trip on its own item name",
  );
  assert(
    INDEX_SOURCE.includes(".sort((a, b) => b.name.length - a.name.length)"),
    "GUARD 15 must consume longest item names first so a shared trailing word (e.g. 'Burger') never false-positives on a longer name that contains it",
  );
  assert(
    INDEX_SOURCE.includes("GUARD 15 (blocked item suggested as alternative) tripped"),
    "GUARD 15 must log a trip the same way every other guard in this file does",
  );
  assert(
    /reply = orderableSiblings\.length > 0[\s\S]{0,40}\? `\$\{reply\}/.test(INDEX_SOURCE),
    "GUARD 15 must append to the existing reply, never replace/edit it (same convention as GUARD 12)",
  );
});
