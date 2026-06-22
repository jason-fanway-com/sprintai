/**
 * SprintAI Conversation-Judge auto-fix seam (Spec 06 §4) — BUILT, OFF.
 *
 * One config flag gates everything: EVAL_AUTOFIX_ENABLED (env, default false).
 *
 *   false (NOW): notify only. maybeAutoFix() returns {dispatched:false,
 *                reason:"disabled"} and does NOTHING — no task created, no crew
 *                dispatch, no side effects.
 *   true (LATER, when Jason trusts it): high-confidence CRITICAL flags would
 *                auto-create a crew fix task. The dispatch is intentionally NOT
 *                wired yet — flipping the flag reaches a clearly-marked TODO that
 *                still no-ops until the dispatch target is wired in a later task.
 *
 * This file exists so enabling auto-fix later is a one-switch change to a known
 * seam, with the gate and the decision logic already reviewed.
 */

import type { EvalFlag } from "./judge-notify.ts";

export function autofixEnabled(): boolean {
  return Deno.env.get("EVAL_AUTOFIX_ENABLED") === "true";
}

export interface AutoFixResult {
  dispatched: boolean;
  reason: string;
  candidates?: EvalFlag[];
}

/**
 * Decide whether a flagged eval should auto-create a crew fix task.
 * GATED OFF: with EVAL_AUTOFIX_ENABLED unset/false this is a pure no-op.
 */
export function maybeAutoFix(args: {
  conversationId: string;
  shopName: string;
  flags: EvalFlag[];
}): AutoFixResult {
  if (!autofixEnabled()) {
    return { dispatched: false, reason: "disabled" };
  }

  // ---- Seam only reached when the flag is flipped true (NOT now). ----------
  // High-confidence CRITICAL flags are the only auto-fix candidates.
  const candidates = args.flags.filter((f) => f.severity === "critical");
  if (candidates.length === 0) {
    return { dispatched: false, reason: "no critical flags" };
  }

  // INTENTIONALLY NOT WIRED: actual crew-task dispatch is a later task. Even
  // with the flag true, this still no-ops (returns dispatched:false) until the
  // dispatch target is implemented and separately approved. This guarantees
  // flipping the env flag alone cannot fire real auto-dispatch.
  console.log(
    "[judge-autofix] EVAL_AUTOFIX_ENABLED=true and CRITICAL candidates present, " +
      "but dispatch is not wired (seam only). No task created.",
    { conversationId: args.conversationId, shop: args.shopName, candidates },
  );
  return {
    dispatched: false,
    reason: "enabled-but-dispatch-not-wired (seam only)",
    candidates,
  };
}
