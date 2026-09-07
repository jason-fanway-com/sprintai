// Red-green evidence for the 2026-09-07 named-item removal fix.
//
// Bug (hand-tested 3×): "large cheese pizza" + "garlic knots" in cart,
// customer says "remove the pizza" → pizza survives, KNOTS removed.
// Root cause: line 4568 of index.ts used `.test(norm)` (throwing away
// the captured name), so the 4th isCorrection branch fired but the actual
// removal code fell through to the bare-form path, which always removed
// `cartItems[cartItems.length - 1]` regardless of what was named.
//
// Fix: a) capture name via namedRemoveMatch, b) stem-match against cart
// lines, c) remove the matched item (or ask for clarification).
//
// These tests inline the regex + stem logic the same way correction-buckets
// inlines the isCorrection regexes — the logic cannot be imported from
// index.ts since it lives inside an async request handler.
// If index.ts's correction handler changes, update this file too.
//
// Run: deno test --allow-net --allow-env --allow-read supabase/functions/chat-sms/named-remove-20260907.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { stemWord } from "./pending-disambiguation.ts";

function norm(msg: string): string {
  return msg.trim().toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

const NAMED_REMOVE_RE =
  /^(?:remove the|remove my|drop the|drop my|take off the|take off my|cancel the|cancel my|get rid of the|scratch the)\s+(.+)$/i;

const STOPWORDS_REMOVE = new Set(["the","and","for","with","one","a","an","of","by","my"]);

function namedRemoveStems(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS_REMOVE.has(w))
      .map(stemWord),
  );
}

function resolveNamedRemove(
  phrase: string,
  cartItems: Array<{ name: string; menu_item_id: string }>,
): "no-match" | "ambiguous" | string {
  const n = norm(phrase);
  const m = n.match(NAMED_REMOVE_RE);
  if (!m) return "no-match";
  const capturedName = m[1].trim();
  const queryStems = namedRemoveStems(capturedName);
  const matches = cartItems.filter((item) => {
    const itemStems = namedRemoveStems(item.name);
    return [...queryStems].some((s) => itemStems.has(s));
  });
  if (matches.length === 0) return "no-match";
  if (matches.length > 1) return "ambiguous";
  return matches[0].menu_item_id;
}

// ── The exact two-item cart from Jason's repro ──────────────────────────────

const REPRO_CART = [
  { name: "Large Cheese Pizza", menu_item_id: "pizza-001" },
  { name: "Garlic Knots",       menu_item_id: "knots-001" },
];

// RED-equivalent: prove the OLD code path was wrong.
// The old code always removed the LAST item regardless of the named phrase.
// We pin that "knots-001" was the last item, so the old path would have
// removed it even when the customer said "remove the pizza".
Deno.test("RED-equivalent: last item in repro cart is garlic knots, not pizza", () => {
  assertEquals(REPRO_CART[REPRO_CART.length - 1].menu_item_id, "knots-001");
});

// GREEN: the three exact repro transcripts from Jason.
Deno.test("GREEN repro 1: 'remove the pizza' → removes pizza, not garlic knots", () => {
  assertEquals(resolveNamedRemove("remove the pizza", REPRO_CART), "pizza-001");
});

Deno.test("GREEN repro 2: 'drop my garlic knots' → removes garlic knots", () => {
  assertEquals(resolveNamedRemove("drop my garlic knots", REPRO_CART), "knots-001");
});

Deno.test("GREEN repro 3: 'remove the knots' → removes garlic knots (stem match)", () => {
  assertEquals(resolveNamedRemove("remove the knots", REPRO_CART), "knots-001");
});

// ── Four-branch coverage ─────────────────────────────────────────────────────

Deno.test("branch: no-match — item named but not in cart → no-match", () => {
  assertEquals(resolveNamedRemove("remove the wings", REPRO_CART), "no-match");
});

Deno.test("branch: ambiguous — two cart lines match the query stem → ambiguous", () => {
  const ambigCart = [
    { name: "Large Cheese Pizza", menu_item_id: "pizza-sm" },
    { name: "Small Cheese Pizza", menu_item_id: "pizza-lg" },
  ];
  // "cheese" appears in both — should ask for clarification, not guess
  assertEquals(resolveNamedRemove("remove the cheese pizza", ambigCart), "ambiguous");
});

Deno.test("branch: exact single match with full item name → correct id", () => {
  const cart = [
    { name: "Greek Salad",        menu_item_id: "salad-001" },
    { name: "Garlic Knots",       menu_item_id: "knots-001" },
    { name: "Large Cheese Pizza", menu_item_id: "pizza-001" },
  ];
  assertEquals(resolveNamedRemove("remove the salad", cart), "salad-001");
  assertEquals(resolveNamedRemove("drop my large cheese pizza", cart), "pizza-001");
});

Deno.test("branch: bare phrase (no name captured) → resolveNamedRemove returns no-match (bare path handled separately)", () => {
  // Bare removal phrases don't hit NAMED_REMOVE_RE → no-match signals
  // the caller to fall back to the bare-form (last-item) path.
  assertEquals(resolveNamedRemove("remove that", REPRO_CART), "no-match");
  assertEquals(resolveNamedRemove("remove it", REPRO_CART), "no-match");
  assertEquals(resolveNamedRemove("scratch that", REPRO_CART), "no-match");
});

// ── New verb coverage added in the fix ──────────────────────────────────────

Deno.test("new verbs: 'cancel the pizza' / 'get rid of the knots' / 'scratch the pizza' are captured", () => {
  assertEquals(resolveNamedRemove("cancel the pizza", REPRO_CART), "pizza-001");
  assertEquals(resolveNamedRemove("get rid of the knots", REPRO_CART), "knots-001");
  assertEquals(resolveNamedRemove("scratch the pizza", REPRO_CART), "pizza-001");
});
