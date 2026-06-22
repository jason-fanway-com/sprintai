# BUILD NOTES — Structural Outbound Watchdog

Branch: `feat/outbound-watchdog` · Status: TEST ONLY (not merged, not deployed)
Author: John Walsh (builder) · Date: 2026-06-22

## What this is

A single, default-deny chokepoint that EVERY customer-facing outbound message
must pass through. By construction, a message can only leave the system if it is
one of four accounted-for reasons WITH real evidence:

| reason | evidence required | audience |
|---|---|---|
| `inbound_reply` | fresh triggering inbound id + timestamp within 900s, not future | diner |
| `payment_confirmed` | cart id + cart in a paid state | diner |
| `order_refunded` | cart id + `refunded_cents > 0` | diner |
| `merchant_welcome` | merchant subscription active | merchant (B2B) |

Everything else is DENIED, logged `[OUTBOUND-WATCHDOG][CRITICAL]`, and never sent.

## Why it's structural, not conventional

The real network sender is NOT exported. The only exported send path is
`guardedSend(ctx, deliver)`. The actual Twilio `fetch` / `imsg send` lives INSIDE
the `deliver` closure, which runs ONLY on ALLOW. A new or rogue call site cannot
reach the network without constructing a typed `OutboundContext` and passing the
guard. There is no other door.

## Files

- `supabase/functions/_shared/outbound-guard.ts` — the guard (`assertOutboundAllowed`, `guardedSend`). Unchanged this run; verified correct.
- `supabase/functions/chat-sms/index.ts` — `sendSmsViaTwilio(ctx,...)` wraps the Twilio fetch inside `guardedSend`; `inboundReplyCtx` threaded to all synchronous replies; `txnCtx` for receipt/refund reads real cart state.
- `supabase/functions/stripe-webhook/index.ts` — merchant welcome gated via `merchant_welcome`. **Changed this run:** `subscriptionActive` now reads the REAL Stripe `subscription.status` (`active`/`trialing`) instead of a constant `true`.
- `scripts/imsg-bridge.sh` — `assert_outbound_allowed` shell guard; both `imsg send` callers (`send_reply`, `drain_outbound_queue`) gated; default-deny.
- `signup-page/_proof/outbound-watchdog-proofs.mjs` — functions-side proof (imports the REAL `.ts`).
- `signup-page/_proof/outbound-watchdog-bridge-proof.sh` — bridge shell-guard proof (sources the REAL function).
- `signup-page/_proof/run-outbound-watchdog-proofs.sh` — one-shot runner.

## Customer-facing send sites (final enumeration)

| location | type | gated? |
|---|---|---|
| `chat-sms/index.ts:1089` Twilio `Messages.json` | diner SMS reply/receipt | ✅ inside `guardedSend` (via `sendSmsViaTwilio`) |
| `chat-sms/index.ts:1320` `outbound_queue` insert | diner iMessage (bridge drains) | ✅ inside `guardedSend` deliver closure |
| `stripe-webhook/index.ts:891` Twilio `Messages.json` | merchant welcome | ✅ inside `guardedSend` (`merchant_welcome`) |
| bridge `send_reply` → `imsg send` | diner reply | ✅ `assert_outbound_allowed inbound_reply` |
| bridge `drain_outbound_queue` → `imsg send` | diner receipt/refund | ✅ `assert_outbound_allowed payment_confirmed/order_refunded` |

**Non-customer Twilio calls (provisioning, no gating needed — noted):**
- `stripe-webhook:747` `AvailablePhoneNumbers/US/Local.json` — number search
- `stripe-webhook:767` `IncomingPhoneNumbers.json` (POST) — number purchase
- `stripe-webhook:807` `IncomingPhoneNumbers.json?PhoneNumber=` — lookup for release
- `stripe-webhook:822` `IncomingPhoneNumbers/{sid}.json` (DELETE) — number release

These are account/number provisioning, not messages. No customer text is emitted.

Grep confirms only TWO `Messages.json` sends in the whole functions tree, both
inside `guardedSend`. The only `outbound_queue` insert is inside `guardedSend`.
**No ungated customer-facing door exists.**

## Real-state evidence each call site passes

- **chat-sms `txnCtx` (payment_confirmed):** `cartPaymentStatus = cartRow.payment_status`, `cartId = order_cart_id` — read from the real `order_carts` row loaded by id. Guard DENIES if not in a paid state.
- **chat-sms `txnCtx` (order_refunded):** `cartRefundedCents = cartRow.refunded_cents`, `cartId = order_cart_id` — real row. Guard DENIES if `refunded_cents` is not `> 0`.
- **chat-sms `inboundReplyCtx`:** `inboundMessageId = Twilio MessageSid/SmsMessageSid` of the live inbound, `inboundAtMs = now` (processing it live → fresh). DENIES if absent/stale.
- **stripe-webhook `merchant_welcome`:** `subscriptionActive = (subscription.status === "active" || "trialing")` from the real Stripe subscription retrieved in the signature-verified `checkout.session.completed` handler. No longer a hardcoded `true`.

## Proof results

Run: `bash signup-page/_proof/run-outbound-watchdog-proofs.sh`

- **Functions-side: 48/48 passed.** Imports the REAL `outbound-guard.ts` via Node 22 native type-stripping (`--experimental-strip-types`) — ZERO drift, no copy, no regex extraction. Covers every reason's ALLOW/DENY matrix, default-deny, the deliver-spy structural proof (deliver() never fires on any DENY; fires exactly once on each ALLOW), captured CRITICAL DENY lines, a rogue-send simulation (network side-effect only reachable through `guardedSend` with valid evidence), and regression of the two real receipts + synchronous inbound replies.
- **Bridge shell guard: 13/13 passed.** Sources the REAL `assert_outbound_allowed` from `imsg-bridge.sh`. Proves ALLOW only for `inbound_reply` (fresh id+epoch) and `payment_confirmed`/`order_refunded` (queue-row id); DENY (CRITICAL logged, send skipped) for missing evidence, stale/future ts, unknown/blank reason.

Sample captured CRITICAL DENY (functions):
```
[OUTBOUND-WATCHDOG][CRITICAL] DENY reason=payment_confirmed shop=- tenant=- conversation=- cart=- to=+15***67 why="payment_confirmed missing cart id"
```
Sample captured CRITICAL DENY (bridge):
```
[OUTBOUND-WATCHDOG][CRITICAL] DENY reason=blast ev1=x why="unknown or blank reason"
```

## Why no regex extractor (drift avoidance)

The earlier `_extract-outbound-guard.sh` regex-stripped the TS into `.mjs` — fragile
and drift-prone, exactly the trap flagged. **Removed.** Node 22 strips TS types
natively, so the proof imports the actual source file. What we prove is what runs.

## Tooling notes

- `deno` not available in this repo; `node v22.22.0` is. Native `--experimental-strip-types` covers the guard import cleanly.
- `bash -n scripts/imsg-bridge.sh` → OK.
- `node --check --experimental-strip-types` on stripe-webhook → no errors from this change.

## Safety confirmations

- Committed to `feat/outbound-watchdog` ONLY. NOT merged, NOT pushed to main, NOT deployed.
- Live iMessage bridge (PID 18724) UNTOUCHED — not restarted, not killed.
- No real SMS / iMessage sent. Proofs are pure logic + spies; no network, no live services.
- No secrets in the diff.
