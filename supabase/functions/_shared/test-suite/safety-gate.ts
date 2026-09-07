/**
 * safety-gate.ts — enforceSafetyGate, extracted to its own module.
 *
 * This function must be importable with zero side effects and zero required
 * permissions: it's a plain function over plain data, no I/O, no env reads.
 * It used to live inline in runner.ts, which meant importing it for a unit
 * test also executed runner.ts's top-level code (including a `Deno.env.get`
 * call), so a bare `deno test` on the gate's own test file died on a
 * permission prompt before a single assertion ran — a safety-critical test
 * that fails by default is one nobody runs. Keeping this function in a leaf
 * module with no imports of its own is what makes that impossible.
 */

/**
 * `channel` states the risk being guarded against, not a mode switch: the SMS
 * checks below exist to stop a real diner's phone from being texted, and
 * `sendMessage`/`sendMessageWithRetry` in runner.ts only ever POST JSON to
 * chat-sms, which hard-sets `channel = "web"` and — per that function's own
 * comment — "never calls Twilio" for that path. A "web" call therefore cannot
 * reach a phone no matter what `protected`/`phone_number_e164` say, so the
 * checks are genuinely inapplicable and skipped. This is a scoped exception
 * based on verified capability, not a general loosening — any caller that can
 * actually reach SMS must pass "sms" and gets both checks, unchanged.
 */
export function enforceSafetyGate(
  shop: { id: string; name: string; protected: boolean; phone_number_e164: string | null },
  channel: "web" | "sms",
): void {
  if (channel === "web") return;
  if (shop.protected === true) {
    throw new Error(
      `SAFETY GATE: Shop "${shop.name}" (${shop.id}) is protected. ` +
      `Refusing to run test suite against a protected shop. ` +
      `Only test/unprotected shops (no phone number) are allowed.`,
    );
  }
  if (shop.phone_number_e164 !== null && shop.phone_number_e164 !== "") {
    throw new Error(
      `SAFETY GATE: Shop "${shop.name}" (${shop.id}) has a phone number ` +
      `(${shop.phone_number_e164}). Refusing to run — this shop could receive ` +
      `real SMS traffic. Only phone-less test shops are allowed.`,
    );
  }
}
