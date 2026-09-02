# Spec: Order ticket delivery — the paid order must reach the kitchen or someone must know it didn't

**Date:** 2026-09-01
**Owner:** Lead → John Walsh (build) → Melvin (verify)
**Priority:** 4 of 5. Independent of specs 1–3; can run in parallel.

## Why this exists

The order ticket email is the **only** channel by which a restaurant learns an order exists. There is no order queue in the owner dashboard — the owner nav (`admin-dashboard/src/components/Layout.tsx:40–46`) is At a Glance, Conversations, Quality, Production Readiness, Issues, Chat with your shop, Financial Reporting. No Orders page. No printer. No POS push for non-Toast shops.

So this one email sits between the customer's money and the customer's food, and it can currently fail silently in two distinct ways.

Everything else in this system is built to fail closed — `guardedSend` defaults to deny, the delivery zone refuses rather than guesses, the fake-checkout gate blocks rather than hopes. This path fails open, and nobody is watching it.

## Evidence

`supabase/functions/chat-sms/index.ts`, the `payment_confirmed` handler:

**Failure mode A — no destination, no ticket, no error.**
```
line 2535:  if (system_event === "payment_confirmed" && shop.email_ticket_recipient) {
```
If `email_ticket_recipient` is null the branch is skipped entirely. No log, no error, no record. The customer is charged, the receipt goes out, the restaurant is never told. Spec 3 gates this at go-live; this spec makes the runtime path itself loud.

**Failure mode B — the idempotency claim precedes the send.**
```
lines 2538–2543:  claim ticket_emailed_at via conditional UPDATE (WHERE ticket_emailed_at IS NULL)
lines ~2621:      fetch("https://api.resend.com/emails", …)
lines ~2653:      if (!emailResp.ok) console.error(…)
lines ~2657:      catch (emailErr) console.error("Non-fatal: order ticket email threw", …)
```
The slot is claimed *before* the send is attempted. A non-2xx from Resend, or a throw, is logged and swallowed — and because the slot is already claimed, **nothing will ever retry it.** Same outcome as A: paid order, no ticket, no alarm.

The idempotency guard itself is correct thinking — it is there to prevent double-sends under concurrency. The ordering is what is wrong.

**Failure mode C — the audit table nobody reads.**
`ticket_send_log` (migration 044) records `http_status`, `resend_message_id`, recipient, cart, shop, per attempt. It is written at `chat-sms/index.ts:2637`. A repo-wide grep finds exactly two references: the migration and that insert. **Nothing reads this table.** No alert, no dashboard tile, no query, no `issue-detector` rule. A Resend outage, a domain-reputation block, or a typo'd recipient is invisible until a restaurant phones Jason.

## Fix

### Fix 1 — claim on success, not before

Restructure so the send is attempted first and the slot is claimed only on a confirmed 2xx. Keep double-send protection intact:

- Use a short-lived claim (`ticket_send_attempt_at` or an advisory lock) to serialize concurrent callers, then set `ticket_emailed_at` only after Resend returns 2xx.
- On failure, release the claim so a retry is possible.
- A duplicate ticket is an annoyance; a missing ticket is a customer with no food and a merchant with a chargeback. When the two risks conflict, prefer the duplicate — and dedupe on `order_number` in the subject so the kitchen can see it is the same order.

### Fix 2 — bounded retry

- Retry on failure with backoff, at least 3 attempts across ~2 minutes. Log every attempt to `ticket_send_log` (it already captures per-attempt rows — that is what it was built for).
- Exhausting retries is a **critical** event, not a `console.error`.

### Fix 3 — escalate a failed ticket

When retries are exhausted, or when `email_ticket_recipient` is null on a paid order:

- Write an `issues` row (severity critical) so it surfaces in the existing Issues page and the `issue-detector` → Telegram path the team already watches.
- Do **not** invent a new customer-facing message. The outbound guard's two-transactional-exception rule (paid-order receipt, refund) stands — this escalation is internal only.

### Fix 4 — make the audit table earn its existence

- Add an `issue-detector` rule (it already runs on pg_cron every 10 min): any `ticket_send_log` row with a non-2xx `http_status`, or any paid `order_carts` row older than N minutes with no successful ticket, raises an issue.
- Surface ticket health on the owner's At a Glance as a simple binary — orders received today vs tickets delivered today. An owner should be able to see at a glance that every order they were paid for reached their kitchen.

## Acceptance (Melvin verifies)

1. Force Resend to 500. The ticket is retried, `ticket_emailed_at` is **not** set, `ticket_send_log` has one row per attempt, and after exhaustion a critical `issues` row exists.
2. Restore Resend. The retry succeeds, `ticket_emailed_at` is set exactly once, exactly one email is delivered.
3. Fire two concurrent `payment_confirmed` events for one cart. Exactly one email. No double-send.
4. Pay an order on a shop with null `email_ticket_recipient`. A critical issue is raised. (Spec 3 prevents this shop from being live; this proves the runtime path is loud if it ever happens.)
5. `issue-detector` raises on a seeded non-2xx `ticket_send_log` row within one cron cycle.
6. At a Glance shows orders-vs-tickets for the day and the two numbers agree on a clean day.
7. No change to the outbound guard's allowed transactional exceptions. Diff `outbound-guard.ts` — it should be untouched.

## Out of scope

- Building a full order queue / KDS in the dashboard. Worth doing, not this week. Note that until it exists, email remains a single channel, and this spec only makes its failure visible rather than eliminating it.
- SMS or push ticket delivery to the owner as a second channel. Same reasoning — flagged as the natural follow-on once the first shops are live and we know how often email actually fails.

## Definition of done

Send-then-claim ordering, bounded retry, critical escalation on exhaustion or missing destination, `issue-detector` rule reading `ticket_send_log`, At a Glance tile. Melvin verifies all 7 criteria including the concurrency test.
