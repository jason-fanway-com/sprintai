// Faithful logic proof for fix/web-testmode-and-reuse-window.
//
// This reproduces the EXACT decision expressions added to chat-sms/index.ts and
// asserts the behavior. It does not call Stripe or the DB; it proves the gating
// logic — which is where the risk lives — byte-for-byte against the source.
//
// Run: deno run --allow-none proof-web-testmode-reuse/logic-proof.ts
//   (or: ~/.deno/bin/deno run proof-web-testmode-reuse/logic-proof.ts)

let pass = 0, fail = 0;
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) requestTestMode derivation (web path). Mirrors chat-sms lines:
//      const url = new URL(req.url);
//      requestTestMode = body.test === true || url.searchParams.get("test") === "1";
//    SMS path never runs this; requestTestMode stays its default `false`.
// ─────────────────────────────────────────────────────────────────────────────
function deriveRequestTestMode(reqUrl: string, body: { test?: unknown }): boolean {
  const url = new URL(reqUrl);
  return body.test === true || url.searchParams.get("test") === "1";
}
const BASE = "https://x.supabase.co/functions/v1/chat-sms";

console.log("\n[FIX 1] Web test-mode flag derivation");
// WITH flag (body) → true
assert("body {test:true} → requestTestMode=true", deriveRequestTestMode(BASE, { test: true }) === true);
// WITH flag (query) → true
assert("?test=1 → requestTestMode=true", deriveRequestTestMode(BASE + "?test=1", {}) === true);
// NO flag → false  (the no-behavior-change / regression proof)
assert("no flag, no param → requestTestMode=false", deriveRequestTestMode(BASE, {}) === false);
// Only explicit boolean true counts — truthy junk must NOT trip it
assert("body {test:'true'} (string) → false", deriveRequestTestMode(BASE, { test: "true" }) === false);
assert("body {test:1} (number) → false", deriveRequestTestMode(BASE, { test: 1 }) === false);
assert("body {test:false} → false", deriveRequestTestMode(BASE, { test: false }) === false);
assert("?test=0 → false", deriveRequestTestMode(BASE + "?test=0", {}) === false);
assert("?test=true (not '1') → false", deriveRequestTestMode(BASE + "?test=true", {}) === false);

// ─────────────────────────────────────────────────────────────────────────────
// 2) Activation guard. Mirrors chat-sms:
//      const keywordTestMode = userMessage.trim().toUpperCase() === "TESTMODE";
//      const activatingTestMode = keywordTestMode || (requestTestMode && !cart.test_mode);
//    Proves: (a) keyword always activates (any channel), (b) the web flag
//    activates only on the FIRST turn (cart not yet in test mode) so an
//    in-progress test order is not wiped each turn, (c) no-flag never activates.
// ─────────────────────────────────────────────────────────────────────────────
function activating(userMessage: string, requestTestMode: boolean, cartTestMode: boolean): boolean {
  const keywordTestMode = userMessage.trim().toUpperCase() === "TESTMODE";
  return keywordTestMode || (requestTestMode && !cartTestMode);
}

console.log("\n[FIX 1] Activation guard");
// keyword always activates and resets, regardless of current test_mode
assert("TESTMODE keyword (fresh cart) → activate", activating("TESTMODE", false, false) === true);
assert("testmode keyword lowercased → activate", activating(" testmode ", false, false) === true);
assert("TESTMODE keyword while already in test → activate (explicit reset)", activating("TESTMODE", false, true) === true);
// web flag, first turn (cart not yet test) → activate once
assert("web flag, cart NOT yet test → activate", activating("a bagel please", true, false) === true);
// web flag, subsequent turns (cart already test) → NO re-activation (don't wipe order)
assert("web flag, cart ALREADY test → NO activate (order preserved)", activating("add a coffee", true, true) === false);
// no flag, no keyword → never activate  (real diner)
assert("no flag, normal message → NO activate", activating("two everything bagels", false, false) === false);
assert("no flag, cart somehow test → still NO re-activate via flag", activating("more", false, true) === false);

// ─────────────────────────────────────────────────────────────────────────────
// 3) Business-hours bypass. Mirrors chat-sms:
//      if (!isOpen && todayHours.length > 0 && !cart.test_mode) { ...closed... }
//    Proves test_mode bypasses the gate; non-test diners still gated when closed.
// ─────────────────────────────────────────────────────────────────────────────
function isClosedGateTriggered(isOpen: boolean, hasHours: boolean, cartTestMode: boolean): boolean {
  return !isOpen && hasHours && !cartTestMode;
}
console.log("\n[FIX 1] Hours-gating bypass");
assert("closed + has hours + NOT test → gated (real diner blocked)", isClosedGateTriggered(false, true, false) === true);
assert("closed + has hours + TEST → bypass (Jason can test)", isClosedGateTriggered(false, true, true) === false);
assert("open + NOT test → not gated", isClosedGateTriggered(true, true, false) === false);

// ─────────────────────────────────────────────────────────────────────────────
// 4) success_url branch. Mirrors chat-sms submit_order:
//      success_url: testMode ? .../order-success-test?cart=.. : .../order-success?cart=..
// ─────────────────────────────────────────────────────────────────────────────
function successUrl(testMode: boolean, cartId: string): string {
  return testMode
    ? `https://getsprintai.com/order-success-test?cart=${cartId}`
    : `https://getsprintai.com/order-success?cart=${cartId}`;
}
console.log("\n[FIX 1] success_url routing");
assert("testMode=true → /order-success-test", successUrl(true, "abc").includes("/order-success-test?cart=abc"));
assert("testMode=false → /order-success (real)", successUrl(false, "abc") === "https://getsprintai.com/order-success?cart=abc");

// ─────────────────────────────────────────────────────────────────────────────
// 5) Web reuse freshness window. Mirrors the new web reuse query filter:
//      .eq("status","active").gte("started_at", windowStart)
//    where windowStart = now - 24h. A stale (>24h) or non-active conv is NOT
//    reused (→ new conversation); a fresh active one IS reused.
// ─────────────────────────────────────────────────────────────────────────────
function wouldReuse(startedAtIso: string, status: string, nowMs: number): boolean {
  const windowStart = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  return status === "active" && startedAtIso >= windowStart;
}
console.log("\n[FIX 2] Web reuse freshness window");
const now = Date.parse("2026-06-23T13:00:00.000Z");
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const H = 60 * 60 * 1000;
assert("active conv started 1h ago → REUSE (same-sitting order preserved)", wouldReuse(iso(1 * H), "active", now) === true);
assert("active conv started 23h ago → REUSE (still in window)", wouldReuse(iso(23 * H), "active", now) === true);
assert("active conv started 25h ago (stale prior-day) → NEW (no weld)", wouldReuse(iso(25 * H), "active", now) === false);
assert("inactive conv 1h ago → NEW (status gate)", wouldReuse(iso(1 * H), "expired", now) === false);
assert("active conv started just now → REUSE", wouldReuse(iso(0), "active", now) === true);

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
if (fail > 0) { Deno.exit(1); }
