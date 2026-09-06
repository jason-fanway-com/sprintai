# Item I — Unacknowledged-order escalation (INSTRUCTION-10)

**Rule:** a PAID order whose kitchen ticket was delivered, still `expo_status='new'`
(never acknowledged) 7 minutes later → **exactly one** SMS to the shop owner.
**Validated when:** a synthetic unacknowledged order triggers exactly one escalation.

Reuse `issue-detector`. Do not build a new function.

---

## Pre-mortem (why this fails, and the mitigation)

1. **It double-texts the owner.** Sweeps overlap, or the issue row is closed and the rule
   re-fires. → Exactly-once is enforced in the DATABASE, not in the rule: a conditional
   `UPDATE ... WHERE owner_escalated_at IS NULL RETURNING id` claims the order. Only a
   winning claim may send. Never gate on the `issues` table.
2. **It fires 17 minutes late.** `issue-detector` cron is every 10 min (047/048), so a
   7-min timer lands 7–17 min after the fact — the rule is worthless for a hot kitchen.
   → Add a lightweight `mode:"escalation"` invocation on its OWN pg_cron every 2 min that
   runs ONLY this rule. The full sweep stays at 10 min.
3. **It texts a diner.** Catastrophic compliance failure. → Recipient is ONLY
   `shops.owner_mobile`. Never `order_carts` phone, never a conversation number. If
   `owner_mobile` is null → create the issue row, send nothing.
4. **It bypasses the outbound chokepoint.** → New `OutboundReason: "owner_escalation"`
   in `_shared/outbound-guard.ts`, default-deny like the rest, with real evidence
   required. All sends go through `guardedSend`. No new network door.
5. **It never fires at all**, because item H (Resend delivery webhooks) is blocked on
   Jason and `ticket_delivery_status` stays NULL. → Clock starts at
   `COALESCE(ticket_delivery_at [when delivered], ticket_emailed_at)`. Handed-to-Resend
   is sufficient; a real `delivered` event is better but not required.
6. **It spams during demos.** Demo shops are permanently test-mode. → Skip
   `test_mode = true` by default; `include_test_mode` sweep option exists for the
   validation walk only.
7. **A stuck shop generates a burst** (Expo screen off, 20 orders unacked). → Cap 5
   escalations per shop per sweep. Per-order exactly-once already bounds the total.
8. **Bounced tickets double-alert.** → `ticket_delivery_status IN ('bounced','complained')`
   is EXCLUDED here; that is item H's alert, a different failure.

---

## Migration `092_owner_escalation.sql`

```sql
ALTER TABLE order_carts
  ADD COLUMN IF NOT EXISTS owner_escalated_at timestamptz;

COMMENT ON COLUMN order_carts.owner_escalated_at IS
  'When the 7-minute unacknowledged-order escalation SMS was claimed for this order. Non-null = already escalated; the claim is a conditional UPDATE so an order can escalate at most once (INSTRUCTION-10 item I).';

CREATE INDEX IF NOT EXISTS idx_order_carts_escalation_scan
  ON order_carts (shop_id, expo_status)
  WHERE owner_escalated_at IS NULL;
```
Apply it. Confirm the column is live before deploying the function.

## Guard — `_shared/outbound-guard.ts`

Add `"owner_escalation"` to `OutboundReason`. Add to `OutboundContext`:
`unackedMinutes?: number`, `ticketHandedOff?: boolean`, `escalationClaimed?: boolean`.

```
case "owner_escalation": {
  if (!ctx.cartId)                       DENY "owner_escalation missing cart id"
  if (!PAID_STATES.has(status))          DENY "owner_escalation cart not paid"
  if (ctx.ticketHandedOff !== true)      DENY "owner_escalation without delivered/handed-off ticket"
  if (!(Number(ctx.unackedMinutes) >= 7))DENY "owner_escalation before 7-minute threshold"
  if (ctx.escalationClaimed !== true)    DENY "owner_escalation without exactly-once DB claim"
  ALLOW "unacknowledged paid order past 7-minute threshold"
}
```
This is merchant-facing (B2B operational alert to the owner's own mobile), same audience
class as `merchant_welcome`. Never a diner.

Extend the existing guard unit tests: one ALLOW case and one DENY case for EACH of the
five conditions above. Existing tests must still pass.

## Rule — `issue-detector/index.ts`

`detectUnackedOrders(supabase, opts)`, `detection_rule: "unacked_order_escalation"`,
severity `sev_1`.

Select candidates: `payment_status` in the paid set, `expo_status = 'new'`,
`expo_acknowledged_at IS NULL`, `owner_escalated_at IS NULL`,
`ticket_delivery_status IS DISTINCT FROM 'bounced'` and not `'complained'`,
`test_mode = false` (unless `opts.include_test_mode`), clock source non-null and
`<= now() - 7 min`. Limit 100; cap 5 per shop.

Per candidate, in this order:
1. Claim: `update order_carts set owner_escalated_at = now() where id = $1 and owner_escalated_at is null returning id`. No row → another sweep won; skip silently.
2. Look up `shops.owner_mobile`, `shops.name`, `shops.tenant_id`.
3. Create the issue row via the existing `createIssue` path (audit trail, dashboard).
4. If `owner_mobile` present: send via `guardedSend` with the evidence above.
   Provider resolution mirrors `chat-sms`: `TELNYX_API_KEY` set → Telnyx, else Twilio.
   Do NOT copy stripe-webhook's hardcoded Twilio path.
5. On send failure: log, leave `owner_escalated_at` set (a retry storm is worse than one
   missed alert; the issue row remains for the dashboard).

Message body (no PII beyond order number, no menu contents):
`SprintAI: order #<n> at <shop name> has not been acknowledged for <m> minutes. Open the Expo Screen: getsprintai.com/admin/expo`

Register in `ruleRunners`. In `mode:"escalation"` run ONLY this rule.

## Migration `093_escalation_schedule.sql`
pg_cron job `issue-detector-escalation`, every 2 minutes, POSTing
`{"mode":"escalation"}` to the issue-detector function. Unschedule-then-create, mirroring
047/048. Leave the existing 10-min job alone.

---

## Acceptance criteria (all must hold)

- AC1 `deno check` clean on both changed files; guard unit tests pass, old + new.
- AC2 Migration 092 applied; column + partial index confirmed live in the DB.
- AC3 Guard DENIES all five bad-evidence cases; a rogue call site cannot send.
- AC4 Synthetic paid, ticket-handed-off, unacknowledged order older than 7 min →
  **exactly one** issue row AND exactly one send attempt. Re-run the sweep twice more:
  still exactly one. `owner_escalated_at` set once.
- AC5 An ACKNOWLEDGED order (`expo_status != 'new'`) produces zero escalations.
- AC6 An order 5 minutes old produces zero escalations; the same order at 8 minutes
  produces one.
- AC7 A shop with `owner_mobile` NULL produces an issue row and ZERO send attempts.
- AC8 Test-mode orders are skipped by default.
- AC9 No diner number is ever a recipient — prove by inspection of the recipient source.
- AC10 Migration 093 applied; the 2-minute job is listed in `cron.job`.

Do NOT manufacture the signal: drive the real deployed function for AC4. No hand-written
webhook events, no stubbed guard. If a step cannot be exercised for real, say so and stop.

Report back ONLY: result, artifact paths (commits/migrations), and open questions.
