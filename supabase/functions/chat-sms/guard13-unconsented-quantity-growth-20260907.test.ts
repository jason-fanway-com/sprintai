// BUG (2026-09-07, Jason, confirmed live against Zio's, session
// zios-bug3-repro-6-512ad83d-3be0-48d5-bc50-316e058a8d6e): turn 1 "large
// buffalo chicken pizza" -> cart qty=1, $19.99; turn 2 "pickup" (a single,
// non-retried message, nothing to do with the pizza or its options) -> cart
// qty=2, $19.99 — the same unit price silently doubled. Reproduced 1 of 5
// times in manual testing (intermittent — depends on whether the model
// happens to reissue add_item that turn), but real, and it silently doubles
// the charge if it reaches checkout. See guard13-unconsented-quantity-growth.ts
// for the full root-cause writeup.
//
// index.ts calls Deno.serve() at module scope, so it is never imported
// directly by tests (same constraint as every other *.test.ts file in this
// directory). This file imports and tests the REAL decision function
// (computeGuard13), not a hand-copied mirror — GUARD 9's own history in this
// codebase is the reason why: its first version was wired to the wrong
// "before" snapshot, and a test that mirrored the diff logic against clean,
// independently-built inputs stayed green through that bug. The wiring
// regression test at the bottom of this file guards against the same class
// of mistake here.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeGuard13, type Guard13CartLine } from "./guard13-unconsented-quantity-growth.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

// A trivial "was this item named in the message" predicate for tests —
// GUARD 13 takes this as an external parameter (mirroring GUARD 9's shape),
// so the pure decision core can be tested without index.ts's real menu-name
// matching machinery.
function namedPredicate(namedItems: string[]): (itemName: string) => boolean {
  const lower = namedItems.map(n => n.toLowerCase());
  return (itemName: string) => lower.includes(itemName.toLowerCase());
}

const PENDING_PIZZA: Guard13CartLine = {
  menu_item_id: "bcp-1",
  name: "Buffalo Chicken Pizza",
  quantity: 1,
  options: undefined,
  pending_options: ["Choose an option"],
};

Deno.test("computeGuard13: the exact repro — qty grew, options unchanged, item not named -> reverts", () => {
  const before = [{ ...PENDING_PIZZA }];
  const after = [{ ...PENDING_PIZZA, quantity: 2 }];
  const reverts = computeGuard13(before, after, namedPredicate([]));
  assertEquals(reverts.length, 1);
  assertEquals(reverts[0].priorQty, 1);
  assertEquals(reverts[0].item, after[0]);
});

Deno.test("computeGuard13: options actually changed this turn (a real resolution) -> never reverts", () => {
  const before = [{ ...PENDING_PIZZA }];
  const after = [{
    ...PENDING_PIZZA,
    quantity: 2,
    options: { "Choose an option": ["Large 18''"] },
    pending_options: undefined,
  }];
  const reverts = computeGuard13(before, after, namedPredicate([]));
  assertEquals(reverts.length, 0);
});

Deno.test("computeGuard13: customer named the item this turn -> never reverts (could be a genuine second order)", () => {
  const before = [{ ...PENDING_PIZZA }];
  const after = [{ ...PENDING_PIZZA, quantity: 2 }];
  const reverts = computeGuard13(before, after, namedPredicate(["Buffalo Chicken Pizza"]));
  assertEquals(reverts.length, 0);
});

Deno.test("computeGuard13: no quantity growth -> never reverts", () => {
  const before = [{ ...PENDING_PIZZA }];
  const after = [{ ...PENDING_PIZZA }];
  const reverts = computeGuard13(before, after, namedPredicate([]));
  assertEquals(reverts.length, 0);
});

Deno.test("computeGuard13: line was NOT pending before this turn -> never reverts (ordinary add path)", () => {
  const settled: Guard13CartLine = { menu_item_id: "burger-1", name: "Cheeseburger", quantity: 1, options: { Temp: ["Medium"] }, pending_options: undefined };
  const before = [{ ...settled }];
  const after = [{ ...settled, quantity: 2 }];
  const reverts = computeGuard13(before, after, namedPredicate([]));
  assertEquals(reverts.length, 0);
});

Deno.test("computeGuard13: brand-new line this turn (not present before) -> never reverts", () => {
  const before: Guard13CartLine[] = [];
  const after = [{ ...PENDING_PIZZA }];
  const reverts = computeGuard13(before, after, namedPredicate([]));
  assertEquals(reverts.length, 0);
});

Deno.test("computeGuard13: two pending lines, only one grows unconsented -> only that one reverts", () => {
  const otherPending: Guard13CartLine = { menu_item_id: "sub-1", name: "Chicken Cheesesteak Sub", quantity: 1, options: undefined, pending_options: ["Choose an option"] };
  const before = [{ ...PENDING_PIZZA }, { ...otherPending }];
  const after = [{ ...PENDING_PIZZA, quantity: 2 }, { ...otherPending }];
  const reverts = computeGuard13(before, after, namedPredicate([]));
  assertEquals(reverts.length, 1);
  assertEquals(reverts[0].item.name, "Buffalo Chicken Pizza");
});

// ── Wiring regression guard (mirrors GUARD 9's own precedent test) ─────────

Deno.test("GUARD 13: exists in index.ts and warns on trip", () => {
  assert(INDEX_SOURCE.includes("GUARD 13 (unconsented quantity growth on pending item)"), "GUARD 13 warn marker must exist");
  assert(/Guard 13 \(2026-09-07, Jason: quantity-doubling/.test(INDEX_SOURCE));
});

function extractGuard13Block(source: string): string {
  const start = source.indexOf("// ── Guard 13 (2026-09-07, Jason: quantity-doubling");
  assert(start !== -1, "GUARD 13 section header comment must exist in index.ts");
  const nextGuardMarker = "// ── Guard (menu link): send the live menu page";
  const end = source.indexOf(nextGuardMarker, start);
  assert(end !== -1, "the guard following GUARD 13 must exist in index.ts (marker text may have moved)");
  return source.slice(start, end);
}

Deno.test("GUARD 13 wiring: index.ts's call site passes cartSnapshotBeforeTurn, not cartItems, as the before-cart", () => {
  const block = extractGuard13Block(INDEX_SOURCE);
  assert(
    /computeGuard13\(\s*cartSnapshotBeforeTurn,\s*guardCart,/.test(block),
    "GUARD 13 must call computeGuard13(cartSnapshotBeforeTurn, guardCart, ...) — got:\n" + block,
  );
  const codeOnly = block.split("\n").map(line => line.replace(/\/\/.*$/, "")).join("\n");
  assertEquals(
    /\bcartItems\b/.test(codeOnly),
    false,
    "GUARD 13's executable code must never reference `cartItems` — it is mutated in place and cannot answer 'what changed this turn'",
  );
});
