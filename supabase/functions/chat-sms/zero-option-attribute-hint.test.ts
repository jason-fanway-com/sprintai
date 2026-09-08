// zero-option-attribute-hint.ts (2026-09-08, revised same day per Jason's
// explicit direction after live-verifying the prompt-nudge shape and
// finding it still non-deterministic: "STOP revising GUARD 17... a
// post-hoc corrector on free-form text has no version that's reliable...
// CHANGE THE SHAPE"). Real NJB bug: "make it an everything bagel" ->
// "Switched to an everything bagel - I'll pass that along to the shop. So,
// want that toasted? Just to be clear - Bagel With Plain Cream Cheese
// doesn't have that kind of option here, so nothing was actually changed"
// — one message claims success, then retracts it.
//
// resolveZeroOptionAttributeChange is the deterministic, authoritative
// fix: detected BEFORE any LLM call for the turn, rendered rather than
// generated. buildZeroOptionAttributeChangeHint (this file's earlier,
// still-present function) is now a FALLBACK for the ambiguous 2+-item
// case only — see its own comment for why it's not the primary mechanism.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildZeroOptionAttributeChangeHint,
  resolveZeroOptionAttributeChange,
  renderZeroOptionAttributeChangeReply,
  type ZeroOptionCartLine,
  type ZeroOptionMenuItem,
  type ZeroOptionMenuItemFull,
} from "./zero-option-attribute-hint.ts";

const BAGEL_LINE: ZeroOptionCartLine = { menu_item_id: "bagel-plain-cc" };
const BAGEL_MENU_ITEM: ZeroOptionMenuItem = {
  id: "bagel-plain-cc",
  ask_plan: { display_name: "Bagel with Plain Cream Cheese", steps: [] },
};
const BAGEL_MENU_ITEM_FULL: ZeroOptionMenuItemFull = {
  ...BAGEL_MENU_ITEM,
  category: "Bagel With",
  price_cents: 350,
};
const PIZZA_LINE: ZeroOptionCartLine = { menu_item_id: "pizza-1" };
const PIZZA_MENU_ITEM: ZeroOptionMenuItem = {
  id: "pizza-1",
  ask_plan: { display_name: "Buffalo Chicken Pizza", steps: [{ kind: "modifier" }] },
};
const PIZZA_MENU_ITEM_FULL: ZeroOptionMenuItemFull = {
  ...PIZZA_MENU_ITEM,
  category: "Pizza",
  price_cents: 1999,
};

// ============================================================
// resolveZeroOptionAttributeChange / renderZeroOptionAttributeChangeReply
// ============================================================

// The exact real repro
Deno.test("resolver: the exact real repro — no alternative item exists, renders a plain single-message decline", () => {
  const resolution = resolveZeroOptionAttributeChange(
    "actually can you make that an everything bagel instead",
    [BAGEL_LINE],
    [BAGEL_MENU_ITEM_FULL],
  );
  assert(resolution, "must resolve");
  assertEquals(resolution!.alternative, null, "no 'Everything Bagel with Cream Cheese' SKU exists in the 'Bagel With' category, so no alternative");
  const reply = renderZeroOptionAttributeChangeReply(resolution!);
  assertEquals(reply, "I can't change that on the Bagel with Plain Cream Cheese — it doesn't have that option.");
  assert(!/switched|noted|got it/i.test(reply), "the rendered reply must never contain a claim-shaped word for a change that didn't happen");
});

Deno.test("resolver: a genuinely different SAME-CATEGORY catalog item is offered by name and real price", () => {
  const plainBagelLine: ZeroOptionCartLine = { menu_item_id: "plain-bagel" };
  const plainBagelItem: ZeroOptionMenuItemFull = {
    id: "plain-bagel", category: "Bagels", price_cents: 125,
    ask_plan: { display_name: "Plain Bagel", steps: [] },
  };
  const everythingBagelItem: ZeroOptionMenuItemFull = {
    id: "everything-bagel", category: "Bagels", price_cents: 150,
    ask_plan: { display_name: "Everything Bagel", steps: [] },
  };
  const resolution = resolveZeroOptionAttributeChange(
    "switch it to an everything bagel",
    [plainBagelLine],
    [plainBagelItem, everythingBagelItem],
  );
  assert(resolution);
  assertEquals(resolution!.alternative, { id: "everything-bagel", name: "Everything Bagel", priceCents: 150 });
  const reply = renderZeroOptionAttributeChangeReply(resolution!);
  assertEquals(reply, "The Everything Bagel is a separate item ($1.50) — want me to swap it in?");
});

Deno.test("resolver: a same-NAME-word item in a DIFFERENT category is not offered as an alternative", () => {
  // "Everything Bagel" exists, but in a different category than the cart
  // item ("Bagel With" vs "Bagels") -- not a genuine substitute for a
  // cream-cheese item, so it must not be offered.
  const everythingBagelWrongCategory: ZeroOptionMenuItemFull = {
    id: "everything-bagel", category: "Bagels", price_cents: 150,
    ask_plan: { display_name: "Everything Bagel", steps: [] },
  };
  const resolution = resolveZeroOptionAttributeChange(
    "make that an everything bagel instead",
    [BAGEL_LINE],
    [BAGEL_MENU_ITEM_FULL, everythingBagelWrongCategory],
  );
  assert(resolution);
  assertEquals(resolution!.alternative, null, "different category is not a genuine substitute");
});

// Real bug, caught on the FIRST live deployed run of this resolver: 3/3
// deterministic runs all confidently offered "Bagel With Butter" as the
// swap — wrong every time, because "bagel" (the item's own generic
// category word, shared by every "Bagel With X" item) was still in the
// candidate-word pool and matched the first same-category item iterated.
Deno.test("resolver: the item's OWN generic word ('bagel') must never itself count as the search descriptor — real bug, matched an arbitrary same-category item 3/3 times before this fix", () => {
  const bagelWithButter: ZeroOptionMenuItemFull = {
    id: "bagel-with-butter", category: "Bagel With", price_cents: 275,
    ask_plan: { display_name: "Bagel With Butter", steps: [] },
  };
  const bagelWithNutella: ZeroOptionMenuItemFull = {
    id: "bagel-with-nutella", category: "Bagel With", price_cents: 350,
    ask_plan: { display_name: "Bagel With Nutella", steps: [] },
  };
  const resolution = resolveZeroOptionAttributeChange(
    "actually can you make that an everything bagel instead",
    [BAGEL_LINE],
    [BAGEL_MENU_ITEM_FULL, bagelWithButter, bagelWithNutella],
  );
  assert(resolution);
  assertEquals(resolution!.alternative, null, "no same-category item's descriptor word ('butter', 'nutella') matches 'everything' — must not fall back to matching the shared word 'bagel'");
});

// THE CRITICAL SAFETY GATE — without this, an unrelated request hijacks
// the entire turn and the customer's real request never gets processed.
Deno.test("resolver SAFETY GATE: an unrelated change request ('switch my order to delivery') with a zero-option item in cart must NOT resolve — real risk found before shipping", () => {
  const resolution = resolveZeroOptionAttributeChange(
    "switch my order to delivery please",
    [BAGEL_LINE],
    [BAGEL_MENU_ITEM_FULL],
  );
  assertEquals(resolution, null, "an order-type change shares no word with the item's own name and must fall through to normal handling, not hijack the turn");
});

Deno.test("resolver SAFETY GATE: 'change my tip to $5' with a zero-option item in cart must NOT resolve", () => {
  const resolution = resolveZeroOptionAttributeChange(
    "actually change my tip to $5",
    [BAGEL_LINE],
    [BAGEL_MENU_ITEM_FULL],
  );
  assertEquals(resolution, null);
});

Deno.test("resolver: no change language at all -> null", () => {
  assertEquals(resolveZeroOptionAttributeChange("can I also get a coffee", [BAGEL_LINE], [BAGEL_MENU_ITEM_FULL]), null);
});

Deno.test("resolver: an item with real ask_plan steps in cart (not zero-option) -> null, this is GUARD 16's territory", () => {
  assertEquals(resolveZeroOptionAttributeChange("switch it to large with pepperoni", [PIZZA_LINE], [PIZZA_MENU_ITEM_FULL]), null);
});

Deno.test("resolver: TWO zero-option items in cart -> null (ambiguous, intentionally left to the fallback, not guessed at)", () => {
  const plainBagelLine: ZeroOptionCartLine = { menu_item_id: "plain-bagel" };
  const plainBagelItem: ZeroOptionMenuItemFull = {
    id: "plain-bagel", category: "Bagels", price_cents: 125,
    ask_plan: { display_name: "Plain Bagel", steps: [] },
  };
  const resolution = resolveZeroOptionAttributeChange(
    "make the bagel an everything bagel",
    [BAGEL_LINE, plainBagelLine],
    [BAGEL_MENU_ITEM_FULL, plainBagelItem],
  );
  assertEquals(resolution, null, "2+ zero-option items is a genuine ambiguity this resolver must not guess at");
});

Deno.test("resolver: two cart LINES of the SAME zero-option item (quantity 2 as two rows) is still unambiguous, not treated as 2 distinct items", () => {
  const resolution = resolveZeroOptionAttributeChange(
    "switch them to everything bagels instead",
    [BAGEL_LINE, { menu_item_id: "bagel-plain-cc" }],
    [BAGEL_MENU_ITEM_FULL],
  );
  assert(resolution, "two lines of the same item must resolve to that one item, not be treated as ambiguous");
  assertEquals(resolution!.menuItemId, "bagel-plain-cc");
});

Deno.test("resolver: empty cart -> null", () => {
  assertEquals(resolveZeroOptionAttributeChange("switch it to an everything bagel", [], [BAGEL_MENU_ITEM_FULL]), null);
});

Deno.test("resolver: a cart line with no matching menu item does not crash and returns null", () => {
  const orphanLine: ZeroOptionCartLine = { menu_item_id: "does-not-exist" };
  assertEquals(resolveZeroOptionAttributeChange("switch it to an everything bagel", [orphanLine], [BAGEL_MENU_ITEM_FULL]), null);
});

Deno.test("resolver: rawRequest preserves the customer's own words for the deterministic set_note call", () => {
  const msg = "actually can you make that an everything bagel instead";
  const resolution = resolveZeroOptionAttributeChange(msg, [BAGEL_LINE], [BAGEL_MENU_ITEM_FULL]);
  assert(resolution);
  assertEquals(resolution!.rawRequest, msg);
});

// ============================================================
// buildZeroOptionAttributeChangeHint — fallback for 2+ zero-option items
// ============================================================

Deno.test("hint (fallback): still fires on the exact real repro message when used standalone", () => {
  const hint = buildZeroOptionAttributeChangeHint(
    "actually can you make that an everything bagel instead",
    [BAGEL_LINE],
    [BAGEL_MENU_ITEM],
  );
  assert(hint);
  assert(hint!.includes("Bagel with Plain Cream Cheese"));
});

Deno.test("hint (fallback): does not fire without change language", () => {
  assertEquals(buildZeroOptionAttributeChangeHint("can I also get a coffee", [BAGEL_LINE], [BAGEL_MENU_ITEM]), null);
});

Deno.test("hint (fallback): does not fire without a zero-option cart item", () => {
  assertEquals(buildZeroOptionAttributeChangeHint("switch it to a large", [PIZZA_LINE], [PIZZA_MENU_ITEM]), null);
});
