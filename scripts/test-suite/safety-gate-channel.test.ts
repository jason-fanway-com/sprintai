/**
 * safety-gate-channel — Regression test for the 2026-09-07 gate fix.
 *
 * enforceSafetyGate used to throw on protected/phoned shops unconditionally,
 * even though this file only ever drives the bot over the JSON "web" path
 * (sendMessage/sendMessageWithRetry), which chat-sms hard-routes to
 * `channel = "web"` and — per that function's own comment — never reaches
 * Twilio. The gate was blocking on a risk that doesn't exist for the way
 * this code calls the function. The fix: the checks only apply when the
 * caller states `channel: "sms"`. A "web" caller is safe by construction and
 * skips both checks regardless of `protected`/`phone_number_e164`.
 *
 * These are direct unit calls against enforceSafetyGate's own logic — no
 * live bot call, no live shop lookup, same pattern as
 * required-options-guard.test.ts.
 *
 * Imports from safety-gate.ts, NOT runner.ts: runner.ts has top-level code
 * (a Deno.env.get call) that requires --allow-env, so importing the gate
 * through runner.ts made this test fail on a permission prompt under a bare
 * `deno test` — a safety-critical test that fails by default is one nobody
 * runs. safety-gate.ts is a leaf module with zero side effects, so this file
 * needs no permission flags at all.
 *
 * Run: deno test scripts/test-suite/safety-gate-channel.test.ts
 */
import { assertThrows, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { enforceSafetyGate } from "./safety-gate.ts";

const PROTECTED_SHOP = {
  id: "e0000000-0000-0000-0000-000000000001",
  name: "Vito's Pizza",
  protected: true,
  phone_number_e164: "+14842018054",
};

const PHONED_UNPROTECTED_SHOP = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Phoned Test Shop",
  protected: false,
  phone_number_e164: "+15551234567",
};

const SAFE_SHOP = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Safe Test Shop",
  protected: false,
  phone_number_e164: null,
};

// ── THE FIX: "web" cannot reach a phone, so it's safe regardless ──────────

Deno.test("channel:web + protected:true shop does NOT throw (the fix)", () => {
  enforceSafetyGate(PROTECTED_SHOP, "web");
});

Deno.test("channel:web + shop with phone_number_e164 set does NOT throw (the fix)", () => {
  enforceSafetyGate(PHONED_UNPROTECTED_SHOP, "web");
});

// ── REGRESSION GUARD: "sms" keeps both checks exactly as before ──────────

Deno.test("channel:sms + protected:true shop STILL throws (regression guard)", () => {
  assertThrows(
    () => enforceSafetyGate(PROTECTED_SHOP, "sms"),
    Error,
    "SAFETY GATE",
  );
});

Deno.test("channel:sms + protected:true shop throws the same protected message as before", () => {
  try {
    enforceSafetyGate(PROTECTED_SHOP, "sms");
    throw new Error("expected enforceSafetyGate to throw");
  } catch (e) {
    const msg = (e as Error).message;
    assertEquals(
      msg,
      `SAFETY GATE: Shop "Vito's Pizza" (e0000000-0000-0000-0000-000000000001) is protected. ` +
      `Refusing to run test suite against a protected shop. ` +
      `Only test/unprotected shops (no phone number) are allowed.`,
    );
  }
});

Deno.test("channel:sms + shop with phone_number_e164 set STILL throws (regression guard)", () => {
  assertThrows(
    () => enforceSafetyGate(PHONED_UNPROTECTED_SHOP, "sms"),
    Error,
    "SAFETY GATE",
  );
});

// ── Baseline: a genuinely safe shop is unaffected on the sms branch ───────

Deno.test("channel:sms + safe shop (protected:false, no phone) does NOT throw (baseline)", () => {
  enforceSafetyGate(SAFE_SHOP, "sms");
});
