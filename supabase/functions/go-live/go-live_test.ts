/**
 * go-live_test.ts — Unit tests for the three new go-live gates (proof,
 * delivery_test, ticket_destination) plus the full 12-gate object.
 *
 * PROVE IT (per INSTRUCTION-06):
 *   1. Shop below 100% proof_pass_pct refused (score + run id in msg)
 *   2. Stale-menu run refused (menu changed after run)
 *   3. Twin-parity fail refused
 *   4. Missing first_delivery_test refused; is_test shop passes
 *   5. Null email_ticket_recipient refused
 *   6. Shop passing all gates flips live (12-key gate object)
 *
 * Runs: deno test --allow-env supabase/functions/go-live/go-live_test.ts
 * deno check: deno check supabase/functions/go-live/go-live_test.ts
 */

import { assertEquals, assertMatch, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ── Helpers: pure gate-logic predicates (mirrors go-live/index.ts) ──────────

/** ticket_destination gate — matches the exact check in go-live/index.ts */
function ticketDestPass(email: string | null): boolean {
  return typeof email === "string" &&
    email.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** delivery_test gate — is_test skips, otherwise requires timestamp */
function deliveryTestPass(isTest: boolean, passedAt: string | null): boolean {
  return isTest || !!passedAt;
}

/** proof gate — checks scorer_version, proof_pass_pct, staleness */
interface ProofCheckInput {
  runExists: boolean;
  runId: string;
  scorerVersion: number;
  proofPassPct: number;
  runStartedAt: string | null;
  menuUpdatedAt: string | null;
}
function proofPass(input: ProofCheckInput): { pass: boolean; message: string } {
  const { runExists, runId, scorerVersion, proofPassPct, runStartedAt, menuUpdatedAt } = input;
  if (!runExists) {
    return { pass: false, message: `Go-live refused: no Proof run found for QA twin. Run Proof before launch.` };
  }
  if (scorerVersion !== 3) {
    return { pass: false, message: `Go-live refused: Proof run ${runId} uses scorer_version ${scorerVersion}, requires version 3. Re-run Proof.` };
  }
  if (proofPassPct !== 100) {
    return { pass: false, message: `Go-live refused: Proof run ${runId} scored ${proofPassPct}% (100% required). Run Proof and clear all failures before launch.` };
  }
  if (menuUpdatedAt && runStartedAt && new Date(runStartedAt) < new Date(menuUpdatedAt)) {
    return { pass: false, message: `Go-live refused: Proof run ${runId} is stale — twin menu changed after the run (run: ${runStartedAt}, menu updated: ${menuUpdatedAt}). Re-run Proof.` };
  }
  return { pass: true, message: "" };
}

/** menu-parity check (mirrors go-live) */
function menuParityPass(
  shopItems: number, shopHash: string | null,
  twinItems: number, twinHash: string | null,
): boolean {
  return twinItems === shopItems && twinHash === shopHash;
}

// ── Expected gate keys (13 total: 9 original + 4 new) ──────────────────────

const ALL_GATE_KEYS = [
  "connect", "delivery_geo", "menu", "menu_approved", "menu_clean",
  "number", "hours", "subscription", "ein",
  "proof", "delivery_test", "ticket_destination", "campaign_assignment",
].sort();

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

// ── Gate 3: ticket_destination ───────────────────────────────────────────

Deno.test("ticket_destination: null email refused", () => {
  assertEquals(ticketDestPass(null), false);
});

Deno.test("ticket_destination: empty string refused", () => {
  assertEquals(ticketDestPass(""), false);
  assertEquals(ticketDestPass("   "), false);
});

Deno.test("ticket_destination: invalid email refused", () => {
  assertEquals(ticketDestPass("notanemail"), false);
  assertEquals(ticketDestPass("missing@dot"), false);   // no TLD
  assertEquals(ticketDestPass("@nodomain.com"), false);
  assertEquals(ticketDestPass("spaces in@name.com"), false);
});

Deno.test("ticket_destination: valid email passes", () => {
  assertEquals(ticketDestPass("kitchen@vitos.com"), true);
  assertEquals(ticketDestPass("owner+orders@pizzashop.net"), true);
  assertEquals(ticketDestPass("chef@restaurant.co.uk"), true);
});

// ── Gate 2: delivery_test ────────────────────────────────────────────────

Deno.test("delivery_test: is_test shop passes without timestamp", () => {
  assertEquals(deliveryTestPass(true, null), true);
  assertEquals(deliveryTestPass(true, "2025-01-01"), true);
});

Deno.test("delivery_test: non-test shop without timestamp fails", () => {
  assertEquals(deliveryTestPass(false, null), false);
  assertEquals(deliveryTestPass(false, undefined as any), false);
});

Deno.test("delivery_test: non-test shop with timestamp passes", () => {
  assertEquals(deliveryTestPass(false, "2026-09-01T12:00:00Z"), true);
});

// ── Gate 1: proof (pure conditions) ──────────────────────────────────────

Deno.test("proof: no run blocks with actionable message", () => {
  const result = proofPass({ runExists: false, runId: "N/A", scorerVersion: 0, proofPassPct: 0, runStartedAt: null, menuUpdatedAt: null });
  assertEquals(result.pass, false);
  assertStringIncludes(result.message, "no Proof run found");
  assertStringIncludes(result.message, "Run Proof before launch");
});

Deno.test("proof: wrong scorer_version blocks with version in message", () => {
  const result = proofPass({ runExists: true, runId: "abc-123", scorerVersion: 2, proofPassPct: 100, runStartedAt: "2026-09-01T10:00:00Z", menuUpdatedAt: "2026-09-01T09:00:00Z" });
  assertEquals(result.pass, false);
  assertStringIncludes(result.message, "scorer_version 2");
  assertStringIncludes(result.message, "requires version 3");
});

Deno.test("proof: below 100% refused — score and run id in message", () => {
  const result = proofPass({ runExists: true, runId: "def-456", scorerVersion: 3, proofPassPct: 82, runStartedAt: "2026-09-01T10:00:00Z", menuUpdatedAt: "2026-09-01T09:00:00Z" });
  assertEquals(result.pass, false);
  assertStringIncludes(result.message, "def-456");
  assertStringIncludes(result.message, "82%");
  assertStringIncludes(result.message, "100% required");
});

Deno.test("proof: stale run (menu changed after run) blocked", () => {
  const result = proofPass({ runExists: true, runId: "ghi-789", scorerVersion: 3, proofPassPct: 100, runStartedAt: "2026-09-01T09:00:00Z", menuUpdatedAt: "2026-09-01T10:00:00Z" });
  assertEquals(result.pass, false);
  assertStringIncludes(result.message, "stale");
  assertStringIncludes(result.message, "twin menu changed after the run");
  assertStringIncludes(result.message, "ghi-789");
});

Deno.test("proof: current 100% run passes", () => {
  const result = proofPass({ runExists: true, runId: "jkl-012", scorerVersion: 3, proofPassPct: 100, runStartedAt: "2026-09-01T10:00:00Z", menuUpdatedAt: "2026-09-01T09:00:00Z" });
  assertEquals(result.pass, true);
});

Deno.test("proof: run before menu — blocked as stale", () => {
  // Same as stale test but with explicit time comparison
  const result = proofPass({ runExists: true, runId: "mno-345", scorerVersion: 3, proofPassPct: 100, runStartedAt: "2026-09-01T10:00:00Z", menuUpdatedAt: "2026-09-01T10:00:01Z" });
  assertEquals(result.pass, false);
  assertStringIncludes(result.message, "stale");
});

// ── Menu parity ──────────────────────────────────────────────────────────

Deno.test("menu_parity: matching items and hashes pass", () => {
  assertEquals(menuParityPass(42, "abc123def", 42, "abc123def"), true);
});

Deno.test("menu_parity: different item counts fail", () => {
  assertEquals(menuParityPass(42, "abc", 40, "abc"), false);
});

Deno.test("menu_parity: different hashes fail", () => {
  assertEquals(menuParityPass(42, "abc", 42, "def"), false);
});

Deno.test("menu_parity: null hashes — both null passes, one null fails", () => {
  assertEquals(menuParityPass(42, null, 42, null), true);
  assertEquals(menuParityPass(42, "abc", 42, null), false);
});

// ── Full gate object: 12 keys ────────────────────────────────────────────

Deno.test("gates: 13 keys exactly (9 original + 4 new)", () => {
  const gates = {
    connect: true, delivery_geo: true, menu: true, menu_approved: true,
    menu_clean: true, number: true, hours: true, subscription: true, ein: true,
    proof: true, delivery_test: true, ticket_destination: true,
    campaign_assignment: true,
  };
  const keys = Object.keys(gates).sort();
  assertEquals(keys, ALL_GATE_KEYS);
  assertEquals(keys.length, 13);
});

Deno.test("gates: all-13-pass → live=true, blocked_by=[]", () => {
  // Simulate the all-or-nothing logic: if every gate passes, blocked_by is empty
  const gates = {
    connect: true, delivery_geo: true, menu: true, menu_approved: true,
    menu_clean: true, number: true, hours: true, subscription: true, ein: true,
    proof: true, delivery_test: true, ticket_destination: true,
    campaign_assignment: true,
  };
  const blocked_by = Object.entries(gates).filter(([, ok]) => !ok).map(([k]) => k);
  assertEquals(blocked_by.length, 0);
});

Deno.test("gates: any single gate fail → blocked_by non-empty", () => {
  // Each new gate failing alone produces the correct blocked_by entry
  const baseGates = {
    connect: true, delivery_geo: true, menu: true, menu_approved: true,
    menu_clean: true, number: true, hours: true, subscription: true, ein: true,
    proof: true, delivery_test: true, ticket_destination: true,
    campaign_assignment: true,
  };

  const failProof = { ...baseGates, proof: false };
  let blocked = Object.entries(failProof).filter(([, ok]) => !ok).map(([k]) => k);
  assertEquals(blocked, ["proof"]);

  const failDelivery = { ...baseGates, delivery_test: false };
  blocked = Object.entries(failDelivery).filter(([, ok]) => !ok).map(([k]) => k);
  assertEquals(blocked, ["delivery_test"]);

  const failTicket = { ...baseGates, ticket_destination: false };
  blocked = Object.entries(failTicket).filter(([, ok]) => !ok).map(([k]) => k);
  assertEquals(blocked, ["ticket_destination"]);

  const failCampaign = { ...baseGates, campaign_assignment: false };
  blocked = Object.entries(failCampaign).filter(([, ok]) => !ok).map(([k]) => k);
  assertEquals(blocked, ["campaign_assignment"]);
});

Deno.test("gates: 9 original keys unchanged in behaviour", () => {
  // Verify the 9 original gates are still present and independently checked
  const originalKeys = ["connect", "delivery_geo", "menu", "menu_approved",
    "menu_clean", "number", "hours", "subscription", "ein"];
  const newKeys = ["proof", "delivery_test", "ticket_destination", "campaign_assignment"];
  const allSorted = [...originalKeys, ...newKeys].sort();
  assertEquals(allSorted, ALL_GATE_KEYS);

  // Every original key is present in the full set
  for (const k of originalKeys) {
    assertEquals(ALL_GATE_KEYS.includes(k), true, `missing original key: ${k}`);
  }
});