// zero-option-attribute-hint.ts (2026-09-08). Real NJB bug: "make it an
// everything bagel" -> "Switched to an everything bagel - I'll pass that
// along to the shop. So, want that toasted? Just to be clear - Bagel With
// Plain Cream Cheese doesn't have that kind of option here, so nothing was
// actually changed" — one message claims success, then retracts it. Jason's
// diagnosis: an ordering problem, not a wording problem. GUARD 17 (see
// guard17-*.test.ts) can only ever run AFTER the model has already composed
// that text and append a correction — this module runs BEFORE the model's
// first call of the turn instead, so the constraint is in its context from
// the start and it can compose ONE honest message.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildZeroOptionAttributeChangeHint, type ZeroOptionCartLine, type ZeroOptionMenuItem } from "./zero-option-attribute-hint.ts";

const BAGEL_LINE: ZeroOptionCartLine = { menu_item_id: "bagel-plain-cc" };
const BAGEL_MENU_ITEM: ZeroOptionMenuItem = {
  id: "bagel-plain-cc",
  ask_plan: { display_name: "Bagel with Plain Cream Cheese", steps: [] },
};
const PIZZA_LINE: ZeroOptionCartLine = { menu_item_id: "pizza-1" };
const PIZZA_MENU_ITEM: ZeroOptionMenuItem = {
  id: "pizza-1",
  ask_plan: { display_name: "Buffalo Chicken Pizza", steps: [{ kind: "modifier" }] },
};

// The exact real repro's customer message
Deno.test("hint fires on the exact real repro message ('make it an everything bagel') with a zero-option item in cart", () => {
  const hint = buildZeroOptionAttributeChangeHint(
    "actually can you make that an everything bagel instead",
    [BAGEL_LINE],
    [BAGEL_MENU_ITEM],
  );
  assert(hint, "must produce a hint");
  assert(hint!.includes("Bagel with Plain Cream Cheese"), "hint must name the zero-option item");
  assert(/set_note/.test(hint!), "hint must point the model at the real, legitimate action (set_note)");
  assert(/ONE honest, coherent message/i.test(hint!), "hint must instruct a single coherent reply, not a claim-then-correction");
});

Deno.test("hint fires on 'switch'/'change'/'swap'/'instead of' phrasings", () => {
  const variants = [
    "switch it to an everything bagel",
    "can you change it to sesame",
    "swap that for an everything one",
    "I want everything instead of plain",
    "now with everything please",
    "updated to everything, thanks",
  ];
  for (const msg of variants) {
    const hint = buildZeroOptionAttributeChangeHint(msg, [BAGEL_LINE], [BAGEL_MENU_ITEM]);
    assert(hint, `must fire for: "${msg}"`);
  }
});

// No change language at all -> no hint (an ordinary add/remove turn should
// never carry this extra system-prompt text)
Deno.test("hint does NOT fire when the message has no change language", () => {
  const hint = buildZeroOptionAttributeChangeHint("can I also get a coffee", [BAGEL_LINE], [BAGEL_MENU_ITEM]);
  assertEquals(hint, null);
});

// No zero-option item in cart -> no hint, even with change language (nothing
// this turn is at risk of the self-contradiction pattern)
Deno.test("hint does NOT fire when the cart has no zero-option items", () => {
  const hint = buildZeroOptionAttributeChangeHint("switch it to a large", [PIZZA_LINE], [PIZZA_MENU_ITEM]);
  assertEquals(hint, null);
});

// Empty cart -> no hint
Deno.test("hint does NOT fire on an empty cart", () => {
  const hint = buildZeroOptionAttributeChangeHint("switch it to something else", [], [BAGEL_MENU_ITEM]);
  assertEquals(hint, null);
});

// Mixed cart: a real-options item AND a zero-option item -> hint fires,
// naming only the zero-option one (the real-options item is GUARD 16's
// territory, not this hint's)
Deno.test("hint names only the zero-option item(s) in a mixed cart", () => {
  const hint = buildZeroOptionAttributeChangeHint(
    "switch the pizza to large and the bagel to everything",
    [PIZZA_LINE, BAGEL_LINE],
    [PIZZA_MENU_ITEM, BAGEL_MENU_ITEM],
  );
  assert(hint, "must fire — a zero-option item is present");
  assert(hint!.includes("Bagel with Plain Cream Cheese"), "must name the zero-option item");
  assert(!hint!.includes("Buffalo Chicken Pizza"), "must NOT name the real-options item — that's not this hint's concern");
});

// Two zero-option items -> both named, de-duplicated if the same item
// appears as two separate cart lines
Deno.test("hint de-duplicates when the same zero-option item has two cart lines", () => {
  const hint = buildZeroOptionAttributeChangeHint(
    "switch them to everything",
    [BAGEL_LINE, { menu_item_id: "bagel-plain-cc" }],
    [BAGEL_MENU_ITEM],
  );
  assert(hint);
  const occurrences = (hint!.match(/Bagel with Plain Cream Cheese/g) ?? []).length;
  assertEquals(occurrences, 1, "the item name should appear once in the hint, not once per cart line");
});

// An item with real ask_plan steps is never named (GUARD 16's territory)
Deno.test("an item with real ask_plan steps never triggers this hint on its own", () => {
  const hint = buildZeroOptionAttributeChangeHint("switch it to large", [PIZZA_LINE], [PIZZA_MENU_ITEM]);
  assertEquals(hint, null);
});

// An item with no ask_plan at all (uncompiled/legacy) is never named
Deno.test("a cart line with no matching menu item, or a menu item with no ask_plan, does not crash and produces no hint on its own", () => {
  const legacyLine: ZeroOptionCartLine = { menu_item_id: "legacy-1" };
  const legacyItem: ZeroOptionMenuItem = { id: "legacy-1", ask_plan: null };
  const hint = buildZeroOptionAttributeChangeHint("switch it to something", [legacyLine], [legacyItem]);
  assertEquals(hint, null);

  const orphanLine: ZeroOptionCartLine = { menu_item_id: "does-not-exist" };
  const hint2 = buildZeroOptionAttributeChangeHint("switch it to something", [orphanLine], [BAGEL_MENU_ITEM]);
  assertEquals(hint2, null);
});
