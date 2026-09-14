// Reply inversion, stage 1 (2026-09-13, docs/specs/2026-09-13-reply-inversion.md).
//
// Structural enforcement, same shape as enforce-single-cart-writer.test.ts:
// a static scan of index.ts's own source, not a behavioral test, because
// the defect this closes is an ABSENCE (nothing constrained
// `reply = loopResult.reply`), not a forbidden call — the old code never
// interpolated a cart field directly at this site at all, it just handed
// the model's raw text straight through unconstrained. The invariant worth
// pinning is therefore "the taproot site no longer lets a mutated turn's
// reply come from the model unconstrained" — checked by requiring the
// mutated-cart branch to route through renderActionConfirmation (or the
// itemizer fallback) before `reply` is read by anything else in the
// runOrderingLoop result-handling block.

import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX_PATH = new URL("./index.ts", import.meta.url).pathname;

async function readIndexSource(): Promise<string> {
  return await Deno.readTextFile(INDEX_PATH);
}

/**
 * Extracts the runOrderingLoop result-handling block: from
 * `reply = loopResult.reply;` up to (and including) the compiled
 * step-question loop that runs right after it — the full span this stage
 * was scoped to fix. Throws (failing the test loudly) if the anchors move,
 * rather than silently matching nothing.
 */
function extractSiteBlock(source: string): string {
  const startMarker = "reply = loopResult.reply;";
  const endMarker = "for (const sq of loopResult.compiledStepQuestions ?? []) {";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0, "anchor 'reply = loopResult.reply;' not found in index.ts — site moved, update this test's anchors");
  assert(end > start, "anchor for the compiled step-question loop not found after the reply assignment — site moved, update this test's anchors");
  return source.slice(start, end);
}

/**
 * The invariant both RED and GREEN below are checked against: the runOrdering-
 * Loop result-handling block must decide the reply for a mutated turn via
 * detectCartMutation + renderActionConfirmation, keyed off the real pre-turn
 * cart snapshot — never a bare, unconditional `reply = loopResult.reply`
 * with nothing standing between the model's text and the customer.
 */
function siteRoutesThroughRenderer(block: string): boolean {
  return block.includes("renderActionConfirmation(") &&
    block.includes("detectCartMutation(") &&
    block.includes("cartSnapshotBeforeTurn");
}

Deno.test("reply-inversion site #21: the mutated-cart branch renders the fact via renderActionConfirmation, keyed off the real cart diff", async () => {
  const block = extractSiteBlock(await readIndexSource());
  assert(siteRoutesThroughRenderer(block), "expected the site block to call detectCartMutation/renderActionConfirmation against cartSnapshotBeforeTurn");
});

Deno.test("reply-inversion site #21: on a mutated turn, the model's own declarative text never reaches `reply` unguarded", async () => {
  const block = extractSiteBlock(await readIndexSource());
  // The line that reassigns `reply` inside the `if (cartMutatedAtLoop)` branch
  // must be sourced from factSentence/warmthTail (both code-derived — the
  // latter is filtered to interrogative-only text via extractQuestionsOnly),
  // never a bare `reply = modelReplyThisTurn` or equivalent unguarded
  // passthrough of the model's full text.
  const mutatedBranchStart = block.indexOf("if (cartMutatedAtLoop)");
  assert(mutatedBranchStart >= 0, "expected a cartMutatedAtLoop-gated branch at this site");
  const mutatedBranch = block.slice(mutatedBranchStart);
  const bareModelReplyAssignment = /reply\s*=\s*modelReplyThisTurn\s*;/;
  assert(!bareModelReplyAssignment.test(mutatedBranch), "found an unguarded `reply = modelReplyThisTurn;` inside the mutated-cart branch — this reintroduces the taproot defect");
  assertStringIncludes(mutatedBranch, "factSentence", "the mutated-cart branch must build `reply` from a code-rendered fact sentence");
});

// ── RED proof ────────────────────────────────────────────────────────────
//
// This is the ACTUAL pre-fix block, byte-for-byte, as it shipped at commit
// 1a0bae93 (`git show 1a0bae93:supabase/functions/chat-sms/index.ts`,
// spanning the same two anchors extractSiteBlock uses above) — the commit
// this stage started from. Pinned verbatim rather than fetched via a git
// subprocess at test time, so this test stays hermetic (no --allow-run
// needed) and still exercises the real historical text, not a paraphrase.
const PRE_FIX_SITE_BLOCK = `    reply = loopResult.reply;
    declinedBlockedItems = loopResult.declinedBlockedItems ?? [];
    toolCallCountThisTurn = loopResult.debugToolCallCount ?? 0;
    if (cart.test_mode && loopResult.debugAttemptMs) {
      debugPerf = { attemptMs: loopResult.debugAttemptMs, toolCallCount: loopResult.debugToolCallCount ?? 0 };
      (debugPerf as Record<string, unknown>).beforeLoopMs = debugBeforeLoopMs;
      (debugPerf as Record<string, unknown>).afterLoopMs  = Math.round(performance.now() - debugReqT0);
      (debugPerf as Record<string, unknown>).toolMs       = loopResult.debugToolMs ?? [];
    }
    // ITEM 2 (2026-09-08, PO live verification): force every compiled slot
    // question opened this turn to reach the customer byte-for-byte. Must run
    // BEFORE stripInventedActions below — that scrub only touches invented
    // kitchen-check promises, not this, but ordering the code-authored
    // canonical text first means downstream guards see the final wording.
    //
    // TWO-QUESTION-COLLISION GUARD (2026-09-11, PO-directed fix): the EARLY
    // ORDER TYPE GATE requires the model to ask pickup/delivery in the SAME
    // reply as an item-added confirmation when order type is still unset —
    // that carve-out is correct and unchanged. But a compiled slot question
    // opened by THIS SAME add_item call used to get force-enforced right
    // alongside it, stacking two questions in one message ("...added. Are
    // you ordering pickup or delivery today? How would you like the Cheese
    // Burger cooked?..."). Order type wins: when the reply already asks it
    // this turn (checked directly off the model's own text — \`cart.order_type\`
    // is still the PRE-loop value here, so this only fires while order type
    // is genuinely still unresolved), the slot question is stripped instead
    // of enforced — in whatever form the model wrote it — and the group is
    // still marked rendered so the stale-pending-option guard below doesn't
    // force it right back in. It asks again, alone, next turn, if the
    // customer still hasn't answered it.
    const deferSlotQuestionForOrderType = cart.order_type == null &&
      /\\bpickup\\b/i.test(reply) && /\\bdelivery\\b/i.test(reply) && /\\?/.test(reply);
    `;

Deno.test("RED proof: this enforcement assertion fails against the actual pre-fix block (commit 1a0bae93)", () => {
  assert(
    !siteRoutesThroughRenderer(PRE_FIX_SITE_BLOCK),
    "sanity check failed: the pinned pre-fix block already routes through renderActionConfirmation — this RED proof is meaningless if so",
  );
});

Deno.test("GREEN proof: the current file's site block passes the same assertion the pre-fix block fails", async () => {
  const block = extractSiteBlock(await readIndexSource());
  assert(siteRoutesThroughRenderer(block), "current index.ts must route the mutated-cart branch through the renderer — GREEN failed");
});
