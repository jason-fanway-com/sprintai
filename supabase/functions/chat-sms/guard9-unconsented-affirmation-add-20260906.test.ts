// P0 INCIDENT (2026-09-06): a real tester's ("Luca") cart doubled from
// $37.97 to $74.95 after he said "Looks good". Root cause, confirmed by
// reading the actual guard code in index.ts (not assumed from the incident
// report): GUARD 4 v3's under-populated-cart backstop fuzzy-matched words in
// the customer's ORIGINAL order ("chicken bacon ranch pizza") against every
// menu item name via extractCustomerReferencedItems/findMissingCartItems,
// found "Chicken Bacon Ranch (Flatbreads)", "Chicken (Quesadillas)", and
// "Ranch" as near-name matches, and appended a customer-facing upsell line
// reading those DB category-adjacent names aloud: "Did you also want
// Chicken Bacon Ranch (Flatbreads), Chicken (Quesadillas), and Ranch, or
// good to go?". That unresolved offer sat in conversation history. Two
// turns later "Looks good" — a bare affirmation matched by
// impliesOrderConfirmation() — was read by the model, given the full
// history including the still-open 3-item offer, as consent to add all of
// it, issuing real add_item tool calls for all three. Cart went from 2
// items/$37.97 to 4 items/$74.95 with zero customer intent.
//
// Fix #1 (verified below via source-text assertion): GUARD 4 v3 no longer
// builds or appends that upsell line. Detection + console.warn telemetry is
// unchanged — it still catches genuinely dropped items (a real prior bug
// fixed 2026-09-05) — only the customer-facing suggestion is gone.
//
// Fix #2: GUARD 9, a deterministic backstop that holds even if some FUTURE
// mechanism leaves an open, unresolved offer in history again. On any turn
// where the customer's message is a bare affirmation, if the cart's total
// quantity for a menu item grew and the CURRENT message alone (never
// history) does not name that item, the growth is reverted before the
// reply is sent.
//
// FOLLOW-UP INCIDENT (same day, caught by independent QA before this guard
// ever shipped): GUARD 9's first version built its "before" quantity
// snapshot from index.ts's `cartItems` variable, which is mutated IN PLACE
// by executeTool's push()/splice() calls during the tool-execution loop that
// runs BEFORE the guard — so by the time the guard read `cartItems`, it
// already reflected POST-turn state. "before" and "after" were computed from
// the same mutated data, delta was always <= 0, and the guard could never
// trip. The original version of THIS test file used a hand-copied mirror of
// the diff algorithm fed independently-constructed before/after arrays —
// which is exactly why it stayed green while the real wiring was broken: a
// mirror fed clean inputs can't catch an integration bug in how the real
// code obtains those inputs.
//
// The fix moved GUARD 9's diff/decision logic into its own importable module
// (guard9-unconsented-affirmation.ts), wired to `cartSnapshotBeforeTurn` (a
// true pre-tool-loop deep clone — see that declaration's comment in
// index.ts) instead of `cartItems`. This file now imports and tests the REAL
// function, not a copy, and includes a source-text check (last test) that
// fails loudly if index.ts's call site ever regresses back to `cartItems`.
//
// index.ts calls Deno.serve() at module scope, so it is never imported
// directly by tests (same constraint as every other *.test.ts file in this
// directory — see guard-defects-20260906.test.ts's header). The name-lookup
// helpers below (buildMenuItemNamesMirror / extractCustomerReferencedItemsMirror)
// remain verbatim mirrors of index.ts's private buildMenuItemNames /
// extractCustomerReferencedItems — those functions were NOT touched by the
// GUARD 9 fix (they only build the "was this item named this turn?"
// predicate that GUARD 9 takes as an external parameter) and are shared by
// several other guards, so they were deliberately left in index.ts rather
// than relocated. If those functions change in index.ts, update the copies
// here too.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeGuard9, impliesOrderConfirmation } from "./guard9-unconsented-affirmation.ts";
import { hasNonConfirmationContent } from "./confirmation-with-other-intent-20260912.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

// ─── Verbatim mirrors of index.ts's private menu-name-matching helpers ─────
// (unrelated to the GUARD 9 fix — see file header)

const GENERIC_LAST_WORDS_MIRROR = new Set([
  "large", "medium", "small", "regular", "mini", "jumbo", "giant", "personal",
  "half", "whole", "single", "double", "triple", "side", "sides", "plain",
  "pizza", "pizzas", "pie", "pies", "roll", "rolls", "wrap", "wraps", "sub",
  "subs", "sandwich", "sandwiches", "salad", "salads", "soup", "soups",
  "platter", "platters", "combo", "combos", "special", "specials", "dinner",
  "lunch", "breakfast", "meal", "meals", "plate", "plates", "basket",
  "pieces", "piece", "order", "orders", "cup", "bowl", "slice", "slices",
]);

interface MenuLike {
  id: string;
  name: string;
  category?: string | null;
}

function buildMenuItemNamesMirror(menu: MenuLike[]): Map<string, string> {
  const names = new Map<string, string>();

  const nameCount = new Map<string, number>();
  for (const item of menu) {
    const full = item.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    nameCount.set(full, (nameCount.get(full) || 0) + 1);
  }
  const duplicateNames = new Set(
    [...nameCount.entries()].filter(([, c]) => c > 1).map(([n]) => n),
  );

  const wordItemCount = new Map<string, number>();
  for (const item of menu) {
    const words = new Set(
      item.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' '),
    );
    for (const w of words) wordItemCount.set(w, (wordItemCount.get(w) || 0) + 1);
  }

  for (const item of menu) {
    const full = item.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const catShort = (item.category ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

    names.set(item.id.toLowerCase(), item.name);

    if (duplicateNames.has(full)) {
      const qualified = `${full} (${catShort})`;
      names.set(qualified, item.name);
      if (!names.has(full)) names.set(full, item.name);
    } else {
      names.set(full, item.name);
    }

    const parts = full.split(' ').filter(w => w.length >= 3);
    if (parts.length > 1) {
      const lastName = parts[parts.length - 1];
      const unique = (wordItemCount.get(lastName) ?? 0) === 1;
      if (unique && !GENERIC_LAST_WORDS_MIRROR.has(lastName) && !names.has(lastName)) {
        names.set(lastName, item.name);
      }
    }
  }
  return names;
}

function extractCustomerReferencedItemsMirror(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  menuNames: Map<string, string>,
): Set<string> {
  const referenced = new Set<string>();
  const userMessages = history
    .filter(h => h.role === "user")
    .map(h => h.content.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim());

  for (let i = 0; i < userMessages.length; i++) {
    const msg = userMessages[i];
    const isCurrent = i === userMessages.length - 1;
    if (!isCurrent && !/\b(?:and|also|plus|with|then|as well|too)\b/i.test(msg)) continue;

    for (const [key, displayName] of menuNames) {
      if (/^[a-f0-9-]{8,}$/.test(key)) continue;
      if (msg.includes(key)) {
        referenced.add(displayName);
      }
    }
  }
  return referenced;
}

// Builds the same `isItemNamedThisTurn` predicate index.ts's GUARD 9 call
// site builds, from the (mirrored) menu-name helpers above, for use with the
// REAL imported computeGuard9.
function isNamedThisTurnPredicate(userMessage: string, menu: MenuLike[]): (itemName: string) => boolean {
  const menuItemNames = buildMenuItemNamesMirror(menu);
  const namedThisTurn = extractCustomerReferencedItemsMirror(
    [{ role: "user", content: userMessage }],
    menuItemNames,
  );
  return (itemName: string): boolean => {
    const itemLower = itemName.toLowerCase();
    return [...namedThisTurn].some(n => {
      const n2 = n.toLowerCase();
      return n2.includes(itemLower) || itemLower.includes(n2);
    });
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

interface TestCartLine {
  menu_item_id: string;
  name: string;
  quantity: number;
  options?: Record<string, string[]>;
}

const LUCA_MENU: MenuLike[] = [
  { id: "pizza-cbr", name: "Chicken Bacon Ranch", category: "Pizza" },
  { id: "wings", name: "Wings", category: "Wings" },
  { id: "flatbread-cbr", name: "Chicken Bacon Ranch (Flatbreads)", category: "Flatbreads" },
  { id: "quesadilla-chicken", name: "Chicken (Quesadillas)", category: "Quesadillas" },
  { id: "ranch", name: "Ranch", category: "Sides" },
  { id: "fries", name: "Fries", category: "Sides" },
];

// C4 regression fixture (2026-09-12, docs/DEFECT-CLASSES.md, live money
// defect, conv 08782185): a menu shaped like Vito's real one — THREE
// distinct "fries" dishes (French/Bacon Cheese/Nacho Cheese), none of them
// named plain "Fries" — kept SEPARATE from LUCA_MENU (which has its own,
// unambiguous "Fries" item) so the two don't cross-contaminate via
// substring matching. With "fries" genuinely ambiguous across three menu
// items (the real live condition), buildMenuItemNamesMirror's own
// unique-word-alias safety net correctly refuses to alias it to any one of
// them, and "add fries" never substring-matches any of their FULL names —
// so isItemNamedThisTurn legitimately returns false, same as it did live.
// hasOtherIntent is what must save this add, not a smarter name match.
const VITOS_FRIES_MENU: MenuLike[] = [
  { id: "pizza-cbr", name: "Chicken Bacon Ranch", category: "Pizza" },
  { id: "french-fries", name: "French Fries", category: "Sides" },
  { id: "bacon-cheese-fries", name: "Bacon Cheese Fries", category: "Appetizers" },
  { id: "nacho-cheese-fries", name: "Nacho Cheese Fries", category: "Appetizers" },
];

const LUCA_CART_BEFORE: TestCartLine[] = [
  { menu_item_id: "pizza-cbr", name: "Chicken Bacon Ranch", quantity: 1 },
  { menu_item_id: "wings", name: "Wings", quantity: 1 },
];

const LUCA_CART_AFTER_PHANTOM: TestCartLine[] = [
  ...LUCA_CART_BEFORE,
  { menu_item_id: "flatbread-cbr", name: "Chicken Bacon Ranch (Flatbreads)", quantity: 1 },
  { menu_item_id: "quesadilla-chicken", name: "Chicken (Quesadillas)", quantity: 1 },
  { menu_item_id: "ranch", name: "Ranch", quantity: 1 },
];

// ── Requirement 1: the exact Luca sequence, against the REAL function ──────

Deno.test("GUARD 9 (real fn): 'Looks good' does not name the flatbread/quesadilla/ranch — all three classified as phantom", () => {
  const result = computeGuard9(
    "Looks good",
    LUCA_CART_BEFORE,
    LUCA_CART_AFTER_PHANTOM,
    isNamedThisTurnPredicate("Looks good", LUCA_MENU),
  );
  assertEquals(result.tripped, true);
  assertEquals(result.qtyReverts.length, 0);
  const phantomIds = result.phantomAdds.map(i => i.menu_item_id).sort();
  assertEquals(phantomIds, ["flatbread-cbr", "quesadilla-chicken", "ranch"]);
});

Deno.test("GUARD 9 (real fn): the pizza and wings the customer actually ordered are never touched", () => {
  const result = computeGuard9(
    "Looks good",
    LUCA_CART_BEFORE,
    LUCA_CART_AFTER_PHANTOM,
    isNamedThisTurnPredicate("Looks good", LUCA_MENU),
  );
  const phantomIds = new Set(result.phantomAdds.map(i => i.menu_item_id));
  assertEquals(phantomIds.has("pizza-cbr"), false);
  assertEquals(phantomIds.has("wings"), false);
});

// ── Requirement 2: a genuinely named add on affirmation-adjacent phrasing ──

Deno.test("GUARD 9 (real fn): 'yeah also add fries' names fries in the current message — must NOT be reverted", () => {
  const before: TestCartLine[] = [{ menu_item_id: "pizza-cbr", name: "Chicken Bacon Ranch", quantity: 1 }];
  const after: TestCartLine[] = [
    ...before,
    { menu_item_id: "fries", name: "Fries", quantity: 1 },
  ];
  const result = computeGuard9(
    "yeah also add fries",
    before,
    after,
    isNamedThisTurnPredicate("yeah also add fries", LUCA_MENU),
  );
  assertEquals(result.tripped, false, "fries was named this turn and must survive");
  assertEquals(result.phantomAdds.length, 0);
  assertEquals(result.qtyReverts.length, 0);
});

// ── C4 regression (2026-09-12, docs/DEFECT-CLASSES.md, live money defect,
// conv 08782185): "Yes to Jason. Can you add fries to that?" is a bare
// affirmation by impliesOrderConfirmation's own substring test, AND the
// menu's real item is "French Fries" — "add fries" never substring-matches
// that full name, so isItemNamedThisTurn legitimately says false, same as it
// did live. Before the hasOtherIntent param existed, GUARD 9 read that as
// unconsented growth and reverted the fries — the customer's explicit,
// freshly-stated request, silently discarded. ─────────────────────────────

Deno.test("GUARD 9 (real fn): C4 fix — 'Yes to Jason. Can you add fries to that?' — French Fries is NOT named by substring match, but hasOtherIntent must still save it", () => {
  const message = "Yes to Jason. Can you add fries to that?";
  const before: TestCartLine[] = [{ menu_item_id: "pizza-cbr", name: "Chicken Bacon Ranch", quantity: 1 }];
  const after: TestCartLine[] = [
    ...before,
    { menu_item_id: "french-fries", name: "French Fries", quantity: 1 },
  ];
  // Confirms the premise: the customer's own words do NOT literally name
  // "French Fries" — same brittle-substring gap the live incident hit.
  assertEquals(isNamedThisTurnPredicate(message, VITOS_FRIES_MENU)("French Fries"), false);
  const hasOtherIntent = hasNonConfirmationContent(message, "Jason");
  assert(hasOtherIntent, "the message carries real content beyond a bare confirmation");
  const result = computeGuard9(message, before, after, isNamedThisTurnPredicate(message, VITOS_FRIES_MENU), hasOtherIntent);
  assertEquals(result.tripped, false, "the fries add must survive — it was the customer's own explicit ask this turn");
  assertEquals(result.phantomAdds.length, 0);
});

Deno.test("GUARD 9 (real fn): C4 fix — the SAME unnamed French Fries add on a genuinely BARE 'yes' (hasOtherIntent false) is still reverted — no blanket weakening", () => {
  const message = "yes";
  const before: TestCartLine[] = [{ menu_item_id: "pizza-cbr", name: "Chicken Bacon Ranch", quantity: 1 }];
  const after: TestCartLine[] = [
    ...before,
    { menu_item_id: "french-fries", name: "French Fries", quantity: 1 },
  ];
  const hasOtherIntent = hasNonConfirmationContent(message, "Jason");
  assertEquals(hasOtherIntent, false, "a bare 'yes' carries no other content");
  const result = computeGuard9(message, before, after, isNamedThisTurnPredicate(message, VITOS_FRIES_MENU), hasOtherIntent);
  assertEquals(result.tripped, true, "an unrelated phantom add on a genuinely bare affirmation must still be caught");
  assertEquals(result.phantomAdds.map(i => i.menu_item_id), ["french-fries"]);
});

Deno.test("GUARD 9 (real fn): C4 fix — hasOtherIntent does NOT exempt an unnamed QUANTITY BUMP on an EXISTING line (the GUARD 21/conv ce84c64b doubling shape)", () => {
  const message = "Yes to Jason. Can you add fries to that?";
  // The pizza itself silently doubling on this same compound turn — a
  // request for fries is no explanation for why the PIZZA's own count grew.
  const before: TestCartLine[] = [{ menu_item_id: "pizza-cbr", name: "Chicken Bacon Ranch", quantity: 1 }];
  const after: TestCartLine[] = [{ menu_item_id: "pizza-cbr", name: "Chicken Bacon Ranch", quantity: 2 }];
  const hasOtherIntent = hasNonConfirmationContent(message, "Jason");
  assert(hasOtherIntent);
  const result = computeGuard9(message, before, after, isNamedThisTurnPredicate(message, VITOS_FRIES_MENU), hasOtherIntent);
  assertEquals(result.tripped, true, "same-line quantity growth this turn's words don't explain must still be reverted, even with other content present");
  assertEquals(result.qtyReverts.length, 1);
  assertEquals(result.qtyReverts[0].priorQty, 1);
});

// ── False-positive guard: resolving a pending option must never look like a
//    phantom add just because it changes the line's fingerprint ───────────

Deno.test("GUARD 9 (real fn): resolving a pending option group on 'sure' does not revert anything (no quantity growth)", () => {
  const before: TestCartLine[] = [{ menu_item_id: "wings", name: "Wings", quantity: 1 }];
  const after: TestCartLine[] = [{ menu_item_id: "wings", name: "Wings", quantity: 1, options: { Sauce: ["Ranch"] } }];
  const result = computeGuard9("sure", before, after, isNamedThisTurnPredicate("sure", LUCA_MENU));
  assertEquals(result.tripped, false);
});

Deno.test("GUARD 9 (real fn): an unnamed quantity bump on an unchanged line is reverted to the prior quantity", () => {
  const before: TestCartLine[] = [{ menu_item_id: "wings", name: "Wings", quantity: 1 }];
  const after: TestCartLine[] = [{ menu_item_id: "wings", name: "Wings", quantity: 2 }];
  const result = computeGuard9("looks good", before, after, isNamedThisTurnPredicate("looks good", LUCA_MENU));
  assertEquals(result.phantomAdds.length, 0);
  assertEquals(result.qtyReverts.length, 1);
  assertEquals(result.qtyReverts[0].priorQty, 1);
});

Deno.test("GUARD 9 (real fn): a non-affirmation message never triggers the guard, even if the cart grew unexplained", () => {
  const result = computeGuard9(
    "what's in my cart?",
    LUCA_CART_BEFORE,
    LUCA_CART_AFTER_PHANTOM,
    isNamedThisTurnPredicate("what's in my cart?", LUCA_MENU),
  );
  assertEquals(result.tripped, false);
});

Deno.test("impliesOrderConfirmation (real fn): 'Looks good' is a bare affirmation", () => {
  assert(impliesOrderConfirmation("Looks good"));
});

// QA (Jason, 2026-09-06, live 6-session test — the checkout-gate "coin
// flip"): "thats it" (no apostrophe) silently missed this function's
// alternation, so GUARD 2's deterministic pending-options re-ask never even
// got a chance to fire on that turn — the whole checkout decision fell to
// the model's own judgment, which is exactly why the same two words in
// produced different outcomes across sessions. Fixed by making the
// apostrophe optional, same pattern this function already used correctly
// for "let's go"/"let's do it".
Deno.test("impliesOrderConfirmation (real fn): 'thats it' (no apostrophe) is a bare affirmation", () => {
  assert(impliesOrderConfirmation("thats it"));
});

Deno.test("impliesOrderConfirmation (real fn): 'thats all' (no apostrophe) is a bare affirmation", () => {
  assert(impliesOrderConfirmation("thats all"));
});

Deno.test("impliesOrderConfirmation (real fn): apostrophized forms still work", () => {
  assert(impliesOrderConfirmation("that's it"));
  assert(impliesOrderConfirmation("that's all"));
  assert(impliesOrderConfirmation("that is it"));
});

// ── Integration-shape regression: the EXACT bug QA found ───────────────────
// Reproduces the real code's array-mutation shape, not cleanly-separated
// fixtures: a `cartItemsSim` array that gets mutated IN PLACE the way
// executeTool's push() mutates the real `cartItems`/`cart` param (same
// reference), plus a `cartSnapshotBeforeTurnSim` deep clone taken BEFORE
// that mutation, matching index.ts's actual `cartSnapshotBeforeTurn`
// construction (`JSON.parse(JSON.stringify(...))`) before the tool loop
// runs.

Deno.test("GUARD 9 (real fn, integration shape): reverts correctly when 'before' is a pre-mutation deep clone, not the mutated array", () => {
  // Stands in for index.ts's `cartItems` at the top of the turn.
  const cartItemsSim: TestCartLine[] = [
    { menu_item_id: "pizza-cbr", name: "Chicken Bacon Ranch", quantity: 1 },
    { menu_item_id: "wings", name: "Wings", quantity: 1 },
  ];
  // Stands in for index.ts's `cartSnapshotBeforeTurn`: a deep clone taken
  // BEFORE any tool execution, so later mutation of cartItemsSim cannot
  // reach it.
  const cartSnapshotBeforeTurnSim: TestCartLine[] = JSON.parse(JSON.stringify(cartItemsSim));

  // Simulate the tool-execution loop: executeTool's add_item pushes new
  // lines onto the SAME array object passed in (by reference) — exactly
  // what made the original `cartItems`-wired guard blind.
  cartItemsSim.push(
    { menu_item_id: "flatbread-cbr", name: "Chicken Bacon Ranch (Flatbreads)", quantity: 1 },
    { menu_item_id: "quesadilla-chicken", name: "Chicken (Quesadillas)", quantity: 1 },
    { menu_item_id: "ranch", name: "Ranch", quantity: 1 },
  );
  // Post-tool-call cart (index.ts's `guardCart`, re-read after the loop) —
  // same final content as the now-mutated cartItemsSim.
  const guardCartSim: TestCartLine[] = cartItemsSim;

  const result = computeGuard9(
    "Looks good",
    cartSnapshotBeforeTurnSim, // <-- the FIX: real "before" snapshot, untouched by the push() above
    guardCartSim,
    isNamedThisTurnPredicate("Looks good", LUCA_MENU),
  );

  assertEquals(result.tripped, true, "the fixed guard must trip under the real mutation shape");
  const phantomIds = result.phantomAdds.map(i => i.menu_item_id).sort();
  assertEquals(phantomIds, ["flatbread-cbr", "quesadilla-chicken", "ranch"]);
  assertEquals(result.qtyReverts.length, 0);
});

Deno.test("GUARD 9 (real fn, integration shape): reproduces the ORIGINAL bug when wired to the mutated array as 'before' (proves the fix matters)", () => {
  // Same simulated turn as above, but this time we deliberately reproduce
  // the broken wiring: pass the SAME mutated array as both the "before" the
  // guard reads AND the source that ends up mutated — exactly what
  // `cartItems` was doing in the shipped-then-reverted version.
  const cartItemsSim: TestCartLine[] = [
    { menu_item_id: "pizza-cbr", name: "Chicken Bacon Ranch", quantity: 1 },
    { menu_item_id: "wings", name: "Wings", quantity: 1 },
  ];

  cartItemsSim.push(
    { menu_item_id: "flatbread-cbr", name: "Chicken Bacon Ranch (Flatbreads)", quantity: 1 },
    { menu_item_id: "quesadilla-chicken", name: "Chicken (Quesadillas)", quantity: 1 },
    { menu_item_id: "ranch", name: "Ranch", quantity: 1 },
  );
  const guardCartSim: TestCartLine[] = cartItemsSim;

  const brokenResult = computeGuard9(
    "Looks good",
    cartItemsSim, // <-- the ORIGINAL BUG: "before" is the same mutated array as "after"
    guardCartSim,
    isNamedThisTurnPredicate("Looks good", LUCA_MENU),
  );

  assertEquals(brokenResult.tripped, false, "reproduces the original bug: identical before/after means delta is never > 0");
  assertEquals(brokenResult.phantomAdds.length, 0);
  assertEquals(brokenResult.qtyReverts.length, 0);
});

// ── Requirement 3: GUARD 4 v3 still detects/logs, but never talks ──────────

Deno.test("GUARD 4: still warns on an under-populated cart (detection/telemetry intact)", () => {
  assert(
    INDEX_SOURCE.includes("GUARD 4 ${mode} (under-populated cart) tripped"),
    "GUARD 4's detection console.warn must still exist",
  );
});

Deno.test("GUARD 4: the customer-facing upsell line is gone from index.ts (root cause of the P0)", () => {
  assertEquals(INDEX_SOURCE.includes("upsellLine"), false, "upsellLine must be fully removed, not just unused");
  assertEquals(
    /reply = `\$\{reply\}\\n\\n\$\{upsellLine\}`/.test(INDEX_SOURCE),
    false,
    "the append of an upsell line onto the customer-facing reply must not exist",
  );
});

// ── Requirement/backstop: GUARD 9 itself exists and is wired as documented ─

Deno.test("GUARD 9: exists in index.ts, keyed off impliesOrderConfirmation, and warns on trip", () => {
  assert(INDEX_SOURCE.includes("GUARD 9 (unconsented-add-on-affirmation)"), "GUARD 9 warn marker must exist");
  assert(/Guard 9: unconsented cart growth on a bare affirmation/.test(INDEX_SOURCE));
});

// ── Wiring regression guard (the QA-found bug specifically) ────────────────
// Extracts the GUARD 9 block from index.ts (from its section-header comment
// to the next guard's) and asserts the call site passes
// `cartSnapshotBeforeTurn` into computeGuard9 and does NOT feed it
// `cartItems`. This is the exact wiring mistake QA caught before ship: if it
// ever recurs, this test fails even though computeGuard9 itself (tested
// above) is correct in isolation.

function extractGuard9Block(source: string): string {
  const start = source.indexOf("// ── Guard 9: unconsented cart growth on a bare affirmation");
  assert(start !== -1, "GUARD 9 section header comment must exist in index.ts");
  const nextGuardMarker = "// ── Guard 2: order confirmation + no pickup name";
  const end = source.indexOf(nextGuardMarker, start);
  assert(end !== -1, "the guard following GUARD 9 must exist in index.ts (marker text may have moved)");
  return source.slice(start, end);
}

Deno.test("GUARD 9 wiring: index.ts's call site passes cartSnapshotBeforeTurn, not cartItems, as the before-cart", () => {
  const block = extractGuard9Block(INDEX_SOURCE);
  assert(
    /computeGuard9\(\s*userMessage,\s*cartSnapshotBeforeTurn,\s*guardCart,/.test(block),
    "GUARD 9 must call computeGuard9(userMessage, cartSnapshotBeforeTurn, guardCart, ...) — got:\n" + block,
  );
  // The historical bug: `cartItems` used as the before-snapshot. GUARD 9's
  // CODE (comments deliberately still name `cartItems` as a warning — strip
  // `//` line comments before checking) legitimately references `cartItems`
  // nowhere — that variable belongs to earlier correction/short-circuit
  // logic in the function, not to this guard.
  const codeOnly = block.split("\n").map(line => line.replace(/\/\/.*$/, "")).join("\n");
  assertEquals(
    /\bcartItems\b/.test(codeOnly),
    false,
    "GUARD 9's executable code must never reference `cartItems` — it is mutated in place and cannot answer 'what changed this turn'",
  );
});
