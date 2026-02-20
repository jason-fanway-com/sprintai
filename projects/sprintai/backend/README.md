# SprintAI — Social Media Posting Engine

AI-powered social media automation for HVAC contractors. Clients connect their
own Facebook, Instagram, and Google Business accounts via OAuth; SprintAI's
content engine generates posts and publishes them on a schedule.

---

## How It Works — End to End

```
1. Client signs up on getsprintai.com
2. Client visits /connect → clicks "Connect Facebook" or "Connect Google"
3. Meta / Google OAuth redirect → callback exchanges code for tokens
4. Tokens stored in `sprintai_social_connections` (Supabase)
5. content_generator.py generates a month of HVAC posts via Claude
6. Posts saved to `sprintai_content_calendar` (status = draft)
7. content_qa.py scores every draft post — weak posts are auto-rewritten
8. Approved / rewritten posts promoted to (status = pending)
9. post_scheduler.py runs every 15 min (cron), publishes due posts via API
10. Delivery logged in `sprintai_posts` (status = posted | failed)
```

### Content Status Flow

```
draft  →  [content_qa.py]  →  pending  →  [post_scheduler.py]  →  posted | failed
```

| Status    | Set by                | Meaning                                      |
|-----------|-----------------------|----------------------------------------------|
| `draft`   | content_generator.py  | Generated, awaiting QA review                |
| `pending` | content_qa.py         | QA passed (or rewritten), ready to publish   |
| `posted`  | post_scheduler.py     | Successfully published to the platform       |
| `failed`  | post_scheduler.py     | Publish attempt failed (see sprintai_posts)  |

---

## File Overview

| File | Purpose |
|------|---------|
| `schema.sql` | Supabase table definitions — run once to initialize |
| `oauth_callback.py` | Exchanges OAuth codes for tokens, stores in Supabase |
| `content_generator.py` | Generates a month of HVAC posts via Claude API (status: draft) |
| `content_qa.py` | QA agent — scores & rewrites drafts, promotes to pending |
| `post_scheduler.py` | Publishes pending calendar posts to social platforms |
| `.env.example` | Template for required environment variables |
| `../connect/index.html` | Client-facing OAuth connection page |

---

## Setup

### 1. Install Python dependencies

```bash
pip install supabase python-dotenv requests
```

### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env with your real credentials
```

### 3. Initialize Supabase schema

In the Supabase dashboard → **SQL Editor**, paste and run `schema.sql`.

Or via psql:
```bash
psql "postgresql://postgres:PASSWORD@db.YOUR_PROJECT.supabase.co:5432/postgres" \
     -f schema.sql
```

### 4. Register a Meta (Facebook) App

1. Go to [developers.facebook.com](https://developers.facebook.com/apps/) → Create App → **Business**
2. Add products: **Facebook Login**, **Instagram Graph API**
3. In App Settings → Basic, copy **App ID** and **App Secret** → `.env`
4. Add OAuth Redirect URI: `https://getsprintai.com/oauth/callback/facebook`
5. Under Permissions, request:
   - `pages_manage_posts`
   - `pages_read_engagement`
   - `instagram_basic`
   - `instagram_content_publish`
6. **Submit for App Review** (required before posting on behalf of real pages).
   ⚠️ **Meta app review takes 1–2 weeks.** Start this early.
7. Update `FACEBOOK_APP_ID` in `connect/index.html` (the `{APP_ID}` placeholder comment).

### 5. Register a Google Cloud App

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) → New Project
2. Enable APIs: **My Business API**, **Business Profile Performance API**
3. Create OAuth 2.0 credentials → Web Application
4. Add Authorized redirect URI: `https://getsprintai.com/oauth/callback/google`
5. Copy Client ID and Client Secret → `.env`
6. **Submit for Google App Verification** if you need production access beyond your
   test users. Verification typically takes 1–4 weeks.
7. Update `GOOGLE_CLIENT_ID` in `connect/index.html` (the `{CLIENT_ID}` placeholder comment).

---

## Running the Scripts

### oauth_callback.py

Called when a client completes the OAuth flow. In production this would be
triggered automatically by your server's callback endpoint.

```bash
# Facebook (also captures Instagram Business accounts on same pages)
python oauth_callback.py \
    --platform facebook \
    --code AUTH_CODE_FROM_REDIRECT \
    --client_id CLIENT_UUID

# Google Business
python oauth_callback.py \
    --platform google \
    --code AUTH_CODE_FROM_REDIRECT \
    --client_id CLIENT_UUID
```

### content_generator.py

Generates 12 posts per platform (36 total) for the specified month.
Posts are saved as **drafts** (status = `draft`) — run `content_qa.py` next.
Posts are scheduled Mon/Wed/Fri at 10 AM in the given timezone.

```bash
# Generate March 2026 content for a client
python content_generator.py --client_id UUID --month 2026-03

# Preview without saving
python content_generator.py --client_id UUID --month 2026-03 --dry-run

# Specify client's local timezone
python content_generator.py --client_id UUID --month 2026-03 \
    --timezone America/Chicago
```

### content_qa.py

QA agent that reviews every draft post with Claude. Posts are scored on 6
dimensions (Hook Strength, Local Specificity, Value Delivery, CTA Clarity,
Platform Fit, Authenticity). Posts scoring avg ≥ 7.0 are approved; below 7.0
are auto-rewritten by Claude and replaced. All posts are promoted to `pending`
after the QA pass, ready for `post_scheduler.py`.

Run this **after** `content_generator.py` and **before** posts go live.

```bash
# QA all draft posts for March 2026
python content_qa.py --client_id UUID --month 2026-03

# Preview scores without updating Supabase
python content_qa.py --client_id UUID --month 2026-03 --dry-run
```

**Sample output:**
```
🔍 SprintAI Content QA — Acme HVAC | 2026-03

📬 Found 36 draft posts to review

  [01/36] Facebook                     Is your AC ready for summer?…
           ✅ APPROVED  avg=7.8  |  Strong hook, good CTA
  [02/36] Instagram                    At Acme HVAC, we pride oursel…
           ✏️  REWRITE   avg=5.9  |  Generic opener; sounds corporate
           → New: Summer in Phoenix hits different. Your AC shouldn't…
  ...

=======================================================
  QA Complete — Acme HVAC | 2026-03
=======================================================
  Posts reviewed : 36
  Approved       : 22 (61%)
  Rewritten      : 14 (39%)
  Average score  : 7.4
  Lowest post    : At Acme HVAC, we take pride in… — 5.2 avg
=======================================================
```

**Scoring rubric** (6 dimensions, each 1–10):

| Dimension | What's graded |
|-----------|---------------|
| Hook Strength | Does the opener stop the scroll? |
| Local Specificity | Does it feel written for THIS city/company? |
| Value Delivery | Is there something useful for the reader? |
| CTA Clarity | Is the call-to-action clear and specific? |
| Platform Fit | Does it match the platform's format and norms? |
| Authenticity | Does it sound like a real local business owner? |

A custom rubric can be placed at `content/qa-scoring-rubric.md` to override
the built-in rubric (useful for client-specific voice guidelines).

### post_scheduler.py

Publishes all pending posts whose `scheduled_at <= now()`. Designed to be
called by cron every 15 minutes.

```bash
# Run manually
python post_scheduler.py

# Add to crontab
crontab -e
*/15 * * * * cd /path/to/backend && python post_scheduler.py >> /var/log/sprintai.log 2>&1
```

---

## Connect Page (`/connect`)

`connect/index.html` is a standalone branded page clients land on after signup.

- Deploy to Netlify / any static host
- Pass `?client_id=UUID` in the URL so the OAuth flow knows which client is connecting
- After successful OAuth, the callback should redirect back with `?fb=connected` or
  `?gmb=connected` to show the ✅ connected state

To wire up real credentials, search for `{APP_ID}` and `{CLIENT_ID}` in the file
and replace them (or inject at deploy time via Netlify env substitution).

---

## Going Live Checklist

| Item | Status | Notes |
|------|--------|-------|
| Supabase schema applied | ⬜ | Run `schema.sql` once |
| `.env` filled in | ⬜ | Copy `.env.example` |
| Meta app created | ⬜ | developers.facebook.com |
| **Meta app review submitted** | ⬜ | ⏳ 1–2 weeks |
| Google Cloud project + APIs enabled | ⬜ | console.cloud.google.com |
| **Google app verification** | ⬜ | ⏳ 1–4 weeks for production |
| `connect/index.html` deployed | ⬜ | Replace `{APP_ID}` / `{CLIENT_ID}` |
| OAuth redirect URIs whitelisted | ⬜ | Must match exactly |
| Cron job configured | ⬜ | `*/15 * * * *` |
| First client added to `sprintai_clients` | ⬜ | Manual insert or via Stripe webhook |

---

---

## Payment & Onboarding Flow

### Full Flow

```
Landing page (getsprintai.com)
  │
  ▼
/checkout  ─── Client picks Founder ($997/mo) or Growth ($1,500/mo)
  │             POST /create-checkout-session → stripe_webhook.py
  │             → Stripe Checkout hosted page (card entry)
  ▼
Stripe processes payment
  │
  ├── Success → redirects to /welcome?session_id=...
  │
  └── Stripe fires webhook → POST /webhook → stripe_webhook.py
        ├── checkout.session.completed:
        │     1. Create/update client in sprintai_clients (status = active)
        │     2. Fire send_onboarding_email.py → email with /connect link
        │
        └── customer.subscription.deleted:
              → Update client status to 'cancelled'
```

```
/welcome  →  Client sees "You're in" page with CTA to /connect
  │
  ▼
/connect?client_id=UUID  →  OAuth flow for Facebook + Google Business
  │
  ├── Meta OAuth  →  /oauth/callback/facebook  →  token stored in sprintai_social_connections
  └── Google OAuth →  /oauth/callback/google   →  token stored in sprintai_social_connections
         │
         ▼
  content_generator.py  →  generates 1 month of HVAC posts (status: draft)
         │
         ▼
  content_qa.py  →  scores + rewrites weak posts, promotes to pending
         │
         ▼
  post_scheduler.py (cron, every 15 min)  →  publishes Mon/Wed/Fri at 10 AM
```

### Files Involved

| File | Purpose |
|------|---------|
| `../checkout/index.html` | Plan selection UI — calls `/create-checkout-session` |
| `../welcome/index.html`  | Post-payment confirmation page — links to `/connect` |
| `stripe_webhook.py`      | Flask server: checkout session creator + webhook handler |
| `send_onboarding_email.py` | Sends welcome email with connect link |

### Running Locally with Stripe CLI

1. **Install Stripe CLI**
   ```bash
   brew install stripe/stripe-cli/stripe
   stripe login
   ```

2. **Set environment variables**
   ```bash
   cp .env.example .env
   # Fill in STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
   # STRIPE_PRICE_FOUNDER, STRIPE_PRICE_GROWTH, SMTP_USER, SMTP_PASS
   ```

3. **Install Python dependencies**
   ```bash
   pip install flask stripe supabase python-dotenv
   ```

4. **Start the Flask server**
   ```bash
   export FLASK_APP=stripe_webhook.py
   flask run --port 4242
   # or: python stripe_webhook.py
   ```

5. **Forward Stripe events to your local server** (new terminal)
   ```bash
   stripe listen --forward-to localhost:4242/webhook
   # Copy the webhook signing secret printed here → set STRIPE_WEBHOOK_SECRET in .env
   ```

6. **Trigger a test event**
   ```bash
   stripe trigger checkout.session.completed
   stripe trigger customer.subscription.deleted
   ```

7. **Open the checkout page locally**
   - Serve `checkout/index.html` from a local HTTP server
   - Update `BACKEND_URL` in the checkout page to `http://localhost:4242`

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY`      | Stripe secret key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (used in checkout frontend) |
| `STRIPE_WEBHOOK_SECRET`  | Webhook signing secret from `stripe listen` or Stripe dashboard |
| `STRIPE_PRICE_FOUNDER`   | Stripe Price ID for the Founder plan (`price_...`) |
| `STRIPE_PRICE_GROWTH`    | Stripe Price ID for the Growth plan (`price_...`) |
| `SUPABASE_URL`           | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (bypasses RLS) |
| `SMTP_USER`              | Gmail address to send from |
| `SMTP_PASS`              | Gmail App Password (not your account password) |
| `CHECKOUT_SUCCESS_URL`   | Redirect URL after payment (default: `https://getsprintai.com/welcome?session_id={CHECKOUT_SESSION_ID}`) |
| `CHECKOUT_CANCEL_URL`    | Redirect URL on cancel (default: `https://getsprintai.com/checkout`) |

### Sending the Onboarding Email Manually

```bash
python send_onboarding_email.py \
    --client_email "owner@acmeair.com" \
    --client_name  "Bob Smith" \
    --client_id    "your-client-uuid-here"
```

### Deploying the Webhook Server

The Flask app can run on any VPS, Railway, Render, or Fly.io instance.

```bash
# Example: Gunicorn in production
pip install gunicorn
gunicorn --bind 0.0.0.0:4242 stripe_webhook:app
```

Register your live endpoint in the Stripe dashboard:
`https://dashboard.stripe.com/webhooks` → Add endpoint → `https://api.getsprintai.com/webhook`
Select events: `checkout.session.completed`, `customer.subscription.deleted`

---

## Security Notes

- **Never commit `.env`** — add it to `.gitignore`
- Access tokens in `sprintai_social_connections` should be encrypted at rest.
  Use [Supabase Vault](https://supabase.com/docs/guides/database/vault) in production.
- The `SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security — keep it server-side only.
- Meta page tokens generated from a long-lived user token do not expire, but can be
  revoked by the user. Handle `OAuthException` in the scheduler and mark connections
  as needing re-authorization.

---

## Architecture Notes

- This engine is designed to run as **Python scripts called by cron** — simple,
  auditable, and easy to debug. No message queue or worker daemon required initially.
- As volume grows, migrate to a proper job queue (e.g. Celery + Redis or Inngest).
- Image generation (for `image_url`) is not included here — add a separate step
  using DALL-E or Stable Diffusion before `content_generator.py` runs.

---

## Admin Dashboard (`/admin`)

`admin/index.html` is an internal management tool for Jason and Joe. It talks directly to Supabase using the **service role key** (bypasses RLS — internal use only, never expose to clients).

### Features

- **Client List** — table of all clients with plan, status, social connection indicators (FB / IG / GBP), posts this month, and joined date. Click any row to drill in.
- **Client Detail** — full profile, social connection health (token expiry warnings in yellow/red), upcoming content calendar, and action buttons.
- **Content Queue** — all pending/posted/failed posts across every client, sorted by scheduled date.

### Access

Open `admin/index.html` directly in a browser (or deploy to a private URL). Default password: `sprintai-admin-2026`.

To change the password, edit the `ADMIN_PASSWORD` constant in `admin/index.html`.

> ⚠️ The service role key is embedded in this file intentionally — it's an internal tool. Do **not** deploy it to a public URL. Protect with HTTP Basic Auth or VPN access in production.

---

## Client Portal (`/portal`)

A client-facing dashboard with Supabase magic link authentication (no passwords required).

### Files

| File | Purpose |
|------|---------|
| `portal/index.html` | Login page — client enters email, receives a magic link |
| `portal/dashboard.html` | Client dashboard — shows connections, posts, stats, CTA |

### Flow

1. Client visits `portal/index.html`
2. Enters email → clicks "Send Login Link"
3. Supabase sends a magic link to their inbox
4. Client clicks the link → lands on `portal/dashboard.html` authenticated
5. Dashboard shows: company name + plan, connected platforms, this week's posts, 30-day stats

### Deploy

1. Replace `SUPABASE_ANON_KEY` placeholder in both portal files with your actual Supabase **anon** (public) key — **never** the service role key.
2. Set the magic link redirect URL in Supabase Auth → URL Configuration → `Site URL` and `Redirect URLs` to your deployed portal URL.
3. Apply the RLS policies from `schema.sql` so clients can only see their own data.

### Row Level Security

The portal uses the **anon key** + **RLS policies** (defined in `schema.sql`). Clients are matched by their authenticated email address to their record in `sprintai_clients`.

---

## Monthly Report Generator (`backend/monthly_report.py`)

Generates and emails an HTML performance report to each active client for a given month.

### Usage

```bash
# Generate + send reports for February 2026
python monthly_report.py --month 2026-02

# Preview without sending (dry run)
python monthly_report.py --month 2026-02 --dry-run

# Test with a single client
python monthly_report.py --month 2026-02 --client-id UUID --dry-run
```

### What Each Report Contains

- **Stats banner** — posts published + platforms active
- **Posts by platform** — list of every published post with date and preview
- **Next month preview** — 3 upcoming scheduled posts
- **CTA button** — links to the client portal dashboard

### SMTP Configuration

Uses the same SMTP credentials as other outgoing emails:

```env
SMTP_HOST=smtp.mail.me.com
SMTP_PORT=587
SMTP_USER=your@email.com
SMTP_PASS=your-app-password
PORTAL_URL=https://getsprintai.com/portal/
FROM_NAME=Jason @ SprintAI
```

### Scheduling (cron)

```bash
# Send reports on the 1st of each month at 9 AM
0 9 1 * * cd /path/to/backend && python monthly_report.py --month $(date -d "last month" +%Y-%m) >> /var/log/sprintai-reports.log 2>&1
```

---
