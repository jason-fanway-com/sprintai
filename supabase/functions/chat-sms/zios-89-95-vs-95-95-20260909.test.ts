// P0 replay (2026-09-09): Zio's Pizzeria (shop_id
// 2cba7b51-211c-4437-8910-1af4dcc03498, conversation
// f0ecf0fe-909f-4bd6-aa1a-e73f778c501c) quoted a customer $89.95 for a cart
// that actually held $95.95 (subtotal $94.96 + $0.99 fee) -- pepperoni had
// been applied as a modifier to BOTH the Meat Lover's and the Hawaiian, $6.00
// of toppings never ordered. GUARD 2c exists specifically to catch a
// quoted-total-vs-real-total mismatch and did NOT fire.
//
// All four menu-item prices and the $3.00 Pepperoni topping price below are
// Zio's REAL, live menu rows (confirmed via qa_ro.menu_items /
// qa_ro.option_choices, read-only credential, 2026-09-09):
//   Neapolitan Cheese Pizza - Large 18''  35b44d0b-...  $17.99
//   Shrimp Scampi                         8d8a2147-...  $20.99
//   Meat Lover's Pizza - Large 18''       0b7a33b7-...  $24.99 (+ $3.00 Pepperoni choice)
//   Hawaiian Pizza - Large 18''           5eb4554f-...  $24.99 (+ $3.00 Pepperoni choice)
// Correct order: subtotal $88.96 + $0.99 fee = $89.95 total -- exactly the
// figures in the incident report.
//
// LIMITATION (honest, not glossed over): this replays the real, exported
// pricing/detection/render functions (buildGroundedMoneyCents,
// findStrayDollarCents, renderMoneyFooterLines, CART_SUMMARY_RE) against a
// cart shaped by Zio's real menu data reproducing the incident's exact
// dollar figures. It does NOT drive the live LLM tool-call sequence
// (executeTool's add_item/modify_item) end-to-end, because (a) index.ts's
// top-level `Deno.serve` makes the whole module unsafe to import from a unit
// test, and (b) this session had only the read-only `qa_ro` credential --
// no service-role key and no OPENROUTER key were available to run the
// scripts/test-suite HTTP harness against a live/local instance. A live
// conversational replay (scripts/test-suite/proof.ts style) against this
// exact conversation is a follow-up QA needs real credentials for.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildGroundedMoneyCents, findStrayDollarCents } from "./guard2c-currency-lint-20260909.ts";
import { renderMoneyFooterLines } from "./money-footer-20260909.ts";
import { CART_SUMMARY_RE } from "./cart-summary-intent-20260909.ts";

const SERVICE_FEE_CENTS = 99;

const NEAPOLITAN = { menu_item_id: "35b44d0b-9aaa-4ac8-bf0e-4f8a8bf252bd", name: "Neapolitan Cheese Pizza - Large 18''", price_cents: 1799, quantity: 1 };
const SCAMPI     = { menu_item_id: "8d8a2147-0bcd-4711-9cae-80cc3d570d9e", name: "Shrimp Scampi",                        price_cents: 2099, quantity: 1 };

// The real menu, as the bot would have read it (base price plus the real
// $3.00 Pepperoni topping choice on each pizza) -- used to build the
// grounded money set, exactly as GUARD 2c does in index.ts.
const ZIOS_MENU_SUBSET = [
  { price_cents: 1799, option_groups: [] },
  { price_cents: 2099, option_groups: [] },
  { price_cents: 2499, option_groups: [{ choices: [{ price_cents: 300 }] }] }, // Meat Lover's + Pepperoni
  { price_cents: 2499, option_groups: [{ choices: [{ price_cents: 300 }] }] }, // Hawaiian + Pepperoni
];

// The CORRECT cart, per the incident report: 4 items, $17.99/$20.99/$24.99/$24.99.
const CORRECT_CART = [
  NEAPOLITAN,
  SCAMPI,
  { menu_item_id: "0b7a33b7-f02c-4609-b7d2-1b99c08e805a", name: "Meat Lover's Pizza - Large 18''", price_cents: 2499, quantity: 1 },
  { menu_item_id: "5eb4554f-d4f7-4f8d-8440-55b051856650", name: "Hawaiian Pizza - Large 18''",      price_cents: 2499, quantity: 1 },
];
const CORRECT_SUBTOTAL = 1799 + 2099 + 2499 + 2499; // 8896
const CORRECT_TOTAL = CORRECT_SUBTOTAL + SERVICE_FEE_CENTS; // 8995

// The BUGGY cart actually written to order_carts: pepperoni applied as a
// $3.00 modifier to BOTH pizzas (CartItem.price_cents is the derived,
// modifier-inclusive per-unit price -- see index.ts's CartItem interface
// comment -- so a $3.00 topping shows up as +300 on the line's price_cents,
// exactly as the real add_item path would write it).
const BUGGY_CART = [
  NEAPOLITAN,
  SCAMPI,
  { menu_item_id: "0b7a33b7-f02c-4609-b7d2-1b99c08e805a", name: "Meat Lover's Pizza - Large 18''", price_cents: 2799, quantity: 1 },
  { menu_item_id: "5eb4554f-d4f7-4f8d-8440-55b051856650", name: "Hawaiian Pizza - Large 18''",      price_cents: 2799, quantity: 1 },
];
const BUGGY_SUBTOTAL = 1799 + 2099 + 2799 + 2799; // 9496 -- matches the live $94.96 exactly
const BUGGY_TOTAL = BUGGY_SUBTOTAL + SERVICE_FEE_CENTS; // 9595 -- matches the live $95.95 exactly

Deno.test("sanity: reconstructed buggy cart matches the live incident's real numbers", () => {
  assertEquals(BUGGY_SUBTOTAL, 9496);
  assertEquals(BUGGY_TOTAL, 9595);
  assertEquals(CORRECT_SUBTOTAL, 8896);
  assertEquals(CORRECT_TOTAL, 8995);
});

// ── OLD behavior (RED): claimsATotal only fires on total-claiming language ──
// Reproduced verbatim from index.ts's GUARD 2c (the regex itself, not a
// paraphrase) to prove the live reply shape genuinely slipped past it.
const OLD_CLAIMS_A_TOTAL =
  /\b(?:total|subtotal|comes to|that['’]ll be|that will be|you owe|grand total|order total|due|to pay|adds up to|comes out to|altogether|all together)\b/i;

const LIVE_REPLY_SHAPE = "So that's four pizzas for $89.95, sound good?";

Deno.test("RED: the live reply shape never trips the old total-claiming regex", () => {
  assertEquals(OLD_CLAIMS_A_TOTAL.test(LIVE_REPLY_SHAPE), false);
});

// ── NEW behavior (GREEN): the widened currency lint catches it anyway ──────
Deno.test("GREEN: GUARD 2c widening flags $89.95 against the real $95.95 buggy cart", () => {
  const grounded = buildGroundedMoneyCents(
    BUGGY_CART, ZIOS_MENU_SUBSET, SERVICE_FEE_CENTS, undefined, undefined, BUGGY_TOTAL,
  );
  // 89.95 must not coincide with any real cart line, menu price, topping
  // upcharge, subtotal, fee, or the real (wrong) total -- it doesn't.
  const stray = findStrayDollarCents([8995], grounded);
  assertEquals(stray, 8995);
});

Deno.test("NO FALSE POSITIVE: a correct $89.95 quote against the real $89.95 cart never trips", () => {
  const grounded = buildGroundedMoneyCents(
    CORRECT_CART, ZIOS_MENU_SUBSET, SERVICE_FEE_CENTS, undefined, undefined, CORRECT_TOTAL,
  );
  const stray = findStrayDollarCents([8995], grounded);
  assertEquals(stray, null);
});

Deno.test("NO FALSE POSITIVE: quoting a real menu/topping price before adding never trips", () => {
  // "Large pepperoni is $3.00 extra, or the Neapolitan is $17.99 on its own."
  const grounded = buildGroundedMoneyCents(
    CORRECT_CART, ZIOS_MENU_SUBSET, SERVICE_FEE_CENTS, undefined, undefined, CORRECT_TOTAL,
  );
  const stray = findStrayDollarCents([300, 1799], grounded);
  assertEquals(stray, null);
});

// ── Step 2: itemized recap is code-owned, three labelled lines, fee never folded ──
Deno.test("GREEN: recap renders Subtotal / Service fee / Total as three labelled lines", () => {
  const footer = renderMoneyFooterLines(CORRECT_CART, SERVICE_FEE_CENTS);
  assertEquals(footer, "Subtotal: $88.96\nService fee: $0.99\nTotal: $89.95");
});

Deno.test("GREEN: the buggy cart's own recap correctly reflects the wrong money (proves the render, not the mutation, is what step 5 covers)", () => {
  const footer = renderMoneyFooterLines(BUGGY_CART, SERVICE_FEE_CENTS);
  assertEquals(footer, "Subtotal: $94.96\nService fee: $0.99\nTotal: $95.95");
});

// ── Step 1: the exact live customer phrase now bypasses the LLM/guard chain ──
Deno.test("GREEN: 'show me the cart with prices' (the live customer's exact words) now matches the read-only shortcut", () => {
  assert(CART_SUMMARY_RE.test("show me the cart with prices"));
  assert(CART_SUMMARY_RE.test("show me the cart with prices".trim()));
});

Deno.test("RED (documented): the OLD narrower shortcut missed this exact phrase", () => {
  const OLD_CART_SUMMARY_RE = /^(?:show(?:\s+me)?(?:\s+my)?(?:\s+(?:full\s+)?order|\s+cart|\s+order)?|what(?:'?s|\s+is)(?:\s+in)?(?:\s+my)?(?:\s+cart|\s+order)|(?:my\s+)?(?:order|cart)(?:\s+so\s+far)?|(?:see|view|check|read)\s+(?:my\s+)?(?:order|cart)|what(?:\s+did|\s+have)\s+i(?:\s+(?:get|order|got|added))?)[\s?]*$/i;
  assertEquals(OLD_CART_SUMMARY_RE.test("show me the cart with prices"), false);
});

Deno.test("NO FALSE POSITIVE: the widened read-only shortcut still ignores real order language", () => {
  assertEquals(CART_SUMMARY_RE.test("can I get a large pepperoni pizza"), false);
  assertEquals(CART_SUMMARY_RE.test("add a large pepperoni"), false);
  assertEquals(CART_SUMMARY_RE.test("what wing flavors do you have"), false);
});
