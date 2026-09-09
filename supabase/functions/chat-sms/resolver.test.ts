// Item 3 (2026-09-09): acceptance tests for the phrase-isolated resolver.
//
// Test menu mirrors real Zio's structure (verified live 2026-09-08) — the
// same fixture pizza-topping-compose.test.ts uses, extended with ask_plan
// on Hawaiian and Meat Lover's so the "pepperoni on one of two pizzas"
// defect tests can assert full toppings isolation.
//
// Every case asserts BOTH the resolved operations AND the resulting cart
// state (via applyOps). Tests are grouped by the acceptance criterion they
// cover so a failure names the defect directly.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveUtterance,
  resolvePhrase,
  splitPhrases,
  buildLexicon,
  applyOps,
  type ResolvedOp,
  type AddItemOp,
  type HonestMissOp,
  type RemoveToppingOp,
  type AskAmbiguityOp,
} from "./resolver.ts";
import type { ComposeMenuItem } from "./pizza-topping-compose.ts";

// ── TEST MENU FIXTURE ──────────────────────────────────────────────────────

const TOPPING_CHOICES = [
  "Pepperoni", "Sausage", "Mushrooms", "Onions", "Extra Cheese", "Bacon",
  "Peppers", "Hot Peppers", "Roasted Red Peppers", "Fresh Garlic",
];

function toppingStep(choices: string[]) {
  return {
    group_id: "toppings-group",
    slot_key: null,
    kind: "modifier" as const,
    ask_mode: "on_request" as const,
    prompt_template: "add_toppings.on_request",
    choices: choices.map((name, i) => ({
      id: `choice-${i}-${name.toLowerCase().replace(/\s+/g, "-")}`,
      display: name,
      price_delta_cents: 300,
    })),
  };
}

function buildMenu(): ComposeMenuItem[] {
  return [
    {
      id: "neap-small",
      name: "Neapolitan Cheese Pizza - Small 14''",
      category: "Pizza",
      ask_plan: {
        compiled_at: "", compiler_version: 1,
        display_name: "Small Neapolitan Cheese Pizza",
        base_price_cents: 1525, recap_template: "", ticket_template: "",
        steps: [toppingStep(TOPPING_CHOICES)],
      },
    },
    {
      id: "neap-med",
      name: "Neapolitan Cheese Pizza - Medium 16''",
      category: "Pizza",
      ask_plan: {
        compiled_at: "", compiler_version: 1,
        display_name: "Medium Neapolitan Cheese Pizza",
        base_price_cents: 1675, recap_template: "", ticket_template: "",
        steps: [toppingStep(TOPPING_CHOICES)],
      },
    },
    {
      id: "neap-large",
      name: "Neapolitan Cheese Pizza - Large 18''",
      category: "Pizza",
      ask_plan: {
        compiled_at: "", compiler_version: 1,
        display_name: "Large Neapolitan Cheese Pizza",
        base_price_cents: 1799, recap_template: "", ticket_template: "",
        steps: [toppingStep(TOPPING_CHOICES)],
      },
    },
    {
      id: "sicilian",
      name: "Sicilian Cheese Pizza",
      category: "Pizza",
      ask_plan: {
        compiled_at: "", compiler_version: 1,
        display_name: "Sicilian Cheese Pizza",
        base_price_cents: 1999, recap_template: "", ticket_template: "",
        steps: [toppingStep(TOPPING_CHOICES)],
      },
    },
    {
      id: "grandma",
      name: "Grandma Cheese Pizza",
      category: "Pizza",
      ask_plan: {
        compiled_at: "", compiler_version: 1,
        display_name: "Grandma Cheese Pizza",
        base_price_cents: 1899, recap_template: "", ticket_template: "",
        steps: [toppingStep(TOPPING_CHOICES)],
      },
    },
    // Hawaiian and Meat Lover's have ask_plan so the phrase-isolation test
    // can verify that toppings from one phrase's op never land on the other.
    {
      id: "hawaiian",
      name: "Hawaiian Pizza - Large 18''",
      category: "Pizza",
      ask_plan: {
        compiled_at: "", compiler_version: 1,
        display_name: "Hawaiian Pizza",
        base_price_cents: 1999, recap_template: "", ticket_template: "",
        steps: [toppingStep(TOPPING_CHOICES)],
      },
    },
    {
      id: "meatlovers",
      name: "Meat Lover's Pizza - Large 18''",
      category: "Pizza",
      ask_plan: {
        compiled_at: "", compiler_version: 1,
        display_name: "Meat Lover's Pizza",
        base_price_cents: 2199, recap_template: "", ticket_template: "",
        steps: [toppingStep(TOPPING_CHOICES)],
      },
    },
    // Calzone with same topping list — must NEVER be selected as a base pizza.
    {
      id: "pepp-calzone",
      name: "Pepperoni Calzone",
      category: "Calzones & Strombolis",
      ask_plan: {
        compiled_at: "", compiler_version: 1,
        display_name: "Pepperoni Calzone",
        base_price_cents: 999, recap_template: "", ticket_template: "",
        steps: [toppingStep(TOPPING_CHOICES)],
      },
    },
  ];
}

// ── HELPER ─────────────────────────────────────────────────────────────────

function asAdd(op: ResolvedOp): AddItemOp {
  assertEquals(op.kind, "add_item");
  return op as AddItemOp;
}

function asMiss(op: ResolvedOp): HonestMissOp {
  assertEquals(op.kind, "honest_miss");
  return op as HonestMissOp;
}

function asRemove(op: ResolvedOp): RemoveToppingOp {
  assertEquals(op.kind, "remove_topping");
  return op as RemoveToppingOp;
}

function asAsk(op: ResolvedOp): AskAmbiguityOp {
  assertEquals(op.kind, "ask_ambiguity");
  return op as AskAmbiguityOp;
}

// ── ACCEPTANCE TESTS ───────────────────────────────────────────────────────

// ── 1A. Pepperoni on the first pizza, NOT the second (direction A) ─────────
// THE ORIGINAL DEFECT: pepperoni was being applied to BOTH pizzas when the
// customer asked for it on only one. This test asserts the invariant by
// construction: the Meat Lover's phrase never sees the pepperoni token.
Deno.test("PHRASE ISOLATION — pepperoni on Hawaiian only (direction A): Hawaiian+pepperoni then Meat Lover's", () => {
  const menu = buildMenu();
  const ops = resolveUtterance("1 Hawaiian with pepperoni, 1 Meat Lover's", menu);

  assertEquals(ops.length, 2);

  const hawaiianOp = asAdd(ops[0]);
  assertEquals(hawaiianOp.itemId, "hawaiian");
  assertEquals(hawaiianOp.quantity, 1);
  assertEquals(hawaiianOp.addToppings.map(t => t.display), ["Pepperoni"]);

  const meatOp = asAdd(ops[1]);
  assertEquals(meatOp.itemId, "meatlovers");
  assertEquals(meatOp.quantity, 1);
  assertEquals(meatOp.addToppings, []); // pepperoni MUST NOT appear here

  // Resulting cart: only Hawaiian has pepperoni.
  const cart = applyOps(ops, []);
  assertEquals(cart.length, 2);
  assertEquals(cart[0].toppings, ["Pepperoni"]);
  assertEquals(cart[1].toppings, []); // Meat Lover's: no pepperoni
});

// ── 1B. Pepperoni on the second pizza, NOT the first (direction B) ─────────
// Same invariant, opposite phrase order: the Meat Lover's op is resolved
// before the Hawaiian, but pepperoni still lands only on Hawaiian.
Deno.test("PHRASE ISOLATION — pepperoni on Hawaiian only (direction B): Meat Lover's then Hawaiian+pepperoni", () => {
  const menu = buildMenu();
  const ops = resolveUtterance("1 Meat Lover's, 1 Hawaiian with pepperoni", menu);

  assertEquals(ops.length, 2);

  const meatOp = asAdd(ops[0]);
  assertEquals(meatOp.itemId, "meatlovers");
  assertEquals(meatOp.addToppings, []); // no pepperoni — it belongs to the other phrase

  const hawaiianOp = asAdd(ops[1]);
  assertEquals(hawaiianOp.itemId, "hawaiian");
  assertEquals(hawaiianOp.addToppings.map(t => t.display), ["Pepperoni"]);

  const cart = applyOps(ops, []);
  assertEquals(cart[0].toppings, []); // Meat Lover's: no pepperoni
  assertEquals(cart[1].toppings, ["Pepperoni"]); // Hawaiian: pepperoni
});

// ── 2. Three-pizza order with distinct toppings each ─────────────────────
// The canonical multi-item isolation test: three phrases, each with a
// different topping. No topping crosses a phrase boundary.
Deno.test("THREE-PIZZA ORDER — distinct toppings per pizza, none cross a phrase boundary", () => {
  const menu = buildMenu();
  const ops = resolveUtterance(
    "1 large cheese with pepperoni, 1 large cheese with mushrooms, 1 Hawaiian",
    menu,
  );

  assertEquals(ops.length, 3);

  const p1 = asAdd(ops[0]);
  assertEquals(p1.itemId, "neap-large");
  assertEquals(p1.addToppings.map(t => t.display), ["Pepperoni"]);

  const p2 = asAdd(ops[1]);
  assertEquals(p2.itemId, "neap-large");
  assertEquals(p2.addToppings.map(t => t.display), ["Mushrooms"]);

  const p3 = asAdd(ops[2]);
  assertEquals(p3.itemId, "hawaiian");
  assertEquals(p3.addToppings, []); // no spill-over from either cheese pizza phrase

  const cart = applyOps(ops, []);
  assertEquals(cart.length, 3);
  assertEquals(cart[0].toppings, ["Pepperoni"]);
  assertEquals(cart[1].toppings, ["Mushrooms"]);
  assertEquals(cart[2].toppings, []); // Hawaiian untouched
});

// ── 3. Multi-topping single pizza ─────────────────────────────────────────
// "with pepperoni and mushrooms" stays as ONE phrase; both toppings land
// on the same pizza. This must NOT split on the "and" between toppings.
Deno.test("MULTI-TOPPING — both toppings resolve to the same pizza, no split on 'and' between toppings", () => {
  const menu = buildMenu();
  const ops = resolveUtterance("large cheese pizza with pepperoni and mushrooms", menu);

  assertEquals(ops.length, 1);
  const op = asAdd(ops[0]);
  assertEquals(op.itemId, "neap-large");
  assertEquals(op.quantity, 1);
  assertEquals(op.addToppings.map(t => t.display).sort(), ["Mushrooms", "Pepperoni"].sort());

  const cart = applyOps(ops, []);
  assertEquals(cart.length, 1);
  assertEquals(cart[0].toppings.sort(), ["Mushrooms", "Pepperoni"].sort());
});

// ── 4. Topping the shop does not sell (D3 — the Honest Miss) ─────────────
// "anchovies" is not in Zio's topping list. The resolver must:
//   - add NOTHING to the cart
//   - return honest_miss with what the shop DOES have
//   - never guess or silently skip
Deno.test("HONEST MISS (D3) — topping not sold: nothing added, available toppings listed", () => {
  const menu = buildMenu();
  const ops = resolveUtterance("large cheese pizza with anchovies", menu);

  assertEquals(ops.length, 1);
  const op = asMiss(ops[0]);
  assertEquals(op.reason, "topping_not_sold");
  assertEquals(op.missedToken, "anchovies");
  // The shop's real topping list must be in availableInstead.
  assertEquals(op.availableInstead.includes("Pepperoni"), true);
  assertEquals(op.availableInstead.includes("Mushrooms"), true);
  assertEquals(op.gapLogged, true);

  // Cart must be empty — nothing was added.
  const cart = applyOps(ops, []);
  assertEquals(cart.length, 0);
});

// ── 5. Topping named before the item ──────────────────────────────────────
// "large pepperoni pizza" — topping word appears before the item word.
// The resolver must correctly identify "pepperoni" as the topping and
// "large pizza" as the base item (neap-large), never confuse the order.
Deno.test("TOPPING BEFORE ITEM — 'large pepperoni pizza' resolves topping correctly, not an item miss", () => {
  const menu = buildMenu();
  const ops = resolveUtterance("large pepperoni pizza", menu);

  assertEquals(ops.length, 1);
  const op = asAdd(ops[0]);
  assertEquals(op.itemId, "neap-large");
  assertEquals(op.addToppings.map(t => t.display), ["Pepperoni"]);

  const cart = applyOps(ops, []);
  assertEquals(cart[0].toppings, ["Pepperoni"]);
});

// ── 6. Quantity plus modifier in one phrase ────────────────────────────────
// "2 large cheese pizzas" — quantity 2, no toppings.
Deno.test("QUANTITY + MODIFIER — '2 large cheese pizzas' -> qty 2, neap-large, no toppings", () => {
  const menu = buildMenu();
  const ops = resolveUtterance("2 large cheese pizzas", menu);

  assertEquals(ops.length, 1);
  const op = asAdd(ops[0]);
  assertEquals(op.itemId, "neap-large");
  assertEquals(op.quantity, 2);
  assertEquals(op.addToppings, []);

  const cart = applyOps(ops, []);
  assertEquals(cart.length, 1);
  assertEquals(cart[0].quantity, 2);
  assertEquals(cart[0].toppings, []);
});

// ── 7. Correction — remove topping from one phrase only ───────────────────
// "remove pepperoni from the Hawaiian" targets the Hawaiian cart line.
// The Meat Lover's in the same cart must not be touched.
Deno.test("CORRECTION — 'remove pepperoni from the Hawaiian' only removes from Hawaiian, not from other cart items", () => {
  const menu = buildMenu();

  // Seed a cart that has both pizzas with pepperoni (simulating a prior
  // turn where pepperoni was accidentally added to both).
  const seeded = [
    { itemId: "hawaiian", itemName: "Hawaiian Pizza", quantity: 1, toppings: ["Pepperoni"] },
    { itemId: "meatlovers", itemName: "Meat Lover's Pizza", quantity: 1, toppings: ["Pepperoni"] },
  ];

  const lexicon = buildLexicon(menu);
  const op = resolvePhrase("remove pepperoni from the Hawaiian", lexicon);

  const removeOp = asRemove(op);
  assertEquals(removeOp.targetItemHint.toLowerCase().includes("hawaiian"), true);
  assertEquals(removeOp.toppingName.toLowerCase(), "pepperoni");

  const cart = applyOps([removeOp], seeded);
  // Hawaiian: pepperoni removed.
  assertEquals(cart[0].toppings, []);
  // Meat Lover's: pepperoni untouched.
  assertEquals(cart[1].toppings, ["Pepperoni"]);
});

// ── 8. Bare item with no toppings ─────────────────────────────────────────
// "1 Hawaiian" with no modifiers -> clean add_item, no toppings.
Deno.test("BARE ITEM — '1 Hawaiian' resolves to Hawaiian with no toppings", () => {
  const menu = buildMenu();
  const ops = resolveUtterance("1 Hawaiian", menu);

  assertEquals(ops.length, 1);
  const op = asAdd(ops[0]);
  assertEquals(op.itemId, "hawaiian");
  assertEquals(op.quantity, 1);
  assertEquals(op.addToppings, []);

  const cart = applyOps(ops, []);
  assertEquals(cart[0].toppings, []);
});

// ── 9. Comma-split isolation: three distinct items, all toppings isolated ──
// Full four-item utterance that triggered the original defect in production.
// Each item must produce its own op with only its own toppings.
Deno.test("FOUR-ITEM ORDER — four comma-phrases, each gets only its stated toppings", () => {
  const menu = buildMenu();
  const ops = resolveUtterance(
    "1 large cheese with sausage, 1 large cheese with onions, 1 Hawaiian, 1 Meat Lover's",
    menu,
  );

  assertEquals(ops.length, 4);

  const p1 = asAdd(ops[0]);
  assertEquals(p1.addToppings.map(t => t.display), ["Sausage"]);

  const p2 = asAdd(ops[1]);
  assertEquals(p2.addToppings.map(t => t.display), ["Onions"]);

  const p3 = asAdd(ops[2]);
  assertEquals(p3.itemId, "hawaiian");
  assertEquals(p3.addToppings, []);

  const p4 = asAdd(ops[3]);
  assertEquals(p4.itemId, "meatlovers");
  assertEquals(p4.addToppings, []);

  const cart = applyOps(ops, []);
  assertEquals(cart.length, 4);
  assertEquals(cart[0].toppings, ["Sausage"]);
  assertEquals(cart[1].toppings, ["Onions"]);
  assertEquals(cart[2].toppings, []);
  assertEquals(cart[3].toppings, []);
});

// ── 10. No size specified + multiple variants -> ask_ambiguity, never guess ─
// "cheese pizza with pepperoni" — the shop has S, M, L. The resolver must
// ask rather than silently pick the largest or cheapest.
Deno.test("AMBIGUITY — no size stated with multiple size variants: ask, never guess", () => {
  const menu = buildMenu();
  const ops = resolveUtterance("cheese pizza with pepperoni", menu);

  assertEquals(ops.length, 1);
  const op = asAsk(ops[0]);
  assertEquals(op.kind, "ask_ambiguity");
  // Candidates must include all three Neapolitan sizes.
  const names = op.candidates.join(" ").toLowerCase();
  assertEquals(names.includes("small"), true);
  assertEquals(names.includes("medium"), true);
  assertEquals(names.includes("large"), true);

  // Cart must be empty — nothing was added.
  const cart = applyOps(ops, []);
  assertEquals(cart.length, 0);
});

// ── 11. splitPhrases structural isolation sanity check ────────────────────
// Verify that the splitter never borrows a token from one phrase string into
// another. This is a unit test of the split itself, not the resolver.
Deno.test("SPLIT SANITY — comma-separated phrases are independent strings with no shared tokens", () => {
  const menu = buildMenu();
  const lexicon = buildLexicon(menu);
  const phrases = splitPhrases("1 Hawaiian with pepperoni, 1 Meat Lover's", lexicon);

  assertEquals(phrases.length, 2);
  // "pepperoni" must live in phrase 0 and NOT in phrase 1.
  assertEquals(phrases[0].includes("pepperoni"), true);
  assertEquals(phrases[1].toLowerCase().includes("pepperoni"), false);
});

// ── 12. Item not found at all (full honest miss) ───────────────────────────
// "lobster bisque" — not on Zio's pizza menu at all.
Deno.test("HONEST MISS — item not on menu: nothing added, available items listed", () => {
  const menu = buildMenu();
  const ops = resolveUtterance("lobster bisque", menu);

  assertEquals(ops.length, 1);
  const op = asMiss(ops[0]);
  assertEquals(op.reason, "item_not_found");
  assertEquals(op.gapLogged, true);
  // availableInstead must list real menu items.
  assertEquals(op.availableInstead.length > 0, true);

  const cart = applyOps(ops, []);
  assertEquals(cart.length, 0);
});

// ── ROUND 2 (2026-09-09): exact whole-name match fixes ─────────────────────
// The live menu-readiness walk found real dish names the round-1 resolver
// could never resolve to themselves: names built entirely from words the
// resolver treats as generic noise ("Side Salad"), names sharing a flavor
// word with an unrelated item in a different format ("Turkey Wrap" vs
// "Turkey Sub"), names containing "with" or a comma as part of the name
// itself rather than a topping clause or phrase separator, and names
// leading with a numeral that parseQuantity would otherwise strip as an
// order quantity. Each fixture below is isolated (not the shared pizza
// buildMenu()) to keep these cases from interacting with the pizza-specific
// ambiguity/tiebreak tests above.

function nonPizzaMenu(): ComposeMenuItem[] {
  return [
    { id: "side-salad", name: "Side Salad", category: "Salads", ask_plan: null },
    { id: "turkey-wrap", name: "Turkey Wrap", category: "Wraps", ask_plan: null },
    { id: "turkey-sub", name: "Turkey Sub", category: "Subs", ask_plan: null },
    { id: "wings-bonein", name: "10 Pieces Wings (Bone-In)", category: "Wings", ask_plan: null },
    { id: "wings-boneless", name: "10 Pieces Wings (Boneless)", category: "Wings", ask_plan: null },
    { id: "pierogies-onions", name: "Sauteed Pierogies With Onions (5)", category: "Sides", ask_plan: null },
    { id: "cbr-pizza", name: "Chicken, Bacon & Ranch Pizza", category: "Pizza", ask_plan: null },
    { id: "double-burger-1", name: "Double Burger", category: "Burgers", ask_plan: null },
    { id: "double-burger-2", name: "Double Burger", category: "Burgers", ask_plan: null },
  ] as unknown as ComposeMenuItem[];
}

Deno.test("EXACT NAME MATCH — name built entirely from generic words ('Side Salad') still resolves", () => {
  const ops = resolveUtterance("Side Salad", nonPizzaMenu());
  assertEquals(ops.length, 1);
  assertEquals(asAdd(ops[0]).itemId, "side-salad");
});

Deno.test("EXACT NAME MATCH — shared flavor word across formats resolves to the format actually named ('Turkey Wrap' vs 'Turkey Sub')", () => {
  const wrapOps = resolveUtterance("Turkey Wrap", nonPizzaMenu());
  assertEquals(wrapOps.length, 1);
  assertEquals(asAdd(wrapOps[0]).itemId, "turkey-wrap");

  const subOps = resolveUtterance("Turkey Sub", nonPizzaMenu());
  assertEquals(subOps.length, 1);
  assertEquals(asAdd(subOps[0]).itemId, "turkey-sub");
});

Deno.test("EXACT NAME MATCH — leading numeral that is part of the dish's own name is not stripped as a quantity ('10 Pieces Wings (Bone-In)' vs '(Boneless)')", () => {
  const boneInOps = resolveUtterance("10 Pieces Wings (Bone-In)", nonPizzaMenu());
  assertEquals(boneInOps.length, 1);
  assertEquals(asAdd(boneInOps[0]).itemId, "wings-bonein");

  const bonelessOps = resolveUtterance("10 Pieces Wings (Boneless)", nonPizzaMenu());
  assertEquals(bonelessOps.length, 1);
  assertEquals(asAdd(bonelessOps[0]).itemId, "wings-boneless");
});

Deno.test("EXACT NAME MATCH — 'with' inside the dish's own name is not parsed as a topping clause", () => {
  const ops = resolveUtterance("Sauteed Pierogies With Onions (5)", nonPizzaMenu());
  assertEquals(ops.length, 1);
  const op = asAdd(ops[0]);
  assertEquals(op.itemId, "pierogies-onions");
  assertEquals(op.addToppings, []); // "Onions" must not be split off as a topping request
});

Deno.test("EXACT NAME MATCH — comma inside the dish's own name is not parsed as a phrase separator", () => {
  const ops = resolveUtterance("Chicken, Bacon & Ranch Pizza", nonPizzaMenu());
  assertEquals(ops.length, 1);
  assertEquals(asAdd(ops[0]).itemId, "cbr-pizza");
});

Deno.test("GENUINE DUPLICATE NAME — two distinct items sharing one display_name still ask/miss, never guess", () => {
  const ops = resolveUtterance("Double Burger", nonPizzaMenu());
  assertEquals(ops.length, 1);
  const op = asMiss(ops[0]);
  assertEquals(op.reason, "item_not_found"); // ambiguous between the two ids — missing beats wrong
});

// ── ROUND 3 (2026-09-09 P0): 6-phrasing matrix for phrase splitter ────────
// Defect: splitPhrases used splitOnAndItem whose andRe lacked word-numbers
// ("one", "two", etc.) as valid QTY_LEAD, so "one meat lover and one hawaai"
// was NOT split at the "and" boundary — Pepperoni bled from an earlier phrase
// into Hawaiian and Meat Lover's on live orders. Fourth recurrence of the
// pepperoni-bleed defect; prior fix certified from a single phrasing only.
//
// Fix: replaced splitOnAndItem with a regex matching phrase-split.ts exactly.
// All 6 phrasings must yield 4 independent phrases. Case 6 "gimme a plain..."
// splits correctly (4 phrases) but resolveUtterance("gimme a plain", ...) may
// not resolve — "gimme" is filler that blocks pizza-context fallback; this is
// a known resolution limit, documented below, not a splitter defect.

function buildMatrixMenu(): ComposeMenuItem[] {
  const noSteps = { compiled_at: "", compiler_version: 1 as const, display_name: "", base_price_cents: 0, recap_template: "", ticket_template: "", steps: [] };
  return [
    { id: "plain",     name: "Plain Pizza",        category: "Pizza", ask_plan: { ...noSteps, display_name: "Plain Pizza",        base_price_cents: 1599 } },
    { id: "pepperoni", name: "Pepperoni Pizza",     category: "Pizza", ask_plan: { ...noSteps, display_name: "Pepperoni Pizza",     base_price_cents: 1799 } },
    { id: "meatlovers",name: "Meat Lover's Pizza",  category: "Pizza", ask_plan: { ...noSteps, display_name: "Meat Lover's Pizza",  base_price_cents: 2199 } },
    { id: "hawaiian",  name: "Hawaiian Pizza",      category: "Pizza", ask_plan: { ...noSteps, display_name: "Hawaiian Pizza",      base_price_cents: 1999 } },
  ];
}

const SPLIT_MATRIX: [string, string][] = [
  ["1 pepp, 1 plain, 1 hawaiin, 1 meat lovers",                    "comma-digit"],
  ["one plain, one pepperoni, one meat lover and one hawaai",       "word-qty+and (live failure)"],
  ["a plain, a pepperoni, a meat lovers and a hawaiian",            "article+and"],
  ["plain pizza, pepperoni pizza, meat lovers pizza, hawaiian pizza","comma-noun"],
  ["1 cheese 1 pepperoni 1 meat lover 1 hawaiian",                  "implicit-digit"],
  ["gimme a plain and a pepperoni and a meat lovers and a hawaiian", "and-chain (filler lead)"],
];

Deno.test("PHRASE MATRIX — all 6 phrasings split into exactly 4 independent phrases", () => {
  const menu = buildMatrixMenu();
  const lexicon = buildLexicon(menu);
  for (const [utterance, label] of SPLIT_MATRIX) {
    const phrases = splitPhrases(utterance, lexicon);
    assertEquals(phrases.length, 4, `[${label}] expected 4 phrases, got ${phrases.length}: ${JSON.stringify(phrases)}`);
  }
});

Deno.test("RESOLVE MATRIX — phrasings 1-5 resolve to exactly 4 add_item ops (no bleed)", () => {
  const menu = buildMatrixMenu();
  for (const [utterance, label] of SPLIT_MATRIX.slice(0, 5)) {
    const ops = resolveUtterance(utterance, menu);
    const adds = ops.filter(op => op.kind === "add_item");
    assertEquals(adds.length, 4, `[${label}] expected 4 add_item ops, got ${adds.length}: ${JSON.stringify(ops.map(o => o.kind))}`);
  }
});

// Case 6 known limit: the split is correct (4 phrases) but "gimme a plain"
// does not resolve because "gimme" is unstrippable filler that precedes the
// pizza name and blocks the plain-pizza context-fallback path. Document this
// honestly rather than pretending it passes.
Deno.test("RESOLVE MATRIX case 6 — KNOWN LIMIT: 'gimme a plain...' splits correctly but first phrase may not resolve", () => {
  const menu = buildMatrixMenu();
  const lexicon = buildLexicon(menu);
  // Split must still be 4 phrases — the splitter is correct.
  const phrases = splitPhrases("gimme a plain and a pepperoni and a meat lovers and a hawaiian", lexicon);
  assertEquals(phrases.length, 4, `expected 4 phrases from case-6 utterance`);
  assertEquals(phrases[0], "gimme a plain");
  assertEquals(phrases[1], "a pepperoni");
  assertEquals(phrases[2], "a meat lovers");
  assertEquals(phrases[3], "a hawaiian");
  // Phrases 2-4 (zero-indexed 1-3) should resolve cleanly.
  for (const phrase of phrases.slice(1)) {
    const ops = resolveUtterance(phrase, menu);
    const adds = ops.filter(op => op.kind === "add_item");
    assertEquals(adds.length, 1, `phrase "${phrase}" expected 1 add, got ${adds.length}`);
  }
});
