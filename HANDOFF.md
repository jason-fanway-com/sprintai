# SprintAI — Handoff

Last updated: 2026-08-14

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

One service fee per order ($0.99). That's the business model. The codebase
is built from day one to self-serve thousands of restaurants — every onboarding
step, number provision, and menu import is automated.

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
│   │       └── judge-*.ts             # Evaluator rubric + notify + autofix
│   └── migrations/           # SQL migrations (001–053)
├── scripts/
│   ├── imsg-bridge.sh        # iMessage bridge (runs on the Mac)
│   ├── build-public-site.sh  # Allowlist build for public origin
│   └── check-issues.sh       # Issue monitoring helper
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
   053 (test-suite read RLS).
7. `docs/specs/menu-intake-standard.md` — canonical schema, QA validator (§A),
   double-extract fidelity check (§B), mandatory owner sign-off (§C).
   This is the contract every menu must satisfy before go-live.
8. `docs/specs/2026-08-12-prod-data-safety-and-njb-restore.md` — the 2026-08-09
   NJB menu-wipe incident and the non-destructive / isolation rules it spawned.
9. `docs/specs/2026-08-13-shop-conversation-test-suite.md` — the ~100-case
   per-shop acceptance suite (go-live gate + drift detection).
10. `admin-dashboard/src/lib/roles.ts` — role derivation from app_metadata
   (super_admin / shop_owner), route guards, shop-scoped dashboards.

---

## How data flows

```
CUSTOMER TEXTS "I want a dozen bagels"
 → iMessage bridge or Twilio webhook receives it
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
  sprintai-chat-admin`. The SPA uses `<BrowserRouter basename="/dashboard">`;
  `deploy-root/_redirects` has separate rewrites for `/admin/*` and `/dashboard/*`.
- **Edge functions**: `supabase functions deploy <name>`.
- **Commit format**: functional prefix (`feat:`, `fix:`, `docs:`, `chore:`).

---

## Environment variables

The authoritative list is `.env.example` in the repo root. Key groups:

- **OpenRouter**: `OPENROUTER_API_KEY` (with `ANTHROPIC_API_KEY` fallback)
- **Supabase**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
- **Stripe**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_TEST_*`
- **Twilio**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- **Resend**: `RESEND_API_KEY` (email receipts)
- **OpenAI**: `OPENAI_API_KEY` (embeddings for knowledge base)
- **Firecrawl**: `FIRECRAWL_API_KEY` (website scraping)
- **Anthropic**: `ANTHROPIC_API_KEY` (fallback)

Secrets live in Supabase/Netlify environment settings, never in code.

---

## Things that will surprise you

- **The admin dashboard is a separate Netlify site.** It's not in the public
  build. It deploys manually. The proxy in `netlify.toml` routes
  `getsprintai.com/admin` → `sprintai-chat-admin.netlify.app/admin`. The SPA
  uses `<BrowserRouter basename="/dashboard">`. The deploy-root `_redirects`
  now serves both `/admin/*` and `/dashboard/*` (internal SPA routes).
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
- **The ordering loop only returns when tools are done.** DeepSeek Flash can
  emit `tool_use` blocks and `stop_reason=end_turn` in the same turn (breakfast
  sandwiches). The loop now executes any pending tool calls before returning;
  if the model produces neither tools nor text it degrades to a soft cart
  read-back instead of the dead-end "I couldn't process that".
- **10DLC carrier rejection 806 drove the disclosure copy.** The homepage CTA
  and footer carry the exact message-frequency sentence ("typically 3-8
  messages per order") carriers require. Legal pages point at `getsprintai.com`;
  `getsprintai.net` is retired.

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
