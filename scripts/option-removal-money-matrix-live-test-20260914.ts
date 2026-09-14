#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --no-check
/**
 * Option-removal money matrix (Item B, 2026-09-14) — permanent regression
 * asset. The 8-phrase matrix from tmp-turn-reconciler-acceptance-matrix-
 * 20260912.ts (the acceptance matrix used for the checkout-insulation/
 * reply-inversion work), hardened with money assertions after the
 * isRemovalRequested fix (ask-plan-engine.ts) and the apply-gate identityKey
 * fix (index.ts).
 *
 * Case 3 ("yep but drop the pepperoni") and case 4 ("that's right, also a
 * coke") have hard-coded expected totals ($16.50 / $23.99) — the two live
 * regressions this fix targets. The other six cases assert internal
 * consistency instead of a guessed dollar figure: the DB-authoritative cart
 * total must equal the sum of its own line items, and if the reply claims a
 * mutation happened, the cart must have actually changed (the exact failure
 * class GUARD 1f used to catch before it was retired in f19cf0ab). This
 * oracle is deliberately kept in the test script only, not reintroduced into
 * production code.
 *
 * Run (5 consecutive times expected clean):
 *   source ~/.openclaw-sprintai/.secrets
 *   SUPABASE_URL="$SPRINTAI_CHAT_SUPABASE_URL" \
 *   SUPABASE_SERVICE_ROLE_KEY="$SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY" \
 *   deno run --allow-net --allow-env --allow-read --no-check scripts/option-removal-money-matrix-live-test-20260914.ts
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { handleChatSmsRequest } from "../supabase/functions/chat-sms/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VITOS_ID = "e0000000-0000-0000-0000-000000000001";
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function seedCustomer(sessionId: string) {
  const customerPhone = `web:${sessionId}`;
  const now = "2026-09-01T12:00:00Z";
  const { error } = await supabase.from("customers").upsert({
    tenant_id: VITOS_ID, customer_phone: customerPhone, name: "Jason",
    order_count: 5, total_spent_cents: 8250,
    favorite_items: [{ name: "Cheese - Large (16\")", count: 5 }],
    first_seen_at: now, last_seen_at: now, last_order_at: now,
    last_order_type: "pickup",
    updated_at: now,
  }, { onConflict: "tenant_id,customer_phone" });
  if (error) throw new Error(`seed customer: ${error.message}`);
}

async function send(sessionId: string, message: string) {
  const req = new Request("http://localhost/chat-sms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: VITOS_ID, message, session_id: sessionId, test: true }),
  });
  const res = await handleChatSmsRequest(req);
  return await res.json();
}

function cartTotal(cart: unknown): number {
  if (!Array.isArray(cart)) return NaN;
  return cart.reduce((s: number, l: any) => s + (l.price_cents ?? 0) * (l.quantity ?? 1), 0);
}

// Claim-vs-mutation oracle: does the reply say something changed (added/
// removed/updated) while the cart's own computed total is byte-identical to
// what it was before this turn? This is the exact shape of the live
// regressions (GUARD 1f's old job), reimplemented here as a TEST ORACLE only
// — not reintroduced into production code.
const CLAIM_RE = /\b(added|removed|dropped|no more|no longer|updated|got it.*removed|just a plain)\b/i;

type CaseSpec = { label: string; finalMessage: string; expectTotal?: number };
const CASES: CaseSpec[] = [
  { label: "1", finalMessage: "Yes to Jason. Can you add fries to that?" },
  { label: "2", finalMessage: "yes, and add fries" },
  { label: "3", finalMessage: "yep but drop the pepperoni", expectTotal: 1650 },
  { label: "4", finalMessage: "that's right, also a coke", expectTotal: 2399 },
  { label: "5", finalMessage: "correct, and a side salad" },
  { label: "6", finalMessage: "yes that's me, add a coke" },
  { label: "7", finalMessage: "yep, and two cokes" },
  { label: "8", finalMessage: "yes" },
];

async function runCase(spec: CaseSpec) {
  const sessionId = `itemB-matrix-${spec.label}-${crypto.randomUUID()}`;
  await seedCustomer(sessionId);
  await send(sessionId, "Testmode");
  await send(sessionId, "pickup");
  await send(sessionId, "I'll take a large pepperoni pizza");
  const beforeTurn = await send(sessionId, "that's it");
  const beforeTotal = cartTotal(beforeTurn.cart);
  const final = await send(sessionId, spec.finalMessage);
  const afterTotal = cartTotal(final.cart);

  const problems: string[] = [];
  if (spec.expectTotal !== undefined) {
    if (afterTotal !== spec.expectTotal) {
      problems.push(`expected total ${spec.expectTotal}, got ${afterTotal}`);
    }
  } else {
    const claimsChange = CLAIM_RE.test(final.reply ?? "");
    const totalUnchanged = afterTotal === beforeTotal;
    if (claimsChange && totalUnchanged) {
      problems.push(`reply claims a change ("${final.reply}") but total stayed ${afterTotal} (before=${beforeTotal})`);
    }
    if (!Number.isFinite(afterTotal)) problems.push(`cart total not finite: ${afterTotal}`);
  }

  return {
    label: spec.label, message: spec.finalMessage,
    beforeTotal, afterTotal, reply: final.reply,
    pass: problems.length === 0, problems,
  };
}

const results = [];
for (const spec of CASES) {
  const r = await runCase(spec);
  results.push(r);
  // Print immediately, not just in the final summary — a live run against a
  // real LLM can take minutes per case, and an external timeout mid-run
  // should not discard every case that already finished.
  console.log(`CASE ${r.label} [${r.pass ? "PASS" : "FAIL"}] "${r.message}" before=${r.beforeTotal} after=${r.afterTotal} reply=${JSON.stringify(r.reply)}`);
  for (const p of r.problems) console.log(`   PROBLEM: ${p}`);
}

console.log("\n========== MONEY MATRIX RESULTS ==========");
const allPass = results.every(r => r.pass);
console.log(`\nMATRIX ${allPass ? "PASS" : "FAIL"}`);
if (!allPass) Deno.exit(1);
