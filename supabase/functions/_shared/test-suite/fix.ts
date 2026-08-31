/**
 * fix.ts — Root-cause + proposed-fix generation for FAILING test cases.
 *
 * For every failed case, an LLM reads the transcript + judge findings and
 * returns a concise { root_cause, proposed_fix }. Criticals MUST always get
 * one — the whole point of the fix loop is that a failing critical never
 * lands in the DB with an empty root cause.
 *
 * Reuses the shared judge JSON parser so the output contract is the same
 * robust extraction used by the judge (no new parsing quirks).
 */

import { parseJudgeJson } from "../judge-rubric.ts";
import type { AnyCase } from "./library.ts";
import type { JudgeResult } from "./judge.ts";
import type { RunResult } from "./runner.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface FixResult {
  root_cause: string;
  proposed_fix: string;
}

export interface FixConfig {
  /** OpenRouter/Anthropic API key for the fix LLM. */
  fixApiKey: string;
  /** Fix model id (default deepseek-v4-flash). */
  fixModel?: string;
  /** Optional API endpoint override (default OpenRouter). */
  fixApiUrl?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function transcriptText(run: RunResult): string {
  if (run.error) return `RUNNER ERROR: ${run.error}`;
  const lines: string[] = [];
  let idx = 0;
  for (const t of run.transcript) {
    idx++;
    lines.push(`[${idx}-customer] ${t.message}`);
    if (t.reply !== undefined && t.reply !== null) {
      idx++;
      lines.push(`[${idx}-assistant] ${t.reply}`);
    }
  }
  return lines.join("\n") || "(empty transcript)";
}

function judgeFindingsText(judge: JudgeResult): string {
  const parts: string[] = [];
  if (judge.flags.length > 0) {
    parts.push("Judge flags:");
    for (const f of judge.flags) {
      parts.push(`  - [${f.severity}] ${f.check}: ${f.explanation}`);
    }
  }
  const failed = judge.criteria.filter((c) => !c.passed);
  if (failed.length > 0) {
    parts.push("Failed criteria:");
    for (const c of failed) {
      parts.push(`  - ${c.id}: ${c.reason || "no reason"}`);
    }
  }
  if (parts.length === 0) parts.push("(no detailed findings)");
  return parts.join("\n");
}

const FIX_SYSTEM = `You are the SprintAI test-failure triage assistant. Given a FAILED
conversation test case — the case definition, the bot transcript, and the
judge's findings — you diagnose WHY it failed and propose a concrete,
actionable fix in the SprintAI codebase/prompt/config.

SprintAI is an SMS/web ordering bot for family-owned restaurants. The fix
should point at a real lever: a prompt change in the chat-sms edge function, a
rubric check that needs a rule, a menu/config data issue, a guardrail, or a
specific code path. Do NOT propose vague "improve the prompt" — name the
specific behavior to change and where.

Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "root_cause": "<one or two sentences, specific, no hedging>",
  "proposed_fix": "<concrete actionable fix, 2-4 sentences, name the file/system>"
}
Keep both fields tight and specific.`;

const FIX_RETRY = `\n\nYOUR PREVIOUS REPLY WAS NOT VALID JSON. Respond with ONLY a JSON object
{"root_cause": "...", "proposed_fix": "..."} and nothing else.`;

function buildUserPrompt(run: RunResult, testCase: AnyCase, judge: JudgeResult): string {
  return `CASE: ${testCase.id} — ${testCase.label}
CATEGORY: ${testCase.category} | CRITICALITY: ${testCase.criticality}

SUCCESS CRITERIA:
${testCase.success_criteria.map((c) => `  - ${c.id}: ${c.description}`).join("\n")}

JUDGE FINDINGS:
${judgeFindingsText(judge)}

TRANSCRIPT:
${transcriptText(run)}

Diagnose the failure and return the JSON object.`;
}

async function fixApiCall(
  config: FixConfig,
  user: string,
): Promise<string> {
  const url = config.fixApiUrl ?? "https://openrouter.ai/api/v1/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.fixApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://getsprintai.com",
      "X-Title": "SprintAI Fix Loop",
    },
    body: JSON.stringify({
      model: config.fixModel ?? "deepseek/deepseek-v4-flash",
      max_tokens: 512,
      reasoning: { enabled: false },
      messages: [
        { role: "system", content: FIX_SYSTEM },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Fix API ${res.status}: ${t.slice(0, 500)}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

function parseFix(text: string): FixResult | null {
  const parsed = parseJudgeJson(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const p = parsed as { root_cause?: string; proposed_fix?: string };
    const rootCause = (p.root_cause ?? "").trim();
    const proposedFix = (p.proposed_fix ?? "").trim();
    if (rootCause || proposedFix) {
      return { root_cause: rootCause, proposed_fix: proposedFix };
    }
  }
  return null;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate root_cause + proposed_fix for a FAILED case. One LLM call, one
 * retry on unparseable output. On total failure, falls back to a deterministic
 * (non-empty) root cause derived from the judge findings so a critical is
 * never persisted empty.
 */
export async function generateRootCauseFix(
  config: FixConfig,
  run: RunResult,
  testCase: AnyCase,
  judge: JudgeResult,
): Promise<FixResult> {
  const user = buildUserPrompt(run, testCase, judge);

  const text = await fixApiCall(config, user);
  let result = parseFix(text);
  if (!result) {
    const retryText = await fixApiCall(config, user + FIX_RETRY);
    result = parseFix(retryText);
  }

  if (!result) {
    // Deterministic fallback — never empty for a failing case.
    const failed = judge.criteria.filter((c) => !c.passed);
    const summary = failed.length
      ? failed.map((c) => `${c.id}: ${c.reason || "failed"}`).join("; ")
      : (judge.flags.length
          ? judge.flags.map((f) => `${f.check}: ${f.explanation}`).join("; ")
          : "Case failed with no recorded findings");
    result = {
      root_cause: `Case "${testCase.id}" failed. ${summary}`,
      proposed_fix: `Investigate the chat-sms behavior for case "${testCase.id}" and correct the failing behavior identified above.`,
    };
  }

  return result;
}
