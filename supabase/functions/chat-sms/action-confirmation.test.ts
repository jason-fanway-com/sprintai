// Reply inversion, stage 1 (2026-09-13, docs/specs/2026-09-13-reply-inversion.md).
// See action-confirmation.ts's header for the rule this enforces and why.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectCartMutation,
  renderActionConfirmation,
  extractQuestionsOnly,
  stripFalseMutationClaims,
  type MutationCartLine,
} from "./action-confirmation.ts";

// ── detectCartMutation ──────────────────────────────────────────────────────

Deno.test("detectCartMutation: brand-new line -> added", () => {
  const before: MutationCartLine[] = [];
  const after: MutationCartLine[] = [
    { menu_item_id: "fries", name: "French Fries", quantity: 1, price_cents: 399 },
  ];
  assertEquals(detectCartMutation(before, after), { action: "added", itemName: "French Fries", qty: 1, line: after[0] });
});

Deno.test("detectCartMutation: line disappears -> removed", () => {
  const before: MutationCartLine[] = [
    { menu_item_id: "fries", name: "French Fries", quantity: 1, price_cents: 399 },
  ];
  const after: MutationCartLine[] = [];
  assertEquals(detectCartMutation(before, after), { action: "removed", itemName: "French Fries" });
});

Deno.test("detectCartMutation: same identity, quantity grows -> qty_set", () => {
  const before: MutationCartLine[] = [
    { menu_item_id: "coke", name: "Coke", quantity: 1, price_cents: 199 },
  ];
  const after: MutationCartLine[] = [
    { menu_item_id: "coke", name: "Coke", quantity: 2, price_cents: 199 },
  ];
  assertEquals(detectCartMutation(before, after), { action: "qty_set", itemName: "Coke", qty: 2 });
});

// v430 regression (live, conv v430, Vito's, 2026-09-13): "Yes but this week
// I want pepperoni" swapped an existing pizza's topping. Same menu_item_id,
// one identity replaced by another -> "corrected", named after the actual
// new topping, not a bare count.
Deno.test("detectCartMutation: v430 regression — topping swap on the same base item -> corrected, names the topping", () => {
  const before: MutationCartLine[] = [
    {
      menu_item_id: "large-pizza",
      name: "Large Pizza",
      quantity: 1,
      price_cents: 1699,
      options: { Toppings: ["Cheese"] },
    },
  ];
  const after: MutationCartLine[] = [
    {
      menu_item_id: "large-pizza",
      name: "Large Pizza",
      quantity: 1,
      price_cents: 1699,
      options: { Toppings: ["Pepperoni"] },
    },
  ];
  const event = detectCartMutation(before, after);
  assertEquals(event, { action: "corrected", itemName: "Large Pizza", detailName: "Pepperoni" });
  assertEquals(renderActionConfirmation(event!), "Swapped to Pepperoni.");
});

// FAILURE B (2026-09-13): a genuine ADDITION to an existing item's options
// (cheese pizza -> cheese+pepperoni pizza — cheese never left) used to be
// misclassified as a swap because the branch only checked whether the
// before/after option arrays differed at all, not whether anything was
// actually removed. Rendering "Swapped to Pepperoni." here is a
// CODE-authored false claim that cheese is gone.
//
// Rendering-consistency fix (2026-09-14): the resulting line now carries
// options, so renderActionConfirmation itemizes it (name + full option list
// + price) instead of the bare "Pepperoni added." — the customer sees the
// pizza's current toppings and total, not just the word "added."
Deno.test("detectCartMutation: FAILURE B — adding a second topping is NOT a swap (cheese stays)", () => {
  const before: MutationCartLine[] = [
    { menu_item_id: "large-pizza", name: "Large Pizza", quantity: 1, price_cents: 1699, options: { Toppings: ["Cheese"] } },
  ];
  const after: MutationCartLine[] = [
    { menu_item_id: "large-pizza", name: "Large Pizza", quantity: 1, price_cents: 1699, options: { Toppings: ["Cheese", "Pepperoni"] } },
  ];
  const event = detectCartMutation(before, after);
  assertEquals(event, { action: "option_added", itemName: "Large Pizza", detailName: "Pepperoni", line: after[0] });
  assertEquals(renderActionConfirmation(event!), "Large Pizza (Toppings: Cheese, Pepperoni) $16.99");
});

Deno.test("detectCartMutation: FAILURE B — removing a topping alone is NOT a swap", () => {
  const before: MutationCartLine[] = [
    { menu_item_id: "large-pizza", name: "Large Pizza", quantity: 1, price_cents: 1699, options: { Toppings: ["Cheese", "Pepperoni"] } },
  ];
  const after: MutationCartLine[] = [
    { menu_item_id: "large-pizza", name: "Large Pizza", quantity: 1, price_cents: 1699, options: { Toppings: ["Cheese"] } },
  ];
  const event = detectCartMutation(before, after);
  assertEquals(event, { action: "option_removed", itemName: "Large Pizza", detailName: "Pepperoni" });
  assertEquals(renderActionConfirmation(event!), "Pepperoni removed.");
});

// Regression guard: a TRUE swap (cheese genuinely gone, pepperoni genuinely
// new) must still render "Swapped to Pepperoni." — the v430 test above
// covers this too; this one names the failure mode explicitly so a future
// change to the option_added/option_removed branches can't silently regress
// the real-swap case without a titled test failing.
Deno.test("detectCartMutation: FAILURE B regression check — genuine swap (both a real removal and a real addition) still classifies as corrected", () => {
  const before: MutationCartLine[] = [
    { menu_item_id: "large-pizza", name: "Large Pizza", quantity: 1, price_cents: 1699, options: { Toppings: ["Cheese"] } },
  ];
  const after: MutationCartLine[] = [
    { menu_item_id: "large-pizza", name: "Large Pizza", quantity: 1, price_cents: 1699, options: { Toppings: ["Pepperoni"] } },
  ];
  const event = detectCartMutation(before, after);
  assertEquals(event, { action: "corrected", itemName: "Large Pizza", detailName: "Pepperoni" });
  assertEquals(renderActionConfirmation(event!), "Swapped to Pepperoni.");
});

Deno.test("detectCartMutation: no structural change -> null", () => {
  const cart: MutationCartLine[] = [
    { menu_item_id: "coke", name: "Coke", quantity: 1, price_cents: 199 },
  ];
  assertEquals(detectCartMutation(cart, cart.map(l => ({ ...l }))), null);
});

// 2026-09-13 soft gap: this used to return a non-null "added" event naming
// only the FIRST of the two new lines (coke), silently dropping shake from
// the confirmation instead of falling back to the itemizer as this
// function's own docstring promises callers it will. Two or more
// simultaneous new identities are exactly the "too ambiguous to name safely
// in one sentence" case the docstring describes — this must return null so
// index.ts's fallback (renderItemizedRecap) fires instead of a single-item
// sentence that drops an item.
Deno.test("detectCartMutation: multiple unrelated lines touched at once -> null (caller must fall back to the itemizer)", () => {
  const before: MutationCartLine[] = [
    { menu_item_id: "fries", name: "French Fries", quantity: 1, price_cents: 399 },
  ];
  const after: MutationCartLine[] = [
    { menu_item_id: "fries", name: "French Fries", quantity: 1, price_cents: 399 },
    { menu_item_id: "coke", name: "Coke", quantity: 1, price_cents: 199 },
    { menu_item_id: "shake", name: "Shake", quantity: 1, price_cents: 499 },
  ];
  const event = detectCartMutation(before, after);
  assertEquals(event, null);
});

// 2026-09-13 soft gap, positive case: two DIFFERENT items added together in
// one turn (fries + coke, cart was empty before) must not silently drop one
// of them from the confirmation. detectCartMutation returns null (ambiguous
// — see test above); the itemizer fallback then represents both.
Deno.test("detectCartMutation: two different items added in the same turn -> null, itemizer fallback represents both", () => {
  const before: MutationCartLine[] = [];
  const after: MutationCartLine[] = [
    { menu_item_id: "fries", name: "French Fries", quantity: 1, price_cents: 399 },
    { menu_item_id: "coke", name: "Coke", quantity: 1, price_cents: 199 },
  ];
  const event = detectCartMutation(before, after);
  assertEquals(event, null, "two simultaneous adds must fall back to the itemizer, not silently name only one");
});

// ── renderActionConfirmation ─────────────────────────────────────────────────

Deno.test("renderActionConfirmation: added names the item, not a bare count", () => {
  assertEquals(
    renderActionConfirmation({ action: "added", itemName: "French Fries", qty: 1 }),
    "French Fries added.",
  );
});

// Rendering-consistency fix (2026-09-14, PO live diagnosis): the same
// "item added" event used to render bare ("Large Cheese Pizza added.") or
// itemized ("Large Cheese Pizza (Toppings: Pepperoni (+$4.50)) $21.00")
// depending only on which code path a given turn happened to take through —
// never on anything about the item itself. A plain option-free add stays
// terse; an add carrying options/modifiers is always itemized so the
// customer sees the upcharge they just agreed to.
Deno.test("renderActionConfirmation: added, item carries options -> itemized with price, not bare", () => {
  const event = {
    action: "added" as const,
    itemName: "Large Cheese Pizza",
    qty: 1,
    line: {
      menu_item_id: "large-pizza",
      name: "Large Cheese Pizza",
      quantity: 1,
      price_cents: 2100,
      options: { Toppings: ["Pepperoni"] },
    },
  };
  assertEquals(
    renderActionConfirmation(event, new Map([["large-pizza", new Map([["pepperoni", 450]])]])),
    "Large Cheese Pizza (Toppings: Pepperoni (+$4.50)) $21.00",
  );
});

Deno.test("renderActionConfirmation: added, plain item with no options -> stays terse", () => {
  const event = {
    action: "added" as const,
    itemName: "French Fries",
    qty: 1,
    line: { menu_item_id: "fries", name: "French Fries", quantity: 1, price_cents: 399 },
  };
  assertEquals(renderActionConfirmation(event), "French Fries added.");
});

Deno.test("renderActionConfirmation: added, no line on the event (unknown shape) -> falls back to bare, never throws", () => {
  assertEquals(
    renderActionConfirmation({ action: "added", itemName: "French Fries", qty: 1 }),
    "French Fries added.",
  );
});

Deno.test("renderActionConfirmation: removed", () => {
  assertEquals(renderActionConfirmation({ action: "removed", itemName: "Coke" }), "Coke removed.");
});

Deno.test("renderActionConfirmation: qty_set", () => {
  assertEquals(
    renderActionConfirmation({ action: "qty_set", itemName: "Coke", qty: 3 }),
    "Coke — now 3.",
  );
});

// ── extractQuestionsOnly ─────────────────────────────────────────────────────

Deno.test("extractQuestionsOnly: drops declarative cart-fact sentences, keeps the question", () => {
  // The exact shape of the 19:07 Vito's live incident this spec exists to
  // close: a correct add, wrapped in a false three-item enumeration and a
  // total the model was never authorized to state.
  const modelReply =
    "Got it, adding a large plain cheese pizza. I've got your items: large cheese pepperoni pizza, " +
    "french fries, and a large plain cheese pizza. Confirm? Subtotal: $25.99 Service fee: $0.99 Total: $26.98";
  assertEquals(extractQuestionsOnly(modelReply), "Confirm?");
});

Deno.test("extractQuestionsOnly: preserves the EARLY ORDER TYPE GATE question", () => {
  const modelReply = "Got it — one Special Stromboli added. Are you ordering pickup or delivery today?";
  assertEquals(extractQuestionsOnly(modelReply), "Are you ordering pickup or delivery today?");
});

Deno.test("extractQuestionsOnly: no question anywhere -> empty string", () => {
  assertEquals(extractQuestionsOnly("Got it, added the fries!"), "");
});

Deno.test("extractQuestionsOnly: empty/undefined input -> empty string", () => {
  assertEquals(extractQuestionsOnly(""), "");
});

// ── extractQuestionsOnly — FAILURE A (2026-09-13) ───────────────────────────
// A false item-enumeration fused INTO the interrogative sentence itself, not
// as a separate declarative sentence, must not survive just because the
// whole thing ends in "?". This is the exact 19:07 live incident shape,
// phrased as a question instead of a declarative statement.

const KNOWN_ITEM_NAMES = ["French Fries", "Large Plain Cheese Pizza", "Large Cheese Pepperoni Pizza", "Coke"];

Deno.test("extractQuestionsOnly: FAILURE A repro — false item enumeration fused into the confirm question is dropped entirely", () => {
  const modelReply =
    "Added the fries. So that's your large cheese pepperoni pizza, french fries, and a large plain cheese pizza — confirm?";
  assertEquals(extractQuestionsOnly(modelReply, KNOWN_ITEM_NAMES), "");
});

Deno.test("extractQuestionsOnly: FAILURE A variant — item list fused into a different question phrasing", () => {
  const modelReply = "You've got a large cheese pepperoni pizza, french fries, and a coke in there — ready to check out?";
  assertEquals(extractQuestionsOnly(modelReply, KNOWN_ITEM_NAMES), "");
});

Deno.test("extractQuestionsOnly: FAILURE A variant — single false item name fused into a short question", () => {
  const modelReply = "Your large plain cheese pizza is on its way — anything else?";
  assertEquals(extractQuestionsOnly(modelReply, KNOWN_ITEM_NAMES), "");
});

Deno.test("extractQuestionsOnly: FAILURE A variant — false price fused into a question", () => {
  const modelReply = "That'll be $26.98 total — sound good?";
  assertEquals(extractQuestionsOnly(modelReply, KNOWN_ITEM_NAMES), "");
});

Deno.test("extractQuestionsOnly: a genuine item-free question still survives the known-item-name filter", () => {
  const modelReply = "Fries added. Are you ordering pickup or delivery today?";
  assertEquals(extractQuestionsOnly(modelReply, KNOWN_ITEM_NAMES), "Are you ordering pickup or delivery today?");
});

// ── extractQuestionsOnly — round 2 (2026-09-13) ─────────────────────────────
// Round 1 closed the NAMED-ENUMERATION form of the 19:07 incident (a false
// item list fused into the confirm question). It left the QUANTITY form
// open: a bare item-count claim, or a spelled-out quantity glued to an item
// category word, matches no known item name and no $ sign, so it survived
// verbatim. These three repros are exactly what round-2 verification found
// still getting through.

Deno.test("extractQuestionsOnly: round 2 repro — bare item-count claim is the origin defect itself (3 items vs a 2-item cart) and must be dropped", () => {
  const modelReply = "Fries added. That's 3 items — confirm?";
  assertEquals(extractQuestionsOnly(modelReply, KNOWN_ITEM_NAMES), "");
});

Deno.test("extractQuestionsOnly: round 2 repro — spelled-out quantity + item-category words, no literal menu-name substring match", () => {
  const modelReply = "...So your two pizzas and a soda — ready to check out?";
  assertEquals(extractQuestionsOnly(modelReply, KNOWN_ITEM_NAMES), "");
});

// KNOWN RESIDUAL GAP — not fixed this round. "the pep pizza" is a
// colloquial/abbreviated reference to a real menu item that does not
// substring-match its canonical name ("Large Cheese Pepperoni Pizza"), so
// it is not caught by sentenceAssertsCartFact. A general abbreviation
// heuristic was evaluated and rejected (see action-confirmation.ts's
// comment above isShortSingleWordName) because short word-fragment prefix
// matching reopens the over-strip failure this same round had to close, at
// a much larger scale, for an unbounded set of common word fragments. This
// test documents ACTUAL current behavior (the sentence survives unstripped)
// so the gap stays visible and honest rather than silently presumed closed.
Deno.test("extractQuestionsOnly: round 2 repro, KNOWN GAP — colloquial abbreviated item reference is NOT scrubbed (documented, not fixed)", () => {
  const modelReply = "Is the pep pizza all for tonight?";
  assertEquals(extractQuestionsOnly(modelReply, KNOWN_ITEM_NAMES), "Is the pep pizza all for tonight?");
});

// ── extractQuestionsOnly — round 2 over-strip fix (2026-09-13) ─────────────
// A menu item literally named a short, common English word ("Side",
// "Water") made the item-name substring check fire on harmless, item-free
// customer questions, silently deleting them. Fixed by excluding
// short (<=5 char) single-word item names from the substring check.

const KNOWN_ITEM_NAMES_WITH_SHORT_WORDS = [...KNOWN_ITEM_NAMES, "Side", "Water"];

Deno.test("extractQuestionsOnly: round 2 fix — a menu item named 'Side' no longer strips an unrelated, harmless question", () => {
  const modelReply = "Fries added. Do you want anything on the side?";
  assertEquals(
    extractQuestionsOnly(modelReply, KNOWN_ITEM_NAMES_WITH_SHORT_WORDS),
    "Do you want anything on the side?",
  );
});

Deno.test("extractQuestionsOnly: round 2 fix — a menu item named 'Water' no longer strips an unrelated, harmless question", () => {
  const modelReply = "Would you like a water with that?";
  assertEquals(
    extractQuestionsOnly(modelReply, KNOWN_ITEM_NAMES_WITH_SHORT_WORDS),
    "Would you like a water with that?",
  );
});

Deno.test("extractQuestionsOnly: round 2 regression check — real item-name lies with longer, multi-word names still strip after the short-name exclusion", () => {
  const modelReply =
    "Added the fries. So that's your large cheese pepperoni pizza, french fries, and a large plain cheese pizza — confirm?";
  assertEquals(extractQuestionsOnly(modelReply, KNOWN_ITEM_NAMES_WITH_SHORT_WORDS), "");
});

// ── stripFalseMutationClaims (item H — reply-inversion ESCAPE on unmutated turns) ──
// Pins the two exact live canary transcripts (b4c80c78/1eeab0c0 conversation
// families) where the model claimed a mutation happened on a turn cart_json
// never actually changed on.

Deno.test("stripFalseMutationClaims: real exact live repro — 'Got it - a Cheese Burger added.' on an unmutated turn is stripped", () => {
  const reply = "Got it - a Cheese Burger added. Are you ordering pickup or delivery today?";
  const { reply: out, stripped } = stripFalseMutationClaims(reply, ["Cheese Burger"], ["Medium"]);
  assertEquals(stripped, true);
  assertEquals(/cheese burger/i.test(out), false);
  assertEquals(/added/i.test(out), false);
  assertEquals(/pickup or delivery/i.test(out), true); // genuine question survives
});

Deno.test("stripFalseMutationClaims: real exact live repro — 'I've got your cheeseburger!' (no space, loose match) is stripped", () => {
  const reply = "I've got your cheeseburger! Pickup or delivery?";
  const { reply: out, stripped } = stripFalseMutationClaims(reply, ["Cheese Burger"], []);
  assertEquals(stripped, true);
  assertEquals(/cheeseburger/i.test(out), false);
});

Deno.test("stripFalseMutationClaims: 'Medium temp noted.' (option-choice-value claim, no menu item name) is stripped", () => {
  const reply = "Medium temp noted. Pickup or delivery today?";
  const { reply: out, stripped } = stripFalseMutationClaims(reply, ["Cheese Burger"], ["Medium"]);
  assertEquals(stripped, true);
  assertEquals(/medium/i.test(out), false);
  assertEquals(/pickup or delivery/i.test(out), true);
});

Deno.test("stripFalseMutationClaims: a genuine voice reply with no mutation claim passes through untouched", () => {
  const reply = "We're open until 10pm tonight. Anything else I can help with?";
  const { reply: out, stripped } = stripFalseMutationClaims(reply, ["Cheese Burger"], ["Medium"]);
  assertEquals(stripped, false);
  assertEquals(out, reply);
});

Deno.test("stripFalseMutationClaims: an unmutated turn can still answer a question naming a real item, as long as it doesn't claim an add", () => {
  const reply = "A Cheese Burger is $8.49 with fries. Want me to add one?";
  const { reply: out, stripped } = stripFalseMutationClaims(reply, ["Cheese Burger"], []);
  // "Cheese Burger is $8.49" is price-shaped/names a known item but contains
  // no mutation-claim verb (added/noted/got it/...) — it's informational,
  // not a false success claim, so it must survive.
  assertEquals(stripped, false);
  assertEquals(out, reply);
});

Deno.test("stripFalseMutationClaims: stripping everything falls back to a safe neutral question, never an empty reply", () => {
  const reply = "Got it - a Cheese Burger added.";
  const { reply: out, stripped } = stripFalseMutationClaims(reply, ["Cheese Burger"], []);
  assertEquals(stripped, true);
  assertEquals(out.length > 0, true);
  assertEquals(/\?/.test(out), true);
});
