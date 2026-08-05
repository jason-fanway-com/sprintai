/**
 * _shared/test-mode.ts — Test-mode Stripe key resolution + strict allowlist gate
 *
 * SINGLE SOURCE OF TRUTH for test-mode key selection. Used by both
 * chat-sms (submit_order tool) and create-checkout (test-mode branch).
 *
 * HARD-GATE: ONLY keys starting with `sk_test_` or `rk_test_` are accepted.
 * A live key (sk_live_, rk_live_) or any other value is rejected — fail closed.
 * If STRIPE_TEST_SECRET_KEY is unset or invalid, returns null.
 */

/**
 * Resolve and validate the test-mode Stripe key.
 * Returns the key if it passes the allowlist gate, null otherwise.
 */
export function getTestModeStripeKey(): string | null {
  const key = (Deno.env.get("STRIPE_TEST_SECRET_KEY") ?? "").trim();
  if (!key) return null;
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return key;
  // HARD-GATE: key exists but is NOT test-prefixed — reject.
  console.error(
    "[test-mode] HARD-GATE: STRIPE_TEST_SECRET_KEY is set but does not start with sk_test_ or rk_test_. Rejecting.",
  );
  return null;
}

/**
 * Validate an arbitrary key for test-mode use.
 * Accepts ONLY test-prefixed keys (sk_test_ or rk_test_).
 */
export function isTestKey(key: string): boolean {
  return key.startsWith("sk_test_") || key.startsWith("rk_test_");
}