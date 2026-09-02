#!/usr/bin/env deno run
/**
 * verify-correction-reflected.ts — RED-then-GREEN proof for FIX A.
 *
 * Prove that verifyCartOpsInvariants correctly detects/forgives cart-shrink
 * based on the expectCartShrink flag from the case fixture.
 *
 * Run: deno run scripts/test-suite/verify-correction-reflected.ts
 */
import { verifyCartOpsInvariants } from "./cart-ops.ts";
import type { RunResult, TurnResult } from "./runner.ts";

// Helper: a simple cart item
function ci(name: string, qty = 1) {
  return { menu_item_id: name.toLowerCase().replace(/\s+/g, "-"), name, quantity: qty };
}

// ── RED: cartops-reduce-qty, expectCartShrink=true, cart does NOT shrink ──
const redRun: RunResult = {
  caseId: "cartops-reduce-qty",
  shopId: "test",
  sessionId: "red-test",
  expectCartShrink: true,
  transcript: [
    { role: "customer", message: "I need 2 Banana Chips", cart: [ci("Banana Chips", 2)] },
    { role: "customer", message: "Actually, just one Banana Chip", cart: [ci("Banana Chips", 2)] },
  ],
};

// ── GREEN: cartops-reduce-qty, expectCartShrink=true, cart DOES shrink ──
const greenRun: RunResult = {
  caseId: "cartops-reduce-qty",
  shopId: "test",
  sessionId: "green-test",
  expectCartShrink: true,
  transcript: [
    { role: "customer", message: "I need 2 Banana Chips", cart: [ci("Banana Chips", 2)] },
    { role: "customer", message: "Actually, just one Banana Chip", cart: [ci("Banana Chips", 1)] },
  ],
};

// ── CONVERSATIONAL: conv-topic-change-back, NO expectCartShrink ──
const convRun: RunResult = {
  caseId: "conv-topic-change-back",
  shopId: "test",
  sessionId: "conv-test",
  // expectCartShrink NOT set
  transcript: [
    { role: "customer", message: "I'll take a Burger", cart: [ci("Burger")] },
    { role: "customer", message: "Actually swap that for a Salad", cart: [ci("Salad")] },
  ],
};

// ── Run ──
let pass = 0, fail = 0;

// RED
const red = verifyCartOpsInvariants(redRun);
const redCorr = red.invariants.find((i: any) => i.id === "correction_reflected")!;
const redOk = redCorr.passed === false && redCorr.applied === true;
console.log(`${redOk ? "✅" : "❌"} RED: cartops-reduce-qty, expectCartShrink=true, cart did NOT shrink → passed=${redCorr.passed}, applied=${redCorr.applied}`);
if (!redOk) console.log(`   detail: ${redCorr.detail}`);
if (redOk) pass++; else fail++;

// GREEN
const green = verifyCartOpsInvariants(greenRun);
const greenCorr = green.invariants.find((i: any) => i.id === "correction_reflected")!;
const greenOk = greenCorr.passed === true && greenCorr.applied === true;
console.log(`${greenOk ? "✅" : "❌"} GREEN: cartops-reduce-qty, expectCartShrink=true, cart DID shrink → passed=${greenCorr.passed}, applied=${greenCorr.applied}`);
if (!greenOk) console.log(`   detail: ${greenCorr.detail}`);
if (greenOk) pass++; else fail++;

// CONVERSATIONAL (no expectCartShrink)
const conv = verifyCartOpsInvariants(convRun);
const convCorr = conv.invariants.find((i: any) => i.id === "correction_reflected")!;
const convOk = convCorr.passed === true && convCorr.applied === false;
console.log(`${convOk ? "✅" : "❌"} CONV: conv-topic-change-back, NO expectCartShrink → passed=${convCorr.passed}, applied=${convCorr.applied}`);
if (!convOk) console.log(`   detail: ${convCorr.detail}`);
if (convOk) pass++; else fail++;

console.log(`\n─── ${pass} passed, ${fail} failed ───`);
Deno.exit(fail > 0 ? 1 : 0);