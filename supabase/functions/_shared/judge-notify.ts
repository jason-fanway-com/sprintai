/**
 * SprintAI Conversation-Judge notify layer (Spec 06 §4).
 *
 * Builds a severity-ordered Telegram digest from NEW flagged evals and provides
 * a CLEARLY-GATED send seam. In TEST mode the send is stubbed: the digest
 * payload is returned/logged as an artifact and NOT actually sent to Jason's
 * live Telegram. Flipping JUDGE_TELEGRAM_SEND_ENABLED=true (env) + providing a
 * bot token/chat id is the only thing that makes a real send happen.
 *
 * Rules:
 *  - CRITICAL/MAJOR flags ping individually (worst-first), each line carries:
 *    shop name + check + one-line evidence snippet + transcript reference.
 *  - MINOR rolls up into a periodic (daily) summary, NOT per-incident pings.
 *  - Quiet on clean: if there is nothing CRITICAL/MAJOR new, no immediate ping.
 */

import type { Severity } from "./judge-rubric.ts";

export interface EvalFlag {
  check: string;
  severity: Severity;
  evidence_message_ids: string[];
  explanation: string;
}

export interface FlaggedEvalRow {
  id: string;
  tenant_id: string;
  shop_id: string | null;
  conversation_id: string;
  shop_name: string;
  max_severity: Severity | null;
  flags: EvalFlag[];
  judged_at: string;
}

/** A short evidence snippet pulled from the explanation (one line). */
function snippet(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** Public app base for transcript drill-down links. */
const APP_BASE =
  Deno.env.get("ADMIN_APP_BASE_URL") ?? "https://app.getsprintai.com";

function transcriptRef(conversationId: string): string {
  return `${APP_BASE}/conversations/${conversationId}`;
}

const SEV_RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 };
const SEV_EMOJI: Record<Severity, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🟡",
};

export interface DigestPayload {
  kind: "immediate" | "minor_rollup";
  generated_at: string;
  /** Telegram-ready text (Markdown-ish, plain enough to also read raw). */
  text: string;
  /** Eval ids covered by this digest (so caller can mark notified_at). */
  eval_ids: string[];
  /** Structured lines for the Command Center / artifact. */
  lines: Array<{
    severity: Severity;
    shop_name: string;
    check: string;
    evidence: string;
    transcript_ref: string;
    conversation_id: string;
    eval_id: string;
  }>;
}

/**
 * Build the IMMEDIATE digest: only CRITICAL + MAJOR flags, severity-ordered
 * (worst first), one line per flag. Returns null if there is nothing to ping.
 */
export function buildImmediateDigest(rows: FlaggedEvalRow[]): DigestPayload | null {
  const lines: DigestPayload["lines"] = [];
  for (const row of rows) {
    for (const f of row.flags) {
      if (f.severity === "critical" || f.severity === "major") {
        lines.push({
          severity: f.severity,
          shop_name: row.shop_name,
          check: f.check,
          evidence: snippet(f.explanation),
          transcript_ref: transcriptRef(row.conversation_id),
          conversation_id: row.conversation_id,
          eval_id: row.id,
        });
      }
    }
  }
  if (lines.length === 0) return null;

  lines.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);

  const body = lines
    .map(
      (l) =>
        `${SEV_EMOJI[l.severity]} *${l.severity.toUpperCase()}* — ${l.shop_name}\n` +
        `   check: \`${l.check}\`\n` +
        `   ${l.evidence}\n` +
        `   transcript: ${l.transcript_ref}`,
    )
    .join("\n\n");

  const text =
    `🏁 *Sprint Conversation Judge* — ${lines.length} new issue(s)\n\n${body}`;

  return {
    kind: "immediate",
    generated_at: new Date().toISOString(),
    text,
    eval_ids: [...new Set(lines.map((l) => l.eval_id))],
    lines,
  };
}

/**
 * Build the MINOR daily rollup: counts of minor flags grouped by shop+check.
 * Returns null if there are no minor flags.
 */
export function buildMinorRollup(rows: FlaggedEvalRow[]): DigestPayload | null {
  const counts = new Map<string, { shop: string; check: string; n: number }>();
  const lines: DigestPayload["lines"] = [];
  const evalIds = new Set<string>();

  for (const row of rows) {
    for (const f of row.flags) {
      if (f.severity !== "minor") continue;
      evalIds.add(row.id);
      const key = `${row.shop_name}::${f.check}`;
      const cur = counts.get(key) ?? { shop: row.shop_name, check: f.check, n: 0 };
      cur.n += 1;
      counts.set(key, cur);
      lines.push({
        severity: "minor",
        shop_name: row.shop_name,
        check: f.check,
        evidence: snippet(f.explanation),
        transcript_ref: transcriptRef(row.conversation_id),
        conversation_id: row.conversation_id,
        eval_id: row.id,
      });
    }
  }
  if (counts.size === 0) return null;

  const body = [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .map((c) => `🟡 ${c.shop} — \`${c.check}\` ×${c.n}`)
    .join("\n");

  const text = `🏁 *Sprint Judge — daily quality rollup (MINOR)*\n\n${body}`;

  return {
    kind: "minor_rollup",
    generated_at: new Date().toISOString(),
    text,
    eval_ids: [...evalIds],
    lines,
  };
}

/**
 * Send seam — CLEARLY GATED. By default (test mode) this does NOT message
 * Jason; it returns {sent:false, stubbed:true} and the caller logs/persists the
 * payload as an artifact. A real send only happens when:
 *   JUDGE_TELEGRAM_SEND_ENABLED === "true"  AND
 *   TELEGRAM_BOT_TOKEN + JUDGE_TELEGRAM_CHAT_ID are set.
 */
export async function sendDigest(
  payload: DigestPayload,
): Promise<{ sent: boolean; stubbed: boolean; reason?: string }> {
  const enabled = Deno.env.get("JUDGE_TELEGRAM_SEND_ENABLED") === "true";
  if (!enabled) {
    console.log(
      "[judge-notify] STUBBED (JUDGE_TELEGRAM_SEND_ENABLED!=true). Digest payload:",
      JSON.stringify(payload),
    );
    return { sent: false, stubbed: true, reason: "send-disabled (test mode)" };
  }

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("JUDGE_TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    console.warn("[judge-notify] send enabled but token/chat id missing — not sending.");
    return { sent: false, stubbed: true, reason: "missing token/chat id" };
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: payload.text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("[judge-notify] telegram send failed:", res.status, t);
    return { sent: false, stubbed: false, reason: `telegram ${res.status}` };
  }
  return { sent: true, stubbed: false };
}
