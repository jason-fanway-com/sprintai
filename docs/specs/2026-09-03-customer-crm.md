# Customer CRM — remembered diners + personalized reorder
Date: 2026-09-03
Status: draft — BUILD GATED ON JASON GO (queued; touches PII + chat flow)

## Problem
Every diner conversation starts cold. The bot does not know a returning customer's
name, what they ordered before, or their usual. Jason's vision: "hey Christine, what
can I get you today", "what did I get last Thursday", "I want the regular". This is
the intimacy moat SMS gives us and aggregators cannot. The data already exists
(conversations, order_carts) but is never surfaced back into the conversation.

## Key architecture facts
- Identity of a diner = **(tenant_id, customer_phone)**. Nothing cross-tenant.
- `conversations` already carries `customer_phone` + `metadata.customer_name`.
- Paid order history = `order_carts` (cart_json items, pickup_name, totals,
  payment_status) joined via `conversations` on (tenant_id, customer_phone),
  filtered to paid/confirmed.
- `chat-sms` is the single ordering state machine — the one place to inject a
  remembered-customer context block and to update the profile after a paid order.
- `sms_opt_outs` already tracks consent per (tenant_id, customer_phone).

## User stories
- As a returning diner, I want the bot to greet me by name and offer my usual, so
  ordering feels personal and fast.
- As a diner, I want to say "the regular" / "same as last time" and have it understood.
- As a shop owner, I want the bot to remember MY customers only — never see or use
  another shop's customers.
- As a diner, I want to not be greeted by name if I never gave it or opted out.

## Module decisions
- New table `customers` (materialized profile), UNIQUE (tenant_id, customer_phone):
  columns: tenant_id, customer_phone, name, first_seen_at, last_seen_at,
  order_count, total_spent_cents, favorite_items jsonb (ranked item names+counts),
  last_order_id, last_order_at. RLS: service-role only; owner reads via existing
  shop-scoped admin path. Index (tenant_id, customer_phone).
- Upsert the profile from `stripe-webhook` on paid order (and/or chat-sms on
  confirmed cart): increment order_count, add totals, recompute favorite_items,
  set name from pickup_name when present. Precomputed aggregates — NO live
  full-history scan per message.
- `chat-sms` conversation start: single indexed lookup by (tenant_id, from_number);
  if found, inject a compact context block (name, order_count, top 1-2 items, last
  order date+items) into the system prompt. Bot MAY greet by name and offer the
  regular; MUST NOT recite full history unprompted.
- "The regular" resolution: only assert a regular when favorite item has >= 3
  orders; otherwise ask. "What did I get last Thursday" = query that customer's
  paid orders by date.
- Consent/taste: greet by name only for a RETURNING customer who has a stored name;
  never on first-ever contact. Respect opt-out. Owner-level toggle to disable
  personalization (default on).

## Pre-mortem (why it fails -> mitigation)
1. Cross-tenant leak — Christine orders at shop A and shop B; profiles bleed. ->
   Hard key (tenant_id, customer_phone); every read filters tenant_id; RLS
   service-role only; AC2 proves shop B never sees shop A's profile.
2. Creepy / over-personal ("I see you ordered 14 times") -> tasteful copy, greet +
   offer only, no unsolicited history dump; owner toggle; AC5 checks copy bounds.
3. Wrong person on a shared/recycled number -> greet by name is an offer not an
   assumption; confirm before applying "the regular"; AC4.
4. Stale "regular" from a single fluke order -> require >= 3 orders of an item
   before calling it the regular; AC6.
5. PII exposure in logs -> store minimum (name, phone already present); never log
   name in plaintext beyond existing patterns; profile table service-role only.
6. Scale — per-message aggregation over all orders -> precomputed aggregates on the
   customers row, single indexed lookup per conversation start; AC7 (one query, no
   scan).
7. Opt-out ignored -> personalization suppressed when opted out; AC3.

## Acceptance criteria
1. A `customers` row is created/updated within one paid order: after a diner's cart
   reaches paid, a row for (tenant_id, customer_phone) exists with order_count>=1,
   total_spent_cents = order total, name = pickup_name. Verifiable via DB.
2. Tenant isolation: a customer_phone that ordered at shop A (tenant A) has NO
   customers row or context exposure under tenant B; a chat with shop B for the same
   phone gets a cold (unremembered) start. Verifiable via two-tenant test.
3. Opt-out suppression: a (tenant_id, phone) present in sms_opt_outs (not opted back)
   receives no name greeting and no personalization. Verifiable via test conversation.
4. Returning-customer greeting: a second conversation from a phone with a stored name
   produces a greeting containing that name; a first-ever conversation does not.
   Verifiable via two runs.
5. No unsolicited history dump: the opening bot message never lists more than the
   top 1-2 items and never states raw order counts. Verifiable via transcript assert.
6. "The regular": when the customer's top item has >= 3 paid orders, "the regular"
   resolves to that item and adds it (subject to CartOps never-auto-add: it OFFERS,
   requires confirm); with < 3 it asks instead of guessing. Verifiable via seeded data.
7. Lookup cost: conversation-start personalization uses a single indexed query on
   (tenant_id, customer_phone) against `customers` — no join-scan of order_carts per
   message. Verifiable via query plan / code review.

## Out of scope
- Cross-shop / global customer identity or profile sharing between tenants.
- Outbound marketing, loyalty points, discounts, or unsolicited SMS.
- External CRM sync (HubSpot/Salesforce/etc).
- Editing customer data by the diner; owner-facing CRM UI beyond existing admin
  (a dedicated owner CRM screen is a later spec).
- Any change to the $0.99/order or subscription economics.

## Open questions
1. Owner-facing surface: do we ship an owner CRM view now, or backend + chat
   personalization only (recommended: backend + chat first; UI later)?
2. Retention: how long to keep an inactive customer profile before purge (privacy)?
   Recommend a configurable window (e.g. 24 months) — Jason's call.
3. Name source of truth when pickup_name and metadata.customer_name disagree —
   recommend latest paid pickup_name wins.