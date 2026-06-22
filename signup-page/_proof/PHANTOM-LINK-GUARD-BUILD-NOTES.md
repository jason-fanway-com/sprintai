# Phantom-link guard — BUILD NOTES

**Branch:** `fix/checkout-phantom-link-guard` (off `origin/main`)
**File changed:** `supabase/functions/chat-sms/index.ts` (only)
**Scope:** chat-sms edge function only. No schema/migration changes. No menu/payments economics touched.

## The bug
The ordering loop calls Claude with tools; `submit_order` creates the Stripe
checkout session, sets cart `phase="checkout"`, returns `checkoutUrl`.
Intermittently the model writes prose like *"A payment link is on the way"* /
*"You're all set"* WITHOUT calling `submit_order`. Result: cart stays
`phase="building"`, `stripe_checkout_session_id` stays null, no Stripe session,
no link — but the customer is told a link is coming. Worst-case failure for an
ordering bot. Reproduced from real data (conv `be210325-...`).

Prompt-only fixes already exist (a CRITICAL rule) and the model still misses it,
so this is a **deterministic structural guard**, not a prompt tweak.

## What was built

### 1. Detector — `claimsPaymentSent(text)` (exported)
Lines ~862–924. A maintained list of regex patterns
(`PAYMENT_CLAIM_PATTERNS`) matching payment-claim / order-placed language after
normalizing the text (lowercase, curly-quote fold, whitespace collapse).
Intentionally specific to *claims a link/payment is already sent or the order is
placed* — not normal building chatter. Exported for unit testing.

### 2. Post-turn safety net (primary) — main handler
Lines ~1554–1632, in the SHARED path after `runOrderingLoop` and BEFORE the
`isSms` / web response split (so it guards **both** channels identically,
including the `web:imsg-` iMessage bridge).

Invariant: **a reply that asserts "payment link sent / order placed" only goes
out if a real checkout session exists.**

When `!checkoutUrl && claimsPaymentSent(reply)`:
- Re-reads the authoritative `order_carts` row (cart_json, pickup_name, phase,
  session id).
- **If a real session already exists on the row** (`stripe_checkout_session_id`
  set or `phase==="checkout"`): send an honest "already sent, check your texts"
  reminder. Does NOT create a second session (idempotency).
- **Else if recoverable** (has items, no incomplete bundle, pickup name known —
  from the row or a name-like last user message after the bot asked for a name):
  force `submit_order` via `executeTool`, producing a REAL `cs_test_`/`cs_live_`
  session, then send the real success copy. Reuses the existing submit path.
- **Else (not recoverable)**: replace the reply with an honest fallback
  (`honestFallbackReply`) that asks for the missing piece (name / more bundle
  picks / restart) and makes NO payment claim.

Helpers added near the detector: `checkoutAlreadyExists(row)`,
`honestFallbackReply(cart, incompleteBundle)`.

The pre-existing real-path override (`safeReply = checkoutUrl ? "Payment link
sent!..." : reply`) and the `submit_order` success wording are unchanged — the
guard only catches the FALSE path.

## Determinism / idempotency
- Guard only forces a submit when no `checkoutUrl` from this turn AND no session
  already on the row → no double session, no double charge.
- Reuses `executeTool("submit_order")` which already writes the session id +
  `phase="checkout"` once.

## Proof artifacts (this directory)
| File | What it proves | Result |
|---|---|---|
| `phantom-link-detector.test.{mjs,log}` | Detector catches all 23 known false phrases incl. the real-world failure; 0 false positives on 15 normal-chatter phrases | **38/38 PASS** |
| `phantom-link-guard-invariant.test.{mjs,log}` | Guard decision tree holds the invariant across the full state matrix x3 (24 runs); 0 phantoms; no-double-session | **PASS** |
| `phantom-link-live.test.log` | 18 live confirm-order runs vs deployed TEST function: every run → real `cs_test_` session + phase checkout; 0 phantoms | **18/18 PASS** |
| `phantom-link-live-clean.test.log` | Re-run (15) after the clean (no-hook) redeploy | **15/15 PASS** |
| `phantom-link-forced.test.log` | Forced-phantom live proof (temporary test_mode hook): guard catches the lie and either recovers a real session (Case A) or sends an honest no-claim reply (Case B) | **PASS (A+B)** |

### Live deploy note
Deployed `chat-sms` to the **TEST** project `rvdqfxtrskxekfkqnegx`
(SprintAI-Chat, Stripe TEST / `sk_test_`) to run live proof. A temporary
`test_mode`-only `__FORCE_PHANTOM__` hook was deployed to force the bug on
demand for the forced-phantom proof, then **removed from `index.ts` and the
clean version redeployed and re-verified** (15/15). The token does not exist in
`index.ts`; it remains only in the proof test file that documents the procedure.

## Channels
Guard runs in the shared code path before the `isSms` branch, so `sms` (Twilio),
`web`, and `web:imsg-` (iMessage bridge) are all guarded by the same logic. Live
proof exercised the **web** path (the real NJB iMessage/web test path).

## Constraints confirmed
- NOT merged, NOT pushed to main, NOT deployed to prod (only TEST project).
- No schema/migration changes.
- No secrets in the diff. Test mode only (`sk_test_`).
- `deno lint` error count unchanged (7, all pre-existing; none in new code).
  `deno check` fails only on a pre-existing `@types/node` esm.sh resolution
  issue that occurs identically on unmodified `origin/main` (environment, not
  this change).
