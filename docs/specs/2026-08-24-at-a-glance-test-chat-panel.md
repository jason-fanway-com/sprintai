# Spec: At a Glance — embedded test-chat panel (right 2/3)

**Owner:** SprintAI_bot → John Walsh → Melvin
**Date:** 2026-08-24
**Request (Jason):** The shop-owner At a Glance screen must show the test chat on the **right 1/3**, with the glance content on the **left 2/3**, so an owner can immediately test conversations with their assistant and generate test orders.

## Approach — reuse, don't rebuild

`admin-dashboard/src/components/ShopChatTest.tsx` already exists: props `{ shopId: string, shopName: string }`, posts to `chat-sms`, and runs in test mode. Embed it. Do not build a new chat widget.

At a Glance = `admin-dashboard/src/pages/ShopOwnerDashboard.tsx`, which already resolves the current `shop` ({id, name, ...}).

## Tasks

1. **Layout split** in `ShopOwnerDashboard.tsx`:
   - Wrap the main content in a two-column layout: **left ≈2/3** = existing At a Glance tiles/content; **right ≈1/3** = `<ShopChatTest shopId={shop.id} shopName={shop.name} forceTest />`.
   - Right panel full-height, its own scroll, visually distinct as a "Test your assistant" sandbox with a short label so the owner knows orders here are test-only.
   - Responsive: on narrow screens stack (chat below the glance tiles), don't break mobile.
   - Only render the chat panel once a `shop` is resolved (guard the existing null/loading states).

2. **Force test mode** in `ShopChatTest.tsx`:
   - Today test mode is gated by `?test=1` in the URL (`isTestMode()`). Add an optional prop `forceTest?: boolean` (default false). When true, the component behaves as test mode regardless of the URL param (sends `test: true` to chat-sms).
   - Existing callers (no prop) keep current behavior exactly.

3. **Label/clarity:** a small badge or line on the panel: "Test mode — orders placed here are practice, not real." Warm, plain.

## Acceptance (Melvin, live)
- At a Glance renders with glance tiles on the left ~2/3 and the working test chat on the right ~1/3.
- Owner can send a message, the assistant replies, and a **test** order can be driven to completion (test mode confirmed — no real charge, cart flagged test).
- Chat is scoped to the current shop (`shop.id`); switching shops re-scopes the chat.
- Existing `?test=1` callers of ShopChatTest are unchanged.
- Mobile: layout stacks, nothing overflows.
- No tenant leakage: chat uses the resolved shop's id only.

## Out of scope
- No changes to chat-sms server logic. No new order types. No persistence beyond what ShopChatTest already does.
