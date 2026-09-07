// FIX (2026-09-06, Jason — live QA): identical input ("chicken caesar
// salad"), three fresh sessions, three different journeys. Vito's Pizza
// (Jack's Slice menu) has two active menu_items both literally named
// "Chicken Caesar" — one in category "Salads" (required Dressing option
// group, no is_default choice set), one in category "Wraps" (dressing baked
// into the fixed recipe, no option group at all). GUARD 7/7b (the existing
// same-name disambiguation guards) only react AFTER the LLM has already
// acted — an ambiguous add_item rolled back, or a free-text question asked
// — which is exactly why the journey varied: the model sometimes asked
// "salad or wrap?" even though "salad" already disambiguates, and sometimes
// added the wrong thing or invented a dressing nobody named.
//
// GUARD 7c runs BEFORE the LLM/tool loop, on the customer's fresh message,
// using the SAME categoryWordMatches() the reactive guards already trust
// (imported for real from pending-disambiguation.ts, which already has its
// own dedicated test file — not re-tested here). If the message names a
// duplicate-name item family AND a category word in that SAME message
// resolves to exactly one candidate, it resolves and adds directly. A bare
// "chicken caesar" with no category word supplies no signal (0 matches) and
// is left alone — genuine ambiguity still asks, unchanged.
//
// The actual add_item call, executeTool, sendSms etc. are real I/O and not
// re-tested here (that's what the shared executeTool/is_default tests
// already cover) — this file tests the pure "which candidate, if any, does
// this message resolve to" decision, copied verbatim from index.ts, plus
// wiring assertions against the live file.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { categoryWordMatches } from "./pending-disambiguation.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

interface Candidate {
  id: string;
  name: string;
  category: string | null;
}

// Copied verbatim from GUARD 7c's resolution logic in index.ts, including:
// (a) the adjacency-based negation check (QA-found: "I don't want the
// chicken caesar salad" would have been ADDED despite the negation),
// deliberately adjacency-based (negation immediately before the ITEM NAME,
// same pattern GUARD 4 v2's negation-filter uses) so "chicken caesar salad,
// no croutons please" — negation about an unrelated topping — still resolves;
// (b) the question gate (QA-found LIVE, the more serious gap: "how much is
// the chicken caesar salad?" was being silently ADDED, never answered).
// Order-intent phrases are always allowed through even with a "?", since
// customers politely phrase real orders as questions.
function resolveByCategoryWord(userMessage: string, candidates: Candidate[], name: string): Candidate | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const negRe = new RegExp(
    `\\b(?:no|not|remove|skip|drop|scratch|cancel(?:ling)?|(?:don['’]?t|do\\s+not|dont)\\s+(?:want|need|get|add))\\s+(?:the\\s+)?(?:any\\s+)?${escapedName}\\b`,
    "i",
  );
  if (negRe.test(userMessage)) return null;
  const hasOrderIntent = /\b(?:i'?ll\s+(?:have|take|get)|i\s+want|i'?d\s+like|give\s+me|let\s+me\s+get|(?:can|could)\s+(?:i|we)\s+(?:get|have|order|grab))\b/i.test(userMessage);
  if (!hasOrderIntent) {
    const looksLikeQuestion = /\?/.test(userMessage) || /^\s*(?:how|what|is|are|does|do|did|was|were|will|can\s+you|could\s+you)\b/i.test(userMessage);
    if (looksLikeQuestion) return null;
  }
  const categoryMatches = candidates.filter(c => categoryWordMatches(c.category, userMessage));
  if (categoryMatches.length !== 1) return null;
  return categoryMatches[0];
}

const CHICKEN_CAESAR_SALAD: Candidate = { id: "salad-id", name: "Chicken Caesar", category: "Salads" };
const CHICKEN_CAESAR_WRAP: Candidate = { id: "wrap-id", name: "Chicken Caesar", category: "Wraps" };
const CANDIDATES = [CHICKEN_CAESAR_SALAD, CHICKEN_CAESAR_WRAP];

Deno.test("GUARD 7c decision: 'chicken caesar salad' resolves to the Salads candidate every time", () => {
  const resolved = resolveByCategoryWord("chicken caesar salad", CANDIDATES, "chicken caesar");
  assertEquals(resolved?.id, "salad-id");
});

Deno.test("GUARD 7c decision: 'can I get a chicken caesar wrap' resolves to the Wraps candidate every time", () => {
  const resolved = resolveByCategoryWord("can I get a chicken caesar wrap", CANDIDATES, "chicken caesar");
  assertEquals(resolved?.id, "wrap-id");
});

Deno.test("GUARD 7c decision: a bare 'chicken caesar' with no category word supplies no signal — genuinely ambiguous, untouched", () => {
  const resolved = resolveByCategoryWord("chicken caesar", CANDIDATES, "chicken caesar");
  assertEquals(resolved, null);
});

Deno.test("GUARD 7c decision: is deterministic — the same message always resolves the same way", () => {
  const results = Array.from({ length: 20 }, () => resolveByCategoryWord("chicken caesar salad", CANDIDATES, "chicken caesar")?.id);
  assert(results.every(r => r === "salad-id"), `every run must resolve identically, got: ${JSON.stringify(results)}`);
});

// QA-found before ship: without the decline check, this would add the item
// the customer just said they DIDN'T want.
Deno.test("GUARD 7c decision: 'I don't want the chicken caesar salad' is a decline, never an add", () => {
  const resolved = resolveByCategoryWord("I don't want the chicken caesar salad", CANDIDATES, "chicken caesar");
  assertEquals(resolved, null);
});

Deno.test("GUARD 7c decision: 'no chicken caesar wrap for me' is a decline, never an add", () => {
  const resolved = resolveByCategoryWord("no chicken caesar wrap for me", CANDIDATES, "chicken caesar");
  assertEquals(resolved, null);
});

Deno.test("GUARD 7c decision: a genuine order is not mistaken for a decline just because 'no' appears elsewhere", () => {
  // sanity check the decline check isn't so broad it eats real orders
  const resolved = resolveByCategoryWord("chicken caesar salad, no croutons please", CANDIDATES, "chicken caesar");
  assertEquals(resolved?.id, "salad-id");
});

Deno.test("QA regression: widened negation catches 'dont' without an apostrophe", () => {
  assertEquals(resolveByCategoryWord("dont want the chicken caesar salad", CANDIDATES, "chicken caesar"), null);
});

Deno.test("QA regression: widened negation catches 'do not want'", () => {
  assertEquals(resolveByCategoryWord("do not want the chicken caesar salad", CANDIDATES, "chicken caesar"), null);
});

Deno.test("QA regression: widened negation catches 'don't add'", () => {
  assertEquals(resolveByCategoryWord("don't add the chicken caesar wrap", CANDIDATES, "chicken caesar"), null);
});

// QA (Melvin, 2026-09-06, live-fired against v254 before this fix): a
// customer ASKING ABOUT a duplicate-name item was being silently ADDED to
// the cart and never answered. Headline finding — this is the more serious
// gap, worse than the negation one.
Deno.test("QA regression LIVE-FOUND: 'how much is the chicken caesar salad?' is a question, never an add", () => {
  assertEquals(resolveByCategoryWord("how much is the chicken caesar salad?", CANDIDATES, "chicken caesar"), null);
});

Deno.test("QA regression LIVE-FOUND: 'is the chicken caesar salad gluten free?' is a question, never an add", () => {
  assertEquals(resolveByCategoryWord("is the chicken caesar salad gluten free?", CANDIDATES, "chicken caesar"), null);
});

Deno.test("QA regression LIVE-FOUND: 'do you have a chicken caesar wrap?' is a question, never an add", () => {
  assertEquals(resolveByCategoryWord("do you have a chicken caesar wrap?", CANDIDATES, "chicken caesar"), null);
});

Deno.test("question gate: order-intent phrasing is allowed through even with a question mark", () => {
  assertEquals(resolveByCategoryWord("can I get a chicken caesar wrap?", CANDIDATES, "chicken caesar")?.id, "wrap-id");
  assertEquals(resolveByCategoryWord("I'll have the chicken caesar salad, please?", CANDIDATES, "chicken caesar")?.id, "salad-id");
});

Deno.test("question gate: a bare statement with no '?' and no interrogative opener still resolves", () => {
  assertEquals(resolveByCategoryWord("chicken caesar salad", CANDIDATES, "chicken caesar")?.id, "salad-id");
});

// ── Wiring regression guards against the live file ─────────────────────────

function extractBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert(start !== -1, `start marker not found in index.ts: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert(end !== -1, `end marker not found after start in index.ts: ${endMarker}`);
  return source.slice(start, end);
}

Deno.test("GUARD 7c wiring: runs BEFORE the LLM/tool loop, ahead of pending option-answer resolution", () => {
  const guard7cIdx = INDEX_SOURCE.indexOf("// ── Guard 7c (2026-09-06, Jason");
  const pendingOptionIdx = INDEX_SOURCE.indexOf("// ── Pending option-answer resolution (DEFECT 1");
  assert(guard7cIdx !== -1 && pendingOptionIdx !== -1, "both markers must exist");
  assert(guard7cIdx < pendingOptionIdx, "GUARD 7c must run before the LLM/tool loop gets a turn");
});

Deno.test("GUARD 7c wiring: only resolves on EXACTLY one category match — never 0 (no signal) or 2+ (still ambiguous)", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 7c (2026-09-06, Jason", "// ── Pending option-answer resolution (DEFECT 1");
  assert(block.includes("categoryMatches7c.length !== 1) continue"), "must skip (fall through to the LLM) on anything other than exactly one match");
});

Deno.test("GUARD 7c wiring: uses the real categoryWordMatches, not a reimplementation", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 7c (2026-09-06, Jason", "// ── Pending option-answer resolution (DEFECT 1");
  assert(block.includes("categoryWordMatches(c.category, userMessage)"), "must reuse the shared, already-tested categoryWordMatches");
});

Deno.test("GUARD 7c wiring: never invents an option value — required-but-unspecified options are read back from add_item's own pending_options, not fabricated", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 7c (2026-09-06, Jason", "// ── Pending option-answer resolution (DEFECT 1");
  assert(
    block.includes('"add_item", { menu_item_id: resolved7c.id, quantity: 1 }'),
    "the add_item call must pass ONLY menu_item_id and quantity — no options object, so a required group with no default is left genuinely pending, never guessed",
  );
  assert(block.includes("addedLine7c?.pending_options"), "must read back whatever add_item itself decided is still pending (which already runs the is_default fill)");
});

Deno.test("GUARD 7c wiring: a still-pending required option is asked through the shared humanizer with the REAL recorded choices, never a raw tuple or an invented list", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 7c (2026-09-06, Jason", "// ── Pending option-answer resolution (DEFECT 1");
  assert(block.includes("renderMissingOptionsPrompt([{ name: resolved7c.name, missingGroups: pending7c }])"), "must ask via the shared humanizer, same as GUARD 2 and D1");
  assert(block.includes("group.choices.map(c => c.name).join"), "must list the real recorded choices, not leave the customer guessing");
});

Deno.test("GUARD 7c wiring: a negation immediately before the item name is checked before resolving (adjacency-based, not bare co-occurrence)", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 7c (2026-09-06, Jason", "// ── Pending option-answer resolution (DEFECT 1");
  assert(block.includes("negRe7c.test(userMsgLower7c)) continue"), "a negated mention of the item must fall through to the normal loop, never be added");
  assert(negBlockIsAdjacencyBased(block), "the negation check must require the decline word immediately before the escaped item name, not just co-occurrence anywhere in the message");
});

function negBlockIsAdjacencyBased(block: string): boolean {
  const idx = block.indexOf("const negRe7c = new RegExp(");
  if (idx === -1) return false;
  const snippet = block.slice(idx, idx + 600);
  return snippet.includes("${escapedName7c}");
}

Deno.test("GUARD 7c wiring: a question about the item is checked before resolving, order-intent phrases exempted", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 7c (2026-09-06, Jason", "// ── Pending option-answer resolution (DEFECT 1");
  assert(block.includes("hasOrderIntent7c"), "must check for order-intent phrasing before gating on question shape");
  assert(block.includes("looksLikeQuestion7c"), "must gate on question shape (a '?' or an interrogative opener)");
  assert(block.includes("if (looksLikeQuestion7c) continue"), "a message that looks like a question (and isn't order-intent) must fall through, never be added");
});

Deno.test("GUARD 7c wiring: a real executeTool failure falls through to the normal loop rather than silently swallowing it", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 7c (2026-09-06, Jason", "// ── Pending option-answer resolution (DEFECT 1");
  assert(block.includes("if (!addResult7c.ok) break;"), "an add_item failure here must fall through, not be swallowed or crash the turn");
});
