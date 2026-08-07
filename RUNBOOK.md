# SprintAI — Runbook

Last updated: 2026-08-07

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
Twilio (SMS) + iMessage bridge (Mac). LLM calls go through OpenRouter.

---

## Architecture & topology

```
Customer SMS → Twilio → webhook → chat-sms edge function
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
- The admin SPA uses `<BrowserRouter basename="/dashboard">`. The deploy-root `_redirects` rewrites all paths to `/dashboard/index.html`.

### Supabase project

| Key | Value |
|-----|-------|
| Project ID | `sprintai-chat` |
| Functions | `supabase/functions/` (Deno) |
| Migrations | `supabase/migrations/` (001–040) |

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

```bash
cd admin-dashboard
npm run build
# Vite outputs to dist/ (base="/dashboard/")
# Manually copy dist/ contents to deploy-root/dashboard/
cp -r dist/* deploy-root/dashboard/
# Deploy to the SEPARATE site:
netlify deploy --dir admin-dashboard/deploy-root --site sprintai-chat-admin
# If good:
netlify deploy --dir admin-dashboard/deploy-root --site sprintai-chat-admin --prod
```

After deploy, verify: `curl -s https://getsprintai.com/admin/ | head -20` should
return the admin SPA HTML (proxied from `sprintai-chat-admin`).

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

### SMS / Twilio

- Numbers: `+16109366213`, `+16103792553` (provisioned via Messaging Service `MG76067b4fbbb54eb914c3087f559c2f8b`)
- A2P status: Sole Prop brand (`BN04b99e0012aa2314c12448ffcd01913f`) is approved but capped at one number. Standard brand (LLC, scalable) registration is in progress — blocked on EIN propagation.
- Inbound webhook: Twilio points to `chat-sms` edge function.
- The iMessage bridge on the Mac also handles inbound SMS → `chat-sms` for the primary number (`+14842018054`).

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
| `issue-detector` | Cron | Detect quality issues from evals; alert via Telegram |
| `daily-reset` | Daily | Clear expired specials, delivery pauses; audit log |

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

### Operations & maintenance
| Function | Purpose | JWT |
|----------|---------|-----|
| `provision-number` | Auto-buy Twilio number for new shop | No |
| `toast-order` | Toast POS menu fetch + order placement | No |
| `daily-reset` | Clear expired specials + delivery pauses | No |

### Quality & monitoring
| Function | Purpose | JWT |
|----------|---------|-----|
| `eval-sweep` | Conversation Judge — automated quality scoring | No |
| `issue-detector` | Issue detection from evals (3 severity tiers) | No |

### Shared libraries (`_shared/`)
| File | Purpose |
|------|---------|
| `outbound-guard.ts` | Structural chokepoint — all customer-facing sends route here |
| `connect.ts` | Stripe Connect helpers, `isShopLive()` gate, service fee constant |
| `test-mode.ts` | Test-mode Stripe key resolution with allowlist gate |
| `judge-rubric.ts` | Conversation Judge rubric (single source of truth) |
| `judge-notify.ts` | Judge digest → Telegram notification |
| `judge-autofix.ts` | Auto-fix seam (OFF by default) |

---

## Database

Single Postgres database with tenant isolation enforced by RLS policies.

Key tables: `tenants`, `shops`, `menu_items`, `option_groups`, `option_choices`,
`order_carts`, `cart_items`, `messages`, `conversations`, `conversation_evals`,
`knowledge_base`, `availability_overrides`, `admin_action_log`, `issues`,
`resolution_log`, `sprintai_clients`.

Migrations are in `supabase/migrations/` (001–040). Migration `039` added the
delivery flow (order_type, delivery_address, driver_tip). Migration `038` removed
user-metadata-based RLS policies, replaced with `app_metadata`-based policies
via the `set-app-metadata` edge function.

### RLS model

- User roles: `is_admin`, `tenant_id` in `auth.users.app_metadata`.
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

5. **TCPA / 10DLC**: All messaging respects opt-in, honors STOP immediately and
   permanently, observes quiet hours.

---

## Monitoring & alerting

- `eval-sweep` generates conversation quality assessments every ~5 minutes.
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
- Confirm `deploy-root/_redirects` has the SPA catch-all.
- Check `admin-dashboard/vite.config.ts` has `base: "/dashboard/"`.

### Edge function deploy fails
- `supabase functions deploy <name>` — check `supabase/config.toml` has the
  function's `verify_jwt` setting.
- For new functions: add the `[functions.<name>]` block to `config.toml` first.
