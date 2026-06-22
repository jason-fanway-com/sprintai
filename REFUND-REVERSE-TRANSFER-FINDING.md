# Finding: `reverse_transfer` does NOT apply — refund code is already correct

**Branch:** `fix/refund-reverse-transfer` (off `fix/wizard-hours-and-or-parser`)
**Date:** 2026-06-22
**Mode:** Stripe TEST only (`sk_test…`, connected acct `acct_1Tl78PFHuvmmWIzA`). No deploy, no merge, no production.

## TL;DR
The requested fix (add `reverse_transfer: true` to the full-refund path) is **wrong for
this codebase and would BREAK full refunds in production.** The current
`refund-order/index.ts` is **already correct as written.** No code change was made to
the refund logic.

## Why the bug report is based on a stale model
The bug report describes **destination charges** ("the application fee was taken on the
associated transfer… you must also set reverse_transfer=true"). That error only occurs on
**destination/separate charges**, where a `transfer_data.destination` created a transfer to
the connected account.

Sprint deliberately **rebuilt onto DIRECT charges** (documented in `VERIFIED.md` §10.6 and
the "direct-charge rebuild" note). On a direct charge:
- the charge is created ON the connected account via the `Stripe-Account` header,
- `application_fee_amount: 99` rides on top,
- there is **NO** `transfer_data` / `on_behalf_of`, therefore **no transfer exists to reverse.**

So `reverse_transfer` is meaningless here and **Stripe rejects it.** The QA failure almost
certainly came from a destination-charge test fixture, not the current direct-charge stack.

## Empirical proof (Stripe TEST mode, acct_1Tl78PFHuvmmWIzA, 2026-06-22)
Created a real $30.99 direct charge with a $0.99 application fee (mirroring
`create-checkout`), then exercised the refund paths:

```
--- A. FULL refund ---
PI ... amount=3099 app_fee=99
❌ A1 full w/ reverse_transfer:true (the task's proposed fix):
     Cannot reverse transfer on charge ch_... because it does not have an associated transfer.
✅ A2 full w/ refund_application_fee:true ONLY  (== current code):
     refund amount=3099
     app_fee=99 app_fee_refunded=99   => the $0.99 IS returned to Sprint

--- B. PARTIAL refund ($10.00) ---
✅ B1 partial $10, NO refund_application_fee  (== current code):
     charge amount_refunded=1000
     app_fee=99 app_fee_refunded=0    => Sprint KEEPS the $0.99

❌ B2 any refund w/ reverse_transfer:true on a direct charge:
     Cannot reverse transfer on charge ch_... because it does not have an associated transfer.
```

### What this proves
1. **Full refund already works** with `refund_application_fee: true` alone, and it returns
   the $0.99 app fee to Sprint (`app_fee_refunded=99`). The claim that "full refunds will
   ERROR in production" is **false for the direct-charge model.**
2. **Partial refund already works** and keeps the $0.99 (`app_fee_refunded=0`), per spec.
3. **`reverse_transfer: true` is REJECTED** on these charges. Adding it — as the task
   requested — would turn working full refunds into hard errors. That is the opposite of
   the intended fix.

## Idempotency
The refund call already passes an idempotency key:
`refund_<order_cart_id>_<full|amount_cents>` via `connectedAccountOpts(...)`. Satisfied.

## Recommendation
- **Do NOT add `reverse_transfer`.** Keep `refund-order/index.ts` as-is.
- If QA still sees the destination-charge error, the test harness or a fixture is creating
  **destination** charges; align it with the live direct-charge flow (`create-checkout`).
- If the business ever switches back to destination charges, THEN full refunds would need
  `reverse_transfer: true` and partial refunds would need proportional
  `refund_application_fee` handling — but that is a model change, not a bug fix, and would
  reintroduce the −$0.21/order loss that drove the rebuild.

**Escalation flag:** the QA report and this finding disagree on the charge model. Confirm
which model QA tested before anyone acts on the original bug ticket.
