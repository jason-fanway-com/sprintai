# SprintAI — Business

Last updated: 2026-08-10

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
| Restaurant subscription | $99/mo (starter), $247/mo (pro), $497/mo (enterprise) |

The $0.99 is applied as a Stripe application fee on every order's direct charge.
It is never shown as a line item to the diner (disclosed in the checkout
transition message). The subscription is billed separately via Stripe Billing →
`stripe-webhook` Netlify function.

At 10 orders/day per restaurant, a shop generates ~$300/mo in service fees +
$99–497/mo subscription. At 1,000 restaurants averaging 15 orders/day: ~$450K/mo
in service fees + $150K–$500K/mo subscription. The model works at scale.

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
   provisioning make this possible.

3. **AI-native, not AI-wrapped.** The ordering flow is an LLM conversation by
   design, not a form with an AI layer on top. The admin experience is
   conversational by design, not a CRUD dashboard with a chatbot on the side.
   The quality monitoring (eval-sweep) is AI-native: an LLM judges every
   conversation automatically.

4. **Safety by construction, not convention.** The outbound guard is a
   structural chokepoint — every customer-facing message must pass through a
   single function with a typed reason. There is no other send path. Default
   is deny.

5. **Build for scale from day one.** Tenant isolation is absolute (RLS, not
   application-level filtering). Every onboarding step is automated. Every
   change that requires per-restaurant manual intervention is flagged as debt.

---

## Current state (August 2026)

- **MVP is live** with one test shop. The ordering flow works end-to-end:
  customer texts → AI conversation → cart → Stripe checkout → receipt.
- **A2P/10DLC:** Sole Prop brand is approved but capped at one phone number.
  Standard brand (LLC) registration is in progress, blocked on IRS EIN
  propagation. This is the critical path to scaling beyond a handful of shops.
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

---

## What's next (near-term roadmap)

1. **A2P Standard brand** — unblock scaling. The moment the EIN propagates,
   register the brand, replicate to carriers, activate the campaign.
2. **First real restaurant** — onboard one paying shop with their real menu,
   real Stripe, and real phone number. Validate the end-to-end in production
   with real customers.
3. **Stripe Connect OAuth secrets** — add the missing keys so Path A (existing
   Stripe merchants) works end-to-end.
4. **Multi-number scale** — once the Standard brand is approved, provision
   numbers for multiple shops from the Messaging Service pool.
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
