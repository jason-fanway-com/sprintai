#!/usr/bin/env deno run --allow-net --allow-env --allow-read
/**
 * tmp-proof-subset-inprocess-20260913.ts — checkpoint 2 of the turn-reconciler
 * branch (fix/turn-reconciler-20260912). Runs a 10-case SUBSET of the real
 * Proof suite (same generator.ts/runner.ts/cart-ops.ts modules proof.ts uses,
 * unmodified — no bespoke grading logic) against Vito's, but pointed at the
 * LOCAL in-process server (scripts/tmp-local-chat-server-20260912.ts, which
 * wraps handleChatSmsRequest from the branch's own supabase/functions/chat-sms/
 * index.ts) instead of the deployed edge function. This lets the branch be
 * graded against the SAME acceptance gate used for production go-live
 * without deploying.
 *
 * The per-case grading logic below is copied verbatim from
 * scripts/test-suite/proof.ts (same invariant calls, same order, same
 * pass/fail semantics) — only the case count (10-slice) and chatFunctionUrl
 * (local) differ, and the test_runs bookkeeping insert is skipped since this
 * is a local diagnostic run, not a queued production grading run.
 *
 * Prereq: start the local server first (separate process):
 *   deno run --allow-net --allow-env --no-check scripts/tmp-local-chat-server-20260912.ts
 *
 * Run:
 *   source ~/.openclaw-sprintai/.secrets
 *   SPRINTAI_CHAT_SUPABASE_URL / SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY must be set
 *   deno run --allow-net --allow-env --allow-read scripts/tmp-proof-subset-inprocess-20260913.ts
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateCases } from "./test-suite/generator.ts";
import { runCase } from "./test-suite/runner.ts";
import type { AnyCase, TestCase, ConversationalCase } from "./test-suite/library.ts";
import type { RunResult } from "./test-suite/runner.ts";
import {
  verifyCartOpsInvariants,
  verifyStatedTotal,
  verifyCheckoutFinalize,
  verifyHallucinationGuard,
  verifyCartPersistence,
  verifyNoWrongPriceCharge,
  verifyTenantIsolationNoLeak,
  verifyStopOptOutHonored,
  verifyRequiredOptionsCovered,
} from "./test-suite/cart-ops.ts";
import { verifyHoursClosed } from "./test-suite/hours-closed.ts";

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const SHOP_ID = Deno.args[0] ?? "e0000000-0000-0000-0000-000000000001"; // Vito's
const LOCAL_FN_URL = Deno.env.get("LOCAL_CHAT_FUNCTION_URL") ?? "http://localhost:9876/chat-sms";
const SUBSET_SIZE = Number(Deno.env.get("PROOF_SUBSET_SIZE") ?? "10");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("FATAL: SPRINTAI_CHAT_SUPABASE_URL and SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY must be set");
  Deno.exit(2);
}

console.log(`Proof subset (in-process, checkpoint 2): shop_id=${SHOP_ID}`);
console.log(`Local chat function: ${LOCAL_FN_URL}`);
console.log(`Subset size: ${SUBSET_SIZE}`);
console.log("");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

console.log("Generating cases...");
const { cases: allCases, shop, menuItemCount } = await generateCases({
  supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, shopId: SHOP_ID,
});
const cases = allCases.slice(0, SUBSET_SIZE);
console.log(`  Shop: ${shop.name} (${shop.id})`);
console.log(`  Menu items: ${menuItemCount}`);
console.log(`  Full suite: ${allCases.length} cases; running first ${cases.length}`);
console.log("");

let shopMenuId = "";
const menuNames = await (async () => {
  const { data: menus } = await supabase
    .from("menus").select("id").eq("shop_id", SHOP_ID)
    .order("created_at", { ascending: false }).limit(1);
  if (!menus?.length) return new Set<string>();
  shopMenuId = menus[0].id;
  const { data: items } = await supabase
    .from("menu_items").select("name").eq("menu_id", menus[0].id).eq("active", true);
  return new Set<string>((items ?? []).map((i: { name: string }) => i.name));
})();

const requiredOptionGroupsByItem = await (async () => {
  const map = new Map<string, string[]>();
  if (!shopMenuId) return map;
  const { data: rows } = await supabase
    .from("option_groups")
    .select("name, menu_item_id, display_order, menu_items!inner(menu_id, active)")
    .eq("required", true).eq("menu_items.menu_id", shopMenuId).eq("menu_items.active", true)
    .order("display_order");
  for (const row of (rows ?? []) as { name: string; menu_item_id: string }[]) {
    const arr = map.get(row.menu_item_id) ?? [];
    arr.push(row.name);
    map.set(row.menu_item_id, arr);
  }
  return map;
})();

interface ProofCaseResult { caseId: string; passed: boolean; reason: string; label: string; }
function isConversationalCase(c: AnyCase): c is ConversationalCase {
  return "persona" in c && "goal" in c;
}

const results: ProofCaseResult[] = [];
let passCount = 0;
let failCount = 0;
let noMoneyInvariantCount = 0;
let requiredOptionsInvokedCount = 0;
let requiredOptionsRanCount = 0;

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const label = isConversationalCase(c)
    ? `[conv] ${c.id}: ${c.persona} → ${c.goal}`
    : (c as TestCase).label ?? (c as TestCase).id;
  console.log(`[${i + 1}/${cases.length}] Running ${c.id}...`);

  let run: RunResult;
  try {
    run = await runCase(
      { supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, chatFunctionUrl: LOCAL_FN_URL, simulatorApiKey: Deno.env.get("OPENROUTER_API_KEY") ?? "" },
      SHOP_ID, c,
    );
  } catch (e) {
    results.push({ caseId: c.id, passed: false, reason: `runner-error: ${(e as Error).message}`, label });
    failCount++;
    console.log(`  ✗ RUNNER ERROR: ${(e as Error).message.slice(0, 100)}`);
    continue;
  }

  const expectsCheckout = !isConversationalCase(c) && (c as TestCase).expects_checkout === true;
  const hoursMode = !isConversationalCase(c) ? (c as TestCase).hoursMode : undefined;
  const hasCart = (run.transcript ?? []).some((t: any) => ((t.cart as any[] | undefined) ?? []).length > 0);

  let passed = true;
  let reason = "";
  const appliedInvariants: string[] = [];
  let moneyInvariantApplied = false;

  if (run.error) { passed = false; reason = run.error; }

  if (passed && hasCart) {
    moneyInvariantApplied = true;
    const cartOps = verifyCartOpsInvariants(run);
    for (const inv of cartOps.invariants) appliedInvariants.push(`cartops:${inv.id}:${inv.passed ? "PASS" : "FAIL"}`);
    if (!cartOps.passed) {
      passed = false;
      reason = `cartops: ${cartOps.invariants.filter((inv) => !inv.passed).map((inv) => inv.detail).join("; ")}`;
    }
  }

  const expectedLineCount = !isConversationalCase(c) ? (c as TestCase).expectedLineCount : undefined;
  const expectNonEmptyFinalCart = typeof expectedLineCount === "number" && expectedLineCount > 0;

  if (passed && hasCart) {
    const roc = verifyRequiredOptionsCovered(run, requiredOptionGroupsByItem, expectNonEmptyFinalCart);
    appliedInvariants.push(`required-options-covered:${roc.passed ? "PASS" : "FAIL"}${roc.applied ? "" : ":skipped"}`);
    requiredOptionsInvokedCount++;
    if (roc.applied) requiredOptionsRanCount++;
    if (!roc.passed) { passed = false; reason = `required-options-covered: ${roc.detail}`; }
  }
  if (passed && expectedLineCount !== undefined) {
    const finalTurn = (run.transcript ?? [])[(run.transcript ?? []).length - 1];
    const finalCart = (finalTurn?.cart as unknown[] | undefined) ?? [];
    appliedInvariants.push(`line-count:${finalCart.length === expectedLineCount ? "PASS" : "FAIL"}`);
    if (finalCart.length !== expectedLineCount) {
      passed = false;
      reason = `line-count: expected ${expectedLineCount} cart line(s), got ${finalCart.length}`;
    }
  }

  const expectedItemCents = (!isConversationalCase(c) ? (c as TestCase).expectedItemCents : undefined) ?? 0;
  if (passed && (expectedItemCents > 0 || hasCart)) {
    moneyInvariantApplied = true;
    const totalCheck = verifyStatedTotal(run);
    appliedInvariants.push(`stated-total:${totalCheck.passed ? "PASS" : "FAIL"}`);
    if (!totalCheck.passed) { passed = false; reason = `stated-total: ${totalCheck.detail}`; }
  }

  if (passed && expectsCheckout) {
    moneyInvariantApplied = true;
    const checkoutCheck = await verifyCheckoutFinalize(supabase, run);
    appliedInvariants.push(`checkout-finalize:${checkoutCheck.passed ? "PASS" : "FAIL"}`);
    if (!checkoutCheck.passed) { passed = false; reason = `checkout-finalize: ${checkoutCheck.detail}`; }
  }

  if (passed && hoursMode === "closed") {
    const hc = verifyHoursClosed(run);
    appliedInvariants.push(`hours-closed:${hc.passed ? "PASS" : "FAIL"}`);
    if (!hc.passed) { passed = false; reason = `hours-closed: ${hc.invariants.filter((inv) => !inv.passed).map((inv) => inv.detail).join("; ")}`; }
  }

  if (passed) {
    const hg = verifyHallucinationGuard(run, menuNames);
    appliedInvariants.push(`hallucination-guard:${hg.passed ? "PASS" : "FAIL"}`);
    if (!hg.passed) { passed = false; reason = `hallucination-guard: ${hg.detail}`; }
  }

  if (passed) {
    const cp = verifyCartPersistence(run);
    appliedInvariants.push(`cart-persistence:${cp.passed ? "PASS" : "FAIL"}`);
    if (!cp.passed) { passed = false; reason = `cart-persistence: ${cp.detail}`; }
  }

  if (passed && c.id && /price|checkout|total|cartops-/.test(c.id)) {
    moneyInvariantApplied = true;
    const nwpc = await verifyNoWrongPriceCharge(c as any, run, shopMenuId, supabase);
    appliedInvariants.push(`no-wrong-price-charge:${nwpc.passed ? "PASS" : "FAIL"}`);
    if (!nwpc.passed) { passed = false; reason = `no-wrong-price-charge: ${nwpc.detail}`; }
  }

  if (passed) {
    const ti = await verifyTenantIsolationNoLeak(c as any, run, (shop as any).tenant_id ?? "", shopMenuId, supabase);
    appliedInvariants.push(`tenant-isolation:${ti.passed ? "PASS" : "FAIL"}`);
    if (!ti.passed) { passed = false; reason = `tenant-isolation: ${ti.detail}`; }
  }

  const hasStopTurn = run.transcript?.some((t: any) => (t.message ?? "").trim().toUpperCase() === "STOP");
  if (passed && hasStopTurn) {
    const so = await verifyStopOptOutHonored(c as any, run, supabase);
    appliedInvariants.push(`stop-opt-out:${so.passed ? "PASS" : "FAIL"}`);
    if (!so.passed) { passed = false; reason = `stop-opt-out: ${so.detail}`; }
  }

  if (!moneyInvariantApplied) noMoneyInvariantCount++;

  if (passed) {
    passCount++;
    console.log(`  ✓ PASS ${c.id}  [${appliedInvariants.join(", ")}]`);
  } else {
    failCount++;
    console.log(`  ✗ FAIL ${c.id}: ${reason.slice(0, 120)}  [${appliedInvariants.join(", ")}]`);
  }

  results.push({ caseId: c.id, passed, reason, label });
}

const total = results.length;
console.log("");
console.log(`PROOF SUBSET: ${passCount}/${total} pass`);
console.log(`Cases run: ${results.map((r) => r.caseId).join(", ")}`);
if (failCount > 0) {
  console.log("Failures:");
  for (const r of results.filter((r) => !r.passed)) console.log(`  ✗ ${r.caseId}: ${r.reason}`);
}

Deno.exit(passCount === total ? 0 : 1);
