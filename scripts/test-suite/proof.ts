#!/usr/bin/env deno run --allow-net --allow-env --allow-read
/**
 * proof.ts — LOCAL DEV TOOL ONLY — NOT the production gate.
 *
 * The authoritative production grader is supabase/functions/test-runner/index.ts
 * (the server-side edge function triggered by pg_cron). This CLI exists for
 * interactive / diagnostic use during development and debugging.
 *
 * BOTH proof.ts and test-runner import the SAME verifiers from
 * _shared/test-suite/cart-ops.ts (verifyCartOpsInvariants, verifyStatedTotal,
 * verifyCheckoutFinalize, verifyHallucinationGuard, verifyCartPersistence)
 * and _shared/test-suite/hours-closed.ts (verifyHoursClosed). They MUST produce
 * identical proof_pass results for the same shop at the same commit. Any
 * divergence is a bug in the import contract, not an acceptable variance.
 *
 * Usage: deno run --allow-net --allow-env --allow-read scripts/test-suite/proof.ts <shop_id>
 *        deno run --allow-net --allow-env --allow-read scripts/test-suite/proof.ts <shop_id> --timeout-test
 *
 * Final line: "PROOF: N/N pass"  |  exit 0 iff 100% pass, else exit 1.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateCases } from "./generator.ts";
import { runCase } from "./runner.ts";
import type { AnyCase, TestCase, ConversationalCase } from "./library.ts";
import type { RunResult } from "./runner.ts";
import {
  verifyCartOpsInvariants,
  verifyStatedTotal,
  verifyCheckoutFinalize,
  verifyHallucinationGuard,
  verifyCartPersistence,
} from "./cart-ops.ts";
import { verifyHoursClosed } from "./hours-closed.ts";

// ── Config ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SPRINTAI_CHAT_SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")!;
const PROJECT_REF = Deno.env.get("SPRINTAI_CHAT_SUPABASE_PROJECT_REF") ?? "rvdqfxtrskxekfkqnegx";
const CHAT_FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/chat-sms`;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("FATAL: SPRINTAI_CHAT_SUPABASE_URL and SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY must be set");
  Deno.exit(2);
}

// ── CLI ────────────────────────────────────────────────────────────────────

const args = Deno.args;
if (args.length < 1 || args[0] === "--help" || args[0] === "-h") {
  console.error("Usage: deno run --allow-net --allow-env --allow-read proof.ts <shop_id> [--timeout-test]");
  Deno.exit(2);
}

const SHOP_ID = args[0];
const TIMEOUT_TEST = args.includes("--timeout-test");
const EFFECTIVE_FN_URL = TIMEOUT_TEST
  ? "https://10.255.255.1/functions/v1/chat-sms" // unroutable — guaranteed timeout
  : CHAT_FUNCTION_URL;

console.log(`Proof: shop_id=${SHOP_ID}`);
console.log(`Edge function: ${EFFECTIVE_FN_URL}`);
console.log(`Timeout: ${Deno.env.get("PROOF_TURN_TIMEOUT_MS") ?? "30000"}ms, retries: 2`);
console.log("");

// ── Main ───────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// 1. Generate all cases from the shop's real menu
console.log("Generating cases...");
const { cases, shop, menuItemCount, libraryCount, cartOpsCount, conversationalCount, derivedCount, hoursClosedCount } =
  await generateCases({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY, shopId: SHOP_ID });

console.log(`  Shop: ${shop.name} (${shop.id})`);
console.log(`  Menu items: ${menuItemCount}`);
console.log(`  Cases: ${cases.length} total (${libraryCount} library + ${cartOpsCount} cart-ops + ${derivedCount} derived + ${hoursClosedCount} hours-closed + ${conversationalCount} conversational)`);
console.log("");

// Build shop menu name set for hallucination guard
const menuNames = await (async () => {
  const { data: menus } = await supabase
    .from("menus")
    .select("id")
    .eq("shop_id", SHOP_ID)
    .order("created_at", { ascending: false })
    .limit(1);
  if (!menus?.length) return new Set<string>();
  const { data: items } = await supabase
    .from("menu_items")
    .select("name")
    .eq("menu_id", menus[0].id)
    .eq("active", true);
  return new Set<string>((items ?? []).map((i: { name: string }) => i.name));
})();

// 2. Run every case
const results: ProofCaseResult[] = [];
let passCount = 0;
let failCount = 0;
let noMoneyInvariantCount = 0;

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const label = isConversationalCase(c)
    ? `[conv] ${c.id}: ${c.persona} → ${c.goal}`
    : (c as TestCase).label ?? (c as TestCase).id;
  console.log(`[${i + 1}/${cases.length}] Running ${c.id}...`);

  let run: RunResult;
  try {
    run = await runCase(
      {
        supabaseUrl: SUPABASE_URL,
        serviceRoleKey: SERVICE_ROLE_KEY,
        chatFunctionUrl: EFFECTIVE_FN_URL,
        simulatorApiKey: Deno.env.get("OPENROUTER_API_KEY") ?? "",
      },
      SHOP_ID,
      c,
    );
  } catch (e) {
    results.push({
      caseId: c.id,
      passed: false,
      reason: `runner-error: ${(e as Error).message}`,
      label,
    });
    failCount++;
    console.log(`  ✗ RUNNER ERROR: ${(e as Error).message.slice(0, 100)}`);
    continue;
  }

  // ── Grade deterministically (capability dispatch — no category gating) ──
  const expectsCheckout = !isConversationalCase(c) && (c as TestCase).expects_checkout === true;
  const hoursMode = !isConversationalCase(c) ? (c as TestCase).hoursMode : undefined;
  const expectedItemCents = (!isConversationalCase(c) ? (c as TestCase).expectedItemCents : undefined) ?? 0;
  const hasCart = (run.transcript ?? []).some((t: any) => (t.cart as any[]).length > 0);

  let passed = true;
  let reason = "";
  const appliedInvariants: string[] = [];
  let moneyInvariantApplied = false;

  // If run had an error (harness-timeout, etc.)
  if (run.error) {
    passed = false;
    reason = run.error;
  }

  // CartOps invariants (all 5: total, displayed items, no-mutation, correction, duplicates)
  // Apply whenever server cart was produced — not only on category cart-ops
  if (passed && hasCart) {
    moneyInvariantApplied = true;
    const cartOps = verifyCartOpsInvariants(run);
    for (const inv of cartOps.invariants) {
      appliedInvariants.push(`cartops:${inv.id}:${inv.passed ? "PASS" : "FAIL"}`);
    }
    if (!cartOps.passed) {
      passed = false;
      const failed = cartOps.invariants.filter((inv) => !inv.passed).map((inv) => inv.detail);
      reason = `cartops: ${failed.join("; ")}`;
    }
  }

  // Totals: grade whenever expectedItemCents > 0 OR server cart exists
  if (passed && (expectedItemCents > 0 || hasCart)) {
    moneyInvariantApplied = true;
    const totalCheck = verifyStatedTotal(run);
    appliedInvariants.push(`stated-total:${totalCheck.passed ? "PASS" : "FAIL"}`);
    if (!totalCheck.passed) {
      passed = false;
      reason = `stated-total: ${totalCheck.detail}`;
    }
  }

  // Checkout-finalize: whenever expects_checkout === true (regardless of category)
  if (passed && expectsCheckout) {
    moneyInvariantApplied = true;
    const checkoutCheck = await verifyCheckoutFinalize(supabase, run);
    appliedInvariants.push(`checkout-finalize:${checkoutCheck.passed ? "PASS" : "FAIL"}`);
    if (!checkoutCheck.passed) {
      passed = false;
      reason = `checkout-finalize: ${checkoutCheck.detail}`;
    }
  }

  // Hours-closed: when hoursMode === "closed"
  if (passed && hoursMode === "closed") {
    const hc = verifyHoursClosed(run);
    appliedInvariants.push(`hours-closed:${hc.passed ? "PASS" : "FAIL"}`);
    if (!hc.passed) {
      passed = false;
      const failed = hc.invariants.filter((inv) => !inv.passed).map((inv) => inv.detail);
      reason = `hours-closed: ${failed.join("; ")}`;
    }
  }

  // Hallucination guard: all cases
  if (passed) {
    const hg = verifyHallucinationGuard(run, menuNames);
    appliedInvariants.push(`hallucination-guard:${hg.passed ? "PASS" : "FAIL"}`);
    if (!hg.passed) {
      passed = false;
      reason = `hallucination-guard: ${hg.detail}`;
    }
  }

  // Cart persistence guard: all cases
  if (passed) {
    const cp = verifyCartPersistence(run);
    appliedInvariants.push(`cart-persistence:${cp.passed ? "PASS" : "FAIL"}`);
    if (!cp.passed) {
      passed = false;
      reason = `cart-persistence: ${cp.detail}`;
    }
  }

  if (!moneyInvariantApplied) {
    noMoneyInvariantCount++;
  }

  if (passed) {
    passCount++;
    console.log(`  ✓ PASS ${c.id}  [${appliedInvariants.join(", ")}]`);
  } else {
    failCount++;
    console.log(`  ✗ FAIL ${c.id}: ${reason.slice(0, 120)}  [${appliedInvariants.join(", ")}]`);
  }

  results.push({ caseId: c.id, passed, reason, label });
}

// ── Final PROOF line ───────────────────────────────────────────────────────
const total = results.length;
console.log("");
console.log(`PROOF: ${passCount}/${total} pass`);
if (noMoneyInvariantCount > 0) {
  console.log(`Cases with no money invariant applied: ${noMoneyInvariantCount}`);
}
if (failCount > 0) {
  console.log(`Failures:`);
  for (const r of results.filter((r) => !r.passed)) {
    console.log(`  ✗ ${r.caseId}: ${r.reason}`);
  }
}

Deno.exit(passCount === total ? 0 : 1);

// ── Helpers ────────────────────────────────────────────────────────────────

interface ProofCaseResult {
  caseId: string;
  passed: boolean;
  reason: string;
  label: string;
}

function isConversationalCase(c: AnyCase): c is ConversationalCase {
  return "persona" in c && "goal" in c;
}