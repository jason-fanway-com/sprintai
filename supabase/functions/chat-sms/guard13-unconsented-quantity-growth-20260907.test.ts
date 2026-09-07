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

// ── Full-family phrase coverage (2026-09-07, Jason: "test each of these
// explicitly ... none may create a line or increase a quantity") ──────────
//
// computeGuard13 itself is message-text-agnostic — it only takes a boolean
// (isItemNamedThisTurn). The real risk this bug class lives in is index.ts's
// isNamedThisTurn13, which derives that boolean from buildMenuItemNames +
// extractCustomerReferencedItems (both already relied on by GUARD 9/10) —
// if either of those ever misclassified one of these ordinary phrases as
// "naming a menu item," GUARD 13 would wrongly skip the revert. These
// functions are copied verbatim from their CURRENT index.ts source (not
// reimplemented) — same convention as correction-buckets-20260906.test.ts —
// with a source-text regression check below so drift is caught, not missed.
const GENERIC_LAST_WORDS_MIRROR = new Set([
  "large", "medium", "small", "regular", "mini", "jumbo", "giant", "personal",
  "half", "whole", "single", "double", "triple", "side", "sides", "plain",
  "pizza", "pizzas", "pie", "pies", "roll", "rolls", "wrap", "wraps", "sub",
  "subs", "sandwich", "sandwiches", "salad", "salads", "soup", "soups",
  "platter", "platters", "combo", "combos", "special", "specials", "dinner",
  "lunch", "breakfast", "meal", "meals", "plate", "plates", "basket",
  "pieces", "piece", "order", "orders", "cup", "bowl", "slice", "slices",
]);

interface Guard13TestMenuItem { id: string; name: string; category?: string }

function buildMenuItemNamesMirror(menu: Guard13TestMenuItem[]): Map<string, string> {
  const names = new Map<string, string>();
  const nameCount = new Map<string, number>();
  for (const item of menu) {
    const full = item.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    nameCount.set(full, (nameCount.get(full) || 0) + 1);
  }
  const duplicateNames = new Set([...nameCount.entries()].filter(([, c]) => c > 1).map(([n]) => n));
  const wordItemCount = new Map<string, number>();
  for (const item of menu) {
    const words = new Set(item.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' '));
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

function extractCustomerReferencedItemsMirror(message: string, menuNames: Map<string, string>): Set<string> {
  const referenced = new Set<string>();
  const msg = message.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [key, displayName] of menuNames) {
    if (/^[a-f0-9-]{8,}$/.test(key)) continue;
    if (msg.includes(key)) referenced.add(displayName);
  }
  return referenced;
}

function isNamedThisTurnMirror(message: string, menu: Guard13TestMenuItem[]): (itemName: string) => boolean {
  const menuNames = buildMenuItemNamesMirror(menu);
  const namedThisTurn = extractCustomerReferencedItemsMirror(message, menuNames);
  return (itemName: string): boolean => {
    const itemLower = itemName.toLowerCase();
    return [...namedThisTurn].some(n => {
      const n2 = n.toLowerCase();
      return n2.includes(itemLower) || itemLower.includes(n2);
    });
  };
}

// A realistic menu shaped like Zio's, the shop this bug was found on —
// deliberately includes items whose names could plausibly collide with an
// innocuous word if the alias logic were looser than it is (Double Burger:
// "double" is a GENERIC_LAST_WORD and must never alias to it).
const REALISTIC_MENU: Guard13TestMenuItem[] = [
  { id: "bcp-1", name: "Buffalo Chicken Pizza", category: "Pizza" },
  { id: "sub-1", name: "Chicken Cheesesteak Sub", category: "Subs" },
  { id: "brg-1", name: "Double Burger", category: "Burgers" },
  { id: "can-1", name: "Cannoli", category: "Desserts" },
];

const PHRASES: Array<[string, string]> = [
  ["order type", "pickup"],
  ["order type", "delivery"],
  ["order type", "takeout"],
  ["order type", "for here"],
  ["order type", "to go"],
  ["affirmation", "yes"],
  ["affirmation", "sure"],
  ["affirmation", "ok"],
  ["affirmation", "sounds good"],
  ["affirmation", "that works"],
  ["affirmation", "looks good"],
  ["name answer", "John"],
];

for (const [category, phrase] of PHRASES) {
  Deno.test(`GUARD 13 family: "${phrase}" (${category}) never names an item and always reverts unconsented growth`, () => {
    const isNamed = isNamedThisTurnMirror(phrase, REALISTIC_MENU);
    // None of these phrases should resolve to ANY of the realistic menu's items.
    for (const item of REALISTIC_MENU) {
      assertEquals(isNamed(item.name), false, `"${phrase}" must not be read as naming ${item.name}`);
    }
    // And, combined with computeGuard13, growth on a pending line is reverted.
    const before = [{ ...PENDING_PIZZA }];
    const after = [{ ...PENDING_PIZZA, quantity: 2 }];
    const reverts = computeGuard13(before, after, isNamed);
    assertEquals(reverts.length, 1, `"${phrase}" must trigger a GUARD 13 revert`);
    assertEquals(reverts[0].priorQty, 1);
  });
}

Deno.test("GUARD 13 family: 'Double Burger' is never aliased to the bare word 'double' (GENERIC_LAST_WORDS)", () => {
  const isNamed = isNamedThisTurnMirror("double", REALISTIC_MENU);
  assertEquals(isNamed("Double Burger"), false);
});

Deno.test("GUARD 13 family: sanity check — the mirror DOES detect a real, deliberate item mention (control case)", () => {
  const isNamed = isNamedThisTurnMirror("another buffalo chicken pizza please", REALISTIC_MENU);
  assertEquals(isNamed("Buffalo Chicken Pizza"), true);
});

Deno.test("GUARD 13 family: buildMenuItemNames/extractCustomerReferencedItems mirrors match index.ts's current source (drift guard)", () => {
  assert(INDEX_SOURCE.includes("function buildMenuItemNames(menu: EffectiveMenuItem[]): Map<string, string> {"), "buildMenuItemNames signature moved or changed — update the mirror above");
  assert(INDEX_SOURCE.includes("function extractCustomerReferencedItems("), "extractCustomerReferencedItems signature moved or changed — update the mirror above");
  assert(INDEX_SOURCE.includes('const GENERIC_LAST_WORDS = new Set(['), "GENERIC_LAST_WORDS moved or changed — update the mirror above");
  assert(INDEX_SOURCE.includes('"double", "triple"'), "GENERIC_LAST_WORDS contents changed — update GENERIC_LAST_WORDS_MIRROR above");
});
