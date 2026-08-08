# Spec: Shop-Level Financial Reporting Dashboard

**Owner:** Jason (directive 2026-08-08)
**Status:** Captured — research + full spec in progress
**Priority:** Post-demo (not an 8/11 blocker)

## What Jason asked for (source of truth)

1. **QuickBooks-like view of all transactions** — a clean, complete ledger of the shop's orders/payments.
2. **QuickBooks-compatible CSV export** — downloadable file the owner can import into QuickBooks or other accounting software.
3. **World-class reporting** — research and define what *else* a family-restaurant owner needs beyond a transaction list to make this best-in-class.
4. **Location:** a dashboard **at the shop level, inside the admins' suite** (the `admin-dashboard` app), tenant-scoped to that shop.

## Constraints / context

- Data source: `order_carts` (orders, totals, tips, order_number, order_type, timestamps) + Stripe (payouts, fees, refunds, disputes).
- **Tenant isolation is absolute** — a shop sees only its own transactions. Hard compliance gate.
- Lives in `admin-dashboard`, shop-scoped view (see admin/shop split work).
- Generalizes to all shops — no per-restaurant custom reports.

## Research questions (to fill for "world-class")

- QuickBooks import formats: CSV vs IIF vs QBO — which does QuickBooks Online/Desktop actually accept for transactions? Column schema.
- What financial views a restaurant owner expects: daily/weekly/monthly sales, gross vs net, Stripe fees, tips (owed to staff), refunds/chargebacks, payout reconciliation (Sprint order → Stripe payout), sales tax collected, average ticket, order count, best-sellers, delivery vs pickup mix.
- Tax/compliance: sales tax reporting, 1099-K context (Stripe issues it), reconciliation to bank deposits.
- Export UX: date-range picker, per-period export, "download for accountant."
- Comparables: how Toast / Square / Clover present owner financials — the bar.

## Deliverable of the research phase

A complete build spec: data model/queries, report list, CSV schema(s), dashboard IA, acceptance criteria — ready for John Walsh to build and Melvin to verify.
