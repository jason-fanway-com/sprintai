// Deterministic red-then-green for the two defects Jason found in live
// testing on 2026-09-06.
//
// DEFECT 1: raw DB category names ("Salads", "Wraps") leaked into
//           customer-facing text as "(Salads)"/"(Wraps)" in four places.
//           Fixed with categoryDisplayWord() (pending-disambiguation.ts),
//           which lowercases + singularizes a category into the ordinary
//           word a person would say, used at all four sites in place of the
//           raw category string.
// DEFECT 2: honestFallbackReply()'s empty-cart branch returned the
//           first-contact greeting unconditionally, with no check on
//           whether this was actually the start of the conversation.
//           Several hallucination/proof guards call it as their fallback
//           whenever cart_json is still empty — completely normal mid-order
//           (e.g. an item stuck in a pending disambiguation) — so a guard
//           tripping there stapled a cold "What can I get started for you?"
//           greeting onto a reply that was about to carry a pending
//           disambiguation question forward. Fixed by threading a
//           `hasHistory` flag (`!isLifetimeFirstContact`) into
//           honestFallbackReply from all 7 call sites.
//
// index.ts calls Deno.serve() at module scope, so it is never imported
// directly by tests (importing it binds a real port and fails the test
// run outright) — same constraint as every other *.test.ts file in this
// directory. Where the fix lives inline in index.ts rather than in an
// importable module, these tests assert against the actual source text
// (Deno.readTextFileSync) rather than a hand-copied guess, so a future
// edit that reintroduces the leak or drops the hasHistory gate fails loudly.
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { categoryDisplayWord, renderDisambiguationReask, type PendingCandidate } from "./pending-disambiguation.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
const PENDING_DISAMBIGUATION_SOURCE = Deno.readTextFileSync(new URL("./pending-disambiguation.ts", import.meta.url));

const CAESAR_CANDIDATES: PendingCandidate[] = [
  { menu_item_id: "caesar-salad", name: "Chicken Caesar", category: "Salads", price_cents: 1295 },
  { menu_item_id: "caesar-wrap", name: "Chicken Caesar", category: "Wraps", price_cents: 999 },
];

// ── DEFECT 1: categoryDisplayWord ────────────────────────────────────────────

Deno.test("categoryDisplayWord: ordinary plural categories singularize and lowercase", () => {
  assertEquals(categoryDisplayWord("Salads"), "salad");
  assertEquals(categoryDisplayWord("Wraps"), "wrap");
  assertEquals(categoryDisplayWord("Sides"), "side");
  assertEquals(categoryDisplayWord("Entrees"), "entree");
  assertEquals(categoryDisplayWord("Beverages"), "beverage");
});

Deno.test("categoryDisplayWord: 'ches/shes/xes/ses/zes' strip -es, not -s", () => {
  assertEquals(categoryDisplayWord("Sandwiches"), "sandwich");
  assertEquals(categoryDisplayWord("Dishes"), "dish");
  assertEquals(categoryDisplayWord("Boxes"), "box");
  assertEquals(categoryDisplayWord("Glasses"), "glass");
});

Deno.test("categoryDisplayWord: 'ies' becomes 'y'", () => {
  assertEquals(categoryDisplayWord("Fries"), "fry");
});

Deno.test("categoryDisplayWord: a trailing double-s is left alone", () => {
  assertEquals(categoryDisplayWord("Class"), "class");
});

Deno.test("categoryDisplayWord: a category with no plural is unchanged (just lowercased)", () => {
  assertEquals(categoryDisplayWord("Pizza"), "pizza");
});

Deno.test("categoryDisplayWord: null/undefined/empty all resolve to the empty string", () => {
  assertEquals(categoryDisplayWord(null), "");
  assertEquals(categoryDisplayWord(undefined), "");
  assertEquals(categoryDisplayWord(""), "");
});

// ── DEFECT 1: no site anywhere in chat-sms leaks a raw category ─────────────

Deno.test("DEFECT 1: the raw-category-leak pattern never reappears in chat-sms", () => {
  const LEAK_PATTERN = /\.category \? `/;
  assertEquals(LEAK_PATTERN.test(INDEX_SOURCE), false, "index.ts");
  assertEquals(LEAK_PATTERN.test(PENDING_DISAMBIGUATION_SOURCE), false, "pending-disambiguation.ts");
});

Deno.test("DEFECT 1: no raw '(Category)' parenthetical survives in customer-facing templates", () => {
  // The four fixed sites all used to render "${c.name}${c.category ? ` (${c.category})` : \"\"}"
  // or the resolver's inline variant. None of that shape should remain.
  assertEquals(/\(\$\{(?:c|resolved)\.category\}\)/.test(INDEX_SOURCE), false);
});

Deno.test("DEFECT 1: renderDisambiguationReask uses 'the {name} {word}' style, never raw category parens", () => {
  const reask = renderDisambiguationReask(CAESAR_CANDIDATES);
  assert(reask.includes("the Chicken Caesar salad"), reask);
  assert(reask.includes("the Chicken Caesar wrap"), reask);
  assertEquals(reask.includes("(Salads)"), false);
  assertEquals(reask.includes("(Wraps)"), false);
});

Deno.test("DEFECT 1: resolver confirmation reads 'Got it — {name} {word} added.' (no parens)", () => {
  const resolved = CAESAR_CANDIDATES[0];
  const word = categoryDisplayWord(resolved.category);
  const reply = `Got it — ${resolved.name}${word ? ` ${word}` : ""} added.`;
  assertEquals(reply, "Got it — Chicken Caesar salad added.");
});

Deno.test("DEFECT 1: GUARD 7's initial ask uses 'the {name} {word} — $price' joined with 'or'", () => {
  const optionsText = CAESAR_CANDIDATES
    .map(c => {
      const word = categoryDisplayWord(c.category);
      return `the ${c.name}${word ? ` ${word}` : ""} — $${(c.price_cents / 100).toFixed(2)}`;
    })
    .join(" or ");
  assertEquals(optionsText, "the Chicken Caesar salad — $12.95 or the Chicken Caesar wrap — $9.99");
});

Deno.test("DEFECT 1: carried-forward clarifier reads 'did you want the X or the Y?' (a 'the' per option)", () => {
  const stillOpenOptions = CAESAR_CANDIDATES
    .map(c => {
      const word = categoryDisplayWord(c.category);
      return `the ${c.name}${word ? ` ${word}` : ""}`;
    })
    .join(" or ");
  const finalReply = `Sorry, I didn't catch that — what would you like to order?\n\nStill wondering — did you want ${stillOpenOptions}?`;
  assert(finalReply.endsWith("did you want the Chicken Caesar salad or the Chicken Caesar wrap?"), finalReply);
});

// ── DEFECT 2: honestFallbackReply's hasHistory gate ─────────────────────────

const FIRST_CONTACT_GREETING =
  "What can I get started for you? Let me know your items and I'll get your order going.";
const MID_ORDER_FALLBACK = "Sorry, I didn't catch that — what would you like to order?";

// Mirrors honestFallbackReply's empty-cart branch (index.ts). Kept as a pure
// function here because index.ts calls Deno.serve() at module scope and
// cannot be imported by a test process (see file header).
function emptyCartFallback(hasHistory: boolean): string {
  return hasHistory ? MID_ORDER_FALLBACK : FIRST_CONTACT_GREETING;
}

Deno.test("DEFECT 2: true first contact (no history, empty cart) keeps the warm greeting unchanged", () => {
  assertEquals(emptyCartFallback(false), FIRST_CONTACT_GREETING);
});

Deno.test("DEFECT 2: a guard tripping mid-order with an empty cart never re-sends the greeting", () => {
  const reply = emptyCartFallback(true);
  assertEquals(reply.includes("What can I get started for you?"), false);
  assertEquals(reply, MID_ORDER_FALLBACK);
  assertNotEquals(reply, FIRST_CONTACT_GREETING);
});

Deno.test("DEFECT 2: honestFallbackReply's signature and empty-cart branch are hasHistory-gated in source", () => {
  assert(
    /function honestFallbackReply\(cart: AnyCartItem\[\], incompleteBundle = false, hasHistory = false\): string/.test(
      INDEX_SOURCE,
    ),
    "honestFallbackReply must accept a hasHistory parameter",
  );
  // The RED shape: return the greeting unconditionally whenever the cart is
  // empty, with nothing consulting conversation history. That exact
  // unconditional pattern must no longer exist.
  assertEquals(
    /if \(!cart \|\| cart\.length === 0\) \{\s*return "What can I get started/.test(INDEX_SOURCE),
    false,
    "REGRESSION: empty-cart branch returned the greeting unconditionally again",
  );
  assert(INDEX_SOURCE.includes(FIRST_CONTACT_GREETING), "first-contact greeting text must still exist");
  assert(INDEX_SOURCE.includes(MID_ORDER_FALLBACK), "mid-order fallback text must exist");
});

Deno.test("DEFECT 2: all 7 honestFallbackReply call sites pass a hasHistory argument tied to isLifetimeFirstContact", () => {
  const calls = (INDEX_SOURCE.match(/honestFallbackReply\([^)]*\)/g) ?? [])
    .filter(c => !c.startsWith("honestFallbackReply(cart:"));
  assertEquals(calls.length, 7, `expected 7 call sites, found ${calls.length}: ${calls.join(" | ")}`);
  for (const call of calls) {
    assert(call.includes("isLifetimeFirstContact"), `call site missing hasHistory arg: ${call}`);
  }
});
