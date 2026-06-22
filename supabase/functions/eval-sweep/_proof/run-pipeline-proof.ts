// Pipeline proof (Spec 06 §5) — NO LLM, NO DB, NO network. Exercises the pure
// judge pipeline logic: idempotency hashing, digest assembly (severity order +
// MINOR rollup), safe-degrade, and the auto-fix seam being OFF.
//
// Run: deno run --allow-env run-pipeline-proof.ts

import { maxSeverityOf, parseJudgeJson } from "../../_shared/judge-rubric.ts";
import {
  buildImmediateDigest,
  buildMinorRollup,
  type FlaggedEvalRow,
} from "../../_shared/judge-notify.ts";
import { maybeAutoFix, autofixEnabled } from "../../_shared/judge-autofix.ts";

let pass = true;
function assert(name: string, cond: boolean, extra = "") {
  if (!cond) pass = false;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${extra ? " :: " + extra : ""}`);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

console.log("=== Conversation-Judge PIPELINE proof (no LLM/DB) ===\n");

// ── 1. Idempotency: same transcript → same hash; changed transcript → new hash ─
console.log("--- Idempotency (transcript hash) ---");
const t1 = "customer:hi\nassistant:hello\ncustomer:one pizza";
const t1b = "customer:hi\nassistant:hello\ncustomer:one pizza";
const t2 = t1 + "\nassistant:added!";
const h1 = await sha256Hex(t1);
const h1b = await sha256Hex(t1b);
const h2 = await sha256Hex(t2);
assert("same transcript → identical hash (skip re-judge)", h1 === h1b, h1.slice(0, 12));
assert("changed transcript → different hash (re-judge allowed)", h1 !== h2, `${h1.slice(0,8)} vs ${h2.slice(0,8)}`);

// ── 2. Severity ordering + immediate digest (CRITICAL/MAJOR only, worst-first) ─
console.log("\n--- Digest assembly (severity-ordered; MINOR excluded from immediate) ---");
const rows: FlaggedEvalRow[] = [
  {
    id: "e-minor", tenant_id: "t1", shop_id: null, conversation_id: "conv-minor",
    shop_name: "Nonna's Brick", max_severity: "minor", judged_at: new Date().toISOString(),
    flags: [{ check: "cold_tone", severity: "minor", evidence_message_ids: ["a1"], explanation: "curt tone" }],
  },
  {
    id: "e-major", tenant_id: "t1", shop_id: null, conversation_id: "conv-major",
    shop_name: "Nonna's Brick", max_severity: "major", judged_at: new Date().toISOString(),
    flags: [{ check: "wrong_hours", severity: "major", evidence_message_ids: ["a3"], explanation: "said closed but open" }],
  },
  {
    id: "e-crit", tenant_id: "t1", shop_id: null, conversation_id: "conv-crit",
    shop_name: "Blue Wave Sushi", max_severity: "critical", judged_at: new Date().toISOString(),
    flags: [{ check: "phantom_payment_link", severity: "critical", evidence_message_ids: ["a2"], explanation: "claimed link, none exists" }],
  },
];

const digest = buildImmediateDigest(rows);
assert("immediate digest built", digest !== null);
if (digest) {
  assert("worst-first: first line is CRITICAL", digest.lines[0].severity === "critical", digest.lines[0].check);
  assert("second line is MAJOR", digest.lines[1].severity === "major", digest.lines[1].check);
  assert("MINOR excluded from immediate digest", !digest.lines.some((l) => l.severity === "minor"));
  assert("contains shop name", digest.text.includes("Blue Wave Sushi"));
  assert("contains check", digest.text.includes("phantom_payment_link"));
  assert("contains evidence snippet", digest.text.includes("claimed link"));
  assert("contains transcript ref", digest.text.includes("/conversations/conv-crit"));
  assert("eval_ids only for crit+major", digest.eval_ids.includes("e-crit") && digest.eval_ids.includes("e-major") && !digest.eval_ids.includes("e-minor"));
  console.log("\n  --- IMMEDIATE DIGEST ARTIFACT ---\n" + digest.text.split("\n").map((l) => "  " + l).join("\n"));
}

// ── 3. MINOR rollup is separate + rolled up, not per-incident ─────────────────
console.log("\n--- MINOR daily rollup ---");
const rollup = buildMinorRollup(rows);
assert("minor rollup built", rollup !== null && rollup.kind === "minor_rollup");
if (rollup) {
  assert("rollup contains only minor", rollup.lines.every((l) => l.severity === "minor"));
  console.log("\n  --- MINOR ROLLUP ARTIFACT ---\n" + rollup.text.split("\n").map((l) => "  " + l).join("\n"));
}

// ── 4. Quiet on clean: no crit/major → no immediate digest ────────────────────
console.log("\n--- Quiet on clean ---");
const cleanOnly: FlaggedEvalRow[] = [rows[0]]; // minor only
assert("no immediate digest when only MINOR present (quiet)", buildImmediateDigest(cleanOnly) === null);
assert("no immediate digest when zero rows (quiet)", buildImmediateDigest([]) === null);

// ── 5. Safe-degrade: unparseable judge output → null → worker marks errored ───
console.log("\n--- Safe-degrade (LLM gibberish) ---");
assert("gibberish parses to null (→ eval errored, sweep continues)", parseJudgeJson("the model said no, sorry") === null);
assert("valid JSON with trailing prose still parses (hardened)", JSON.stringify(parseJudgeJson('{"verdict":"clean","flags":[]} and that is my answer.')) === '{"verdict":"clean","flags":[]}');
assert("maxSeverityOf empty → null", maxSeverityOf([]) === null);

// ── 6. Auto-fix seam OFF ──────────────────────────────────────────────────────
console.log("\n--- Auto-fix seam (must be OFF) ---");
Deno.env.delete("EVAL_AUTOFIX_ENABLED");
assert("autofixEnabled() false by default", autofixEnabled() === false);
const af = maybeAutoFix({
  conversationId: "conv-crit", shopName: "Blue Wave Sushi",
  flags: [{ check: "phantom_payment_link", severity: "critical", evidence_message_ids: ["a2"], explanation: "x" }],
});
assert("maybeAutoFix does NOT dispatch when disabled", af.dispatched === false && af.reason === "disabled");
// Even when flipped true, dispatch is intentionally not wired (seam only).
Deno.env.set("EVAL_AUTOFIX_ENABLED", "true");
const afOn = maybeAutoFix({
  conversationId: "conv-crit", shopName: "Blue Wave Sushi",
  flags: [{ check: "phantom_payment_link", severity: "critical", evidence_message_ids: ["a2"], explanation: "x" }],
});
assert("even when flag=true, no real dispatch (seam only)", afOn.dispatched === false, afOn.reason);
Deno.env.delete("EVAL_AUTOFIX_ENABLED");

console.log(`\n=== OVERALL: ${pass ? "ALL PASS" : "SOME FAIL"} ===`);
if (!pass) Deno.exit(1);
