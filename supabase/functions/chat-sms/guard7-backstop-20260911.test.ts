// Coverage for the two defects in the PO's live Vito's Gyro repro
// (menu-checkout-13: "Gyro (Beef or Chicken)" -> "Bleu Cheese, Beef" -> ...
// looped through all 5 turns without ever resolving).
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

Deno.test("BUG 1: GUARD 7's persisted payload carries display_name (ask_plan fallback convention)", () => {
  const guard7PayloadRe = /const pendingPayload: PendingDisambiguation = \{[\s\S]{0,400}?display_name: c\.ask_plan\?\.display_name \?\? c\.name,/;
  assert(guard7PayloadRe.test(INDEX_SOURCE), "GUARD 7's pendingPayload construction is missing display_name");
});

Deno.test("BUG 1: GUARD 7b's persisted payload carries display_name too (one bug, both render/persist sites)", () => {
  const guard7bPayloadRe = /const pendingPayload7b: PendingDisambiguation = \{[\s\S]{0,400}?display_name: c\.ask_plan\?\.display_name \?\? c\.name,/;
  assert(guard7bPayloadRe.test(INDEX_SOURCE), "GUARD 7b's pendingPayload7b construction is missing display_name");
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

Deno.test("BUG 2: a fresh GUARD 7/7b disambiguation this turn is never clobbered by a stale attempt count", () => {
  // The flag is set exactly at GUARD 7 and GUARD 7b's own persistence sites...
  const setCount = (INDEX_SOURCE.match(/pendingDisambiguationOverwrittenThisTurn = true;/g) ?? []).length;
  assertEquals(setCount, 2, "expected exactly 2 sites (GUARD 7 and GUARD 7b) to set the overwritten flag");
  // ...and checked before the attempt-counter logic runs.
  assert(INDEX_SOURCE.includes("} else if (pendingDisambiguationOverwrittenThisTurn) {"));
});

Deno.test("BUG 2: the backstop renders the numbered list via renderDisambiguationReask, using display_name candidates", () => {
  assert(INDEX_SOURCE.includes("finalReply = renderDisambiguationReask(carriedDisambiguation.candidates, priorReplyText);"));
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
