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

---

# Build Spec: Shop Financial Reporting Dashboard

## 1. Research Findings

### 1.1 QuickBooks Import Format

QuickBooks Online accepts **CSV for transaction imports** (bank feed and journal entries). QuickBooks Desktop uses **IIF** (Intuit Interchange Format), but IIF is legacy — CSV is the modern, universal path. QBO (QuickBooks Online format) is API-only, not user-facing.

**Standard QuickBooks CSV column formats (two accepted layouts):**

**3-column format (most common for restaurant owners):**
| Column | Description | Sprint Source |
|---|---|---|
| `Date` | Transaction date (MM/DD/YYYY) | `order_carts.created_at` |
| `Description` | Payee / memo | `"Sprint Order #" + order_number` |
| `Amount` | Positive = income, Negative = expense | `total` (positive) or fee/refund (negative) |

**4-column format (preferred — separates debits/credits):**
| Column | Description | Sprint Source |
|---|---|---|
| `Date` | MM/DD/YYYY | `order_carts.created_at` |
| `Description` | Transaction memo | `"Order #" + order_number + " - " + customer_name` |
| `Credit` | Income (sales + tips) | `subtotal + tip` |
| `Debit` | Expenses (fees, refunds) | Stripe processing fee, refund amount |

**We produce both formats.** A 4-column CSV for the full ledger (orders + fees + refunds + payouts mixed), and a 3-column simplified version for owners who import only sales.

**Additional QBO-friendly columns we optionally include:**
- `Reference Number` = `order_number`
- `Payment Method` = `"Stripe"`
- `Category` = `"Restaurant Sales"` (hint for QBO categorization)

### 1.2 Stripe Reporting Landscape

From Stripe docs (fetched successfully):
- Stripe provides **prebuilt reports**: Balance, Payout Reconciliation. CSV export is standard.
- Stripe has **QuickBooks integration** via Stripe Apps marketplace, but it syncs at the platform level — not suitable for per-tenant shop views.
- Stripe Sigma (custom SQL reports) is available but requires a separate subscription.
- **Stripe Connect payouts** follow a lifecycle: `pending` → `in_transit` → `paid` (1-2 business days) or `failed`/`canceled`. Tracked via `payout.*` webhooks.
- For Connect platforms, the platform controls payout schedules (daily by default).

**Implication for Sprint:** We must reconcile order-level revenue against the actual Stripe payout that lands in the shop's bank account. The owner needs to see: "I sold $1,000 on Monday. Stripe took $29 in fees. $971 will hit my bank on Wednesday."

### 1.3 Competitor Baseline (Toast, Square, Clover)

Common restaurant financial reports from leading POS systems:

| Report | Toast | Square | Clover |
|---|---|---|---|
| Daily Sales Summary | ✅ | ✅ | ✅ |
| Payment Breakdown (cash/card/tip) | ✅ | ✅ | ✅ |
| Labor Cost % of Sales | ✅ | ✅ | ✅ |
| Sales Tax Liability | ✅ | ✅ | ✅ |
| Item Sales Mix (best-sellers) | ✅ | ✅ | ✅ |
| Discounts/Comps Summary | ✅ | ✅ | ✅ |
| Net Sales (gross - discounts - refunds) | ✅ | ✅ | ✅ |
| Hourly Sales (staffing) | ✅ | ✅ | ❌ |

**The bar:** All three show daily sales, net, and tax on the home screen. Toast surfaces labor cost as a percentage of sales prominently. Square excels at payout reconciliation. Clover is weaker on analytics.

**Sprint's advantage:** Because Sprint owns the order + Stripe payment data end-to-end, we can deliver a cleaner, more trustworthy financial picture than any POS — no double-entry, no manual reconciliation.

---

## 2. Dashboard IA (Information Architecture)

### URL
`/dashboard/shop/:shopId/financials`

### Navigation
Admin dashboard sidebar, under the shop's section: "Financials"

### Page Layout
```
┌─────────────────────────────────────────────────────┐
│  ← Back to Shop    Financials: [Shop Name]           │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │
│  │ Gross    │ │ Net      │ │ Tips     │ │ Avg    │  │
│  │ Sales    │ │ Revenue  │ │ Collected│ │ Ticket │  │
│  │ $X,XXX   │ │ $X,XXX   │ │ $XXX     │ │ $XX.XX │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘  │
│                                                      │
│  [Today] [This Week] [This Month] [Custom...]        │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  Revenue Chart (bar chart: daily totals)     │   │
│  │  ██ ██ ██ ██ ██ ██ ██                       │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  Transaction Ledger (table)                  │   │
│  │  Date │ Order# │ Type │ Gross │ Fees │ Net  │   │
│  │  ─────┼────────┼──────┼───────┼──────┼──────│   │
│  │  ...  │ ...    │ ...  │ ...   │ ...  │ ...  │   │
│  │                                  Page 1 of N │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  [Export CSV (QuickBooks)] [Export CSV (Simple)]    │
└─────────────────────────────────────────────────────┘
```

### Tabs (if space-constrained)
1. **Overview** — KPI cards + revenue chart
2. **Ledger** — transaction table with filters
3. **Payouts** — Stripe payout reconciliation

---

## 3. Report Definitions

### 3.1 KPI Cards (Overview tab)

All scoped to the selected date range.

| KPI | Formula | Source |
|---|---|---|
| **Gross Sales** | SUM(`order_carts.total`) for completed orders | `order_carts` where `status = 'completed'` |
| **Net Revenue** | Gross Sales - Refunds - Stripe Fees | Computed |
| **Tips Collected** | SUM(`order_carts.tip`) | `order_carts` |
| **Average Ticket** | Gross Sales ÷ completed order count | Computed |
| **Order Count** | COUNT completed orders | `order_carts` |
| **Stripe Fees** | SUM of processing fees (estimated ~2.9% + $0.30 or from Stripe payout data) | Stripe `balance_transactions` or estimated |
| **Refunds** | SUM of refund amounts | `order_carts` with refund status or Stripe `refunds` |

### 3.2 Revenue Chart

- **Type:** Vertical bar chart
- **X-axis:** Day (for This Week / This Month) or Week (for Last 30 / Custom long range)
- **Y-axis:** Gross sales ($)
- **Second series (optional):** Net revenue overlay line
- **Library:** Recharts (already in admin-dashboard)

### 3.3 Transaction Ledger

Full scrollable table. Columns:

| Column | Source | Sortable |
|---|---|---|
| Date | `order_carts.created_at` | ✅ |
| Order # | `order_carts.order_number` | ✅ |
| Type | `order_carts.order_type` (delivery/pickup/dine-in) | ✅ |
| Customer | `order_carts.customer_name` or masked phone | ❌ |
| Subtotal | `order_carts.subtotal` | ✅ |
| Tip | `order_carts.tip` | ✅ |
| Tax | `order_carts.tax` | ✅ |
| Gross | `order_carts.total` | ✅ |
| Stripe Fee | Estimated or actual from Stripe | ✅ |
| Net | Gross - Stripe Fee | ✅ |
| Payment Status | `order_carts.payment_status` | ✅ |

**Features:**
- Pagination (50 rows per page)
- Search by order number or customer name
- Filter by: date range, order type, payment status
- Click row → opens order detail drawer/modal

### 3.4 Payout Reconciliation

This is the money feature — no other POS does this well.

Shows each Stripe payout that includes this shop's orders, with:
- Payout date (when the money hit the bank)
- Payout amount
- Orders included (expandable list)
- Stripe fees deducted
- Expected vs actual (flag discrepancies)

**Data source:** Stripe `payouts` + `balance_transactions` filtered by the shop's Stripe Connect account.

---

## 4. CSV Export Specifications

### 4.1 QuickBooks-Compatible CSV (4-column)

```csv
Date,Description,Credit,Debit
08/08/2026,Order #1042 - (555) 123-4567,42.50,
08/08/2026,Order #1043 - (555) 987-6543,28.75,
08/08/2026,Stripe Processing Fee,0.00,2.07
08/08/2026,Refund - Order #1041,,15.00
```

**Rules:**
- Date in `MM/DD/YYYY` format (QuickBooks US locale default)
- Credit = positive cash in (sales + tips)
- Debit = positive cash out (fees + refunds)
- No currency symbol in values
- UTF-8 with BOM (so Excel opens it correctly)

### 4.2 Simple CSV (3-column)

```csv
Date,Description,Amount
08/08/2026,Order #1042 - (555) 123-4567,42.50
08/08/2026,Order #1043 - (555) 987-6543,28.75
08/08/2026,Stripe Processing Fee,-2.07
08/08/2026,Refund - Order #1041,-15.00
```

### 4.3 Export Options (UI)

- Date range picker (defaults to current month)
- Format selector: "QuickBooks (4-column)" | "Simple CSV"
- One-click download button
- Filename: `[ShopName]-financials-[YYYY-MM-DD]-to-[YYYY-MM-DD].csv`

---

## 5. Data Model & Queries

### 5.1 Database Objects Involved

| Table | Relevant Columns |
|---|---|
| `order_carts` | `id`, `tenant_id`, `created_at`, `order_number`, `order_type`, `customer_name`, `customer_phone`, `subtotal`, `tip`, `tax`, `total`, `payment_status`, `stripe_payment_intent_id` |

### 5.2 Edge Function: `shop-financials`

**New Supabase edge function.** Location: `supabase/functions/shop-financials/index.ts`

**Endpoints:**

| Method | Path | Purpose |
|---|---|---|
| GET | `/shop-financials/:shopId/summary` | KPI cards data for date range |
| GET | `/shop-financials/:shopId/ledger` | Paginated transaction list |
| GET | `/shop-financials/:shopId/payouts` | Stripe payout reconciliation |
| GET | `/shop-financials/:shopId/export` | Generate and return CSV file |

**Auth:** Supabase session + tenant-scoped. Shop must belong to the authenticated user's tenant.

### 5.3 Core Query: Ledger

```sql
SELECT
  id,
  created_at,
  order_number,
  order_type,
  customer_name,
  subtotal,
  tip,
  tax,
  total,
  payment_status,
  stripe_payment_intent_id
FROM order_carts
WHERE tenant_id = $tenant_id
  AND created_at BETWEEN $start_date AND $end_date
  AND status = 'completed'
ORDER BY created_at DESC
LIMIT 50 OFFSET $offset;
```

### 5.4 Core Query: Summary KPIs

```sql
SELECT
  COUNT(*) as order_count,
  COALESCE(SUM(subtotal), 0) as gross_subtotal,
  COALESCE(SUM(tip), 0) as total_tips,
  COALESCE(SUM(tax), 0) as total_tax,
  COALESCE(SUM(total), 0) as gross_sales
FROM order_carts
WHERE tenant_id = $tenant_id
  AND created_at BETWEEN $start_date AND $end_date
  AND status = 'completed';
```

### 5.5 Stripe Integration

For fee data and payout reconciliation, the edge function calls Stripe API server-side:

1. **Get fees for a payment intent:** `stripe.balanceTransactions.list({ source: payment_intent_id })` — returns the fee.
2. **Get payouts for Connect account:** `stripe.payouts.list({ limit: 30 }, { stripeAccount: shop_stripe_account_id })`
3. **Get balance transactions for payout:** `stripe.balanceTransactions.list({ payout: payout_id }, { stripeAccount: ... })`

**Fallback:** If Stripe API call fails or shop has no Connect account, use estimated fee formula: `total * 0.029 + 0.30` per order. Show a "fees are estimated" badge.

### 5.6 Revenue Chart Data

```sql
SELECT
  DATE(created_at) as day,
  SUM(total) as daily_total,
  COUNT(*) as order_count
FROM order_carts
WHERE tenant_id = $tenant_id
  AND created_at BETWEEN $start_date AND $end_date
  AND status = 'completed'
GROUP BY DATE(created_at)
ORDER BY day ASC;
```

---

## 6. Frontend Architecture

### 6.1 Route
Add to admin-dashboard React Router:
```
/dashboard/shop/:shopId/financials
```

### 6.2 Component Tree
```
ShopFinancialsPage
├── DateRangePicker (preset: Today / Week / Month / Custom)
├── KPICards (row of 4-6 cards)
│   └── KPICard (label, value, delta from prior period)
├── RevenueChart (Recharts BarChart)
├── TransactionLedger
│   ├── LedgerFilters (date, type, search)
│   ├── LedgerTable (sortable, paginated)
│   └── Pagination
├── PayoutReconciliation
│   ├── PayoutList
│   └── PayoutDetail (expandable)
└── ExportButton (dropdown: QuickBooks CSV / Simple CSV)
```

### 6.3 State Management
- Use React hooks + SWR or React Query for data fetching (consistent with existing admin-dashboard patterns)
- Date range stored in URL search params (`?from=2026-08-01&to=2026-08-31`)
- Ledger page in URL search param (`?page=2`)

---

## 7. Tenant Isolation (Compliance Gate)

Every query and API call must carry tenant isolation:

1. Edge function extracts `tenant_id` from the authenticated user's JWT
2. All SQL queries include `WHERE tenant_id = $tenant_id` as the first filter
3. Shop ID is validated: the shop must belong to the user's tenant before any data is returned
4. Stripe account ID is fetched from the shop record (never from user input)

**Failure mode:** If a shop ID doesn't match the user's tenant, return 404 — don't confirm the shop exists.

---

## 8. Implementation Plan

### Phase 1: Core Ledger (MVP for post-demo)

| Step | Owner | Deliverable |
|---|---|---|
| 1. Create `shop-financials` edge function with summary + ledger endpoints | John Walsh | Working API |
| 2. Add `/shop/:shopId/financials` route to admin-dashboard | John Walsh | Working page |
| 3. Build KPICards + TransactionLedger components | John Walsh | Working UI |
| 4. Wire revenue chart (Recharts bar chart) | John Walsh | Working chart |
| 5. Build CSV export endpoint + download button | John Walsh | Working export |
| 6. Melvin verifies: tenant isolation, correct math, CSV opens in Excel + QuickBooks | Melvin | Sign-off |

### Phase 2: Payout Reconciliation + Stripe Fees (post-P1)

| Step | Owner | Deliverable |
|---|---|---|
| 7. Add Stripe API integration for fee data | John Walsh | Actual fee data |
| 8. Build PayoutReconciliation component | John Walsh | Working payout view |
| 9. Add export with fee data included | John Walsh | Accurate net figures |
| 10. Melvin verifies: Stripe data matches Dashboard, math is correct | Melvin | Sign-off |

### Phase 3: Enhancements (backlog)

- Period-over-period delta on KPI cards ("+12% vs last week")
- Sales tax liability report (grouped by tax rate)
- Best-seller items report (requires order items table)
- Email scheduled reports (daily/weekly summary to owner)
- Print-friendly PDF export

---

## 9. Acceptance Criteria

### Must pass before "done"

1. **Tenant isolation:** Shop A cannot see Shop B's transactions via URL manipulation or API call.
2. **Math correctness:** Sum of all ledger rows = KPI card gross sales. Net = Gross - Fees - Refunds.
3. **CSV validity:** Exported CSV opens in Excel with correct columns and formatting. Imports into QuickBooks Online without column errors.
4. **Date range:** All KPIs, chart, and ledger respect the selected date range. URL reflects the range.
5. **Empty state:** Shop with no orders shows zero-state gracefully ("No transactions in this period") — not a broken page.
6. **Paginated ledger:** 50 rows per page, works with 10,000+ orders without crashing.
7. **Responsive:** Works on tablet and desktop (restaurant manager on iPad is a key persona).

### Nice to have

- Loading skeletons for KPI cards and chart
- CSV filename includes shop name and date range
- Click-to-copy order number

---

## 10. Open Questions for Jason

1. **Stripe fee source:** Do we already store Stripe `balance_transaction.fee` anywhere, or should the edge function fetch it live? (Live fetch is P2; estimated fees for P1.)
2. **Refund tracking:** Are refunds tracked in `order_carts` with a status, or only via Stripe? Need to decide data source for refund reporting.
3. **Sales tax:** Is `order_carts.tax` reliably populated? Do we need a tax-rate lookup or is the stored value authoritative?
4. **Tips payout reporting:** Should we show tips as owed-to-staff (separate from shop revenue), or just report them collected? This has labor/payroll implications.
5. **Multi-shop owner view:** Should an owner with 3 shops get a consolidated financial view, or only per-shop? (Per-shop for now; consolidated = future feature.)
