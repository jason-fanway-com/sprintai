// P0 (2026-09-09, live money defect): unit tests for the extracted GUARD 1f
// decision core, exercising the EXACT reply text captured live against Zio's
// Pizzeria (shop_id 2cba7b51-211c-4437-8910-1af4dcc03498) before this fix:
// customer added "large plain pizza with extra cheese" (real line: Large 18"
// Neapolitan Cheese Pizza, price_cents 2199, options {"Add Toppings":
// ["Extra Cheese"]}), then said "remove the extra cheese", then answered a
// disambiguation "1" -- and the bot replied "Removed the extra cheese from
// the large..." / "Done - removed the extra cheese from the large pizza..."
// while the cart line was byte-identical (Extra Cheese still present,
// subtotal unchanged). Reproduced live twice in a row before this fix; see
// BLOCKED.txt 2026-09-09 entry for the full transcript.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  replyAcknowledgesCart,
  claimsExplicitCorrectionWithoutMutation,
  claimsAmbiguousCorrectionWithoutMutation,
  evaluateGuard1f,
  type Guard1fCartItem,
} from "./guard1f-correction-claim-20260909.ts";

// Real cart shape from the live incident (unchanged before vs. after —
// that's the whole defect).
const ZIOS_CART_BEFORE: Guard1fCartItem[] = [
  { name: "Large 18'' Neapolitan Cheese Pizza" }, // still has Extra Cheese in real life; name-only is all these functions read
  { name: "Medium 16'' Neapolitan Cheese Pizza" },
];
const ZIOS_CART_AFTER = ZIOS_CART_BEFORE; // byte-identical, exactly as in the live incident

const LIVE_REPLY_1 = "Removed the extra cheese from the large. So now you've got a large plain Neapolitan and a medium Neapolitan with pepperoni. Anything else?";
const LIVE_REPLY_2 = "Done - removed the extra cheese from the large pizza. You've got a large plain and a medium pepperoni. Anything else?";

Deno.test("evaluateGuard1f: RED (documents the live incident) -- both real false-correction replies would have been silenced by replyAcknowledgesCart alone", () => {
  // This is the OLD guard's condition, kept here only to prove the incident
  // was real: claimsCorrectedWithoutMutation (now split) fires, but the old
  // single replyAcknowledgesCart escape hatch also fires on both, because
  // each reply names "large"/"neapolitan" -- a real cart item's own words.
  assertEquals(replyAcknowledgesCart(LIVE_REPLY_1, ZIOS_CART_AFTER), true);
  assertEquals(replyAcknowledgesCart(LIVE_REPLY_2, ZIOS_CART_AFTER), true);
});

Deno.test("evaluateGuard1f: GREEN -- live incident reply 1 ('Removed the extra cheese from the large...') trips as EXPLICIT, unchanged cart", () => {
  const result = evaluateGuard1f(LIVE_REPLY_1, ZIOS_CART_BEFORE, ZIOS_CART_AFTER);
  assertEquals(result.tripped, true);
  assertEquals(result.reason, "explicit");
});

Deno.test("evaluateGuard1f: GREEN -- live incident reply 2 ('Done - removed the extra cheese...') trips as EXPLICIT, unchanged cart", () => {
  const result = evaluateGuard1f(LIVE_REPLY_2, ZIOS_CART_BEFORE, ZIOS_CART_AFTER);
  assertEquals(result.tripped, true);
  assertEquals(result.reason, "explicit");
});

Deno.test("claimsExplicitCorrectionWithoutMutation: never escapable by replyAcknowledgesCart -- explicit verb + unchanged cart is always false regardless of what else the reply says", () => {
  assertEquals(claimsExplicitCorrectionWithoutMutation(LIVE_REPLY_1, ZIOS_CART_BEFORE, ZIOS_CART_AFTER), true);
  // Even though replyAcknowledgesCart(LIVE_REPLY_1, ...) is true, evaluateGuard1f
  // above still trips -- the explicit branch does not consult replyAcknowledgesCart at all.
});

Deno.test("evaluateGuard1f: a REAL correction (cart actually changed) never trips, even with the same wording", () => {
  const after: Guard1fCartItem[] = [{ name: "Large 18'' Neapolitan Cheese Pizza" }]; // Medium pepperoni line genuinely gone
  const result = evaluateGuard1f(LIVE_REPLY_1, ZIOS_CART_BEFORE, after);
  assertEquals(result.tripped, false);
});

Deno.test("evaluateGuard1f: no correction language at all -> never trips", () => {
  const result = evaluateGuard1f("Anything else for you?", ZIOS_CART_BEFORE, ZIOS_CART_AFTER);
  assertEquals(result.tripped, false);
  assertEquals(result.reason, null);
});

Deno.test("evaluateGuard1f: AMBIGUOUS signal (CHANGE 2, 2026-09-04 regression) is still escapable by replyAcknowledgesCart -- a coherent cart recital ships as-is", () => {
  // The original false-positive this escape hatch was built for: a plain
  // cart listing next to "want" that isn't actually claiming a correction.
  const reply = "Your cart: 1x Large Pizza. Anything else you want?";
  assertEquals(claimsAmbiguousCorrectionWithoutMutation(reply, ZIOS_CART_BEFORE, ZIOS_CART_AFTER), true);
  const result = evaluateGuard1f(reply, ZIOS_CART_BEFORE, ZIOS_CART_AFTER);
  assertEquals(result.tripped, false, "ambiguous signal + cart-acknowledging reply must still ship, unlike the explicit signal");
});

Deno.test("evaluateGuard1f: AMBIGUOUS signal with NO cart awareness at all still trips (unchanged pre-existing behavior)", () => {
  const reply = "Just one is what you wanted, right?";
  const result = evaluateGuard1f(reply, ZIOS_CART_BEFORE, ZIOS_CART_AFTER);
  assertEquals(result.tripped, true);
  assertEquals(result.reason, "ambiguous");
});
