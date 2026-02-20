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
6. Posts saved to `sprintai_content_calendar` (status = pending)
7. post_scheduler.py runs every 15 min (cron), publishes due posts via API
8. Delivery logged in `sprintai_posts` (status = posted | failed)
```

---

## File Overview

| File | Purpose |
|------|---------|
| `schema.sql` | Supabase table definitions — run once to initialize |
| `oauth_callback.py` | Exchanges OAuth codes for tokens, stores in Supabase |
| `post_scheduler.py` | Publishes pending calendar posts to social platforms |
| `content_generator.py` | Generates a month of HVAC posts via Claude API |
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
