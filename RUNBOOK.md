# SprintAI — Runbook

Last updated: 2026-08-20

This is the operational manual for the SprintAI ordering system. It is the
canonical source of truth for how the system deploys, runs, and recovers. If
anything here disagrees with the code, the code wins — and fix this document.

---

## System overview

SprintAI replaces a restaurant's phone ordering: customers text a shop's number,
an LLM handles the conversation (menu, bundles, delivery, checkout), and the
order is charged via Stripe Connect. A web chat PWA exists as a secondary
channel. Shop owners manage menus and delivery via an AI-powered admin dashboard.

The stack is Supabase (Postgres + Edge Functions) + Netlify (hosting + proxy) +
Telnyx (SMS + 10DLC) + iMessage bridge (Mac). LLM calls go through OpenRouter.
Twilio is deprecated — see "SMS / Telnyx" below.

---

## Architecture & topology

```
Customer SMS → Telnyx → webhook → chat-sms edge function
                                      ↕
Customer web → PWA (shop-chat) → chat-sms edge function
                                      ↕
                              Supabase Postgres
                                      ↕
Shop owner → admin dashboard → admin-chat / admin-api edge functions
                                      ↕
                              Stripe Connect (direct charges)
```

### The public site and the admin dashboard are SEPARATE

| Surface | Netlify site | Hostname | Content |
|---------|-------------|----------|---------|
| Public + shop chat | `sprintai-dev` | `getsprintai.com` | Marketing pages, `public/chat/` (shop-chat PWA) |
| Admin dashboard | `sprintai-chat-admin` | `getsprintai.com/admin` | Login-gated admin SPA |

- The `sprintai-dev` site is git auto-deploy from `main` (build: `npm install && bash scripts/build-public-site.sh`, publish: `public/`).
- The admin site is **manual deploy** — see "Admin dashboard deploy" below.
- The `/admin` and `/admin/*` routes on `getsprintai.com` are Netlify proxy rewrites to `sprintai-chat-admin.netlify.app/admin` — the admin source NEVER reaches the root origin.
- The admin SPA uses `base: "/admin/"` (vite.config.ts) and `<BrowserRouter basename="/admin">` (src/main.tsx). The deploy-root `_redirects` serves `/admin/*` → `/admin/index.html` (SPA fallback; real asset files served first). Verified live 2026-08-19.

### Supabase project

| Key | Value |
|-----|-------|
| Project ID | `sprintai-chat` |
| Functions | `supabase/functions/` (Deno) |
| Migrations | `supabase/migrations/` (001–055) |

---

## Deployment

### Public site (auto-deploy)

Push to `main` on `jason-fanway-com/sprintai`. Netlify auto-builds and publishes
`./public`. Build command and publish dir are in `netlify.toml`.

The public site is an **explicit allowlist** — `build-public-site.sh` copies
only marketing pages (`index.html`, `contact.html`, etc.) and the shop-chat PWA
build (`shop-chat/dist/` → `public/chat/`). Nothing from `supabase/`,
`admin-dashboard/`, `_proof/`, or `specs/` reaches the public origin.

**To deploy the public site:** push to `main`. Done.

### Admin dashboard (manual deploy)

The admin dashboard serves both super-admins (global operator view) and shop
owners (tenant-scoped self-serve view). Shared pages (Conversations, Quality,
Production Readiness, Issues, Shop Chat, Financial Reporting, At a Glance)
self-scope via `useEffectiveTenant()` — super-admins see all, shop owners see
only their own. **At a Glance** is the owner's landing page: today's revenue,
Store Health ring (checkout completion × conversation quality × store readiness),
KPI row with prior-period deltas, revenue tiles across time ranges, top sellers
vs no-sales items, last 5 conversations — all tenant-scoped.

```bash
cd admin-dashboard
npm run build
# Vite outputs to dist/ (base="/admin/")
# Sync dist into deploy-root/admin/ (the proxy route at getsprintai.com/admin)
rm -rf deploy-root/admin/assets && cp -r dist/. deploy-root/admin/
# Deploy to the SEPARATE site. NOTE: --site by NAME fails ("Not Found");
# use the site ID e757a50b-e321-400a-91e2-7854e2b0eca0.
netlify deploy --dir admin-dashboard/deploy-root --site e757a50b-e321-400a-91e2-7854e2b0eca0 --prod
```

After deploy, verify the FRONT DOOR (not the origin) serves the new JS hash:
`curl -s https://getsprintai.com/admin/ | grep -o 'assets/index-[^"]*\.js'`
should match the hash in `admin-dashboard/dist/index.html`.

The live SPA is at `getsprintai.com/admin`; Vite `base` and `<BrowserRouter
basename>` are BOTH `/admin/`. `deploy-root/_redirects` rewrites `/admin/*` →
`/admin/index.html` (SPA fallback; Netlify serves real asset files first).

### Supabase edge functions

```bash
# Deploy a single function:
supabase functions deploy <name>
# Deploy all:
supabase functions deploy
```

Functions that need `verify_jwt = false` have it in `supabase/config.toml`.
New functions: add the entry before deploying.

---

## Services & integrations

### SMS / Telnyx (live) — Twilio deprecated

SprintAI sends and receives SMS through **Telnyx**, not Twilio. Twilio's
business-profile verification repeatedly rejected the LLC EIN (error 18602)
and is abandoned as a provider; the same EIN verifies cleanly through Telnyx.

- **10DLC registration: APPROVED** by all seven carriers (AT&T, T-Mobile,
  Verizon, US Cellular, Interop, ClearSky, Liberty). Brand `BJ8MUGY`
  (SprintAI LLC), campaign `CSMB9HG` / Telnyx `4b30019f-fc16-9471-9d17-5533e185444c`.
- **Provider switch:** `resolveSmsProvider()` in `chat-sms` returns `telnyx`
  when `TELNYX_API_KEY` is set, else `twilio` (kept for rollback).
  Reply-to-inbound always mirrors the provider the inbound arrived on.
- **Inbound:** Telnyx messaging-profile webhook POSTs JSON
  (`data.event_type` = `message.received`) → `chat-sms`. DLR events
  (`message.sent` / `message.finalized`) are acknowledged and ignored.
- **Outbound:** `POST https://api.telnyx.com/v2/messages` (Bearer
  `TELNYX_API_KEY`), `{from, to, text}`, wrapped in `guardedSend` — the
  outbound guard is never bypassed.
- **Opt-out:** Telnyx enforces STOP/block at the messaging-profile level. A
  blocked outbound send is classified by `_shared/telnyx-error.ts`, persisted
  as opt-out, logged, and the handler returns cleanly (no crash / retry loop).
- **One messaging profile per shop** is the intended architecture (STOP scoped
  per shop, not globally). All numbers attach to campaign `CSMB9HG`.
- The iMessage bridge on the Mac also handles inbound SMS → `chat-sms` for the
  primary number (`+14842018054`).

Twilio numbers (`+16109366213`, `+16103792553` via Messaging Service
`MG76067b4fbbb54eb914c3087f559c2f8b`) are legacy; provisioning now runs on
Telnyx. See `docs/telnyx-integration-runbook.md` (wiring) and
`docs/10dlc-compliance-obligations.md` (binding behaviour — treat as law).

### iMessage bridge

Location: `scripts/imsg-bridge.sh`  
Runs on the Mac via launchd: `~/Library/LaunchAgents/com.sprintai.imsg-bridge.plist`

The bridge polls Messages.app for incoming SMS destined for `+14842018054`,
forwards them to the `chat-sms` edge function, and sends the LLM reply back via
`imsg send`. It enforces a 15-minute message age freshness gate and tracks
processed message IDs to prevent replay.

Logs: `/tmp/sprintai-imsg-bridge.log`
PID file: `/tmp/sprintai-imsg-bridge.pid`
Processed IDs: `~/.sprintai-bridge/processed-ids.txt`

### Payments (Stripe Connect)

Model: **Direct charges** on the restaurant's connected account. Sprint takes a
flat $0.99 application fee per order. The restaurant bears Stripe processing fees.

Connect paths:
- **Path A (Standard)**: Existing Stripe merchant connects via OAuth (`connect-oauth` edge function)
- **Path B (Express)**: New-to-Stripe restaurant gets embedded onboarding via `connect-create-express`

Pre-go-live gate: `isShopLive()` — requires `charges_enabled=true`,
`payouts_enabled=true`, `connect_status='enabled'`, `connected_account_id` set.

Edge functions involved: `create-checkout`, `stripe-webhook`, `refund-order`,
`connect-create-express`, `connect-oauth`, `go-live`.

Netlify also hosts `stripe-webhook.js` for B2B subscription checkout (tenant
billing, separate from order checkout).

### LLM (OpenRouter)

Model: `deepseek/deepseek-v4-flash` for chat-sms (configurable via env).
API key: `OPENROUTER_API_KEY` with `ANTHROPIC_API_KEY` fallback.

Models per function:
- `chat-sms`: `CHAT_MODEL` env (default flash)
- `admin-chat`: `CHAT_MODEL` env (same)
- `eval-sweep`: `JUDGE_MODEL` env (default flash)

### Scheduled jobs

| Function | Schedule | Purpose |
|----------|----------|---------|
| `eval-sweep` | Every 5 min (cron) | Judge completed conversations; write eval scores |
| `issue-detector` | Every 10 min (pg_cron, 047/048) | Detect quality issues from evals; write to issues table; set notified_at on source evals |
| `daily-reset` | Daily | Clear expired specials, delivery pauses; audit log |

**NOTIFIED_AT contract:** `eval-sweep` DMs flagged evals but does NOT set
`notified_at`. The `issue-detector` is the single actioner — it creates a tracked
issue row, then sets `notified_at`. This ensures zero flagged evals marked
notified without a corresponding issue.

---

## Edge function index

### Customer-facing (live order path)
| Function | Purpose | JWT |
|----------|---------|-----|
| `chat-sms` | Core ordering state machine (SMS + web chat) | No |
| `create-checkout` | Stripe Checkout Session (direct charge) | No |

### Admin / shop owner
| Function | Purpose | JWT |
|----------|---------|-----|
| `admin-api` | REST API for admin dashboard (CRUD) | Yes |
| `admin-chat` | Conversational AI admin (menu mgmt, delivery) | Yes |
| `onboarding-save` | Wizard step persistence (create shop, save step) | No |
| `go-live` | All-or-nothing go-live gate check | No |
| `merchant-auth` | Server-side PIN auth for sold-out manager | No |
| `set-app-metadata` | Set user roles in app_metadata (service-key only) | No |
| `shop-financials` | Shop financial reporting (KPIs, ledger, payouts, CSV export) | Yes |

### Payments
| Function | Purpose | JWT |
|----------|---------|-----|
| `stripe-webhook` | Stripe billing events → tenant lifecycle | No |
| `refund-order` | Refund order with fee logic | No |
| `connect-create-express` | Create Express connected account + onboarding session | No |
| `connect-oauth` | OAuth for existing Standard accounts | No |

### Onboarding & training
| Function | Purpose | JWT |
|----------|---------|-----|
| `onboard-tenant` | Scrape website, chunk, embed → knowledge base | No |
| `train-tenant` | Text paste / document upload → embed | No |
| `scrape-shop` | Firecrawl + Claude summary → shop_context | No |
| `import-menu-csv` | CSV menu importer (idempotent, diff-based) | No |
| `parse-menu-pdf` | PDF/photo menu intake — multi-pass, triple-extract consensus, Opus model, 7-column canonical output | No |

### Operations & maintenance
| Function | Purpose | JWT |
|----------|---------|-----|
| `provision-number` | Auto-buy Twilio number for new shop | No |
| `toast-order` | Toast POS menu fetch + order placement | No |
| `daily-reset` | Clear expired specials + delivery pauses | No |
| `test-parse-judge` | Judge parser robustness test (script, not deployed) | N/A |

### Quality & monitoring
| Function | Purpose | JWT |
|----------|---------|-----|
| `eval-sweep` | Conversation Judge — automated quality scoring | No |
| `issue-detector` | Issue detection from evals (3 severity tiers) | No |

### Shared libraries (`_shared/`)
| File | Purpose |
|------|---------|
| `outbound-guard.ts` | Structural chokepoint — all customer-facing sends route here |
| `telnyx-error.ts` | Classifies Telnyx outbound rejections (opt-out/blocked) for graceful handling |
| `connect.ts` | Stripe Connect helpers, `isShopLive()` gate, service fee constant |
| `test-mode.ts` | Test-mode Stripe key resolution with allowlist gate |
| `stripe-financials.ts` | Real Stripe fee lookup + payout reconciliation for financials |
| `judge-rubric.ts` | Conversation Judge rubric (single source of truth) |
| `judge-notify.ts` | Judge digest → Telegram notification |
| `judge-autofix.ts` | Auto-fix seam (OFF by default) |

---

## Database

Single Postgres database with tenant isolation enforced by RLS policies.

Key tables: `tenants`, `shops`, `menu_items`, `option_groups`, `option_choices`,
`order_carts`, `cart_items`, `messages`, `conversations`, `conversation_evals`,
`knowledge_base`, `availability_overrides`, `admin_action_log`, `issues`,
`resolution_log`, `sprintai_clients`, `ticket_send_log`, `outbound_queue`,
`number_provision_log`.

Migrations are in `supabase/migrations/` (001–055). Migration `039` added the
delivery flow (order_type, delivery_address, driver_tip). Migration `038` removed
user-metadata-based RLS policies, replaced with `app_metadata`-based policies
via the `set-app-metadata` edge function. Migration `041` locked ops tables
(outbound_queue, number_provision_log) behind service-role-only RLS (PII was
anon-readable). Migrations `042–045` added kitchen-ticket idempotency, order-
number assignment hardening, per-send audit logging, and inbound message_sid
dedup. Migration `046` hardened PII-table RLS — forced RLS on outbound_queue + 
number_provision_log, and gated admin_chat_transcripts INSERT to super_admin only.
Migration `047/048` schedules the issue-detector via pg_cron (every 10 min).
Migration `050` adds the 7-column canonical menu schema (prompt_for, upsell,
row_type, content_hash, open_questions, validation, owner sign-off). Migration
`051` adds protected-shop guard (DB-level trigger blocks menu deletes for
real/demo shops). Migration `052` adds test_runs + test_case_results tables
for the shop conversation test suite. Migration `053` adds read policies
(super_admin full / shop_owner own-tenant SELECT) so the QA suite is visible
in the admin dashboard with tenant isolation preserved. Migrations `054`/`055` add case-fix tracking to the QA suite: `proposed_fix`,
`fix_status` (default `open`), and `root_cause` columns on `test_case_results`.
A `scripts/test-suite/fix.ts` script auto-generates root-cause + proposed-fix via
LLM for every failing case; the admin dashboard shows these inline alongside
transcript + judge findings (two-level drill-down: run → case → detail).

### RLS model

- User roles: `super_admin`, `shop_owner` in `auth.users.app_metadata.role`.
  Legacy `is_admin` in `user_metadata` accepted as super_admin fallback.
- `tenant_id` in `app_metadata` scopes shop_owner access to their shop only.
- Policies read `auth.jwt() → app_metadata` — client-cannot-edit.
- Service-role key bypasses RLS for edge functions that need cross-tenant access.

---

## Security invariants

1. **Outbound guard**: ALL customer-facing sends go through `guardedSend()` in
   `_shared/outbound-guard.ts`. Only three reasons allowed: `inbound_reply`,
   `payment_confirmed`, `order_refunded`. Default-deny — anything else is logged
   CRITICAL and dropped.

2. **Tenant isolation**: Every query scopes by `tenant_id`. Cross-tenant data
   leak is a catastrophic failure. RLS enforces this at the DB level.

3. **Test-mode gate**: `_shared/test-mode.ts` allowlists only `sk_test_` /
   `rk_test_` prefixes. A live key in test mode is rejected.

4. **Phantom-link guard**: Payment links can only be sent on a paid cart — the
   guard checks `cart.status === 'paid'` and `cart.stripe_payment_id` exists.

5. **Inbound message dedup**: Inbound SMS/webchat messages carry a `message_sid`
   that is uniqued in Postgres (partial unique index, 045). Duplicate webhook
   deliveries or Twilio retransmits hit a constraint violation and are silently
   skipped — preventing double-orders from replayed messages.

6. **Kitchen ticket idempotency**: `ticket_emailed_at` on `order_carts` is
   claimed via atomic conditional UPDATE (`WHERE ticket_emailed_at IS NULL`)
   before sending. Only one caller wins; duplicate `payment_confirmed` events
   cannot produce duplicate tickets.

7. **Ops-table RLS (041, 046)**: `outbound_queue` and `number_provision_log` are
   service-role-only with RLS forced on. Anon and authenticated roles have no
   privileges. Customer phone numbers and Twilio SIDs are not readable from
   the anon key.

8. **Admin transcript INSERT gate (046)**: `admin_chat_transcripts` INSERT
   requires `is_super_admin()` (user JWT) or service_role key. WITH CHECK(true)
   replaced — any authenticated user could previously inject transcripts.

9. **TCPA / 10DLC**: All messaging respects opt-in, honors STOP immediately and
   permanently, observes quiet hours. The registered campaign (TCR `CSMB9HG`,
   provider Telnyx) is approved by all seven carriers. STOP/HELP/START use the
   **exact registered strings** and are matched **whole-message only** —
   "I want to cancel this order" does NOT opt out. The public homepage CTA and
   footer carry the carrier-required message-frequency disclosure ("Message
   frequency varies by order, typically 3-8 messages per order") — added to
   clear carrier rejection code 806. Legal pages (contact/terms/privacy) use
   the canonical `getsprintai.com` mailbox and publish the SprintAI LLC legal
   identity (5620 Cetronia Rd, Allentown, PA 18106); the retired
   `getsprintai.net` mailbox is gone. See
   `docs/10dlc-compliance-obligations.md` for the full binding spec.

10. **Protected shop guard (051)**: Shops flagged `protected=true` (NJB and
    future demo/live shops) have a DB-level trigger that blocks DELETE on
    menus/menu_items. Legitimate admin re-imports opt in per-transaction:
    `SET LOCAL app.allow_protected_delete = 'on'`. This is the data-layer
    defense against test/QA runs accidentally destroying a real shop's menu.

11. **Deterministic grounding guards (chat-sms)**: Three code-path intercepts
    prevent the LLM from hallucinating in ways that prompt rules alone can't
    stop. Guard 1b: suppress replies inventing off-menu container/portion
    words ("tub", "pint") not in the shop's menu vocabulary. Guard 1c:
    suppress claims an item is in the cart when the authoritative cart row
    disagrees (including empty-cart assertions). Guard 3b: suppress "added X
    to your cart" claims when the cart didn't actually mutate this turn. These
    are code-path intercepts, not prompt-preference — they fire deterministically
    regardless of what the LLM intended.

12. **Customer-question precedence (chat-sms)**: The bot answers direct
    customer questions (e.g. "do you have gluten-free bagels?") before
    advancing the order, even when the question is mixed with declines or
    order-completion signals. Category-level declines (e.g. asking for a
    category the shop doesn't carry) get a clean "we don't carry that" without
    pushing the conversation. Repeated questions get a fresh answer — the bot
    never ignores a customer question to shortcut to "what else can I add?".
    This is a prompt-rule in system-prompt CRITICAL tier, enforced alongside
    the deterministic grounding guards above.

---

## Monitoring & alerting

- `eval-sweep` generates conversation quality assessments every ~5 minutes.
  The Judge grades only assistant messages — a diner's prompt-injection attempt
  is never flagged as an assistant failure. `wrong_total` fires only on an
  explicit stated total; `invented_item` is narrowly scoped to items truly
  absent from the menu, its descriptions, and modifiers — fewer false flags.
  The ground-truth format now carries `description` and `modifiers` per item
  so the Judge can distinguish off-menu items from real add-ons and ingredients.
- `issue-detector` scans evals for patterns: error spikes, quality decline,
  compliance violations → writes to `issues` table + optional Telegram alerts.
- iMessage bridge logs to `/tmp/sprintai-imsg-bridge.log`.
- Stripe webhook failures surface in Supabase function logs.

---

## Troubleshooting

### "Bridge is down" / iMessage not routing
1. SSH to Mac: `launchctl list | grep sprintai`
2. Check logs: `tail -f /tmp/sprintai-imsg-bridge.log`
3. Restart: `launchctl kickstart gui/$(id -u)/com.sprintai.imsg-bridge`

### Stripe Connect onboarding fails
- Verify `isShopLive()` gate passes — all four fields must be set.
- For Path B (Express), the account must have `charges_enabled=true` and
  `payouts_enabled=true`. Onboarding may be incomplete in Stripe dashboard.
- Check `connect_status` on the shop row.

### Admin dashboard blank page
- Confirm `sprintai-chat-admin` site has the latest deploy.
- Confirm `deploy-root/_redirects` has the `/admin/*` → `/admin/index.html` rewrite.
- Check `admin-dashboard/vite.config.ts` has `base: "/admin/"` and `src/main.tsx` `basename="/admin"`.
- The live URL is `getsprintai.com/admin`; the SPA routes under `/admin/`.

### Edge function deploy fails
- `supabase functions deploy <name>` — check `supabase/config.toml` has the
  function's `verify_jwt` setting.
- For new functions: add the `[functions.<name>]` block to `config.toml` first.
