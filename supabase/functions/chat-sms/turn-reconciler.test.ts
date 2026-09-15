// Pins turn-reconciler.ts against the exact matrix the PO required
// (docs/DEFECT-CLASSES.md C1/C4) before this file replaced GUARD 9/13/20/21.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectUnitCompletionEvent,
  identityKey,
  parseExplicitQuantity,
  reconcileAddProposals,
  snapshotCartLines,
  sourcePhraseGroundedInWindow,
  writeCartLine,
  writeBundleLine,
  applyCartSnapshot,
  findCartLineIndexByIdentity,
  type ReconcilerCartLine,
} from "./turn-reconciler.ts";

// ── parseExplicitQuantity ────────────────────────────────────────────────
Deno.test("parseExplicitQuantity: 'two cokes' -> absolute 2", () => {
  assertEquals(parseExplicitQuantity("two cokes"), { kind: "absolute", value: 2 });
});
Deno.test("parseExplicitQuantity: 'a coke' -> no signal", () => {
  assertEquals(parseExplicitQuantity("add a coke"), null);
});
Deno.test("parseExplicitQuantity: 'yes' -> no signal", () => {
  assertEquals(parseExplicitQuantity("yes"), null);
});
Deno.test("parseExplicitQuantity: 'another one' -> relative +1", () => {
  assertEquals(parseExplicitQuantity("another one please"), { kind: "relative", delta: 1 });
});
Deno.test("parseExplicitQuantity: 'make it 3' -> absolute 3", () => {
  assertEquals(parseExplicitQuantity("make it 3"), { kind: "absolute", value: 3 });
});

// ── identityKey ───────────────────────────────────────────────────────────
Deno.test("identityKey: same id + same options in different order are identical", () => {
  const a = identityKey("pizza-1", { Toppings: ["Pepperoni", "Onion"] });
  const b = identityKey("pizza-1", { Toppings: ["Onion", "Pepperoni"] });
  assertEquals(a, b);
});
Deno.test("identityKey: different options are different identities", () => {
  const a = identityKey("pizza-1", { Toppings: ["Pepperoni"] });
  const b = identityKey("pizza-1", { Toppings: ["Mushroom"] });
  assertEquals(a === b, false);
});

// ── detectUnitCompletionEvent ─────────────────────────────────────────────
Deno.test("detectUnitCompletionEvent: brand-new complete line -> event", () => {
  const before = snapshotCartLines([]);
  const after: ReconcilerCartLine[] = [{ menu_item_id: "fries-1", quantity: 1 }];
  const event = detectUnitCompletionEvent(before, after, "fries-1");
  assertEquals(event, { menu_item_id: "fries-1", options: undefined });
});
Deno.test("detectUnitCompletionEvent: still-pending line -> no event yet", () => {
  const before = snapshotCartLines([]);
  const after: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", quantity: 1, pending_options: ["Size"] }];
  const event = detectUnitCompletionEvent(before, after, "pizza-1");
  assertEquals(event, null);
});
Deno.test("detectUnitCompletionEvent: continuation completes this call -> exactly one event", () => {
  const before = snapshotCartLines([{ menu_item_id: "pizza-1", quantity: 1, pending_options: ["Size"] }]);
  const after: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", quantity: 1, options: { Size: ["Medium"] } }];
  const event = detectUnitCompletionEvent(before, after, "pizza-1");
  assertEquals(event, { menu_item_id: "pizza-1", options: { Size: ["Medium"] } });
});
Deno.test("detectUnitCompletionEvent: merge-into-existing-complete-line bumps qty -> event", () => {
  const before = snapshotCartLines([{ menu_item_id: "pizza-1", quantity: 1, options: { Size: ["Medium"] } }]);
  const after: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", quantity: 2, options: { Size: ["Medium"] } }];
  const event = detectUnitCompletionEvent(before, after, "pizza-1");
  assertEquals(event, { menu_item_id: "pizza-1", options: { Size: ["Medium"] } });
});
Deno.test("detectUnitCompletionEvent: true no-op (fullyResolvedExistingIdx branch) -> null", () => {
  const before = snapshotCartLines([{ menu_item_id: "pizza-1", quantity: 1, options: { Size: ["Medium"] } }]);
  const after: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", quantity: 1, options: { Size: ["Medium"] } }];
  const event = detectUnitCompletionEvent(before, after, "pizza-1");
  assertEquals(event, null);
});
Deno.test("detectUnitCompletionEvent: pending line qty grew while still pending -> event (Guard 13 shape)", () => {
  // Model re-issued add_item on an unrelated turn ("pickup") while a required
  // option was still open, bumping qty from 1 to 2. Must emit a proposal so
  // the reconciler's idempotency rule can revert the qty.
  const before = snapshotCartLines([{ menu_item_id: "pizza-1", quantity: 1, pending_options: ["Size"] }]);
  const after: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", quantity: 2, pending_options: ["Size"] }];
  const event = detectUnitCompletionEvent(before, after, "pizza-1");
  assertEquals(event, { menu_item_id: "pizza-1", options: undefined });
});
Deno.test("detectUnitCompletionEvent: pending line unchanged -> null (no spurious proposal)", () => {
  const before = snapshotCartLines([{ menu_item_id: "pizza-1", quantity: 1, pending_options: ["Size"] }]);
  const after: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", quantity: 1, pending_options: ["Size"] }];
  const event = detectUnitCompletionEvent(before, after, "pizza-1");
  assertEquals(event, null);
});

// ── reconcileAddProposals — the acceptance-matrix scenarios ───────────────

Deno.test("reconciler: three 'accept' proposals for the same new item collapse to qty 1, not 3", () => {
  const pre: ReconcilerCartLine[] = [];
  // Loop's own incremental merging already pushed this to qty 3 by the time
  // the turn ends — reproduces the exact bug shape.
  const loopFinal: ReconcilerCartLine[] = [{ menu_item_id: "reg-1", quantity: 3 }];
  const proposals = [
    { menu_item_id: "reg-1", options: undefined, source_phrase: "yes", grounded: true },
    { menu_item_id: "reg-1", options: undefined, source_phrase: "yes", grounded: true },
    { menu_item_id: "reg-1", options: undefined, source_phrase: "yes", grounded: true },
  ];
  const { cart, changes } = reconcileAddProposals(pre, loopFinal, proposals, "yes");
  assertEquals(cart.find(l => l.menu_item_id === "reg-1")?.quantity, 1);
  assertEquals(changes[0].action, "added");
  assertEquals(changes[0].qty, 1);
});

Deno.test("reconciler: model AND deterministic shortcut both propose the same item once each -> qty 1", () => {
  const pre: ReconcilerCartLine[] = [];
  const loopFinal: ReconcilerCartLine[] = [{ menu_item_id: "reg-1", quantity: 2 }];
  const proposals = [
    { menu_item_id: "reg-1", options: undefined, source_phrase: "", grounded: true }, // C2b-regular shortcut
    { menu_item_id: "reg-1", options: undefined, source_phrase: "yes also the usual", grounded: true }, // model's own call
  ];
  const { cart } = reconcileAddProposals(pre, loopFinal, proposals, "yes also the usual");
  assertEquals(cart.find(l => l.menu_item_id === "reg-1")?.quantity, 1);
});

Deno.test("reconciler: re-confirming an item already in preTurnCart is a quantity no-op by default", () => {
  const pre: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", quantity: 1 }];
  const loopFinal: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", quantity: 3 }]; // loop over-grew it
  const proposals = [
    { menu_item_id: "pizza-1", options: undefined, source_phrase: "yes", grounded: true },
    { menu_item_id: "pizza-1", options: undefined, source_phrase: "yes", grounded: true },
  ];
  const { cart, changes } = reconcileAddProposals(pre, loopFinal, proposals, "yes");
  assertEquals(cart.find(l => l.menu_item_id === "pizza-1")?.quantity, 1);
  assertEquals(changes[0].action, "noop_reconfirm");
});

Deno.test("reconciler: re-confirming with an explicit 'two' in the text grows quantity to 2, not summed/multiplied", () => {
  const pre: ReconcilerCartLine[] = [{ menu_item_id: "coke-1", quantity: 1 }];
  const loopFinal: ReconcilerCartLine[] = [{ menu_item_id: "coke-1", quantity: 1 }];
  const proposals = [
    { menu_item_id: "coke-1", options: undefined, source_phrase: "two cokes", grounded: true },
  ];
  const { cart, changes } = reconcileAddProposals(pre, loopFinal, proposals, "yep, and two cokes");
  assertEquals(cart.find(l => l.menu_item_id === "coke-1")?.quantity, 2);
  assertEquals(changes[0].action, "qty_set");
});

Deno.test("reconciler: 'two cokes' in a multi-item turn doesn't bleed onto the other item's quantity", () => {
  const pre: ReconcilerCartLine[] = [];
  const loopFinal: ReconcilerCartLine[] = [
    { menu_item_id: "reg-1", quantity: 1 }, // the regular, accepted plainly
    { menu_item_id: "coke-1", quantity: 1 },
  ];
  const proposals = [
    { menu_item_id: "reg-1", options: undefined, source_phrase: "", grounded: true },
    { menu_item_id: "coke-1", options: undefined, source_phrase: "two cokes", grounded: true },
  ];
  const { cart } = reconcileAddProposals(pre, loopFinal, proposals, "yep, and two cokes");
  assertEquals(cart.find(l => l.menu_item_id === "reg-1")?.quantity, 1);
  assertEquals(cart.find(l => l.menu_item_id === "coke-1")?.quantity, 2);
});

Deno.test("reconciler: ungrounded brand-new proposal is dropped, not silently added", () => {
  const pre: ReconcilerCartLine[] = [];
  const loopFinal: ReconcilerCartLine[] = [{ menu_item_id: "upsell-1", quantity: 1 }];
  const proposals = [
    { menu_item_id: "upsell-1", options: undefined, source_phrase: "yes", grounded: false },
  ];
  const { cart, changes } = reconcileAddProposals(pre, loopFinal, proposals, "yes");
  assertEquals(cart.find(l => l.menu_item_id === "upsell-1"), undefined);
  assertEquals(changes[0].action, "dropped_unauthorized");
});

Deno.test("reconciler: completing a pre-turn PENDING line's required option ('medium' answering Temp) is a continuation, never an unauthorized drop", () => {
  // 2026-09-14 live canary failure: "cheeseburger" (turn 1) leaves a
  // pending line (Temp still open); "medium" (turn 2) completes it via
  // add_item's own continuation path, so the proposal's options are now
  // Temp:Medium — which never matches the pre-turn line's (empty) options
  // by full identity — while "medium" alone names no menu item, so
  // `grounded` is false. Before the fix this deleted the entire line.
  const pre: ReconcilerCartLine[] = [
    { menu_item_id: "burger-1", quantity: 1, pending_options: ["Temp"] },
  ];
  const loopFinal: ReconcilerCartLine[] = [
    { menu_item_id: "burger-1", quantity: 1, options: { Temp: ["Medium"] }, pending_options: [] },
  ];
  const proposals = [
    { menu_item_id: "burger-1", options: { Temp: ["Medium"] }, source_phrase: "cheeseburger medium", grounded: false },
  ];
  const { cart, changes } = reconcileAddProposals(pre, loopFinal, proposals, "medium");
  assertEquals(cart.find(l => l.menu_item_id === "burger-1")?.quantity, 1);
  assertEquals(cart.find(l => l.menu_item_id === "burger-1")?.options, { Temp: ["Medium"] });
  assertEquals(changes[0].action, "noop_reconfirm");
});

Deno.test("reconciler: a pre-turn line that exists under a DIFFERENT (non-pending, already-resolved) option state is authorized, never dropped as a phantom", () => {
  // PO addendum (2026-09-14, 3 live error_log captures): groundedness is
  // judged only against THIS turn's own text, so any turn that doesn't
  // re-name the item ("thats it") looks ungrounded even when the item has
  // existed since an earlier turn. The pending-fallback above only covers
  // the "still has an open required slot" shape; it misses a line that was
  // already fully resolved pre-turn and then had its options changed
  // earlier in the SAME turn (e.g. a topping added by modify_item), which
  // shifts its identity key away from both preIndex's full-identity match
  // and prePendingByMenuItemId (pending_options is empty on both sides).
  // Any pre-turn line sharing menu_item_id, in any option state, is
  // authorized — the asymmetry is that keeping an unrequested line is
  // visible and correctable, silently deleting a requested one is not.
  const pre: ReconcilerCartLine[] = [
    { menu_item_id: "burger-1", quantity: 1, options: { Toppings: ["Lettuce"] }, pending_options: [] },
  ];
  const loopFinal: ReconcilerCartLine[] = [
    { menu_item_id: "burger-1", quantity: 1, options: { Toppings: ["Lettuce", "Tomato"] }, pending_options: [] },
  ];
  const proposals = [
    { menu_item_id: "burger-1", options: { Toppings: ["Lettuce", "Tomato"] }, source_phrase: "burger", grounded: false },
  ];
  const { cart, changes } = reconcileAddProposals(pre, loopFinal, proposals, "thats it");
  assertEquals(cart.find(l => l.menu_item_id === "burger-1")?.quantity, 1);
  assertEquals(cart.find(l => l.menu_item_id === "burger-1")?.options, { Toppings: ["Lettuce", "Tomato"] });
  assertEquals(changes[0].action, "noop_reconfirm");
});

Deno.test("reconciler: a grounded add (fries named this turn) passes through untouched with a single proposal", () => {
  const pre: ReconcilerCartLine[] = [];
  const loopFinal: ReconcilerCartLine[] = [{ menu_item_id: "fries-1", quantity: 1 }];
  const proposals = [
    { menu_item_id: "fries-1", options: undefined, source_phrase: "add fries", grounded: true },
  ];
  const { cart, changes } = reconcileAddProposals(pre, loopFinal, proposals, "Yes to Jason. Can you add fries to that?");
  assertEquals(cart.find(l => l.menu_item_id === "fries-1")?.quantity, 1);
  assertEquals(changes[0].action, "added");
});

// (2026-09-13) The two tests that used to live here ("two/three SEPARATE
// array entries for the same identity collapse to ONE line") pinned
// reconcileAddProposals's array-wide dedup backstop — deleted the same day
// this file's writeCartLine/applyCartSnapshot were added. That backstop only
// ever cleaned up AFTER multiple writers produced duplicate-identity lines;
// with writeCartLine as the sole writer, duplicate array entries for one
// identity can no longer be produced in the first place, so there is
// nothing left to collapse. The equivalent guarantee now lives at the
// source — see the writeCartLine idempotency tests below, and the
// structural enforcement test in enforce-single-cart-writer.test.ts.

Deno.test("reconciler: lines with no proposals this turn pass through completely untouched", () => {
  const pre: ReconcilerCartLine[] = [{ menu_item_id: "salad-1", quantity: 1, options: { Dressing: ["Ranch"] } }];
  const loopFinal: ReconcilerCartLine[] = [{ menu_item_id: "salad-1", quantity: 1, options: { Dressing: ["Ranch"] } }];
  const { cart, changes } = reconcileAddProposals(pre, loopFinal, [], "what are your hours?");
  assertEquals(cart, loopFinal);
  assertEquals(changes.length, 0);
});

// ── writeCartLine — the single-writer guarantee at its source ────────────

Deno.test("writeCartLine: brand-new identity pushes exactly one line at the requested quantity", () => {
  const cart: ReconcilerCartLine[] = [];
  const result = writeCartLine(cart, {
    menu_item_id: "pizza-1", name: "Large Pepperoni Pizza", price_cents: 2100, quantity: 1, source: "legacy",
  });
  assertEquals(result.action, "created");
  assertEquals(cart.length, 1);
  assertEquals(cart[0].quantity, 1);
});

Deno.test("writeCartLine: calling it TWICE for the identical identity in one turn never creates a second array entry — this is the structural fix for the shape-mismatch $42 defect", () => {
  const cart: ReconcilerCartLine[] = [];
  // First writer (what used to be the legacy push): name=menuItem.name, no ask_plan_selections.
  writeCartLine(cart, { menu_item_id: "pizza-1", name: "Cheese - Large (16\")", price_cents: 2100, quantity: 1, source: "legacy" });
  // Second writer (what used to be the compiled push): DIFFERENT name, ask_plan_selections present.
  // Both target the SAME menu_item_id + options — one function, one identity rule, so this must
  // land on the SAME array entry, not spawn a second one.
  const result = writeCartLine(cart, {
    menu_item_id: "pizza-1", name: "Large Cheese Pizza", price_cents: 2100, quantity: 1,
    ask_plan_selections: { g1: "c1" }, source: "compiled",
  });
  assertEquals(cart.length, 1);
  assertEquals(cart[0].quantity, 1);
  assertEquals(result.action, "merged_noop");
});

Deno.test("writeCartLine: re-writing an existing identity with no explicitQuantity is a no-op on quantity (never additive)", () => {
  const cart: ReconcilerCartLine[] = [{ menu_item_id: "reg-1", name: "Regular", price_cents: 500, quantity: 1 } as ReconcilerCartLine];
  const result = writeCartLine(cart, { menu_item_id: "reg-1", name: "Regular", price_cents: 500, quantity: 1, source: "legacy" });
  assertEquals(cart.length, 1);
  assertEquals(cart[0].quantity, 1);
  assertEquals(result.action, "merged_noop");
});

Deno.test("writeCartLine: explicitQuantity (customer's own words) is the only thing that grows an existing line", () => {
  const cart: ReconcilerCartLine[] = [{ menu_item_id: "coke-1", name: "Coke", price_cents: 200, quantity: 1 } as ReconcilerCartLine];
  const result = writeCartLine(cart, {
    menu_item_id: "coke-1", name: "Coke", price_cents: 200, quantity: 1,
    explicitQuantity: { kind: "absolute", value: 2 }, source: "legacy",
  });
  assertEquals(cart.length, 1);
  assertEquals(cart[0].quantity, 2);
  assertEquals(result.action, "qty_grown");
});

Deno.test("writeCartLine: a RELATIVE explicitQuantity called N times against an existing line is a no-op every time — PO 2026-09-13 x15/$331.50 live incident", () => {
  // The model called add_item ~15 times in one turn for the same line, and
  // the caller re-derived the SAME relative delta from the turn's text on
  // every single call. An unconditional `preQty + delta` merge branch
  // restacked once per call (1 -> 16, $331.50) instead of once per turn.
  // Fix: relative deltas are no longer legal input to writeCartLine's merge
  // path at all — a caller must resolve to an absolute target BEFORE
  // calling (see index.ts's preTurnCartForIdentity). This test simulates
  // the OLD failure mode directly (passing "relative" straight through) and
  // asserts it is now inert: quantity must never move from a repeated
  // relative call, whether the identity is matched by continuationIndex or
  // by ordinary identity lookup.
  const cart: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", name: "Pizza", price_cents: 1500, quantity: 1 } as ReconcilerCartLine];
  for (let i = 0; i < 15; i++) {
    writeCartLine(cart, {
      menu_item_id: "pizza-1", name: "Pizza", price_cents: 1500, quantity: 1,
      explicitQuantity: { kind: "relative", delta: 1 }, source: "legacy",
    });
  }
  assertEquals(cart.length, 1);
  assertEquals(cart[0].quantity, 1);
});

Deno.test("writeCartLine: a RELATIVE explicitQuantity called N times via continuationIndex is also a no-op every time", () => {
  const cart: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", name: "Pizza", price_cents: 1500, quantity: 1, pending_options: ["Size"] } as ReconcilerCartLine];
  for (let i = 0; i < 15; i++) {
    writeCartLine(cart, {
      menu_item_id: "pizza-1", name: "Pizza", price_cents: 1500,
      explicitQuantity: { kind: "relative", delta: 1 }, continuationIndex: 0, source: "legacy",
    });
  }
  assertEquals(cart.length, 1);
  assertEquals(cart[0].quantity, 1);
});

Deno.test("writeCartLine: modifiers/unverified_requests distinguish identity so a plain vs. topped line never merges (D1 2026-09-09 guarantee, preserved)", () => {
  const cart: ReconcilerCartLine[] = [];
  writeCartLine(cart, { menu_item_id: "pizza-1", name: "Pizza", price_cents: 1500, quantity: 1, source: "legacy" });
  writeCartLine(cart, {
    menu_item_id: "pizza-1", name: "Pizza", price_cents: 1500, quantity: 1,
    unverified_requests: ["extra cheese"], source: "legacy",
  });
  assertEquals(cart.length, 2);
});

Deno.test("writeCartLine: quantityOnly never creates a line for a missing identity", () => {
  const cart: ReconcilerCartLine[] = [];
  const result = writeCartLine(cart, { menu_item_id: "ghost-1", quantityOnly: true, forceQuantity: 5, source: "reconciler" });
  assertEquals(cart.length, 0);
  assertEquals(result, { index: -1, action: "noop_missing" });
});

Deno.test("writeCartLine: continuationIndex updates the target line in place without touching quantity by default", () => {
  const cart: ReconcilerCartLine[] = [
    { menu_item_id: "pizza-1", name: "Pizza", price_cents: 1500, quantity: 1, pending_options: ["Size"] } as ReconcilerCartLine,
  ];
  writeCartLine(cart, {
    menu_item_id: "pizza-1", name: "Pizza", price_cents: 1800, quantity: 1,
    options: { Size: ["Large"] }, pending_options: [], continuationIndex: 0, source: "legacy",
  });
  assertEquals(cart.length, 1);
  assertEquals(cart[0].quantity, 1);
  assertEquals(cart[0].options, { Size: ["Large"] });
  assertEquals(cart[0].price_cents, 1800);
});

Deno.test("writeBundleLine: appends a bundle container line", () => {
  const cart: ReconcilerCartLine[] = [];
  const result = writeBundleLine(cart, { name: "Dozen Donuts", target: 12, price_cents: 1500, source: "bundle" });
  assertEquals(cart.length, 1);
  assertEquals(result.action, "created");
  assertEquals((cart[0] as unknown as { type: string }).type, "bundle");
});

Deno.test("applyCartSnapshot: replaces array contents in place (same reference, new contents) — used for GUARD 19's full-turn revert", () => {
  const cart: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", quantity: 3 }];
  const snapshot: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", quantity: 1 }];
  const ref = cart;
  applyCartSnapshot(cart, snapshot);
  assertEquals(cart, ref); // still the same array object
  assertEquals(cart, [{ menu_item_id: "pizza-1", quantity: 1 }]);
});

Deno.test("findCartLineIndexByIdentity: pure read, never mutates", () => {
  const cart: ReconcilerCartLine[] = [{ menu_item_id: "pizza-1", quantity: 1, options: { Size: ["Large"] } }];
  const idx = findCartLineIndexByIdentity(cart, "pizza-1", { Size: ["Large"] });
  assertEquals(idx, 0);
  assertEquals(cart.length, 1);
  assertEquals(findCartLineIndexByIdentity(cart, "pizza-1", { Size: ["Medium"] }), -1);
});

// ── Canary: $8.49 item + $0.99 service fee = $9.48, single line, no dup ──
// This is the structural guarantee writeCartLine provides: calling it twice
// with the same identity is a no-op on quantity (idempotent). The total
// ($8.49 subtotal + $0.99 SERVICE_FEE_CENTS) must equal $9.48.
// Keeps any regression that reintroduces a duplicate-line writer visible at
// the unit level before it reaches a real customer.
Deno.test("writeCartLine canary: $8.49 item is idempotent — single line, never doubles to $16.98", () => {
  const SERVICE_FEE_CENTS = 99;
  const ITEM_PRICE_CENTS = 849;
  const cart: ReconcilerCartLine[] = [];
  // First add: creates the line.
  writeCartLine(cart, { menu_item_id: "cheeseburger-id", name: "Cheese Burger", price_cents: ITEM_PRICE_CENTS, quantity: 1, source: "legacy" });
  assertEquals(cart.length, 1, "one line after first add");
  assertEquals(cart[0].price_cents as number, ITEM_PRICE_CENTS);
  assertEquals(cart[0].quantity as number, 1);
  // Second call with same identity (no explicit quantity): must be no-op.
  writeCartLine(cart, { menu_item_id: "cheeseburger-id", name: "Cheese Burger", price_cents: ITEM_PRICE_CENTS, quantity: 1, source: "legacy" });
  assertEquals(cart.length, 1, "still one line — second add must not create a duplicate");
  assertEquals(cart[0].quantity as number, 1, "quantity unchanged — no silent doubling");
  // Total: subtotal + service fee = $9.48.
  const subtotalCents = cart.reduce((s, l) => s + (l.price_cents as number) * (l.quantity as number), 0);
  assertEquals(subtotalCents, ITEM_PRICE_CENTS, "$8.49 subtotal — not doubled");
  assertEquals(subtotalCents + SERVICE_FEE_CENTS, 948, "$8.49 + $0.99 service fee = $9.48 total");
});

// ── sourcePhraseGroundedInWindow (item G/H, cross-turn phrase synthesis) ──
// Pins the exact live canary shape: "cheeseburger" on turn N, "medium" on
// turn N+1, synthesized by the model into source_phrase "cheeseburger
// medium" on a LATER turn whose own text is neither word.
Deno.test("sourcePhraseGroundedInWindow: real exact live repro — 'cheeseburger medium' traces across two prior customer turns", () => {
  assertEquals(
    sourcePhraseGroundedInWindow("cheeseburger medium", ["cheeseburger", "medium", "thats it"]),
    true,
  );
});

Deno.test("sourcePhraseGroundedInWindow: a hallucinated phrase with no real customer word behind it still fails — not loosened into 'authorize anything'", () => {
  assertEquals(
    sourcePhraseGroundedInWindow("large pepperoni pizza", ["cheeseburger", "medium", "thats it"]),
    false,
  );
});

Deno.test("sourcePhraseGroundedInWindow: partial overlap (only one of two words said) still fails — every token must be real", () => {
  assertEquals(
    sourcePhraseGroundedInWindow("cheeseburger large", ["cheeseburger", "medium", "thats it"]),
    false,
  );
});

Deno.test("sourcePhraseGroundedInWindow: empty source_phrase never authorizes", () => {
  assertEquals(sourcePhraseGroundedInWindow("", ["cheeseburger", "medium"]), false);
});

Deno.test("sourcePhraseGroundedInWindow: single contiguous-turn phrase still matches (no regression on the common case)", () => {
  assertEquals(sourcePhraseGroundedInWindow("large pepperoni pizza", ["i want a large pepperoni pizza"]), true);
});

Deno.test("sourcePhraseGroundedInWindow: short filler words (<3 chars) are not required to match, so 'a'/'is' can't be gamed either way", () => {
  // "medium" is real; the short word "a" isn't checked — but the real word still is.
  assertEquals(sourcePhraseGroundedInWindow("a medium", ["medium"]), true);
});
