// Coverage for the three defects in the PO's live Vito's Gyro repro
// (menu-checkout-13: "Gyro (Beef or Chicken)" -> "Bleu Cheese, Beef" -> ...
// looped through all turns without ever resolving, backstop included).
//
// BUG 1: GUARD 7's re-ask (and every sibling render site — GUARD 7b's
//        persisted payload, the resolved-answer confirmation, GUARD 7c's
//        proactive-resolution confirmation, and the carried-forward "Still
//        wondering" follow-up) built its text from the raw, duplicate
//        `name` plus a computed category word, ignoring `display_name`
//        (the menu-compiler's disambiguation rename, e.g. "Gyro Salad" vs
//        "Gyro Sandwich") sitting right on the same candidate. Fixed by
//        candidateOptionText/candidateShortText/candidateNameForConfirm
//        (pending-disambiguation.ts) — see that file's own test coverage
//        for the pure-logic assertions.
// BUG 2: resolvePendingDisambiguation only understands a category word, an
//        ordinal, or a price — a legitimate real answer naming neither
//        ("Bleu Cheese, Beef") fell through to the same open-ended re-ask
//        every turn, forever. Fixed with an attempt counter
//        (PendingDisambiguation.attempts) that, after
//        MAX_DISAMBIGUATION_RETRIES consecutive turns with no tool call
//        either, forces renderDisambiguationReask's numbered list instead —
//        matchOrdinalPosition already resolves a bare "1"/"2" reply through
//        the existing top-of-turn resolution path, so no new resolution
//        logic was needed.
// BUG 3 (2026-09-12, PO — live verification of the BUG 2 fix found the
//        backstop never actually fired): a customer stuck on an unresolved
//        disambiguation doesn't just answer in free text — the model often
//        GUESSES, calling add_item on the still-ambiguous item again. That
//        guess trips GUARD 7 (or GUARD 7b) itself, which used to (a) count
//        as a tool call this turn — defeating the `toolCallCountThisTurn ===
//        0` gate the BUG 2 counter relied on — and (b) overwrite
//        pending_disambiguation with a brand-new payload with no `attempts`
//        field, which ALSO defeats the counter via
//        pendingDisambiguationOverwrittenThisTurn. Both escape hatches fire
//        on every single guessed re-trip, so the streak could never reach
//        MAX_DISAMBIGUATION_RETRIES. Fixed by having GUARD 7/7b themselves
//        detect a re-trip on the SAME item (matched by query_name against
//        cart.pending_disambiguation, the state as of the top of this turn),
//        carry the attempt count forward, and trip the backstop right there
//        instead of deferring to logic this exact path was defeating.
//
// index.ts calls Deno.serve() at module scope, so it can't be imported
// directly by tests (same constraint as every other *.test.ts file in this
// directory — see guard-defects-20260906.test.ts's header). The turn-state-
// dependent wiring (pendingDisambiguationOverwrittenThisTurn,
// toolCallCountThisTurn, MAX_DISAMBIGUATION_RETRIES) is asserted against the
// actual source text so a future edit that silently drops it fails loudly;
// the attempt/threshold decision itself is pure and is re-verified directly.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

// ── BUG 1: every render site reads display_name, none leaks the raw name ───

Deno.test("BUG 1: GUARD 7's optionsText is built from candidateOptionText, not raw c.name", () => {
  assert(/const optionsText = candidates\.map\(c => candidateOptionText\(/.test(INDEX_SOURCE), "GUARD 7's optionsText no longer calls candidateOptionText");
});

Deno.test("BUG 1: GUARD 7's persisted candidates carry display_name (ask_plan fallback convention)", () => {
  const guard7CandidatesRe = /const guard7CandidatesForPending = candidates\.map\(\(c\): PendingCandidate => \(\{[\s\S]{0,400}?display_name: c\.ask_plan\?\.display_name \?\? c\.name,/;
  assert(guard7CandidatesRe.test(INDEX_SOURCE), "GUARD 7's guard7CandidatesForPending construction is missing display_name");
  assert(INDEX_SOURCE.includes("candidates: guard7CandidatesForPending,"), "GUARD 7's pendingPayload no longer carries guard7CandidatesForPending");
});

Deno.test("BUG 1: GUARD 7b's persisted candidates carry display_name too (one bug, both render/persist sites)", () => {
  const guard7bCandidatesRe = /const guard7bCandidatesForPending = candidates\.map\(\(c\): PendingCandidate => \(\{[\s\S]{0,400}?display_name: c\.ask_plan\?\.display_name \?\? c\.name,/;
  assert(guard7bCandidatesRe.test(INDEX_SOURCE), "GUARD 7b's guard7bCandidatesForPending construction is missing display_name");
  assert(INDEX_SOURCE.includes("candidates: guard7bCandidatesForPending,"), "GUARD 7b's pendingPayload7b no longer carries guard7bCandidatesForPending");
});

Deno.test("BUG 1: the resolved-answer confirmation and GUARD 7c's confirmation both use the display_name-aware helper", () => {
  assert(INDEX_SOURCE.includes("candidateNameForConfirm(resolved)"), "resolved-answer confirmation still uses raw name/category-word construction");
  assert(INDEX_SOURCE.includes("candidateNameForConfirm({ menu_item_id: resolved7c.id"), "GUARD 7c's confirmation still uses raw name/category-word construction");
});

Deno.test("BUG 1: the carried-forward 'Still wondering' follow-up uses candidateShortText, not raw c.name", () => {
  const stillWonderingRe = /candidates\.map\(c => candidateShortText\(c\)\)\.join\(" or "\)/;
  assert(stillWonderingRe.test(INDEX_SOURCE), "Still-wondering follow-up still builds text from raw c.name + category word");
});

// ── BUG 2: attempt-counter backstop wiring ──────────────────────────────────

Deno.test("BUG 2: MAX_DISAMBIGUATION_RETRIES=2 exists (consistent with MAX_SHORTFALL_RETRIES convention)", () => {
  assert(INDEX_SOURCE.includes("const MAX_DISAMBIGUATION_RETRIES = 2;"));
});

Deno.test("BUG 2: toolCallCountThisTurn is captured ungated by test_mode (unlike debugPerf)", () => {
  assert(INDEX_SOURCE.includes("let toolCallCountThisTurn = 0;"));
  assert(INDEX_SOURCE.includes("toolCallCountThisTurn = loopResult.debugToolCallCount ?? 0;"));
});

Deno.test("BUG 2: GUARD 7/7b re-persisting this turn is flagged so the bottom-of-function counter doesn't double-count it", () => {
  // The flag is set exactly at GUARD 7 and GUARD 7b's own persistence sites
  // (BUG 3 below is what makes their OWN re-persist carry the streak
  // correctly; this flag's job is only to stop the bottom-of-function
  // fallthrough logic from ALSO incrementing on top of that).
  const setCount = (INDEX_SOURCE.match(/pendingDisambiguationOverwrittenThisTurn = true;/g) ?? []).length;
  assertEquals(setCount, 2, "expected exactly 2 sites (GUARD 7 and GUARD 7b) to set the overwritten flag");
  // ...and checked before the attempt-counter logic runs.
  assert(INDEX_SOURCE.includes("} else if (pendingDisambiguationOverwrittenThisTurn) {"));
});

Deno.test("BUG 2: the bottom-of-function backstop renders the numbered list via renderDisambiguationReask, using display_name candidates", () => {
  assert(INDEX_SOURCE.includes("finalReply = renderDisambiguationReask(carriedDisambiguation.candidates, priorReplyText);"));
});

// ── BUG 3: GUARD 7/7b re-trips on the SAME item must carry the streak, not reset it ──

Deno.test("BUG 3: GUARD 7 carries the attempt count forward when it re-trips on the SAME item already pending", () => {
  assert(INDEX_SOURCE.includes("const priorPendingForThisItem = cart.pending_disambiguation?.query_name === menuItem.name ? cart.pending_disambiguation : null;"), "GUARD 7 no longer checks whether this re-trip is the same item as what was already pending");
  assert(INDEX_SOURCE.includes("const guard7Attempts = (priorPendingForThisItem?.attempts ?? 0) + 1;"), "GUARD 7 no longer carries the attempt count forward");
  assert(INDEX_SOURCE.includes("attempts: guard7Attempts,"), "GUARD 7's pendingPayload no longer persists the carried-forward attempt count");
});

Deno.test("BUG 3: GUARD 7 trips the backstop itself once guard7Attempts exceeds MAX_DISAMBIGUATION_RETRIES", () => {
  assert(INDEX_SOURCE.includes("if (guard7Attempts > MAX_DISAMBIGUATION_RETRIES) {"), "GUARD 7 no longer checks its own carried-forward count against the threshold");
  assert(INDEX_SOURCE.includes("reply = renderDisambiguationReask(guard7CandidatesForPending, priorReplyTextGuard7);"), "GUARD 7's tripped branch no longer forces the numbered list");
});

Deno.test("BUG 3: GUARD 7b carries the attempt count forward when it re-trips on the SAME item already pending", () => {
  assert(INDEX_SOURCE.includes("const priorPendingForThisItem7b = cart.pending_disambiguation?.query_name === candidates[0].name ? cart.pending_disambiguation : null;"), "GUARD 7b no longer checks whether this re-trip is the same item as what was already pending");
  assert(INDEX_SOURCE.includes("const guard7bAttempts = (priorPendingForThisItem7b?.attempts ?? 0) + 1;"), "GUARD 7b no longer carries the attempt count forward");
  assert(INDEX_SOURCE.includes("attempts: guard7bAttempts,"), "GUARD 7b's pendingPayload7b no longer persists the carried-forward attempt count");
});

Deno.test("BUG 3: GUARD 7b trips the backstop itself once guard7bAttempts exceeds MAX_DISAMBIGUATION_RETRIES", () => {
  assert(INDEX_SOURCE.includes("if (guard7bAttempts > MAX_DISAMBIGUATION_RETRIES) {"), "GUARD 7b no longer checks its own carried-forward count against the threshold");
  assert(INDEX_SOURCE.includes("reply = renderDisambiguationReask(guard7bCandidatesForPending, priorReplyTextGuard7b);"), "GUARD 7b's tripped branch no longer forces the numbered list");
});

Deno.test("BUG 3: MAX_DISAMBIGUATION_RETRIES is declared exactly once, above GUARD 7, so both guards and the bottom-of-function logic share one threshold", () => {
  const declCount = (INDEX_SOURCE.match(/const MAX_DISAMBIGUATION_RETRIES = 2;/g) ?? []).length;
  assertEquals(declCount, 1, "MAX_DISAMBIGUATION_RETRIES should be declared exactly once now that GUARD 7/7b also reference it");
});

// Pure re-verification of the SAME-item carry-forward arithmetic GUARD 7/7b
// now perform (mirrors the guard7Attempts/guard7bAttempts logic in index.ts —
// kept inline there because it needs live turn state that has no meaning
// outside a real request).
function guardReTripAttempts(
  priorPendingQueryName: string | null,
  thisItemName:          string,
  priorAttempts:         number,
  maxRetries:            number,
): { attempts: number; tripped: boolean } {
  const isSameItem = priorPendingQueryName === thisItemName;
  const attempts = (isSameItem ? priorAttempts : 0) + 1;
  return { attempts, tripped: attempts > maxRetries };
}

Deno.test("BUG 3 arithmetic: three consecutive guessed add_item attempts on the SAME item trip the backstop on the 3rd (MAX=2)", () => {
  assertEquals(guardReTripAttempts(null, "Gyro", 0, 2), { attempts: 1, tripped: false });
  assertEquals(guardReTripAttempts("Gyro", "Gyro", 1, 2), { attempts: 2, tripped: false });
  assertEquals(guardReTripAttempts("Gyro", "Gyro", 2, 2), { attempts: 3, tripped: true });
});

Deno.test("BUG 3 arithmetic: a re-trip on a DIFFERENT item does not inherit the stale streak", () => {
  assertEquals(guardReTripAttempts("Gyro", "Chicken Caesar", 2, 2), { attempts: 1, tripped: false });
});

// Pure re-verification of the attempt/threshold arithmetic itself (mirrors
// the carriedDisambiguation block in index.ts — kept inline there because it
// needs live turn state that has no meaning outside a real request).
function shouldTripBackstop(
  priorAttempts:         number,
  toolCallCountThisTurn: number,
  maxRetries:            number,
): { attempts: number; tripped: boolean } {
  if (toolCallCountThisTurn !== 0) return { attempts: priorAttempts, tripped: false };
  const attempts = priorAttempts + 1;
  return { attempts, tripped: attempts > maxRetries };
}

Deno.test("Backstop arithmetic: 1st and 2nd unresolved turns do not trip; the 3rd does (MAX=2)", () => {
  assertEquals(shouldTripBackstop(0, 0, 2), { attempts: 1, tripped: false });
  assertEquals(shouldTripBackstop(1, 0, 2), { attempts: 2, tripped: false });
  assertEquals(shouldTripBackstop(2, 0, 2), { attempts: 3, tripped: true });
});

Deno.test("Backstop arithmetic: a turn where the model DID make a tool call doesn't count toward the streak", () => {
  assertEquals(shouldTripBackstop(1, 1, 2), { attempts: 1, tripped: false });
});
