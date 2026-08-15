/**
 * Pure helpers for Telnyx send-error classification (no I/O, no env access).
 * Kept in _shared so the classifier is unit-testable without importing the
 * edge function's top-level `Deno.serve`.
 */

/**
 * Classify a Telnyx send-rejection error code.
 * - "transient": system/delivery issue (e.g. 10036 campaign not approved).
 *   Do NOT persist opt-out or close the conversation — it is not the customer
 *   opting out.
 * - "opt_out": genuine opt-out/block (40002, 40003, 40004). Persist opt-out.
 * - "other": anything else.
 */
export function classifyTelnyxSendError(errCode: string | undefined): "transient" | "opt_out" | "other" {
  if (!errCode) return "other";
  if (errCode === "10036") return "transient";
  if (/^(40002|40003|40004)$/.test(errCode)) return "opt_out";
  return "other";
}
