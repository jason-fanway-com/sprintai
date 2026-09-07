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

// Copied verbatim from GUARD 7c's resolution logic in index.ts.
function resolveByCategoryWord(userMessage: string, candidates: Candidate[]): Candidate | null {
  const categoryMatches = candidates.filter(c => categoryWordMatches(c.category, userMessage));
  if (categoryMatches.length !== 1) return null;
  return categoryMatches[0];
}

const CHICKEN_CAESAR_SALAD: Candidate = { id: "salad-id", name: "Chicken Caesar", category: "Salads" };
const CHICKEN_CAESAR_WRAP: Candidate = { id: "wrap-id", name: "Chicken Caesar", category: "Wraps" };
const CANDIDATES = [CHICKEN_CAESAR_SALAD, CHICKEN_CAESAR_WRAP];

Deno.test("GUARD 7c decision: 'chicken caesar salad' resolves to the Salads candidate every time", () => {
  const resolved = resolveByCategoryWord("chicken caesar salad", CANDIDATES);
  assertEquals(resolved?.id, "salad-id");
});

Deno.test("GUARD 7c decision: 'can I get a chicken caesar wrap' resolves to the Wraps candidate every time", () => {
  const resolved = resolveByCategoryWord("can I get a chicken caesar wrap", CANDIDATES);
  assertEquals(resolved?.id, "wrap-id");
});

Deno.test("GUARD 7c decision: a bare 'chicken caesar' with no category word supplies no signal — genuinely ambiguous, untouched", () => {
  const resolved = resolveByCategoryWord("chicken caesar", CANDIDATES);
  assertEquals(resolved, null);
});

Deno.test("GUARD 7c decision: is deterministic — the same message always resolves the same way", () => {
  const results = Array.from({ length: 20 }, () => resolveByCategoryWord("chicken caesar salad", CANDIDATES)?.id);
  assert(results.every(r => r === "salad-id"), `every run must resolve identically, got: ${JSON.stringify(results)}`);
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

Deno.test("GUARD 7c wiring: a real executeTool failure falls through to the normal loop rather than silently swallowing it", () => {
  const block = extractBlock(INDEX_SOURCE, "// ── Guard 7c (2026-09-06, Jason", "// ── Pending option-answer resolution (DEFECT 1");
  assert(block.includes("if (!addResult7c.ok) break;"), "an add_item failure here must fall through, not be swallowed or crash the turn");
});
