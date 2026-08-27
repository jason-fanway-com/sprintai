# SprintAI — Business

Last updated: 2026-08-27

What SprintAI is, who it serves, how it makes money, and why the product is
built the way it is. For engineers who need business context to make good
technical decisions.

---

## The problem

Restaurants lose 20–40% of phone orders during peak hours because nobody picks
up. The staff who do answer are pulled off the line, off the register, or away
from in-person customers. The phone is the highest-volume sales channel for most
independent restaurants, and it's the worst-served — there is no "phone
ordering" SaaS category worth the name.

Existing solutions fall into two camps:
- **Online ordering platforms** (Toast, DoorDash Storefront) — require the
  customer to download an app, create an account, and browse a menu. High
  friction. These compete for the restaurant's commission margin, not the phone.
- **AI phone agents** (voice) — expensive, latency-sensitive, and fragile with
  accents and background noise. Also, nobody under 40 wants to talk on the
  phone.

SprintAI takes the third path: **text**. The customer texts the restaurant's
existing number the same way they'd text a friend, and an AI handles the entire
ordering conversation — menu, modifications, delivery, payment. Same behavior
as a great phone order-taker, but it never misses a call, never gets the order
wrong, and costs $0.99 per order.

---

## The product

SprintAI is an **AI phone order-taker that works over SMS/iMessage and web
chat.**

The go-to-market motion is now packaged: a mobile **"How it works"** page
(`how-it-works.html`) walks an owner from sign-up → onboarding → marketing kit
→ go-live in ~2 weeks at **$99/mo + $0.99/order (paid by the customer)**. A
per-shop **demo kit** (3 QR codes — text-to-order, the owner's Store Chat,
and sign-up — plus a scripted walkthrough) lets a SprintAI rep close a live
demo on a shop's own phone in minutes: order an item, 86 it from Store Chat,
and watch the bot refuse it in real time. This is the physical embodiment of
the pitch — *you keep your customers, your margin, and your name on the sale*.

Two user surfaces:

### For diners (the ordering experience)
1. **Text the restaurant.** Customer sees the number on Google, the website,
   or a QR code. They text "I want a dozen bagels" or "large pepperoni pizza."
2. **AI conversation.** The bot shows the menu, handles modifications ("no
   onions"), bundles ("make it a combo"), quantity limits, and delivery
   addresses. It sounds like a helpful human order-taker.
3. **Checkout and pay.** At the right moment, the bot sends a Stripe payment
   link. Customer pays. Receipt is texted back. Done.
4. **Web chat fallback.** If a customer prefers, they can use the browser-based
   chat widget (`getsprintai.com/chat/<shop-slug>`) — same AI, same flow.

### For restaurant owners (the admin experience)
1. **Onboarding wizard.** Sign up, import menu (CSV or scrape the website), add
   hours and delivery settings, connect Stripe. Self-serve, no sales call.
2. **Conversational admin.** Change the menu by talking to an AI: "Make the
   everything bagel $1.50." The AI proposes, the owner confirms, it's done.
   Every change is logged and reversible.
3. **Sold-out manager.** PIN-protected simple toggle: tap to mark items sold
   out for today. Designed for line cooks and counter staff who don't have time
   on a computer.
4. **Role-gated dashboard.** Super admins see all shops; shop owners see only
   their own. Role is carried in the JWT (`app_metadata.role`), verified
   server-side, and enforced with frontend route guards.
5. **Financial reporting.** Per-shop transaction ledger with real Stripe fees,
   revenue KPIs, payout reconciliation, and QuickBooks-compatible CSV export.
   Every charge shows its exact Stripe fee (or an estimate for pending charges),
   so the owner sees net revenue, not just gross.
6. **Dashboard.** Orders, revenue, conversation transcripts, quality scores,
   financial reporting. Purpose-built for a restaurant owner, not a SaaS power user.

---

## The business model

| Metric | Value |
|--------|-------|
| Revenue per order | $0.99 flat service fee |
| Restaurant bears | Stripe processing fees (2.9% + $0.30) |
| Sprint keeps | The full $0.99 |
| Customer pays | Food + tax (the $0.99 is invisible to them) |
| Restaurant subscription | $99/mo (single plan — one offering, one price) |

The $0.99 is applied as a Stripe application fee on every order's direct charge.
It is never shown as a line item to the diner (disclosed in the checkout
transition message). The subscription is billed separately via Stripe Billing →
`stripe-webhook` Netlify function.

At 10 orders/day per restaurant, a shop generates ~$300/mo in service fees +
$99/mo subscription. At 1,000 restaurants averaging 15 orders/day: ~$450K/mo
in service fees + $99K/mo subscription. The model works at scale.

---

## The market

- **US restaurants:** ~750,000 (independent + small chain, excluding top-50
  chains that build their own).
- **Initial beachhead:** bagel shops, pizza shops, delis — high phone order
  volume, simple menus, repeat customers.
- **Expansion:** any restaurant that takes phone orders. The system handles
  complex menus with modifiers, bundles, and delivery out of the box.
- **Competition:** nobody is doing SMS-first AI ordering at scale. Voice AI
  companies (Goodcall, Slang, Kea) compete on a different modality. Online
  ordering platforms (Toast, Square) compete on web/app, not the phone.

---

## Product principles

These are encoded in the architecture, not just in marketing.

1. **Zero friction for the customer.** No app, no account, no website. Text
   works on every phone ever made. The first message can be "I want a dozen."

2. **Self-serve for the restaurant.** A shop owner should be able to sign up,
   import their menu, connect payments, and go live in under 30 minutes without
   talking to anyone at SprintAI. The onboarding wizard and automated number
   provisioning make this possible. Menu intake starts from a PDF or photo —
   the owner doesn't need to know what a "canonical CSV" is.

3. **AI-native, not AI-wrapped.** The ordering flow is an LLM conversation by
   design, not a form with an AI layer on top. The admin experience is
   conversational by design, not a CRUD dashboard with a chatbot on the side.
   The quality monitoring (eval-sweep) is AI-native: an LLM judges every
   conversation automatically.

4. **Safety by construction, not convention.** The outbound guard is a
   structural chokepoint — every customer-facing message must pass through a
   single function with a typed reason. There is no other send path. Default
   is deny. The same discipline now guards menus at the data layer: a
   protected-shop trigger blocks any accidental delete of a real shop's menu.

5. **Build for scale from day one.** Tenant isolation is absolute (RLS, not
   application-level filtering). Every onboarding step is automated. Every
   change that requires per-restaurant manual intervention is flagged as debt.

6. **Honest expectation-setting is a feature.** The product tells the owner
   plainly it's AI and can drift — then backs that with real, visible evidence:
   a pre-live acceptance suite, a live per-interaction quality signal, and
   dated periodic re-tests. Transparency about AI limits is what makes the
   quality story credible, not a disclaimer to hide behind.

---

## Current state (August 2026)

- **MVP is live** with one test shop. The ordering flow works end-to-end:
  customer texts → AI conversation → cart → Stripe checkout → receipt.
- **The order-taker got sharper.** Modifier price changes (e.g. "add cheese
  +$1") now actually add to the cart total. A multi-item message with one
  off-menu item adds the valid items instead of rejecting the whole order.
  Ordering a plain bagel by exact name no longer triggers a cream-cheese
  upsell. The bot quotes the menu's exact item names and units. Four
  deterministic grounding guards now intercept hallucinations before they
  reach the customer: off-menu container words ("tub", "pint"), false
  cart-contents claims, phantom "added to cart" confirmations, and a
  phase=checkout guard that prevents a cart from entering checkout without
  a real Stripe session — all caught by code-path rules, not just prompted
  preferences. The checkout
  flow now explicitly discloses the fee-inclusive total (subtotal + $0.99
  service fee + delivery + tip) from the authoritative order total —
  disclosure is code-driven, not model-hoped. Customer questions now take
  precedence over order completion — the bot answers direct questions (e.g.
  "do you have gluten-free bagels?") before advancing the order, even when
  they're mixed with declines. Category-level declines (asking for a category
  the shop doesn't carry) get a clean "we don't carry that." The bot never
  ignores a question to shortcut the order.
- **Telnyx SMS handler is built.** `chat-sms` parses Telnyx inbound webhooks
  (JSON `message.received`), drives the identical ordering conversation, sends
  outbound via the Telnyx Messages API through the outbound guard, handles
  delivery receipts, and implements STOP/HELP/START with the exact
  TCR-registered strings (whole-message matching — "I want to cancel this
  order" does NOT opt out). A blocked send is caught, persisted as opt-out, and
  logged rather than crashing or retry-looping.
- **Legal identity published.** Footer and terms/privacy carry SprintAI LLC, the
  mailing address (5620 Cetronia Rd, Allentown, PA 18106), and the canonical
  `getsprintai.com` support mailbox — one legal entity, one name on the sale.
- **A2P/10DLC: APPROVED via Telnyx.** The SprintAI LLC brand (`BJ8MUGY`) and
  campaign (`CSMB9HG`) are approved by all seven carriers (AT&T, T-Mobile,
  Verizon, US Cellular, Interop, ClearSky, Liberty). Twilio is abandoned — its
  business-profile verification rejected the EIN four times (error 18602) while
  the same EIN verifies cleanly through Telnyx. Telnyx is now the live SMS
  provider and provisioning path, which unblocks scaling beyond a handful of shops.
- **Stripe Connect:** Express onboarding (Path B) is implemented and verified
  in test mode. OAuth for Standard accounts (Path A) is coded but blocked on
  missing secrets (`STRIPE_CONNECT_CLIENT_ID`, `STRIPE_OAUTH_REDIRECT_URL`).
- **iMessage bridge** runs on a Mac — this is the current SMS gateway for the
  primary number. Twilio handles additional numbers.
- **Quality monitoring** (eval-sweep + issue-detector) is deployed and running
  on a schedule. Auto-fix is implemented but disabled (OFF by default).
- **Delivery flow** (order_type, delivery_address, driver_tip) is live. The ordering
  bot handles pickup vs delivery natively, and kitchen ticket emails label orders
  TAKEOUT or DELIVERY with the delivery address when applicable.
- **Kitchen ticket emails** (Resend) are sent per-order with full detail: bundle
  flavor breakdowns, modifier/option rendering, prep notes. Ticket dedup is
  enforced at the database level (ticket_emailed_at conditional claim) and every
  send is audited in `ticket_send_log`. Order numbers are hardened against
  direct-paid insert paths.
- **Inbound message dedup** (045): duplicate SMS webhook deliveries are
  silently skipped via Postgres unique constraint on `message_sid` — preventing
  double-orders from retransmitted messages.
- **Ops-table security** (041, 046): `outbound_queue` (customer phones + SMS bodies)
  and `number_provision_log` (Twilio numbers) are locked to service-role-only
  with RLS forced on. `admin_chat_transcripts` INSERT gated to super_admin only.
  Anon key can no longer read or write PII surfaces.
- **Role-gating**: `super_admin` and `shop_owner` roles in `app_metadata`.
  Frontend route guards enforce access; shop owners see only their shop.
  Legacy `is_admin` in `user_metadata` is a fallback for continuity.
- **Shop financial reporting**: Per-shop transaction ledger with real Stripe
  fees from balance transactions (estimated for pending charges). KPIs,
  revenue chart, payout reconciliation, and QuickBooks-compatible CSV export.
  Owners see net revenue, not just gross.
- **Menu pipeline** imports from PDF/photo, CSV, and website scrape. The Menu
  Intake Standard defines a 7-column canonical schema with triple-extract
  consensus pricing, a deterministic QA validator, and a mandatory owner
  sign-off gate — no menu goes live without the restaurant owner confirming
  every price. Supports option groups for item modifications. Bundles (e.g.,
  "dozen bagels" with flavor selection) are built into the tool loop.
- **Onboarding now starts from a PDF or photo, not a CSV.** The signup wizard
  takes a menu PDF or phone photos, and `parse-menu-pdf` (running the most
  capable Opus model, multi-pass with a dedicated modifier-block pass) reads
  every item, price, and modifier, then surfaces its own "open questions"
  (conflicting prices, missing items) for the owner to resolve before
  sign-off. CSV is still available behind an "advanced" toggle. This is the
  difference between onboarding that feels magical and onboarding that feels
  like homework.
- **Owner sign-off is now a hard go-live gate (§C).** A menu can't go live
  until the owner has confirmed every price and the parse is clean — no
  flagged rows, no open questions. The ordering bot still can't create or
  change a menu item; it only reads what the owner approved.
- **The go-live gate is also the QA story.** The per-shop conversation test
  suite auto-generates ~100 customer conversations from a shop's own menu —
  85 scripted single-turn cases plus 15 realistic multi-turn cases where an
  LLM "customer" plays a persona over several turns — runs them against the
  bot in isolation, and grades each against a rubric. The shop can't go live
  until it passes (≥95% overall AND 100% of the critical subset: wrong price,
  86 leakage, opt-out ignored, cross-tenant leakage). Shown to the owner as their "Store Readiness" report, with a
  matching super-admin QA console (test runs, per-case verdicts, model tier,
  critical failures) behind the login wall. The pitch made real: *AI is
  probabilistic and can drift; we are professionals who are vigilant about
  it, transparently.*
- **Super-admins preview the owner view.** A live Admin⇄Owner toggle lets a
  SprintAI operator flip the dashboard into a shop owner's exact perspective
  (own-shop scoping, Store Readiness signal) without logging out or
  impersonating credentials — supporting demos and support, with role-gating
  still enforced server-side.
- **Shop owners get a real self-serve dashboard.** The dashboard is no longer
  admin-only. A shop owner logs in to their own sidebar — At a Glance,
  Conversations, Quality, Production Readiness, Issues, Chat with your shop,
  Financial Reporting — the same pages SprintAI admins use, but scoped to their
  own shop. They check their store's readiness score, read their own
  conversation-quality signal, and track their own issues without ever emailing
  a SprintAI employee. One page serves both roles (tenant-scoped at query
  time), so there is nothing per-restaurant to build or maintain. This is the
  self-serve model made concrete: the owner is in control, Sprint stays out of
  the loop.
- **The QA console now explains itself.** The Production Readiness page drills
  down from a test run into any failing case and shows the transcript, the
  judge's findings, the root cause, and a proposed fix (with fix status). A
  failing critical case can never land with an empty root cause — an LLM
  triage script auto-generates the diagnosis. This turns the QA suite from a
  pass/fail report into a working log of what was fixed and why, so the team
  (and the owner) can see the bot getting sharper over time.
- **10DLC disclosure is in the funnel.** The homepage CTA and footer carry the
  carrier-required message-frequency sentence ("typically 3-8 messages per
  order") so the send path stays compliant and approved numbers stay
  unblocked. Legal pages canonicalize on `getsprintai.com` (the `getsprintai.net`
  mailbox is retired).
- **CartOps integrity is enforced at the code level.** `cart_json` is the
  single source of truth for a live order: a bare tip reply never mutates
  items, quantity corrections write back to the cart before any reply, and
  every quoted total is computed from `cart_json` (subtotal + $0.99 fee +
  delivery + tip). The invariant `quoted_total == charged_total ==
  sum(cart_json) + fees` holds, so an LLM-supplied number can never reach
  Stripe. An adversarial CartOps battery (`scripts/test-suite/cart-ops.ts`)
  asserts these invariants per shop at 100% — and the battery is shop-aware,
  building its cases from the shop's real menu rather than hardcoded
  references, so the same QA runs for restaurant #1 and #10,000.
- **The QA suite proves the bot won't take an order the kitchen can't fill.**
  A deterministic `hours-closed` case forces the "kitchen is closed" branch
  and verifies the bot refuses with a closed message, no cart, and no payment
  link. It runs automatically at onboarding, so an owner can trust — without
  any SprintAI employee checking — that the bot respects their hours.
- **Delivery is fail-closed.** A delivery address is accepted only as a
  positively-qualified, in-zone street match (Google `status=OK`,
  `partial_match !== true`, `location_type` ∈ {ROOFTOP,
  RANGE_INTERPOLATED}, distance ≤ `delivery_radius_mi`). Centroid-only,
  `ZERO_RESULTS`, and transient geocode failures refuse the address and offer
  pickup — the bot never guesses a delivery. A delivery-enabled shop without
  coordinates can't go live (`delivery_geo` gate); go-live backfills coords
  from the shop's own address.
- **Google Places is a real onboarding step.** When the shop's address is
  known, `onboarding-save` fires `google-places-lookup` to enrich the shop
  with authoritative `formatted_address`, hours, rating/review_count, and
  coordinates — idempotent and fire-and-forget.
- **Onboarding now produces a real Production Readiness run.** Saving a menu
  enqueues a `test_run_queue` row; a launchd worker drains it and runs the
  full generate → run → judge → scorecard → persist pipeline, so the owner's
  Store Readiness report is real and current without any SprintAI employee
  touching it. Menu cap raised 50 → 300 items.
- **At a Glance embeds a live test-chat sandbox.** The owner landing page
  shows the glance tiles plus a `ShopChatTest` panel forced into test mode —
  an owner fires practice orders with no real charge immediately.
- **Short branded payment links.** Checkout emits
  `https://pay.getsprintai.com/o/<code>` (35 chars) instead of the raw
  612-char Stripe URL, so the pay link is a single SMS segment and matches
  what the 10DLC campaign samples show carriers approved.

---

## What's next (near-term roadmap)

1. **Provision live numbers on Telnyx** — the campaign is already approved at
   TCR, so the remaining step is to provision shop numbers, attach them to
   per-shop messaging profiles, assign them to campaign `CSMB9HG`, and pass the
   real-handset delivery test (`sprintai-telnyx-provisioning-test.md`) before the
   first shop goes live. That test is the ground-truth gate: the campaign record
   still carries an 806 CTA rejection in `failureReasons` that may be stale, and
   message delivery is the only way to prove the campaign is actually clear.
2. **First real restaurant** — onboard one paying shop with their real menu,
   real Stripe, and real phone number. Validate the end-to-end in production
   with real customers.
3. **Stripe Connect OAuth secrets** — add the missing keys so Path A (existing
   Stripe merchants) works end-to-end.
4. **Multi-number scale** — the campaign is approved; provision numbers for
   multiple shops on Telnyx, one messaging profile per shop, all attached to
   campaign `CSMB9HG`.
5. **Order routing** — push orders to the restaurant via SMS notification,
   email ticket (Resend, already integrated), and eventually a kitchen display
   or POS integration (Toast API integration exists but is not live).

---

## Key decisions and why

**LLM over form-based ordering.** A form can't handle "I want the same thing as
last time but with extra pickles." An LLM can. The cost difference
(~$0.00006/conversation with DeepSeek Flash) is negligible relative to the
order value. The experience difference is night and day.

**SMS over voice.** Text is asynchronous (no hold times), works in noisy
environments, leaves a permanent record, and has none of the latency/latency
sensitivity problems of real-time audio. Also, TCPA compliance for text is
better-defined and easier to enforce structurally than for voice.

**Direct charges over destination charges.** The restaurant owns the customer
relationship with Stripe — they see the charge, they handle disputes, they own
payouts. Sprint keeps a flat $0.99. This is simpler to explain, simpler to
implement, and avoids the "why is SprintAI holding my money?" problem.

**Express accounts over Standard (for new restaurants).** Most independent
restaurants don't have a Stripe account. Express gives them embedded onboarding
with fewer steps. For those who do have Stripe, the OAuth path exists.

**Conversational admin over CRUD dashboard.** Menu management is a chore
restaurant owners hate. Talking to an AI in plain English is faster, requires
no training, and produces a log of every change. The AI proposes, the owner
confirms — the system never acts unilaterally.

**Automated quality monitoring (from day one).** The ordering bot is an LLM,
and LLMs make mistakes. Rather than wait for customer complaints, the system
judges every conversation automatically and surfaces issues before anyone
notices. This is the difference between "AI ordering" as a demo and as a
production system.
