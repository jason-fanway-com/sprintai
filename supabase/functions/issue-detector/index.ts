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

// ─── Config ──────────────────────────────────────────────────────────────────
const LOOKBACK_HOURS = 24;
const ERROR_SPIKE_THRESHOLD = 3;     // errored evals in 1 hour window
const ERROR_SPIKE_WINDOW_MIN = 60;
const FLAGGED_RATE_THRESHOLD = 0.30; // 30% flagged in last 50 evals
const FLAGGED_RATE_SAMPLE = 50;
const INTENT_FAILURE_THRESHOLD = 5;  // flagged convs in 1 hour
const INTENT_FAILURE_WINDOW_MIN = 60;
const LATENCY_P95_MS = 60_000;        // 60 seconds P95

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
async function isDuplicate(
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
async function createIssue(
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
}

// ─── Sweep orchestrator ──────────────────────────────────────────────────────
async function runDetection(supabase: SupabaseClient, opts: SweepOptions = {}): Promise<ScanReport> {
  const report: ScanReport = {
    evals_scanned: 0,
    tenants_scanned: 0,
    issues_created: 0,
    issues_deduped: 0,
    by_severity: { sev_1: 0, sev_2: 0, sev_3: 0 },
  };

  // Collect all pending issues from all rules
  const allIssues: PendingIssue[] = [];

  const ruleRunners = [
    { fn: () => detectErrorSpike(supabase, opts), label: "error_spike" },
    { fn: () => detectComplianceViolations(supabase, opts), label: "compliance_violation" },
    { fn: () => detectQualityDecline(supabase, opts), label: "quality_decline" },
    { fn: () => detectIntentFailure(supabase, opts), label: "intent_failure" },
    { fn: () => detectLatencySpike(supabase, opts), label: "latency_spike" },
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
  let backfill = false;
  try {
    const body = await req.json();
    backfill = Boolean(body?.backfill);
  } catch { /* default: regular sweep with lookback */ }

  // On backfill, temporarily widen the lookback to include all evals since epoch.
  // We do this by setting a wide LOOKBACK global that the rules use.
  if (backfill) {
    // Widen to 365 days — effectively all evals.
    console.log("[issue-detector] BACKFILL mode — scanning all evals, no lookback limit");
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  try {
    const report = await runDetection(supabase, { backfill });
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
