# SprintAI — Handoff

Last updated: 2026-08-27

What an incoming engineer needs to understand this system and start contributing
within a day. Not a reference — a map.

---

## What SprintAI is

SprintAI replaces restaurant phone ordering with AI. A customer texts a
restaurant's phone number, an LLM handles the full ordering conversation
(menu, bundles, delivery address, checkout), and the order is charged via Stripe
Connect. No app download, no website — just text. There is also a web chat
fallback (PWA) and an AI-powered admin dashboard where shop owners manage menus
and delivery by talking to the system in plain English.

The business model is a flat $99/mo subscription plus a $0.99 service fee per
order (one offering, one price — no tiers). The codebase is built from day one
to self-serve thousands of restaurants — every onboarding step, number
provision, and menu import is automated.

---

## The big ideas

1. **LLM as state machine.** The ordering conversation is not a form wizard.
   It's an LLM with a system prompt, a tool loop (`submit_order`, `add_to_cart`,
   `show_menu`, etc.), and structured outputs. The conversation IS the UX.

2. **Conversational admin.** Shop owners don't click through CRUD forms. They
   tell the AI "make the poppy seed a dozen special for $14.99 on Saturdays" and
   the AI proposes a change. The owner confirms, it executes. Everything is
   undoable and audited.

3. **Automated quality monitoring.** `eval-sweep` (the "Conversation Judge") is
   an out-of-band worker that reads completed conversations, scores them against
   a rubric, and flags issues. It never touches the live order path. The
   `issue-detector` turns those flags into actionable alerts.

4. **Relentless automation.** Number provisioning, menu import, knowledge-base
   scraping, merchant onboarding wizard — all self-serve, no human-in-the-loop
   for routine operations. The North Star is thousands of restaurants with
   minimal manual intervention.

5. **Safety by construction.** The outbound guard is a structural chokepoint:
   every customer-facing message must pass through `guardedSend()` with a valid
   reason. Default is deny. There is no other door.

---

## Repository layout

```
sprintai-ordering/
├── admin-dashboard/          # React + Vite admin SPA (login-gated)
│   └── deploy-root/          # What gets deployed to sprintai-chat-admin
├── shop-chat/                # React + Vite PWA for customer web chat
├── supabase/
│   ├── config.toml           # Function JWT settings + project config
│   ├── functions/            # Edge functions (Deno, deployed to Supabase)
│   │   ├── chat-sms/         # Core ordering state machine
│   │   ├── admin-api/        # REST API for dashboard
│   │   ├── admin-chat/       # Conversational admin
│   │   ├── create-checkout/  # Stripe Checkout (direct charge)
│   │   ├── pay-redirect/     # Short-branded pay.getsprintai.com → Stripe 302 redirect
│   │   ├── stripe-webhook/   # Billing events → tenant lifecycle
│   │   ├── eval-sweep/       # Conversation quality judge
│   │   ├── issue-detector/   # Issue detection from evals
│   │   ├── onboard-tenant/   # Website scrape → knowledge base
│   │   ├── train-tenant/     # Text paste → knowledge base
│   │   ├── import-menu-csv/  # CSV menu importer
│   │   ├── connect-*/        # Stripe Connect onboarding
│   │   ├── go-live/          # All-or-nothing go-live gate
│   │   ├── provision-number/ # Auto-buy Twilio number
│   │   ├── merchant-auth/    # PIN auth for sold-out manager
│   │   ├── shop-financials/  # Shop financial reporting (KPIs, ledger, payouts)
│   │   └── _shared/          # Shared libraries
│   │       ├── outbound-guard.ts      # THE chokepoint — every send goes here
│   │       ├── connect.ts             # Stripe helpers + isShopLive() gate
│   │       ├── test-mode.ts           # Test key allowlist
│   │       ├── stripe-financials.ts   # Real Stripe fees + payout reconciliation
│   │       ├── telnyx-error.ts        # Classify Telnyx opt-out/blocked rejections
│   │       └── judge-*.ts             # Evaluator rubric + notify + autofix
│   └── migrations/           # SQL migrations (001–064)
├── scripts/
│   ├── imsg-bridge.sh        # iMessage bridge (runs on the Mac)
│   ├── build-public-site.sh  # Allowlist build for public origin
│   ├── check-issues.sh       # Issue monitoring helper
│   └── test-suite/           # Per-shop conversation QA suite
│       ├── run.ts            # CLI driver (generates, runs, judges, fixes, persists)
│       ├── generator.ts      # Auto-generates menu-derived cases per shop
│       ├── library.ts        # 15 conversational multi-turn + 16 adversarial cases
│       ├── runner.ts         # Web/simulated multi-turn driver with safety gate
│       ├── judge.ts          # Rubric judge — grades full transcripts
│       ├── scorecard.ts      # Aggregate scoring (≥95% pass, 100% critical)
│       ├── fix.ts            # LLM root-cause + proposed-fix generator for failures
│       ├── persist.ts        # Writes results to test_runs / test_case_results
│       ├── cart-ops.ts       # Shop-aware CartOps battery (100% gate, real menu)
│       ├── hours-closed.ts   # Deterministic closed-hours gate case
│       └── worker.ts         # launchd worker — drains test_run_queue (onboarding QA)
├── how-it-works.html         # Mobile sales explainer (signup→kit→2wk→pricing)
├── docs/demo/                # Erin (NJB) demo kit — 3-QR walkthrough email
├── netlify/
│   └── functions/            # Netlify serverless functions
│       └── stripe-webhook.js # B2B subscription checkout
├── public/                   # Built output (allowlist, gitignored)
├── netlify.toml              # Root site build + proxy rewrites
├── RUNBOOK.md                # Operational reference
├── BUSINESS.md               # Business context (this repo)
└── VERIFIED.md               # Stripe API verification notes
```

---

## Key files to read first

1. `supabase/functions/chat-sms/index.ts` — the core ordering bot. This is the
   system. System prompt builder, tool loop, bundle logic, checkout transition,
   transactional events. ~1200 lines.

2. `supabase/functions/_shared/outbound-guard.ts` — the safety chokepoint.
   Understand this before touching any send path.

3. `supabase/functions/admin-chat/index.ts` — the conversational admin model:
   LLM proposals, confirmation cards, undo.

4. `scripts/imsg-bridge.sh` — the iMessage bridge. Polls Messages.app, judges
   freshness, forwards to the edge function.

5. `netlify.toml` — build, publish, admin proxy. The topology document.

6. `supabase/migrations/` — skim 038 (tenant isolation), 039 (delivery flow),
   040 (test mode fixes), 041 (ops-table RLS lock), 042–045 (kitchen-ticket
   idempotency, order-number hardening, audit log, inbound dedup),
   046 (PII-table RLS forced + admin transcript INSERT gate),
   047/048 (issue-detector pg_cron schedule), 050 (7-column menu schema +
   owner sign-off), 051 (protected-shop guard), 052 (test suite results),
   053 (test-suite read RLS), 054/055 (case-fix tracking: proposed_fix,
   fix_status, root_cause), 056 (sms_opt_outs), 057–059 (onboarding fields:
   owner_name/onboarding_token/ein/is_test/crawl), 060–061 (delivery_hours +
   structured hours normalization), 062 (Google Places fields),
   063 (delivery radius + geo), 064 (test_run_queue for the onboarding worker).
7. `docs/specs/menu-intake-standard.md` — canonical schema, QA validator (§A),
   double-extract fidelity check (§B), mandatory owner sign-off (§C).
   This is the contract every menu must satisfy before go-live.
8. `docs/specs/2026-08-12-prod-data-safety-and-njb-restore.md` — the 2026-08-09
   NJB menu-wipe incident and the non-destructive / isolation rules it spawned.
9. `docs/specs/2026-08-13-shop-conversation-test-suite.md` — the ~100-case
   per-shop acceptance suite (go-live gate + drift detection).
10. `docs/specs/2026-08-16-multi-turn-conversational-cases.md` — the suite's
    conversational mode: 15 LLM-driven multi-turn cases per shop (realistic,
    messy exchanges) judged on the whole transcript, not a single exchange.
11. `admin-dashboard/src/lib/roles.ts` — role derivation from app_metadata
   (super_admin / shop_owner), route guards, shop-scoped dashboards.
12. `admin-dashboard/src/lib/useOwnerTenant.ts` — `useEffectiveTenant()` hook
    that every owner-facing page uses to self-scope to the correct tenant
    (owner's own, super-admin's preview, or null = global). This is the shared-
    dashboard design: one page serves both roles, scoping at query time.

---

## Short branded payment links

`checkout_order` in chat-sms creates a Stripe Checkout Session, then generates
an 8-char hex short code, inserts a row into `pay_links`
(`{cart_id, short_code, stripe_url}`), and emits
`https://pay.getsprintai.com/o/<code>` as the `checkoutUrl` instead of the raw
612-char Stripe URL. The `pay-redirect` edge function (public, no-JWT) looks up
the code and 302s to Stripe. The raw Stripe URL is stored in `pay_links` as a
fallback. The `/o/*` → function rewrite is in `netlify.toml`.

**Why:** (1) Raw Stripe URL = 4-5 SMS segments; branded link = 35 chars.
(2) The 10DLC campaign samples show `pay.getsprintai.com` — production traffic
must match what carriers approved. No public URL shorteners.

---

## How data flows

```
CUSTOMER TEXTS "I want a dozen bagels"
 → iMessage bridge or Telnyx webhook receives it
 → chat-sms edge function
   → loads shop config, menu, hours, knowledge base
   → builds system prompt with effective menu + ground truth
   → calls OpenRouter (DeepSeek Flash) with tool definitions
   → LLM returns structured tool calls or plain text
   → each tool call is validated, executed, guarded
   → send reply via SMS (through outbound-guard → Twilio or imsg)
 → conversation stored: messages + conversation row
 → when order placed: order_cart + cart_items created
 → checkout: create-checkout → Stripe Session → payment capture
 → post-order: stripe-webhook → invoice sent, eval-sweep judges it later
```

---

## The tool loop (chat-sms)

The LLM returns structured JSON. The system has these tools:

| Tool | Effect |
|------|--------|
| `show_menu` | Display menu — the LLM never hallucinates a menu item name |
| `add_to_cart` | Add items + modifiers to cart |
| `show_cart` | Read-back what's in the cart |
| `remove_from_cart` | Remove one item |
| `clear_cart` | Empty everything |
| `submit_order` | Finalize: capture customer name, delivery/pickup preference |
| `checkout_order` | Transition to payment — Stripe link (phantoms prevented) |
| `pass_to_human` | Escalate to shop owner |

Each tool call is validated server-side before execution. Menu lookups are
by ID, not name. Quantities are checked against daily limits and availability.
Pricing is server-authoritative — the LLM's calculation is verified.

---

## Bundles

The system supports a "dozen bagels" bundle: customer picks 12 bagels (with
flavor constraints), the system tracks progress, charges $19.99. The bundle
logic is embedded in the `add_to_cart` and `show_cart` tools.

---

## Deployment conventions

- **Public site**: `git push main` → Netlify auto-deploy. `build-public-site.sh`
  assembles the allowlist into `public/`.
- **Admin dashboard**: `npm run build` in `admin-dashboard/`, copy `dist/` to
  `deploy-root/admin/`, then `netlify deploy --dir deploy-root --site
  sprintai-chat-admin`. The SPA uses `<BrowserRouter basename="/admin">`
  (vite.config.ts `base: "/admin/"`); `deploy-root/_redirects` serves `/admin/*`
  → `/admin/index.html` (SPA fallback). Verified live 2026-08-19.
- **Edge functions**: `supabase functions deploy <name>`.
- **Commit format**: functional prefix (`feat:`, `fix:`, `docs:`, `chore:`).

---

## Environment variables

The authoritative list is `.env.example` in the repo root. Key groups:

- **OpenRouter**: `OPENROUTER_API_KEY` (with `ANTHROPIC_API_KEY` fallback)
- **Supabase**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
- **Stripe**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_TEST_*`
- **Telnyx (live SMS provider)**: `TELNYX_API_KEY`
- **Twilio (deprecated)**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- **Resend**: `RESEND_API_KEY` (email receipts)
- **OpenAI**: `OPENAI_API_KEY` (embeddings for knowledge base)
- **Firecrawl**: `FIRECRAWL_API_KEY` (website scraping)
- **Anthropic**: `ANTHROPIC_API_KEY` (fallback)

Secrets live in Supabase/Netlify environment settings, never in code.

---

## Segment economics are structural, not aspirational

The business model assumes 8 SMS segments/order. Above ~8.8, the $0.99 service
fee doesn't cover SMS cost. Real conversations measured 14-16 segments before the
reductions shipped 2026-08-22. Every chat-sms prompt change or reply format
decision is a segment-cost decision. Measure with:
```bash
deno run --allow-net --allow-env scripts/test-suite/segment-count.ts --live <shop_id>
```
See `BUILD-NOTES-payment-links-compliance-segments.md` for the full breakdown.

---

## Things that will surprise you

- **The admin dashboard is a separate Netlify site.** It's not in the public
  build. It deploys manually. The proxy in `netlify.toml` routes
  `getsprintai.com/admin` → `sprintai-chat-admin.netlify.app/admin`. The SPA
  uses `<BrowserRouter basename="/admin">` (vite.config.ts `base: "/admin/"`);
  `deploy-root/_redirects` serves `/admin/*` → `/admin/index.html` (SPA fallback).
- **Role-gating is in the JWT.** Users have `role` (super_admin / shop_owner)
  and `tenant_id` in `app_metadata`. The frontend (`roles.ts`, `RoleContext`)
  reads these and guards routes. Shop owners see only their shop, super_admins
  see everything. Legacy `is_admin` in `user_metadata` is a fallback.

- **The iMessage bridge is a bash script running on a Mac.** It polls
  Messages.app via AppleScript. It's the only non-cloud piece of infrastructure.
  If the Mac is down, SMS still routes through Twilio but the primary number
  (+14842018054) stops working.

- **verify_jwt is set per-function in `supabase/config.toml`**, not in the
  function code. If you change a function's auth model, change the config file.

- **The LLM never creates a menu item.** The menu is imported via PDF/photo
  (`parse-menu-pdf`) or CSV (`import-menu-csv`), scraped from a website
  (`onboard-tenant`), or managed conversationally (`admin-chat`). The ordering
  bot only reads it. Every menu is validated against the Menu Intake Standard
  (`docs/specs/menu-intake-standard.md`) and requires owner sign-off before
  go-live — Sprint never guesses a price.
- **Menu intake was destructive by design — now guarded.** `parse-menu-pdf`
  historically hard-deleted a shop's menus/items before inserting the new
  parse, with no transaction and no empty-result check. This wiped NJB's real
  menu in a 2026-08-09 test run. Prevention: `parse-menu-pdf` is being made
  non-destructive (transaction, verify item count > 0, soft-archive), and
  migration 051 blocks menu deletes for `protected` shops at the DB layer.
  See `docs/specs/2026-08-12-prod-data-safety-and-njb-restore.md`.

- **Test mode is real.** When `test_mode=true` on a shop, all charges route to
  Stripe test keys. The test-mode gate (`_shared/test-mode.ts`) allowlists only
  `sk_test_` / `rk_test_` prefixes — a live key will be rejected, not silently
  used.

- **eval-sweep is completely out-of-band.** It never runs inline during
  ordering. Crash it, kill it, deploy it wrong — the ordering bot is unaffected.
  They share zero code paths and zero table writes.
- **eval-sweep DMs but does not mark notified.** `eval-sweep` sends the digest
  for newly-flagged evals but deliberately does NOT set `notified_at`. The
  `issue-detector` is the single actioner: it creates the tracked issue row,
  then sets `notified_at`. If a flagged eval has `notified_at` set, it has a
  corresponding `issues` row — invariant, not convention.
- **Pickup-only is NOT a delivery pause.** A shop with `delivery_enabled=false`
  is permanently pickup-only. It is not "paused right now" and must not trigger
  the pickup-only pause message on every greeting (that bug blocked all
  pickup-only shops from taking orders). Only a future `delivery_paused_until`
  triggers the temporary pause message.
- **The ordering bot now answers direct customer questions regardless of context.**
  If a customer asks "do you have gluten-free bagels?" while also declining to
  order more, the bot answers the question before advancing. Questions mixed with
  declines or order-completion signals are still answered. Category-level
  declines (e.g. "do you have coffee?" when the shop doesn't carry it) get a
  clean "we don't carry that" response. Repeated questions still get a fresh
  answer — the bot never ignores a customer question to push the order forward.
- **The At a Glance dashboard ships real business data.** Owner landing page
  shows today's revenue, a Store Health ring (blend of checkout completion,
  conversation quality, store readiness), KPI row with prior-period deltas,
  revenue tiles across time ranges, top sellers vs no-sales items, and the last
  5 conversations — all tenant-scoped via `useEffectiveTenant()`.
- **Financial Reporting is live for shop owners.** The full shop-financials
  page (ledger with real Stripe fees, KPIs, revenue chart, payout
  reconciliation, QuickBooks CSV export) renders owner-scoped at
  `/financial-reporting` without code duplication — the same page component
  serves both super-admin (`/shop/:id/financials`) and owner views.
- **The word "cancel" is banned from all system prompts and bot replies.**
  CANCEL is a registered 10DLC opt-out keyword enforced by Telnyx at platform
  level — a customer typing it alone opts them out of the entire program.
  SprintAI cannot intercept it. At every abandon-or-modify point, the bot offers
  CHANGE or RESTART. The checkout restart regex no longer includes CANCEL.
- **Compliance disclosure is code-driven, not prompt-driven.** The first-contact
  footer ("Msg & data rates may apply...") now appears ONLY on the lifetime first
  contact per (consumer, shop) pair — keyed on `conversations`, not session
  expiry. On every subsequent reply it's stripped by regex (~183 chars saved per
  reply on return sessions).
- **`sms_opt_outs` table** durably records per-(phone, tenant) opt-out state.
  `upsertOptOut()` is called from all STOP/START handlers and the Telnyx
  send-rejection path. Telnyx is the authoritative enforcer; this is the
  application-level record. START clears `opted_back_at` without deleting the row.
- **EIN is a hard gate.** SprintAI does not sell to sole proprietors. A merchant
  without an EIN fails out of signup cleanly — no alternate path. Permanent
  decision by Jason.
- **Telnyx brand/campaign is frozen** until the solutions engineer call resolves
  ISV mechanics. Brand BJ8MUGY verified; campaign CSMB9HG is TCR_ACCEPTED with
  all 7 carriers reporting APPROVED, but `failureReasons` still carries the 806
  CTA rejection and `isTMobileRegistered` reads false — unresolved until the
  delivery test proves whether 806 is stale. Do not modify the campaign.
  Each merchant will ultimately need its own brand + campaign (registry policy).
- **First delivery test is a hard go-live gate.** Before any shop goes live, the
  Telnyx provisioning + delivery test (`sprintai-telnyx-provisioning-test.md`,
  8-step real-handset script) must pass — it is the ground-truth check that the
  campaign actually delivers, since the API's 806 `failureReasons` flag may be a
  stale historical field rather than a live rejection.
- **Owner detail pages show real not-found states**
  ConversationDetail, IssueDetail, and ShopChatDetail now render a clear
  "not found — may belong to another account" message instead of a white
  shell when an RLS-blocked record is accessed. `.single()` → `.maybeSingle()`
  to prevent zero-row error objects.
- **The ordering loop only returns when tools are done.** DeepSeek Flash can
  emit `tool_use` blocks and `stop_reason=end_turn` in the same turn. The loop
  executes any pending tool calls before returning; if nothing is produced it
  degrades to a soft cart read-back.
- **10DLC carrier rejection 806 drove the disclosure copy.** The homepage CTA
  and footer carry the exact message-frequency sentence carriers require. Legal
  pages point at `getsprintai.com`; `getsprintai.net` is retired.
- **SMS now runs on Telnyx, not Twilio.** Twilio's business-profile verification
  rejected the LLC EIN four times (error 18602). The 10DLC campaign is approved
  on Telnyx (brand `BJ8MUGY`, campaign `CSMB9HG`) by all seven carriers. `chat-sms`
  parses Telnyx inbound JSON, sends outbound via the Telnyx Messages API (still
  through `guardedSend`), handles DLRs, and implements STOP/HELP/START with the
  exact registered strings. Provider is chosen by `resolveSmsProvider()` — Telnyx
  when `TELNYX_API_KEY` is set, Twilio behind it for rollback. See
  `docs/telnyx-integration-runbook.md` and `docs/10dlc-compliance-obligations.md`.
- **One offering, one price.** SprintAI sells a single $99/mo order-by-text plan
  plus the $0.99/order fee. The legacy 3-tier "SprintAI Chat" pricing
  ($99/$247/$497) and the HVAC/chat-product surfaces are purged from the public
  site and checkout.
- **The QA suite is now multi-turn with inline fix tracking.** The per-shop
  acceptance suite added 15 conversational cases: an LLM customer-simulator plays
  a persona across up to 6 turns on one `session_id`, and the Judge grades the
  whole transcript — catching drift, loops, and lost context that scripted
  single-turn cases can't. The admin dashboard drills down: run → case →
  transcript + judge findings + root cause + proposed fix, with fix_status
  (open/proposed/fixed/harness/test-data/wontfix). An LLM fix script
  (`scripts/test-suite/fix.ts`) auto-generates root-cause analysis for every
  failing case. The admin nav labels the page "Production Readiness". See
  `docs/specs/2026-08-16-multi-turn-conversational-cases.md`.
- **The order-taker got sharper.** Modifier price changes (e.g. "add cheese
  +$1") now actually add to the cart item price (was silently dropped — a money
  bug). A multi-item message with one off-menu item now adds the valid items
  instead of rejecting the whole message (partial acceptance). Ordering a plain
  bagel by exact name no longer triggers a cream-cheese upsell; combo items like
  "Bagel with Jelly" at $0.75 are recognized as complete standalone items at
  their listed price — the bot never asks for a base bagel flavor. The bot
  quotes the menu's exact item names and units; the prompt enforces item-name
  precedence: the AVAILABLE MENU is authoritative over SPECIAL INSTRUCTIONS.
  The checkout flow now explicitly states the fee-inclusive total from the
  authoritative `order_carts.total_cents` (incl. $0.99 service fee, delivery,
  tip) — disclosure is code-driven, not model-hoped.
- **Deterministic grounding guards are live.** Four code-path intercepts in
  `chat-sms` prevent LLM hallucination: (1) off-menu portion/container words
  ("tub", "pint") not in the shop's menu vocabulary are suppressed,
  (2) claims an item is in the cart when the authoritative cart row disagrees
  (including empty-cart assertions) are blocked, (3) "added X to your cart"
  claims when the cart didn't actually mutate this turn are caught, and
  (4) a cart cannot be saved with `phase=checkout` unless a Stripe checkout
  session already exists — downgraded to `review` if not. These are code-path
  intercepts, not prompt preferences — they fire regardless of what the LLM
  intended.
- **CartOps integrity — `cart_json` is the single source of truth.** A bare
  tip reply never mutates items (the LLM spuriously calling `add_item` on a
  tip turn was the bug); quantity corrections ("just one") write back to
  `cart_json` and persist BEFORE any reply; every quoted total is computed from
  `cart_json` (subtotal + $0.99 fee + delivery + tip). The invariant
  `quoted_total == charged_total == sum(cart_json) + fees` holds — no path lets
  an LLM-supplied number reach Stripe. Backed by an adversarial CartOps battery
  (`scripts/test-suite/cart-ops.ts`) that runs per shop at 100%. The battery
  is shop-aware — cases are built from the shop's real menu items — and total
  checks use an `expectedItemCents` override so they're deterministic, not
  judge arithmetic.
- **The closed-hours gate is deterministically tested.** `chat-sms` accepts a
  gated `test_hours=open|closed` param (never honored on live keys) that
  forces the closed branch via `effectiveOpen`; the suite's `hours-closed`
  critical case verifies the bot refuses with a "kitchen is closed" message,
  no cart, no payment link — proving per shop that the bot never takes an
  order the kitchen can't fulfill.
- **Delivery zone is fail-closed.** A delivery address is accepted only as a
  positively-qualified, in-zone street match (`status=OK`, `partial_match !==
  true`, `location_type` ∈ {ROOFTOP, RANGE_INTERPOLATED}, distance ≤
  `delivery_radius_mi`). Centroid-only (`APPROXIMATE`/`GEOMETRIC_CENTER`),
  `ZERO_RESULTS`, non-OK, and transient geocode failures (one retry) all refuse
  the address and offer pickup — never a guessed delivery. A delivery-enabled
  shop without coordinates can't go live (`delivery_geo` gate); go-live
  backfills coords from the shop's own address so the gate is enforceable.
- **Onboarding now creates a real Production Readiness run.** Saving a menu at
  onboarding enqueues a `test_run_queue` row; a launchd worker
  (`scripts/test-suite/worker.ts`) drains it and runs the full generate → run →
  judge → scorecard → persist pipeline, writing a real `test_runs` row +
  `test_case_results` the owner sees in Production Readiness. Fire-and-forget
  from setup.html — a failure never blocks menu save. `run-worker.sh` sources
  `~/.openclaw/.secrets` first (launchd doesn't inherit shell env).
- **Google Places is a real onboarding step.** `onboarding-save` fires
  `google-places-lookup` when the shop's address is known (not at create, when
  only the name existed) and `google_place_id` is still null — idempotent,
  fire-and-forget. Places enriches the shop with authoritative
  `formatted_address`, hours, rating/review_count, and `latitude`/`longitude`
  (the coords the delivery zone depends on).
- **At a Glance embeds a live test-chat sandbox.** The owner landing page shows
  glance tiles on the left ~2/3 and a `ShopChatTest` panel on the right ~1/3,
  forced into test mode (`forceTest`) — an owner fires practice orders with no
  real charge immediately. Same component, embedded; no new chat widget.
- **The Judge rubric is sharper with fewer false flags.** `wrong_total` fires
  only when the assistant explicitly states a dollar total. `invented_item` is
  narrowly scoped to items genuinely absent from the menu, its descriptions,
  AND modifiers — clarifying questions, real modifiers, and descriptive
  ingredients are never flagged. The Judge evaluates only assistant messages;
  customer prompt-injection attempts are never flagged as assistant failures.
  The menu-ground-truth format (`JudgeGroundTruth.menu`) now carries
  `description` and `modifiers` fields so the Judge can accurately distinguish
  off-menu items from real add-ons — and the `$0.99` service fee is incorporated
  into total-price comparison so legit orders don't false-flag.
- **The admin dashboard is now shared, not admin-only.** Shop owners get their
  own nav sidebar (At a Glance, Conversations, Quality, Production Readiness,
  Issues, Chat with your shop, Financial Reporting) — the same pages super-
  admins use, but tenant-scoped via `useEffectiveTenant()`. A shop owner can
  see their own conversation quality, run their own test suite, and track their
  own issues without SprintAI involvement. This is the self-serve dashboard: an
  owner doesn't need to ask a SprintAI employee what their store's readiness
  score is — they check it themselves. The Admin⇄Owner toggle lets super-admins
  preview any shop's owner perspective for demos and support.

---

## Quickstart for development

```bash
# Clone
git clone git@github.com:jason-fanway-com/sprintai.git sprintai-ordering
cd sprintai-ordering

# Install root deps (for Netlify functions)
npm install

# Admin dashboard
cd admin-dashboard && npm install && npm run dev

# Shop chat PWA
cd shop-chat && npm install && npm run dev

# Edge functions — needs Supabase CLI + local project linked
supabase link --project-ref sprintai-chat
supabase functions serve  # local dev server

# Run a single function locally
supabase functions serve chat-sms
```

---

## Who to ask

- **Jason** — business decisions, Stripe dashboard access, Twilio console,
  A2P campaign management, secrets, customer relationships.
- **RUNBOOK.md** — how to deploy, troubleshoot, recover.
- **This file** — system mental model and conventions.
