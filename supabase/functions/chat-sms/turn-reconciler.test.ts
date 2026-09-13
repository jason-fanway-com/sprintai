// Pins turn-reconciler.ts against the exact matrix the PO required
// (docs/DEFECT-CLASSES.md C1/C4) before this file replaced GUARD 9/13/20/21.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectUnitCompletionEvent,
  identityKey,
  parseExplicitQuantity,
  reconcileAddProposals,
  snapshotCartLines,
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

Deno.test("reconciler: lines with no proposals this turn pass through completely untouched", () => {
  const pre: ReconcilerCartLine[] = [{ menu_item_id: "salad-1", quantity: 1, options: { Dressing: ["Ranch"] } }];
  const loopFinal: ReconcilerCartLine[] = [{ menu_item_id: "salad-1", quantity: 1, options: { Dressing: ["Ranch"] } }];
  const { cart, changes } = reconcileAddProposals(pre, loopFinal, [], "what are your hours?");
  assertEquals(cart, loopFinal);
  assertEquals(changes.length, 0);
});
