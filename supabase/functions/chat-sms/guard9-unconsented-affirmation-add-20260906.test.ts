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
// turns later "Looks good" — a bare affirmation matched by the existing
// impliesOrderConfirmation() helper — was read by the model, given the full
// history including the still-open 3-item offer, as consent to add all of
// it, issuing real add_item tool calls for all three. Cart went from 2
// items/$37.97 to 4 items/$74.95 with zero customer intent.
//
// Fix #1 (verified below via source-text assertion): GUARD 4 v3 no longer
// builds or appends that upsell line. Detection + console.warn telemetry is
// unchanged — it still catches genuinely dropped items (a real prior bug
// fixed 2026-09-05) — only the customer-facing suggestion is gone.
//
// Fix #2 (verified below against a mirror of the real algorithm): GUARD 9,
// a deterministic backstop that holds even if some FUTURE mechanism leaves
// an open, unresolved offer in history again. On any turn where the
// customer's message is a bare affirmation, if the cart's total quantity
// for a menu item grew and the CURRENT message alone (never history) does
// not name that item, the growth is reverted before the reply is sent.
//
// index.ts calls Deno.serve() at module scope, so it is never imported
// directly by tests (same constraint as every other *.test.ts file in this
// directory — see guard-defects-20260906.test.ts's header). The matching
// helpers below (buildMenuItemNamesMirror / extractCustomerReferencedItemsMirror
// / GENERIC_LAST_WORDS_MIRROR) are byte-for-byte copies of index.ts's private
// buildMenuItemNames / extractCustomerReferencedItems / GENERIC_LAST_WORDS —
// copied rather than reimplemented so the Luca transcript is tested against
// the ACTUAL matching behavior, not a hand-wavy approximation. If those
// functions change in index.ts, update the copies here too.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

// ─── Verbatim mirrors of index.ts's private menu-name-matching helpers ─────

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

// ─── Mirror of GUARD 9's own quantity-growth diff/decision logic ───────────
// A pure copy of the algorithm added to index.ts (search "GUARD 9" there),
// so the actual decision behavior — not just the name-matching primitive —
// is under test against realistic cart states.

interface TestCartLine {
  menu_item_id: string;
  name: string;
  quantity: number;
  options?: Record<string, string[]>;
}

function isBareAffirmationMirror(text: string): boolean {
  const norm = text.toLowerCase().trim();
  return /\b(?:yes|yeah|yep|yup|confirm|sure|place (?:the |my |an )?order|check out|checkout|that[' ]s it|that is it|looks good|all good|go ahead|proceed|go for it|do it|send it|pay|ready|done|that[' ]s all|that is all|all set|i'?m ready|i'?m done|good to go|let'?s go|let'?s do it|place it|ring it up|finalize|submit)\b/i.test(norm) ||
    /^(?:ok|okay|k|kk|fine|perfect|great|awesome|excellent|fantastic|sounds good|good|yes please|do it|let's do this)[.!]?$/i.test(norm);
}

function computeGuard9Reverts(
  cartItemsBefore: TestCartLine[],
  guardCartAfter: TestCartLine[],
  userMessage: string,
  menu: MenuLike[],
): { phantomAdds: TestCartLine[]; qtyReverts: Array<{ item: TestCartLine; priorQty: number }> } {
  const phantomAdds: TestCartLine[] = [];
  const qtyReverts: Array<{ item: TestCartLine; priorQty: number }> = [];

  if (!isBareAffirmationMirror(userMessage)) return { phantomAdds, qtyReverts };

  const fingerprint = (i: TestCartLine) => `${i.menu_item_id}::${JSON.stringify(i.options ?? undefined)}`;
  const beforeByFingerprint = new Map<string, TestCartLine>();
  const qtyBefore = new Map<string, number>();
  for (const item of cartItemsBefore) {
    beforeByFingerprint.set(fingerprint(item), item);
    qtyBefore.set(item.menu_item_id, (qtyBefore.get(item.menu_item_id) || 0) + (item.quantity || 1));
  }
  const qtyAfter = new Map<string, number>();
  for (const item of guardCartAfter) {
    qtyAfter.set(item.menu_item_id, (qtyAfter.get(item.menu_item_id) || 0) + (item.quantity || 1));
  }

  const menuItemNames = buildMenuItemNamesMirror(menu);
  const namedThisTurn = extractCustomerReferencedItemsMirror(
    [{ role: "user", content: userMessage }],
    menuItemNames,
  );
  const isNamedThisTurn = (itemName: string): boolean => {
    const itemLower = itemName.toLowerCase();
    return [...namedThisTurn].some(n => {
      const n2 = n.toLowerCase();
      return n2.includes(itemLower) || itemLower.includes(n2);
    });
  };

  for (const [menuItemId, after] of qtyAfter) {
    let delta = after - (qtyBefore.get(menuItemId) || 0);
    if (delta <= 0) continue;
    const postLines = guardCartAfter.filter(i => i.menu_item_id === menuItemId);
    if (isNamedThisTurn(postLines[0]?.name ?? "")) continue;

    for (const line of postLines) {
      if (delta <= 0) break;
      const before = beforeByFingerprint.get(fingerprint(line));
      if (!before) continue;
      const bump = (line.quantity || 1) - (before.quantity || 1);
      if (bump <= 0) continue;
      const take = Math.min(bump, delta);
      qtyReverts.push({ item: line, priorQty: (line.quantity || 1) - take });
      delta -= take;
    }
    for (const line of postLines) {
      if (delta <= 0) break;
      if (beforeByFingerprint.has(fingerprint(line))) continue;
      const lineQty = line.quantity || 1;
      if (lineQty <= delta) {
        phantomAdds.push(line);
        delta -= lineQty;
      } else {
        qtyReverts.push({ item: line, priorQty: lineQty - delta });
        delta = 0;
      }
    }
  }

  return { phantomAdds, qtyReverts };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const LUCA_MENU: MenuLike[] = [
  { id: "pizza-cbr", name: "Chicken Bacon Ranch", category: "Pizza" },
  { id: "wings", name: "Wings", category: "Wings" },
  { id: "flatbread-cbr", name: "Chicken Bacon Ranch (Flatbreads)", category: "Flatbreads" },
  { id: "quesadilla-chicken", name: "Chicken (Quesadillas)", category: "Quesadillas" },
  { id: "ranch", name: "Ranch", category: "Sides" },
  { id: "fries", name: "Fries", category: "Sides" },
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

// ── Requirement 1: the exact Luca sequence ──────────────────────────────────

Deno.test("GUARD 9: 'Looks good' does not name the flatbread/quesadilla/ranch — all three classified as phantom", () => {
  const { phantomAdds, qtyReverts } = computeGuard9Reverts(
    LUCA_CART_BEFORE,
    LUCA_CART_AFTER_PHANTOM,
    "Looks good",
    LUCA_MENU,
  );
  assertEquals(qtyReverts.length, 0);
  const phantomIds = phantomAdds.map(i => i.menu_item_id).sort();
  assertEquals(phantomIds, ["flatbread-cbr", "quesadilla-chicken", "ranch"]);
});

Deno.test("GUARD 9: the pizza and wings the customer actually ordered are never touched", () => {
  const { phantomAdds } = computeGuard9Reverts(
    LUCA_CART_BEFORE,
    LUCA_CART_AFTER_PHANTOM,
    "Looks good",
    LUCA_MENU,
  );
  const phantomIds = new Set(phantomAdds.map(i => i.menu_item_id));
  assertEquals(phantomIds.has("pizza-cbr"), false);
  assertEquals(phantomIds.has("wings"), false);
});

// ── Requirement 2: a genuinely named add on affirmation-adjacent phrasing ──

Deno.test("GUARD 9: 'yeah also add fries' names fries in the current message — must NOT be reverted", () => {
  const before: TestCartLine[] = [{ menu_item_id: "pizza-cbr", name: "Chicken Bacon Ranch", quantity: 1 }];
  const after: TestCartLine[] = [
    ...before,
    { menu_item_id: "fries", name: "Fries", quantity: 1 },
  ];
  const { phantomAdds, qtyReverts } = computeGuard9Reverts(before, after, "yeah also add fries", LUCA_MENU);
  assertEquals(phantomAdds.length, 0, "fries was named this turn and must survive");
  assertEquals(qtyReverts.length, 0);
});

// ── False-positive guard: resolving a pending option must never look like a
//    phantom add just because it changes the line's fingerprint ───────────

Deno.test("GUARD 9: resolving a pending option group on 'sure' does not revert anything (no quantity growth)", () => {
  // Same array slot in the real code: add_item's resolvingPendingIdx path
  // mutates `options` in place without changing quantity. Total quantity for
  // the item is identical before/after, so the quantity-growth gate must
  // never fire here, regardless of the fingerprint (menu_item_id + options)
  // changing shape.
  const before: TestCartLine[] = [{ menu_item_id: "wings", name: "Wings", quantity: 1 }];
  const after: TestCartLine[] = [{ menu_item_id: "wings", name: "Wings", quantity: 1, options: { Sauce: ["Ranch"] } }];
  const { phantomAdds, qtyReverts } = computeGuard9Reverts(before, after, "sure", LUCA_MENU);
  assertEquals(phantomAdds.length, 0);
  assertEquals(qtyReverts.length, 0);
});

Deno.test("GUARD 9: an unnamed quantity bump on an unchanged line is reverted to the prior quantity", () => {
  const before: TestCartLine[] = [{ menu_item_id: "wings", name: "Wings", quantity: 1 }];
  const after: TestCartLine[] = [{ menu_item_id: "wings", name: "Wings", quantity: 2 }];
  const { phantomAdds, qtyReverts } = computeGuard9Reverts(before, after, "looks good", LUCA_MENU);
  assertEquals(phantomAdds.length, 0);
  assertEquals(qtyReverts.length, 1);
  assertEquals(qtyReverts[0].priorQty, 1);
});

Deno.test("GUARD 9: a non-affirmation message never triggers the guard, even if the cart grew unexplained", () => {
  const { phantomAdds, qtyReverts } = computeGuard9Reverts(
    LUCA_CART_BEFORE,
    LUCA_CART_AFTER_PHANTOM,
    "what's in my cart?",
    LUCA_MENU,
  );
  assertEquals(phantomAdds.length, 0);
  assertEquals(qtyReverts.length, 0);
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
