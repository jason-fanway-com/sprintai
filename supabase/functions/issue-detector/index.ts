/**
 * SprintAI issue-detector — self-diagnosing issue detection (Phase 1).
 *
 * SCHEDULED sweep (cron / pg_cron), never called inline by chat-sms. This function:
 *   1. Loads recent conversation_evals (last 24h) and conversations.
 *   2. Runs detection rules across three severity tiers.
 *   3. Deduplicates open issues by (detection_rule, tenant_id, conversation_id).
 *   4. Writes new issues to the `issues` table and logs creation in `resolution_log`.
 *
 * Sev-1 rules (immediate attention):
 *   - error_spike: >= 3 errored evals in 1 hour for same tenant
 *   - compliance_violation: flagged conversation with critical severity
 *
 * Sev-2 rules (same-day):
 *   - quality_decline: flagged rate > 30% in last 50 evals per tenant
 *   - intent_failure: > 5 flagged conversations in 1 hour for same tenant
 *   - latency_spike: conversations with avg message gap > 60s (when >= 10 msgs)
 *
 * Sev-3 rules (informational):
 *   - low_score_conversation: any flagged eval (minor severity)
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { guardedSend, PAID_STATES, type OutboundContext } from "../_shared/outbound-guard.ts";

// ─── Config ──────────────────────────────────────────────────────────────────
const LOOKBACK_HOURS = 24;
const ERROR_SPIKE_THRESHOLD = 3;     // errored evals in 1 hour window
const ERROR_SPIKE_WINDOW_MIN = 60;
const FLAGGED_RATE_THRESHOLD = 0.30; // 30% flagged in last 50 evals
const FLAGGED_RATE_SAMPLE = 50;
const INTENT_FAILURE_THRESHOLD = 5;  // flagged convs in 1 hour
const INTENT_FAILURE_WINDOW_MIN = 60;
const LATENCY_P95_MS = 60_000;        // 60 seconds P95

// INSTRUCTION-10 item I — 7-minute unacknowledged-order escalation.
const ESCALATION_THRESHOLD_MIN = 7;
const ESCALATION_QUERY_LIMIT = 100;
const ESCALATION_PER_SHOP_CAP = 5;    // caps a single stuck shop's burst

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Types ───────────────────────────────────────────────────────────────────
interface EvalRecord {
  id: string;
  tenant_id: string;
  shop_id: string | null;
  conversation_id: string;
  judged_at: string;
  verdict: "clean" | "flagged" | "errored";
  max_severity: "critical" | "major" | "minor" | null;
  flags: Array<{ check: string; severity: string; evidence_message_ids: string[]; explanation: string }>;
}

interface MessageRecord {
  created_at: string;
}

interface PendingIssue {
  tenant_id: string;
  shop_id: string | null;
  conversation_id: string | null;
  eval_id: string | null;
  severity: "sev_1" | "sev_2" | "sev_3";
  detection_rule: string;
  title: string;
  description: string;
  metadata: Record<string, unknown>;
}

interface ScanReport {
  evals_scanned: number;
  tenants_scanned: number;
  issues_created: number;
  issues_deduped: number;
  by_severity: Record<string, number>;
  /** Present only when detectUnackedOrders ran — send-attempt detail doesn't
   *  fit the generic PendingIssue tally above, so it's surfaced separately
   *  rather than silently dropped from the HTTP response. */
  escalation?: {
    candidates_scanned: number;
    sends_attempted: number;
    sends_sent: number;
  };
}

// ─── SQL helper ──────────────────────────────────────────────────────────────
async function sql(supabase: SupabaseClient, query: string) {
  const { error } = await supabase.rpc("pgrest_exec", { query }).maybeSingle();
  if (error) {
    // pgrest_exec may not be available; log but don't block
    console.warn("[issue-detector] pgrest_exec:", error.message);
  }
}

// ─── Dedup check ─────────────────────────────────────────────────────────────
export async function isDuplicate(
  supabase: SupabaseClient,
  issue: PendingIssue,
): Promise<boolean> {
  let query = supabase
    .from("issues")
    .select("id")
    .eq("detection_rule", issue.detection_rule)
    .eq("tenant_id", issue.tenant_id)
    .eq("status", "open");

  // Inclusion of conversation_id in dedup prevents a single critical eval
  // from shadowing all subsequent criticals on the same tenant.
  if (issue.conversation_id) {
    query = query.eq("conversation_id", issue.conversation_id);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    console.warn("[issue-detector] dedup query error:", error.message);
    return false; // be safe and try to insert
  }
  return data !== null;
}

// ─── Write issue ─────────────────────────────────────────────────────────────
export async function createIssue(
  supabase: SupabaseClient,
  issue: PendingIssue,
): Promise<boolean> {
  if (await isDuplicate(supabase, issue)) return false;

  const { data, error } = await supabase
    .from("issues")
    .insert({
      tenant_id: issue.tenant_id,
      shop_id: issue.shop_id ?? null,
      conversation_id: issue.conversation_id ?? null,
      eval_id: issue.eval_id ?? null,
      severity: issue.severity,
      status: "open",
      detection_rule: issue.detection_rule,
      title: issue.title,
      description: issue.description,
      metadata: issue.metadata,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    console.warn("[issue-detector] insert error:", error.message, "rule:", issue.detection_rule);
    return false;
  }

  // Log creation in resolution_log
  if (data?.id) {
    await supabase.from("resolution_log").insert({
      issue_id: data.id,
      action: "created",
      actor: "system",
      note: `Auto-detected by rule: ${issue.detection_rule}`,
      old_status: null,
      new_status: "open",
    });

    // NOTIFIED_AT CONTRACT: the issue-detector is the single actioner.
    // After creating the tracked issue, mark the source eval as notified
    // so neither eval-sweep nor the heartbeat re-DMs for it.
    if (issue.eval_id) {
      const { error: updateErr } = await supabase
        .from("conversation_evals")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", issue.eval_id)
        .is("notified_at", null); // only if not already set
      if (updateErr) {
        console.warn("[issue-detector] notified_at update failed:", updateErr.message);
      }
    }
  }

  return true;
}

// ─── Detection rules ─────────────────────────────────────────────────────────

/** Sev-1: Error spike — >=N errored evals for same tenant in 1 hour. */
async function detectErrorSpike(
  supabase: SupabaseClient,
  opts: SweepOptions = {},
): Promise<PendingIssue[]> {
  const since = opts.backfill
    ? "1970-01-01T00:00:00Z"
    : new Date(Date.now() - ERROR_SPIKE_WINDOW_MIN * 60_000).toISOString();
  const { data } = await supabase
    .from("conversation_evals")
    .select("tenant_id, shop_id, verdict, judged_at")
    .eq("verdict", "errored")
    .gte("judged_at", since);

  const rows = (data ?? []) as Array<{
    tenant_id: string; shop_id: string | null; verdict: string; judged_at: string;
  }>;

  // Group by tenant
  const byTenant = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byTenant.get(r.tenant_id) ?? [];
    arr.push(r);
    byTenant.set(r.tenant_id, arr);
  }

  const issues: PendingIssue[] = [];
  for (const [tenantId, evals] of byTenant) {
    if (evals.length >= ERROR_SPIKE_THRESHOLD) {
      issues.push({
        tenant_id: tenantId,
        shop_id: evals[0].shop_id ?? null,
        conversation_id: null,
        eval_id: null,
        severity: "sev_1",
        detection_rule: "error_spike",
        title: `Error spike: ${evals.length} judge errors in 1 hour`,
        description: `${evals.length} conversation_evals returned errored verdict in the last ${ERROR_SPIKE_WINDOW_MIN} minutes. The LLM judge may be down or returning unparseable output.`,
        metadata: { error_count: evals.length, window_min: ERROR_SPIKE_WINDOW_MIN },
      });
    }
  }
  return issues;
}

/** Sev-1: Compliance violation — flagged evals with critical severity. */
async function detectComplianceViolations(
  supabase: SupabaseClient,
  opts: SweepOptions = {},
): Promise<PendingIssue[]> {
  const since = opts.backfill
    ? "1970-01-01T00:00:00Z"
    : new Date(Date.now() - LOOKBACK_HOURS * 60 * 60_000).toISOString();
  const { data } = await supabase
    .from("conversation_evals")
    .select("id, tenant_id, shop_id, conversation_id, judged_at, flags, max_severity")
    .eq("verdict", "flagged")
    .eq("max_severity", "critical")
    .gte("judged_at", since);

  const rows = (data ?? []) as Array<{
    id: string; tenant_id: string; shop_id: string | null;
    conversation_id: string; judged_at: string;
    flags: Array<{ check: string; severity: string; explanation: string }>;
    max_severity: string;
  }>;

  return rows.map((r) => {
    const flagChecks = r.flags.map((f) => f.check).join(", ");
    return {
      tenant_id: r.tenant_id,
      shop_id: r.shop_id ?? null,
      conversation_id: r.conversation_id,
      eval_id: r.id,
      severity: "sev_1" as const,
      detection_rule: "compliance_violation",
      title: `Compliance violation: ${flagChecks}`,
      description: `A conversation was flagged with CRITICAL severity. Checks fired: ${flagChecks}. ${r.flags.map((f) => f.explanation).join(" | ")}`,
      metadata: {
        conversation_id: r.conversation_id,
        eval_id: r.id,
        flags: r.flags,
      },
    };
  });
}

/** Sev-2: Quality decline — flagged rate > 30% in last 50 evals per tenant. */
async function detectQualityDecline(
  supabase: SupabaseClient,
  opts: SweepOptions = {},
): Promise<PendingIssue[]> {
  // Get recent evals per tenant — order by newest for sample
  const lookback = opts.backfill
    ? "1970-01-01T00:00:00Z"
    : new Date(Date.now() - LOOKBACK_HOURS * 60 * 60_000).toISOString();
  const { data: tenants } = await supabase
    .from("conversation_evals")
    .select("tenant_id")
    .gte("judged_at", lookback)
    .order("tenant_id");

  const tenantIds = [...new Set((tenants ?? []).map((t: { tenant_id: string }) => t.tenant_id))] as string[];
  const issues: PendingIssue[] = [];

  for (const tid of tenantIds) {
    const { data } = await supabase
      .from("conversation_evals")
      .select("verdict")
      .eq("tenant_id", tid)
      .order("judged_at", { ascending: false })
      .limit(FLAGGED_RATE_SAMPLE);

    if (!data || data.length < 10) continue; // not enough data

    const flagged = data.filter((r: { verdict: string }) => r.verdict === "flagged").length;
    const rate = flagged / data.length;

    if (rate >= FLAGGED_RATE_THRESHOLD) {
      issues.push({
        tenant_id: tid,
        shop_id: null,
        conversation_id: null,
        eval_id: null,
        severity: "sev_2",
        detection_rule: "quality_decline",
        title: `Quality decline: ${Math.round(rate * 100)}% flagged rate (last ${data.length} evals)`,
        description: `${flagged} of the last ${data.length} conversation evaluations were flagged. Threshold is ${Math.round(FLAGGED_RATE_THRESHOLD * 100)}%. The diner bot quality may be degraded for this tenant.`,
        metadata: { flagged_count: flagged, sample_size: data.length, flagged_rate: Number(rate.toFixed(3)) },
      });
    }
  }
  return issues;
}

/** Sev-2: Intent failure — >N flagged conversations in 1 hour for same tenant. */
async function detectIntentFailure(
  supabase: SupabaseClient,
  opts: SweepOptions = {},
): Promise<PendingIssue[]> {
  const since = opts.backfill
    ? "1970-01-01T00:00:00Z"
    : new Date(Date.now() - INTENT_FAILURE_WINDOW_MIN * 60_000).toISOString();
  const { data } = await supabase
    .from("conversation_evals")
    .select("tenant_id, shop_id, conversation_id")
    .eq("verdict", "flagged")
    .gte("judged_at", since);

  const rows = (data ?? []) as Array<{
    tenant_id: string; shop_id: string | null; conversation_id: string;
  }>;

  const byTenant = new Map<string, string[]>();
  for (const r of rows) {
    const arr = byTenant.get(r.tenant_id) ?? [];
    arr.push(r.conversation_id);
    byTenant.set(r.tenant_id, arr);
  }

  const issues: PendingIssue[] = [];
  for (const [tenantId, convIds] of byTenant) {
    if (convIds.length >= INTENT_FAILURE_THRESHOLD) {
      issues.push({
        tenant_id: tenantId,
        shop_id: null,
        conversation_id: null,
        eval_id: null,
        severity: "sev_2",
        detection_rule: "intent_failure",
        title: `Intent failure: ${convIds.length} flagged conversations in 1 hour`,
        description: `${convIds.length} conversations were flagged in the last ${INTENT_FAILURE_WINDOW_MIN} minutes. The bot may be misinterpreting diner intent frequently.`,
        metadata: {
          flagged_count: convIds.length,
          window_min: INTENT_FAILURE_WINDOW_MIN,
          conversation_ids: [...new Set(convIds)].slice(0, 20),
        },
      });
    }
  }
  return issues;
}

/** Sev-2: Latency spike — conversations with avg message gap > 60s (>= 10 msgs). */
async function detectLatencySpike(
  supabase: SupabaseClient,
  _opts: SweepOptions = {},
): Promise<PendingIssue[]> {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60_000).toISOString();

  // Find recent conversations with >= 10 messages
  const { data: convs } = await supabase
    .from("conversations")
    .select("id, tenant_id")
    .not("last_message_at", "is", null)
    .order("last_message_at", { ascending: false })
    .limit(200);

  if (!convs?.length) return [];

  const issues: PendingIssue[] = [];

  for (const conv of convs as Array<{ id: string; tenant_id: string }>) {
    const { data: msgs } = await supabase
      .from("messages")
      .select("created_at")
      .eq("conversation_id", conv.id)
      .order("created_at", { ascending: true });

    if (!msgs || msgs.length < 10) continue;

    // Compute message gaps
    const gaps: number[] = [];
    for (let i = 1; i < msgs.length; i++) {
      const gap = new Date(msgs[i].created_at).getTime() - new Date(msgs[i - 1].created_at).getTime();
      if (gap > 0) gaps.push(gap);
    }
    if (gaps.length === 0) continue;

    gaps.sort((a, b) => a - b);
    const p95 = gaps[Math.floor(gaps.length * 0.95)] ?? gaps[gaps.length - 1];

    if (p95 > LATENCY_P95_MS) {
      issues.push({
        tenant_id: conv.tenant_id,
        shop_id: null,
        conversation_id: conv.id,
        eval_id: null,
        severity: "sev_2",
        detection_rule: "latency_spike",
        title: `Latency spike: P95 response gap ${(p95 / 1000).toFixed(1)}s`,
        description: `Conversation ${conv.id.slice(0, 8)} has ${msgs.length} messages with a P95 response gap of ${(p95 / 1000).toFixed(1)} seconds (threshold: ${LATENCY_P95_MS / 1000}s).`,
        metadata: {
          conversation_id: conv.id,
          message_count: msgs.length,
          p95_gap_ms: p95,
          threshold_ms: LATENCY_P95_MS,
        },
      });
    }
  }

  return issues;
}

/** Sev-1: Ticket send failures in ticket_send_log (non-2xx rows).
 *  Catch failures the inline chat-sms handler may have missed. */
export async function detectTicketSendFailures(
  supabase: SupabaseClient,
  opts: SweepOptions = {},
): Promise<PendingIssue[]> {
  const since = opts.backfill
    ? "1970-01-01T00:00:00Z"
    : new Date(Date.now() - LOOKBACK_HOURS * 60 * 60_000).toISOString();

  const { data: failedRows } = await supabase
    .from("ticket_send_log")
    .select("cart_id, http_status, sent_at")
    .not("http_status", "is", null)
    .not("http_status", "in", "(200,201,202,204)")
    .gte("sent_at", since)
    .limit(100);

  if (!failedRows || failedRows.length === 0) return [];

  // Get cart+shop+tenant for each unique cart_id
  const cartIds = [...new Set(failedRows.map((r: { cart_id: string }) => r.cart_id))];
  const { data: carts } = await supabase
    .from("order_carts")
    .select("id, conversation_id, order_number, total_cents, shop_id")
    .in("id", cartIds);
  if (!carts || carts.length === 0) return [];

  const cartMap = new Map((carts as Array<{ id: string; conversation_id: string; order_number: number | null; total_cents: number | null; shop_id: string }>).map(c => [c.id, c]));

  const shopIds = [...new Set(carts.map((c: { shop_id: string }) => c.shop_id))];
  const { data: shops } = await supabase
    .from("shops")
    .select("id, tenant_id, name")
    .in("id", shopIds);
  const shopMap = new Map((shops ?? []).map((s: { id: string; tenant_id: string; name: string }) => [s.id, s]));

  const issues: PendingIssue[] = [];
  for (const row of failedRows as Array<{ cart_id: string; http_status: number; sent_at: string }>) {
    const cart = cartMap.get(row.cart_id);
    if (!cart) continue;
    const shop = shopMap.get(cart.shop_id);
    if (!shop) continue;

    issues.push({
      tenant_id: shop.tenant_id,
      shop_id: cart.shop_id,
      conversation_id: cart.conversation_id,
      eval_id: null,
      severity: "sev_1",
      detection_rule: "ticket_send_failed",
      title: `Order #${cart.order_number ?? row.cart_id} ticket send failed (HTTP ${row.http_status})`,
      description: `Ticket email for order #${cart.order_number ?? row.cart_id} received HTTP ${row.http_status} from Resend at ${row.sent_at}. The kitchen may not have received this ticket.`,
      metadata: {
        cart_id: row.cart_id,
        order_number: cart.order_number ?? null,
        http_status: row.http_status,
        sent_at: row.sent_at,
        total_cents: cart.total_cents ?? null,
        shop_name: shop.name ?? null,
      },
    });
  }
  return issues;
}

/** Sev-1: Missing tickets — paid carts older than ~15 min with no ticket_emailed_at
 *  and no open ticket issue. Catches cases where no ticket was ever delivered. */
export async function detectMissingTickets(
  supabase: SupabaseClient,
  _opts: SweepOptions = {},
): Promise<PendingIssue[]> {
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();

  const { data: carts } = await supabase
    .from("order_carts")
    .select("id, conversation_id, order_number, total_cents, shop_id, updated_at")
    .eq("phase", "confirmed")
    .eq("payment_status", "paid")
    .is("ticket_emailed_at", null)
    .lt("updated_at", cutoff)
    .limit(50);

  if (!carts || carts.length === 0) return [];

  // Get shop tenant_ids
  const shopIds = [...new Set((carts as Array<{ shop_id: string }>).map(c => c.shop_id))];
  const { data: shops } = await supabase
    .from("shops")
    .select("id, tenant_id, name")
    .in("id", shopIds);
  const shopMap = new Map((shops ?? []).map((s: { id: string; tenant_id: string; name: string }) => [s.id, s]));

  // Pre-check: skip carts that already have an open ticket issue
  const convIds = (carts as Array<{ conversation_id: string }>).map(c => c.conversation_id);
  const { data: existingIssues } = await supabase
    .from("issues")
    .select("conversation_id")
    .eq("status", "open")
    .in("detection_rule", ["ticket_send_failed", "ticket_no_destination", "ticket_missing"])
    .in("conversation_id", convIds);
  const convsWithIssue = new Set((existingIssues ?? []).map((i: { conversation_id: string }) => i.conversation_id));

  const issues: PendingIssue[] = [];
  for (const cart of (carts as Array<{ id: string; conversation_id: string; order_number: number | null; total_cents: number | null; shop_id: string; updated_at: string }>)) {
    if (convsWithIssue.has(cart.conversation_id)) continue;
    const shop = shopMap.get(cart.shop_id);
    if (!shop) continue;

    issues.push({
      tenant_id: shop.tenant_id,
      shop_id: cart.shop_id,
      conversation_id: cart.conversation_id,
      eval_id: null,
      severity: "sev_1",
      detection_rule: "ticket_missing",
      title: `Order #${cart.order_number ?? cart.id} has no kitchen ticket`,
      description: `Order #${cart.order_number ?? cart.id} ($${((cart.total_cents ?? 0) / 100).toFixed(2)}) was paid but has no ticket_emailed_at after ${Math.round((Date.now() - new Date(cart.updated_at).getTime()) / 60000)} minutes. The kitchen may have missed this order.`,
      metadata: {
        cart_id: cart.id,
        order_number: cart.order_number ?? null,
        total_cents: cart.total_cents ?? null,
        shop_name: shop.name ?? null,
      },
    });
  }
  return issues;
}

/** Sev-3: Low-score conversation — any flagged eval with minor severity. */
async function detectLowScoreConversations(
  supabase: SupabaseClient,
  opts: SweepOptions = {},
): Promise<PendingIssue[]> {
  const since = opts.backfill
    ? "1970-01-01T00:00:00Z"
    : new Date(Date.now() - LOOKBACK_HOURS * 60 * 60_000).toISOString();
  const { data } = await supabase
    .from("conversation_evals")
    .select("id, tenant_id, shop_id, conversation_id, flags, max_severity")
    .eq("verdict", "flagged")
    .eq("max_severity", "minor")
    .gte("judged_at", since);

  const rows = (data ?? []) as Array<{
    id: string; tenant_id: string; shop_id: string | null;
    conversation_id: string; flags: Array<{ check: string; explanation: string }>;
    max_severity: string;
  }>;

  return rows.map((r) => {
    const flagChecks = r.flags.map((f) => f.check).join(", ");
    return {
      tenant_id: r.tenant_id,
      shop_id: r.shop_id ?? null,
      conversation_id: r.conversation_id,
      eval_id: r.id,
      severity: "sev_3" as const,
      detection_rule: "low_score_conversation",
      title: `Low-score conversation: ${flagChecks}`,
      description: `A conversation was flagged with MINOR severity. Checks: ${flagChecks}. ${r.flags.map((f) => f.explanation).join(" | ")}`,
      metadata: {
        conversation_id: r.conversation_id,
        eval_id: r.id,
        flags: r.flags,
      },
    };
  });
}

interface SweepOptions {
  backfill?: boolean;
  /** Escalation rule only: include test-mode shops (validation walk only). */
  include_test_mode?: boolean;
}

interface EscalationCandidate {
  id: string;
  shop_id: string;
  conversation_id: string | null;
  order_number: number | null;
  total_cents: number | null;
  expo_status: string;
  expo_acknowledged_at: string | null;
  payment_status: string;
  test_mode: boolean;
  ticket_emailed_at: string | null;
  ticket_delivery_at: string | null;
  ticket_delivery_status: string | null;
  owner_escalated_at: string | null;
}

interface EscalationReport {
  candidates_scanned: number;
  issues_created: number;
  sends_attempted: number;
  sends_sent: number;
}

// ─── Escalation SMS provider (mirrors chat-sms resolveSmsProvider) ────────────
// Never the hardcoded-Twilio path from stripe-webhook — Telnyx first, Twilio
// as rollback, same as every other outbound in the system.
function resolveEscalationSmsProvider(): "telnyx" | "twilio" {
  const telnyxKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  return telnyxKey.length > 0 ? "telnyx" : "twilio";
}

/** Send the owner-escalation SMS through the resolved provider, via guardedSend
 *  (the only door to the network). Throws on delivery failure so the caller can
 *  log it without touching the already-committed exactly-once claim. */
async function sendEscalationSms(
  ctx: OutboundContext,
  provider: "telnyx" | "twilio",
  fromNumber: string,
  toNumber: string,
  message: string,
): Promise<{ sent: boolean }> {
  if (provider === "telnyx") {
    const apiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
    if (!apiKey) throw new Error("Telnyx API key not configured");

    const { sent } = await guardedSend({ ...ctx, to: toNumber }, async () => {
      const res = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromNumber, to: toNumber, text: message }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Telnyx escalation send failed: ${res.status} ${errText}`);
      }
    });
    return { sent };
  }

  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  if (!accountSid || !authToken) throw new Error("Twilio credentials not configured");

  const { sent } = await guardedSend({ ...ctx, to: toNumber }, async () => {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${btoa(`${accountSid}:${authToken}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: fromNumber,
          To: toNumber,
          Body: message,
          ...(Deno.env.get("TWILIO_MESSAGING_SERVICE_SID")
            ? { MessagingServiceSid: Deno.env.get("TWILIO_MESSAGING_SERVICE_SID")! }
            : {}),
        }),
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Twilio escalation send failed: ${res.status} ${errText}`);
    }
  });
  return { sent };
}

/**
 * Sev-1: Unacknowledged-order escalation (INSTRUCTION-10 item I).
 *
 * A PAID order whose kitchen ticket was handed off, still `expo_status='new'`
 * (never acknowledged) 7+ minutes later → exactly one SMS to the SHOP OWNER'S
 * OWN mobile, never the diner. Exactly-once is enforced by a conditional
 * UPDATE claim on order_carts (WHERE owner_escalated_at IS NULL RETURNING id)
 * — never gated on the issues table, which can be deduped/closed/reopened
 * independently of whether an order was ever actually claimed.
 */
export async function detectUnackedOrders(
  supabase: SupabaseClient,
  opts: SweepOptions = {},
): Promise<EscalationReport> {
  const report: EscalationReport = {
    candidates_scanned: 0,
    issues_created: 0,
    sends_attempted: 0,
    sends_sent: 0,
  };

  // Permanently-ineligible rows (test-mode, bounced/complained tickets) are
  // filtered at the QUERY level, not just in the loop below — otherwise they
  // never get owner_escalated_at set, never leave the "oldest 100" window,
  // and permanently starve real candidates out of the LIMIT. Postgrest's
  // `not.in` excludes NULLs by SQL three-valued-logic, so the null case is
  // OR'd in explicitly (a NULL delivery status has no bounce/complaint yet).
  const now = Date.now();
  const cutoffIso = new Date(now - ESCALATION_THRESHOLD_MIN * 60_000).toISOString();

  let query = supabase
    .from("order_carts")
    .select(
      "id, shop_id, conversation_id, order_number, total_cents, expo_status, expo_acknowledged_at, payment_status, test_mode, ticket_emailed_at, ticket_delivery_at, ticket_delivery_status, owner_escalated_at",
    )
    .in("payment_status", [...PAID_STATES])
    .eq("expo_status", "new")
    .is("expo_acknowledged_at", null)
    .is("owner_escalated_at", null)
    .not("ticket_emailed_at", "is", null)
    .lte("ticket_emailed_at", cutoffIso)
    .or("ticket_delivery_status.is.null,ticket_delivery_status.not.in.(bounced,complained)")
    .order("ticket_emailed_at", { ascending: true })
    .limit(ESCALATION_QUERY_LIMIT);

  if (!opts.include_test_mode) {
    query = query.eq("test_mode", false);
  }

  const { data: rows } = await query;

  const candidates = (rows ?? []) as EscalationCandidate[];
  report.candidates_scanned = candidates.length;

  // ── Phase 1: filter + per-shop cap in memory (no DB calls) ──────────────
  const perShopCount = new Map<string, number>();
  const eligible: Array<{ cart: EscalationCandidate; unackedMinutes: number }> = [];

  for (const cart of candidates) {
    // Belt-and-suspenders: the query above already excludes these, but the
    // loop re-checks in case a future query edit drops a filter.
    if (!opts.include_test_mode && cart.test_mode) continue;
    if (cart.ticket_delivery_status === "bounced" || cart.ticket_delivery_status === "complained") continue;

    // Clock: prefer a confirmed delivery event; fall back to handed-to-Resend
    // so the rule still fires while item H's delivery webhooks are pending.
    const effectiveAtStr = cart.ticket_delivery_at ?? cart.ticket_emailed_at;
    if (!effectiveAtStr) continue;
    const effectiveAt = new Date(effectiveAtStr).getTime();
    if (!Number.isFinite(effectiveAt)) continue;

    const unackedMinutes = (now - effectiveAt) / 60_000;
    if (unackedMinutes < ESCALATION_THRESHOLD_MIN) continue;

    const shopCount = perShopCount.get(cart.shop_id) ?? 0;
    if (shopCount >= ESCALATION_PER_SHOP_CAP) continue;
    perShopCount.set(cart.shop_id, shopCount + 1);

    eligible.push({ cart, unackedMinutes });
  }

  if (eligible.length === 0) return report;

  // ── Phase 2: ONE batched exactly-once claim for every eligible cart ─────
  // Still race-safe per row (`owner_escalated_at IS NULL` in the WHERE), but
  // costs one round trip instead of one per candidate.
  const { data: claimed, error: claimErr } = await supabase
    .from("order_carts")
    .update({ owner_escalated_at: new Date().toISOString() })
    .in("id", eligible.map((e) => e.cart.id))
    .is("owner_escalated_at", null)
    .select("id");

  if (claimErr) {
    console.error(`[issue-detector] escalation batch claim error:`, claimErr.message);
    return report;
  }

  const wonIds = new Set((claimed ?? []).map((r: { id: string }) => r.id));
  const won = eligible.filter((e) => wonIds.has(e.cart.id));
  if (won.length === 0) return report;

  // ── Phase 3: ONE batched shop lookup for every won candidate ────────────
  const shopIds = [...new Set(won.map((e) => e.cart.shop_id))];
  const { data: shopRows } = await supabase
    .from("shops")
    .select("id, tenant_id, name, owner_mobile, phone_number_e164")
    .in("id", shopIds);

  const shopMap = new Map(
    (shopRows ?? []).map((s: { id: string; tenant_id: string; name: string | null; owner_mobile: string | null; phone_number_e164: string | null }) => [s.id, s]),
  );

  for (const { cart, unackedMinutes } of won) {
    const shop = shopMap.get(cart.shop_id);
    if (!shop) {
      console.error(`[issue-detector] escalation: shop ${cart.shop_id} not found for cart ${cart.id}`);
      continue;
    }

    const minutesRounded = Math.round(unackedMinutes);

    // ── issue row (audit trail, dashboard) ───────────────────────
    // createIssue dedups by (detection_rule, tenant_id, conversation_id,
    // status=open) — also enforced as a hard DB constraint
    // (uq_issues_rule_tenant_open), so a second order in the same open
    // conversation legitimately shares one issue card, same as every other
    // rule. The exactly-once DB claim above already guarantees the SMS/audit
    // side effects for THIS order happened exactly once regardless.
    const created = await createIssue(supabase, {
      tenant_id: shop.tenant_id,
      shop_id: cart.shop_id,
      conversation_id: cart.conversation_id,
      eval_id: null,
      severity: "sev_1",
      detection_rule: "unacked_order_escalation",
      title: `Order #${cart.order_number ?? cart.id} unacknowledged for ${minutesRounded} minutes`,
      description:
        `Order #${cart.order_number ?? cart.id} at ${shop.name ?? shop.id} has not been acknowledged ` +
        `on the Expo Screen for ${minutesRounded} minutes after the kitchen ticket was handed off.`,
      metadata: {
        cart_id: cart.id,
        order_number: cart.order_number ?? null,
        unacked_minutes: minutesRounded,
        shop_name: shop.name ?? null,
      },
    });
    if (created) report.issues_created += 1;

    // ── Step 4: send — ONLY shops.owner_mobile, never a diner number ────
    if (!shop.owner_mobile) {
      console.warn(`[issue-detector] escalation: shop ${shop.id} has no owner_mobile — issue created, no send.`);
      continue;
    }
    if (!shop.phone_number_e164) {
      // No sender number configured — a real send would fail anyway; don't
      // burn the network round-trip (or confuse the failure with a delivery
      // problem). The issue row above already surfaces this order.
      console.warn(`[issue-detector] escalation: shop ${shop.id} has no phone_number_e164 — issue created, no send.`);
      continue;
    }

    const ctx: OutboundContext = {
      reason: "owner_escalation",
      shopId: cart.shop_id,
      tenantId: shop.tenant_id,
      conversationId: cart.conversation_id,
      cartId: cart.id,
      cartPaymentStatus: cart.payment_status,
      ticketHandedOff: true,
      unackedMinutes: minutesRounded,
      escalationClaimed: true,
    };

    const message =
      `SprintAI: order #${cart.order_number ?? cart.id} at ${shop.name ?? "your shop"} has not been ` +
      `acknowledged for ${minutesRounded} minutes. Open the Expo Screen: getsprintai.com/admin/expo`;

    report.sends_attempted += 1;
    try {
      const provider = resolveEscalationSmsProvider();
      const { sent } = await sendEscalationSms(
        ctx,
        provider,
        shop.phone_number_e164,
        shop.owner_mobile,
        message,
      );
      if (sent) report.sends_sent += 1;
    } catch (err) {
      // ── Step 5: on send failure, log and leave owner_escalated_at set ──
      // A retry storm is worse than one missed alert; the issue row remains
      // for the dashboard.
      console.error(`[issue-detector] escalation send failed for cart ${cart.id}:`, (err as Error).message);
    }
  }

  return report;
}

// ─── Sweep orchestrator ──────────────────────────────────────────────────────
// mode:"escalation" runs ONLY detectUnackedOrders (the 2-minute cron in
// migration 093). The default full sweep (10-minute cron, 047/048) still
// includes it too, so a shop isn't only covered by the fast cron.
async function runDetection(
  supabase: SupabaseClient,
  opts: SweepOptions = {},
  mode?: "escalation",
): Promise<ScanReport> {
  const report: ScanReport = {
    evals_scanned: 0,
    tenants_scanned: 0,
    issues_created: 0,
    issues_deduped: 0,
    by_severity: { sev_1: 0, sev_2: 0, sev_3: 0 },
  };

  if (mode === "escalation") {
    const escalation = await detectUnackedOrders(supabase, opts);
    report.issues_created += escalation.issues_created;
    report.by_severity.sev_1 += escalation.issues_created;
    report.escalation = {
      candidates_scanned: escalation.candidates_scanned,
      sends_attempted: escalation.sends_attempted,
      sends_sent: escalation.sends_sent,
    };
    console.log(
      `[issue-detector] escalation mode: ${escalation.candidates_scanned} candidates, ` +
      `${escalation.issues_created} issues, ${escalation.sends_sent}/${escalation.sends_attempted} sends`,
    );
    return report;
  }

  // Collect all pending issues from all rules
  const allIssues: PendingIssue[] = [];

  const ruleRunners = [
    { fn: () => detectErrorSpike(supabase, opts), label: "error_spike" },
    { fn: () => detectComplianceViolations(supabase, opts), label: "compliance_violation" },
    { fn: () => detectQualityDecline(supabase, opts), label: "quality_decline" },
    { fn: () => detectIntentFailure(supabase, opts), label: "intent_failure" },
    { fn: () => detectLatencySpike(supabase, opts), label: "latency_spike" },
    { fn: () => detectTicketSendFailures(supabase, opts), label: "ticket_send_failed" },
    { fn: () => detectMissingTickets(supabase, opts), label: "ticket_missing" },
    { fn: () => detectLowScoreConversations(supabase, opts), label: "low_score_conversation" },
  ];

  for (const { fn, label } of ruleRunners) {
    try {
      const issues = await fn();
      allIssues.push(...issues);
      if (issues.length > 0) {
        console.log(`[issue-detector] ${label}: ${issues.length} issues detected`);
      }
    } catch (err) {
      console.error(`[issue-detector] rule ${label} failed:`, (err as Error).message);
    }
  }

  // Deduplicate and write
  for (const issue of allIssues) {
    try {
      const created = await createIssue(supabase, issue);
      if (created) {
        report.issues_created += 1;
        report.by_severity[issue.severity] = (report.by_severity[issue.severity] ?? 0) + 1;
      } else {
        report.issues_deduped += 1;
      }
    } catch (err) {
      console.error(`[issue-detector] write failed for ${issue.detection_rule}:`, (err as Error).message);
    }
  }

  // detectUnackedOrders manages its own claim + issue-write + send per
  // candidate (exactly-once semantics), so it runs outside the generic
  // PendingIssue[] batch above — merge its tally into the sweep report.
  try {
    const escalation = await detectUnackedOrders(supabase, opts);
    report.issues_created += escalation.issues_created;
    report.by_severity.sev_1 += escalation.issues_created;
    report.escalation = {
      candidates_scanned: escalation.candidates_scanned,
      sends_attempted: escalation.sends_attempted,
      sends_sent: escalation.sends_sent,
    };
    if (escalation.issues_created > 0) {
      console.log(`[issue-detector] unacked_order_escalation: ${escalation.issues_created} issues detected`);
    }
  } catch (err) {
    console.error(`[issue-detector] rule unacked_order_escalation failed:`, (err as Error).message);
  }

  return report;
}

// ─── Entry point ─────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!url || !key) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing SUPABASE_URL / SERVICE_ROLE_KEY" }),
      { status: 500, headers: { ...CORS, "content-type": "application/json" } },
    );
  }

  // Parse optional mode:
  //  - backfill=true → remove lookback window, scan ALL evals for flagged/unresolved
  //  - mode="escalation" → run ONLY the 7-minute unacked-order rule (2-min cron)
  let backfill = false;
  let mode: "escalation" | undefined;
  try {
    const body = await req.json();
    backfill = Boolean(body?.backfill);
    mode = body?.mode === "escalation" ? "escalation" : undefined;
  } catch { /* default: regular sweep with lookback */ }

  // include_test_mode is deliberately NOT read from the request body: this
  // endpoint runs verify_jwt=false, so a client-supplied flag here would let
  // any caller bypass the demo-shop safety skip and trigger real SMS sends
  // to test-mode shops' owner_mobile. The validation walk sets this via a
  // server-side secret instead — set/unset ESCALATION_INCLUDE_TEST_MODE=true
  // in the function's env for the duration of the walk only.
  const includeTestMode = Deno.env.get("ESCALATION_INCLUDE_TEST_MODE") === "true";

  // On backfill, temporarily widen the lookback to include all evals since epoch.
  // We do this by setting a wide LOOKBACK global that the rules use.
  if (backfill) {
    // Widen to 365 days — effectively all evals.
    console.log("[issue-detector] BACKFILL mode — scanning all evals, no lookback limit");
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  try {
    const report = await runDetection(supabase, { backfill, include_test_mode: includeTestMode }, mode);
    return new Response(JSON.stringify({ ok: true, report }), {
      status: 200,
      headers: { ...CORS, "content-type": "application/json" },
    });
  } catch (e) {
    console.error("[issue-detector] sweep failed:", (e as Error).message);
    return new Response(
      JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 200, headers: { ...CORS, "content-type": "application/json" } },
    );
  }
});
