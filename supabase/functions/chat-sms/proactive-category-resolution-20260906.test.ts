// FIX (2026-09-06, Jason — live QA): identical input ("chicken caesar
// salad"), three fresh sessions, three different journeys. Vito's Pizza
// (Jack's Slice menu) has two active menu_items both literally named
// "Chicken Caesar" — one in category "Salads" (required Dressing option
// group, no is_default choice set), one in category "Wraps" (required Wrap
// Type option group). GUARD 7/7b (the existing same-name disambiguation
// guards) only react AFTER the LLM has already acted — an ambiguous
// add_item rolled back, or a free-text question asked — which is exactly
// why the journey varied.
//
// GUARD 7c runs BEFORE the LLM/tool loop, on the customer's fresh message,
// using the SAME categoryWordMatches() the reactive guards already trust
// (imported for real from pending-disambiguation.ts, which already has its
// own dedicated test file — not re-tested here).
//
// This guard's gate went through THREE rounds the same evening:
// 1. Original: name + category word match, no gate at all.
// 2. QA found it added on plain questions ("how much is the chicken caesar
//    salad?") — added a DENY-LIST of question shapes ("?", a leading
//    interrogative).
// 3. QA found the deny-list was still under-inclusive ("price on...",
//    "wondering about...", "tell me about...", "curious if... is gluten
//    free", "...whats in it" — no leading interrogative, no "?"). A
//    deny-list of question forms is whack-a-mole by construction.
// FINAL: replaced with an ALLOW-LIST — require a POSITIVE signal to add
// (explicit order-intent phrase, OR the message being essentially JUST the
// item name/category, optionally with a simple "no/with/without/extra
// <thing>" modifier clause). Any other leftover content word means it's
// not a bare order and falls through to the model.
//
// The actual add_item call, executeTool, sendSms etc. are real I/O and not
// re-tested here — this file tests the pure "which candidate, if any, does
// this message resolve to" decision, copied verbatim from index.ts, plus
// wiring assertions against the live file.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { categoryDisplayWord, categoryWordMatches, stemWord } from "./pending-disambiguation.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

interface Candidate {
  id: string;
  name: string;
  category: string | null;
}

const FILLER_WORDS = new Set(["a", "an", "the", "i", "want", "please", "get", "order", "one", "some", "and", "also", "plus", "for", "me", "ill", "id", "like", "that"]);

// Copied verbatim from GUARD 7c's resolution logic in index.ts.
function resolveByCategoryWord(userMessage: string, candidates: Candidate[], name: string): Candidate | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const negRe = new RegExp(
    `\\b(?:no|not|remove|skip|drop|scratch|cancel(?:ling)?|(?:don['’]?t|do\\s+not|dont)\\s+(?:want|need|get|add))\\s+(?:the\\s+)?(?:any\\s+)?${escapedName}\\b`,
    "i",
  );
  if (negRe.test(userMessage)) return null;
  const categoryMatches = candidates.filter(c => categoryWordMatches(c.category, userMessage));
  if (categoryMatches.length !== 1) return null;
  const resolved = categoryMatches[0];

  const hasOrderIntent = /\b(?:i'?ll\s+(?:have|take|get)|i\s+want|i'?d\s+like|give\s+me|let\s+me\s+get|(?:can|could)\s+(?:i|we|you)\s+(?:get|have|order|grab|add))\b/i.test(userMessage);
  if (!hasOrderIntent) {
    const itemStems = new Set(resolved.name.toLowerCase().split(/\s+/).map(stemWord));
    const categoryStem = resolved.category ? stemWord(categoryDisplayWord(resolved.category)) : null;
    const cleaned = userMessage.toLowerCase().replace(/\b(?:no|with|without|extra)\s+\w+/g, " ");
    const words = cleaned.replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
    const leftover = words.filter(w => {
      if (FILLER_WORDS.has(w)) return false;
      const s = stemWord(w);
      if (itemStems.has(s)) return false;
      if (categoryStem && s === categoryStem) return false;
      return true;
    });
    if (leftover.length > 0) return null;
  }
  return resolved;
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

Deno.test("GUARD 7c decision: 'i want a caesar salad' resolves via the category word alone (Jason's own literal test phrase)", () => {
  const resolved = resolveByCategoryWord("i want a caesar salad", CANDIDATES, "chicken caesar");
  assertEquals(resolved?.id, "salad-id");
});

Deno.test("GUARD 7c decision: a bare 'chicken caesar' with no category word supplies no signal — genuinely ambiguous, untouched", () => {
  const resolved = resolveByCategoryWord("chicken caesar", CANDIDATES, "chicken caesar");
  assertEquals(resolved, null);
});

Deno.test("GUARD 7c decision: is deterministic — the same message always resolves the same way", () => {
  const results = Array.from({ length: 20 }, () => resolveByCategoryWord("chicken caesar salad", CANDIDATES, "chicken caesar")?.id);
  assert(results.every(r => r === "salad-id"), `every run must resolve identically, got: ${JSON.stringify(results)}`);
});

Deno.test("GUARD 7c decision: 'I don't want the chicken caesar salad' is a decline, never an add", () => {
  const resolved = resolveByCategoryWord("I don't want the chicken caesar salad", CANDIDATES, "chicken caesar");
  assertEquals(resolved, null);
});

Deno.test("GUARD 7c decision: 'no chicken caesar wrap for me' is a decline, never an add", () => {
  const resolved = resolveByCategoryWord("no chicken caesar wrap for me", CANDIDATES, "chicken caesar");
  assertEquals(resolved, null);
});

Deno.test("GUARD 7c decision: a genuine order is not mistaken for a decline just because 'no' appears elsewhere", () => {
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

// QA round 2 (Melvin) — live-fired against v254, headline finding.
Deno.test("QA regression round 2: 'how much is the chicken caesar salad?' is a question, never an add", () => {
  assertEquals(resolveByCategoryWord("how much is the chicken caesar salad?", CANDIDATES, "chicken caesar"), null);
});

Deno.test("QA regression round 2: 'is the chicken caesar salad gluten free?' is a question, never an add", () => {
  assertEquals(resolveByCategoryWord("is the chicken caesar salad gluten free?", CANDIDATES, "chicken caesar"), null);
});

Deno.test("QA regression round 2: 'do you have a chicken caesar wrap?' is a question, never an add", () => {
  assertEquals(resolveByCategoryWord("do you have a chicken caesar wrap?", CANDIDATES, "chicken caesar"), null);
});

// QA round 3 (Melvin) — live-fired against v256, the deny-list's own
// under-inclusiveness. All five confirmed live as silent adds before this fix.
Deno.test("QA regression round 3: 'price on the chicken caesar salad' is a question, never an add", () => {
  assertEquals(resolveByCategoryWord("price on the chicken caesar salad", CANDIDATES, "chicken caesar"), null);
});

Deno.test("QA regression round 3: 'wondering about the chicken caesar salad' is a question, never an add", () => {
  assertEquals(resolveByCategoryWord("wondering about the chicken caesar salad", CANDIDATES, "chicken caesar"), null);
});

Deno.test("QA regression round 3: 'tell me about the chicken caesar wrap' is a question, never an add", () => {
  assertEquals(resolveByCategoryWord("tell me about the chicken caesar wrap", CANDIDATES, "chicken caesar"), null);
});

Deno.test("QA regression round 3: 'curious if the chicken caesar salad is gluten free' is a question, never an add", () => {
  assertEquals(resolveByCategoryWord("curious if the chicken caesar salad is gluten free", CANDIDATES, "chicken caesar"), null);
});

Deno.test("QA regression round 3: 'the chicken caesar salad, whats in it' is a question (trailing interrogative, no '?'), never an add", () => {
  assertEquals(resolveByCategoryWord("the chicken caesar salad, whats in it", CANDIDATES, "chicken caesar"), null);
});

Deno.test("positive-signal gate: order-intent phrasing is allowed through even with a question mark", () => {
  assertEquals(resolveByCategoryWord("can I get a chicken caesar wrap?", CANDIDATES, "chicken caesar")?.id, "wrap-id");
  assertEquals(resolveByCategoryWord("I'll have the chicken caesar salad, please?", CANDIDATES, "chicken caesar")?.id, "salad-id");
});

Deno.test("positive-signal gate: a bare statement with no '?' and no interrogative opener still resolves", () => {
  assertEquals(resolveByCategoryWord("chicken caesar salad", CANDIDATES, "chicken caesar")?.id, "salad-id");
});

Deno.test("positive-signal gate: 'can you add...' is order intent, not wrongly blocked as a question", () => {
  assertEquals(resolveByCategoryWord("can you add a chicken caesar wrap", CANDIDATES, "chicken caesar")?.id, "wrap-id");
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

Deno.test("GUARD 7c wiring: positive-signal gate — an allow-list, not a deny-list of question shapes", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 7c (2026-09-06, Jason", "// ── Pending option-answer resolution (DEFECT 1");
  assert(block.includes("hasOrderIntent7c"), "must check for explicit order-intent phrasing");
  assert(block.includes("leftover7c"), "must compute leftover content words after stripping filler/item/category words");
  assert(block.includes("if (leftover7c.length > 0) continue"), "any leftover content word must fall through to the model — the allow-list, not a deny-list of question forms");
  assert(!block.includes("looksLikeQuestion7c"), "the old deny-list approach must be gone, not left alongside the new one");
});

Deno.test("GUARD 7c wiring: 'no/with/without/extra <thing>' modifier clauses are stripped before the leftover check, so real modifiers don't block a bare order", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 7c (2026-09-06, Jason", "// ── Pending option-answer resolution (DEFECT 1");
  assert(block.includes('replace(/\\b(?:no|with|without|extra)\\s+\\w+/g'), "must strip simple modifier clauses before computing leftover content words");
});

Deno.test("GUARD 7c wiring: item/category words are stripped by STEM, not exact match, so plurals and case don't defeat the filter", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 7c (2026-09-06, Jason", "// ── Pending option-answer resolution (DEFECT 1");
  assert(block.includes("stemWord(categoryDisplayWord(resolved7c.category))"), "the category word must be stemmed the same way categoryWordMatches already does");
});

Deno.test("GUARD 7c wiring: a real executeTool failure falls through to the normal loop rather than silently swallowing it", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 7c (2026-09-06, Jason", "// ── Pending option-answer resolution (DEFECT 1");
  assert(block.includes("if (!addResult7c.ok) break;"), "an add_item failure here must fall through, not be swallowed or crash the turn");
});
