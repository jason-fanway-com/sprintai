// STEP 1 (2026-09-09, P0 -- Zio's incident): a real customer asked "show me
// the cart with prices" and the pre-LLM read-only cart-summary shortcut did
// not match it ("the" and "with prices" weren't covered), so the read fell
// through to the LLM -- exactly the read-only path that must never touch the
// LLM or a mutation guard, since the LLM then has to state real money itself.
//
// Widened to cover "the" in place of "my", a "with (the) prices" suffix, a
// standalone "show (me) (the) prices" ask, a "what's my/the total" / "how
// much is my/the order/cart/total" / "what do I owe" ask, and an optional
// leading "can/could you"/"please" and trailing "please" politeness wrapper.
// Still fully anchored (^...$) on purpose -- this must never fire on a real
// order line that happens to mention "cart" or "prices" mid-sentence.
//
// Extracted into its own importable module (same reason GUARD 9/13 were, see
// their headers) so a test can assert against the EXACT regex index.ts uses,
// not a hand-copied mirror that can silently drift from the real wiring.

// P0 fix (2026-09-09, same Zio's transcript, second defect): "show me the
// line items in the order" (asked twice) fell through to the LLM because
// no alternative below covered "line items" or a noun phrase interposed
// between "the" and "order/cart" ("in the order"). Widened with a dedicated
// "line items" alternative and a "what do I have (so far)" alternative
// (equivalent phrasing to the existing "what did/have I get/order/got/
// added" line, just with the verb/pronoun order a real customer actually
// used) — same anchoring discipline as every other alternative here.
const CART_SUMMARY_CORE =
  "(?:show(?:\\s+me)?(?:\\s+my|\\s+the)?(?:\\s+(?:full\\s+)?order|\\s+cart|\\s+order)?(?:\\s+with(?:\\s+the)?\\s+prices?)?" +
  "|show\\s+(?:me\\s+)?(?:the\\s+)?line\\s+items?(?:\\s+in(?:\\s+my|\\s+the)?\\s+(?:order|cart))?" +
  "|show\\s+(?:me\\s+)?(?:the\\s+)?prices?" +
  "|what(?:'?s|\\s+is)(?:\\s+in)?(?:\\s+my|\\s+the)?(?:\\s+cart|\\s+order)" +
  "|what(?:'?s|\\s+is)\\s+(?:my|the)\\s+total" +
  "|how\\s+much\\s+(?:is\\s+)?(?:my|the)\\s+(?:order|cart|total)" +
  "|what\\s+do\\s+i\\s+owe" +
  "|what\\s+do\\s+i\\s+have(?:\\s+so\\s+far)?" +
  "|(?:my|the)\\s+(?:order|cart)(?:\\s+so\\s+far)?" +
  "|(?:see|view|check|read)\\s+(?:my|the)?\\s*(?:order|cart)" +
  "|what(?:\\s+did|\\s+have)\\s+i(?:\\s+(?:get|order|got|added))?)";

export const CART_SUMMARY_RE = new RegExp(
  `^(?:(?:can|could)\\s+you\\s+|please\\s+)?${CART_SUMMARY_CORE}(?:\\s*please)?[\\s?]*$`, "i",
);
