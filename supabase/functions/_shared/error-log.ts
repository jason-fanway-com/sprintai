/**
 * SprintAI — runtime error persistence.
 *
 * Supabase edge-function log retention is ~1 minute, so any runtime failure
 * is unrecoverable shortly after it happens unless we persist it ourselves.
 * `logError` is the single write path into the `error_log` table (migration
 * 137). It is FAIL-OPEN by contract: a failure to persist the error row must
 * never throw or otherwise affect the caller's own error handling — it only
 * console.errors and returns.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const MAX_FIELD_LEN = 4000;

function truncate(s: string | null | undefined): string | null {
  if (s == null) return null;
  return s.length > MAX_FIELD_LEN ? s.slice(0, MAX_FIELD_LEN) : s;
}

export type ErrorLogStage = "tool_loop" | "render" | "outbound_send" | "guard_deny" | "propose_call";

export interface LogErrorParams {
  conversationId?: string | null;
  shopId?: string | null;
  tenantId?: string | null;
  /** e.g. "chat-sms" */
  phase: string;
  stage: ErrorLogStage;
  customerMessage?: string | null;
  error: unknown;
  metadata?: Record<string, unknown>;
}

/** Never throws. Best-effort persistence of a runtime error for post-hoc diagnosis. */
export async function logError(
  supabase: SupabaseClient,
  params: LogErrorParams,
): Promise<void> {
  try {
    const err = params.error;
    const errorMessage = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? null) : null;

    const { error: insertError } = await supabase.from("error_log").insert({
      conversation_id: params.conversationId ?? null,
      shop_id: params.shopId ?? null,
      tenant_id: params.tenantId ?? null,
      phase: params.phase,
      stage: params.stage,
      customer_message: truncate(params.customerMessage ?? null),
      error_message: truncate(errorMessage) ?? "(unknown error)",
      stack: truncate(stack),
      metadata: params.metadata ?? {},
    });

    if (insertError) {
      console.error("[error-log] failed to persist error_log row:", insertError.message);
    }
  } catch (loggingErr) {
    console.error("[error-log] logError threw while persisting error_log row:", loggingErr);
  }
}
