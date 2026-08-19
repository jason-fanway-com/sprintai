# Spec: Shop-Owner View — "At a Glance" dashboard + owner nav

Source: Jason notes 2026-08-17 (msg#160056 nav, msg#160096 at-a-glance contents) + 2026-08-14
(msg#155654 Production Readiness detail, msg#155644 view toggle). Research synthesis 2026-08-19.

## Owner left nav (replaces admin nav when in owner view)
In this order/labels:
1. At a Glance        → /shop-owner (relabel landing to "At a Glance")
2. Conversation       → /conversations (tenant-scoped)
3. Quality            → /conversation-quality (tenant-scoped)
4. Production Readiness→ /test-suite (tenant-scoped to THIS shop only)
5. Issues             → /issues (tenant-scoped)
6. Chat with your shop→ /shop-chats
7. Financial Reporting→ /financial-reporting

Super-admin nav + Admin⇄Owner toggle unchanged. Nav shows for real shop-owner logins AND
super-admin in mode==='owner' preview. Mobile sidebar/bottom-nav extended to owner view.

## HARD REQUIREMENT — tenant isolation (compliance, absolute)
Every owner-view page shows ONLY this owner's tenant/shop data. Use `useEffectiveTenant()`
(previewTenantId for super-admin preview; JWT tenantId for real owner). No cross-tenant leakage.
Audit TestSuite/test_runs, Conversations, Quality, Issues, Shop Chats. This is the critical gate.

## "At a Glance" — contents
Jason-specified:
- Orders widgets: today, this week, last [period] — each shows # orders AND total revenue.
- Revenue: YTD, month, day, quarter; today's revenue; total revenue booked lifetime.
- Top-selling items; items with no sales.
- Last 5 bot conversations.
- Store "health meter" (digital-orders perspective).
- Modern, sleek, premium design — owner feels he's in a well-crafted place.

Research additions (restaurant/SMB dashboard best practice):
- Average order value (AOV) = revenue / orders.
- Checkout completion rate (carts started vs submitted) — core health input.
- New vs returning customers (SMS-moat signal).
- Busiest hours/days.
- Every KPI tile carries trend vs prior period (▲▼ %) + sparkline.
- Single time-range toggle (Today/Week/Month/Qtr/YTD) rather than many redundant widgets.

### Health meter composition (0–100 or A–F, drivers shown)
Blend: checkout completion % + conversation-quality eval pass rate + order-volume trend +
reply/deliverability reliability. Show the drivers, never a black box.

### Layout (inverted pyramid)
- Top-left, largest: Today's revenue + Health score.
- Row of KPI cards: orders (today/week), AOV, completion rate — each with sparkline + delta.
- Revenue tiles: day / week / month / quarter / YTD / lifetime.
- Top sellers + dead items (two compact lists).
- Last 5 conversations (list, links into Conversation view).

## Data sources
- Revenue/fees: reuse `shop-financials` edge function (already has gross/net, per-period, chart).
- Orders/AOV/completion: query `order_carts` / orders + submitted vs started, tenant-scoped.
- Conversations: existing conversations tables, tenant-scoped, limit 5 recent.
- Quality pass rate: `conversation_evals`. Completion: submitted orders / carts created.

## Production Readiness detail (8/14)
Clicking a run shows verbose detail: the test chat, judge findings, recommended fix, what was
done. Not labeled "QA/test suite".

## Build order (slices)
1. Owner nav (7 items) + tenant-isolation audit of the 5 reused pages. [foundation]
2. At a Glance page shell + data hooks (revenue via shop-financials, orders/AOV/completion,
   recent convos) — all tenant-scoped.
3. Health meter + top/dead sellers + trend sparklines + polish (premium design pass).
4. Production Readiness run-detail drill-down.

Deploy: admin-dashboard build → deploy-root/admin → netlify (site e757a50b-e321-400a-91e2-7854e2b0eca0).
Verify front door: curl https://getsprintai.com/admin/ serves new JS hash. Melvin verifies tenant isolation.
