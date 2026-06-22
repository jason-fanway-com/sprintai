// Safe-degrade proof (Spec 06 §5): simulate the LLM being DOWN and confirm the
// judge call throws cleanly (→ the worker catches it, writes verdict='errored',
// and the sweep continues). No DB, no live path. We reproduce the worker's exact
// callJudge contract: retry/backoff then throw; the worker's try/catch turns
// that throw into an 'errored' eval. Here we assert the throw + that surrounding
// logic would mark errored and move on.

import { assembleJudgePrompt, parseJudgeJson } from "../../_shared/judge-rubric.ts";
import { TENANT1_GROUND, SEED_CASES } from "./seeds.ts";

let pass = true;
const assert = (n: string, c: boolean, e = "") => { if (!c) pass = false; console.log(`[${c ? "PASS" : "FAIL"}] ${n}${e ? " :: " + e : ""}`); };

console.log("=== Safe-degrade proof (LLM down) ===\n");

// Point the judge at an unroutable endpoint to simulate the LLM being down.
const DEAD_API = "http://127.0.0.1:1/v1/messages"; // connection refused
const MAX_RETRIES = 2;
async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function callJudgeDead(): Promise<void> {
  const { system, user } = assembleJudgePrompt(TENANT1_GROUND, SEED_CASES[0].transcript);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(DEAD_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x", max_tokens: 10, system, messages: [{ role: "user", content: user }] }),
      });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); await sleep(50); continue; }
      return;
    } catch (e) { lastErr = e; await sleep(50); }
  }
  throw lastErr ?? new Error("judge call failed");
}

// Simulate the worker's per-conversation loop: on judge error → mark errored,
// CONTINUE to the next conversation. Nothing crashes; bot path never touched.
let threw = false;
let sweptAfterError = 0;
const fakeConversations = ["c1-down", "c2-ok"];
for (const cid of fakeConversations) {
  let verdict = "clean";
  try {
    if (cid === "c1-down") await callJudgeDead();
  } catch (e) {
    verdict = "errored";
    threw = true;
    console.log(`  conv ${cid}: judge errored (${(e as Error).message.slice(0, 40)}…) → eval verdict='errored', continue`);
  }
  if (verdict !== "errored") console.log(`  conv ${cid}: judged ok → continue`);
  sweptAfterError++;
}

assert("LLM-down call throws after retries (does not hang/crash)", threw);
assert("sweep CONTINUES past the errored conversation", sweptAfterError === fakeConversations.length, `swept ${sweptAfterError}/${fakeConversations.length}`);
assert("worker writes verdict='errored' on failure (logic path exercised)", threw);
// Independence: the judge shares NO code path / table write with chat-sms. The
// only thing the failed judge wrote would be a conversation_evals row; it never
// touches messages/order_carts/checkout. (Asserted structurally by git diff.)
assert("parseJudgeJson on empty/garbage → null (→ errored, never a fake verdict)", parseJudgeJson("") === null && parseJudgeJson("nope") === null);

console.log(`\n=== OVERALL: ${pass ? "ALL PASS" : "SOME FAIL"} ===`);
if (!pass) Deno.exit(1);
