// REAL-LLM rubric proof (Spec 06 §5). Calls the actual judge model with the
// versioned rubric on SEEDED transcripts and prints verdict + severity +
// evidence ids. Requires ANTHROPIC_API_KEY in env (read from ~/.openclaw/.secrets
// by the wrapper script). READ-ONLY: no DB, no SMS, no live path.
//
// Run: ANTHROPIC_API_KEY=... deno run --allow-env --allow-net run-rubric-proof.ts

import {
  assembleJudgePrompt,
  maxSeverityOf,
  parseJudgeJson,
  CHECK_SEVERITY,
  type CheckId,
  type Severity,
} from "../../_shared/judge-rubric.ts";
import { SEED_CASES, CLEAN_BATCH, ISOLATION_CASE, type SeedCase } from "./seeds.ts";

const JUDGE_MODEL = Deno.env.get("JUDGE_MODEL") ?? "claude-haiku-4-5";
const CLAUDE_API = "https://api.anthropic.com/v1/messages";

interface Flag { check: string; severity: Severity; evidence_message_ids: string[]; explanation: string }

function coerceFlags(parsed: unknown): Flag[] {
  if (!parsed || typeof parsed !== "object") return [];
  const arr = (parsed as { flags?: unknown }).flags;
  if (!Array.isArray(arr)) return [];
  const out: Flag[] = [];
  for (const f of arr) {
    if (!f || typeof f !== "object") continue;
    const check = (f as { check?: string }).check;
    if (!check || !(check in CHECK_SEVERITY)) continue;
    const ids = (f as { evidence_message_ids?: unknown }).evidence_message_ids;
    out.push({
      check,
      severity: CHECK_SEVERITY[check as CheckId],
      evidence_message_ids: Array.isArray(ids) ? ids.map(String) : [],
      explanation: String((f as { explanation?: unknown }).explanation ?? ""),
    });
  }
  return out;
}

async function judge(c: SeedCase): Promise<{ verdict: string; flags: Flag[]; raw: string }> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  const { system, user } = assembleJudgePrompt(c.ground, c.transcript);
  const res = await fetch(CLAUDE_API, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 1024, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text: string = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("").trim();
  const parsed = parseJudgeJson(text) ?? {};
  const flags = coerceFlags(parsed);
  return { verdict: flags.length ? "flagged" : "clean", flags, raw: text };
}

function ok(b: boolean): string { return b ? "PASS" : "FAIL"; }

let allPass = true;

async function check(c: SeedCase, label: string) {
  const r = await judge(c);
  const maxSev = maxSeverityOf(r.flags);
  let pass = r.verdict === c.expect;
  let detail = `verdict=${r.verdict} (want ${c.expect})`;
  if (c.expect === "flagged") {
    const hit = r.flags.find((f) => f.check === c.expectCheck);
    const sevOk = hit ? hit.severity === c.expectSeverity : false;
    const evOk = hit ? hit.evidence_message_ids.length > 0 : false;
    pass = pass && !!hit && sevOk && evOk;
    detail += ` | check=${c.expectCheck} present=${!!hit} sev=${hit?.severity}(want ${c.expectSeverity}) evidence=${hit?.evidence_message_ids.join(",")}`;
  } else {
    pass = pass && r.flags.length === 0;
    detail += ` | flags=${r.flags.length}`;
  }
  if (!pass) allPass = false;
  console.log(`[${ok(pass)}] ${label}::${c.name} maxSev=${maxSev} :: ${detail}`);
  if (r.flags.length) console.log(`        flags: ${JSON.stringify(r.flags)}`);
}

console.log("=== Conversation-Judge REAL-LLM rubric proof ===");
console.log(`model: ${JUDGE_MODEL}\n`);

console.log("--- Rubric fires on known-bad + clean (Spec §5) ---");
for (const c of SEED_CASES) await check(c, "rubric");

console.log("\n--- Quiet on clean batch (zero flags) ---");
for (const c of CLEAN_BATCH) await check(c, "cleanbatch");

console.log("\n--- Tenant isolation: T1 conversation ordering T2's sushi, judged with T1 ground truth only ---");
await check(ISOLATION_CASE, "isolation");
console.log("  (If T2's sushi menu had leaked into T1's ground truth, this would be CLEAN. It must FLAG invented_item.)");

console.log(`\n=== OVERALL: ${allPass ? "ALL PASS" : "SOME FAIL"} ===`);
if (!allPass) Deno.exit(1);
