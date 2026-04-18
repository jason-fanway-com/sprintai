# SprintAI Chat Platform

SMS-first AI chatbot SaaS for small businesses. Multi-tenant, self-serve onboarding, Stripe billing, Toast POS integration.

**Stack:** Supabase (Postgres + pgvector + Edge Functions) · Twilio · OpenAI · Stripe · Netlify

---

## Architecture

```
Customer SMS → Twilio → chat-sms Edge Function
                              ↓
                    Tenant lookup (by phone number)
                              ↓
                    RAG: pgvector knowledge base
                              ↓
                    OpenAI GPT-4o-mini
                              ↓
             [order intent?] → Toast API
                              ↓
                    TwiML response → Twilio → SMS
```

**Signup flow:**
```
getsprintai.com/signup → Stripe Checkout → stripe-webhook 
  → create tenant → trigger onboard-tenant (scrape + embed)
  → assign Twilio number → send welcome SMS
```

---

## Project Structure

```
sprintai-chat/
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   └── 001_initial_schema.sql     ← Run this in Supabase SQL editor
│   └── functions/
│       ├── chat-sms/index.ts          ← Twilio SMS webhook
│       ├── onboard-tenant/index.ts    ← Website scraper + embeddings
│       ├── stripe-webhook/index.ts    ← Billing automation
│       ├── toast-order/index.ts       ← Toast POS integration
│       ├── create-checkout/index.ts   ← Stripe Checkout session creator
│       └── admin-api/index.ts         ← Dashboard REST API
├── admin-dashboard/                   ← React + Vite (deploy to Netlify)
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── Tenants.tsx
│   │   │   ├── TenantDetail.tsx
│   │   │   ├── Conversations.tsx
│   │   │   ├── ConversationDetail.tsx
│   │   │   └── Login.tsx
│   │   └── ...
│   └── netlify.toml
├── signup-page/
│   ├── index.html                     ← Signup form with plan selector
│   └── success.html                   ← Post-checkout success page
└── .env.example
```

---

## Deployment

### 1. Supabase Setup

1. Create project at [supabase.com](https://supabase.com) (or use existing `fdxvflryvctvstxdbdtm`)
2. Enable pgvector: Go to SQL editor → run `CREATE EXTENSION IF NOT EXISTS vector;`
3. Run migration: SQL editor → paste contents of `supabase/migrations/001_initial_schema.sql`
4. Get your project URL and service role key from Settings → API

**Set Edge Function secrets:**
```bash
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set TWILIO_ACCOUNT_SID=AC...
supabase secrets set TWILIO_AUTH_TOKEN=...
supabase secrets set TWILIO_PHONE_NUMBER=+16103792553
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set STRIPE_STARTER_PRICE_ID=price_...
supabase secrets set STRIPE_PRO_PRICE_ID=price_...
supabase secrets set STRIPE_ENTERPRISE_PRICE_ID=price_...
```

**Deploy Edge Functions:**
```bash
cd sprintai-chat
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy chat-sms
supabase functions deploy onboard-tenant
supabase functions deploy stripe-webhook
supabase functions deploy toast-order
supabase functions deploy create-checkout
supabase functions deploy admin-api
```

### 2. Twilio Setup

1. Log in to [twilio.com/console](https://twilio.com/console)
2. Go to Phone Numbers → Active Numbers → click your number (610-379-2553)
3. Under "Messaging" → set Webhook URL:
   ```
   https://YOUR_PROJECT.supabase.co/functions/v1/chat-sms
   ```
   Method: `HTTP POST`
4. Save

**For multi-tenant dedicated numbers:** The `stripe-webhook` function auto-buys numbers via Twilio API for Pro/Enterprise plans.

### 3. Stripe Setup

1. Create products in Stripe Dashboard:
   - **SprintAI Starter** — $99/mo recurring
   - **SprintAI Pro** — $247/mo recurring
   - **SprintAI Enterprise** — $497/mo recurring

2. Copy the Price IDs and set them as Supabase secrets (above)

3. Add webhook endpoint:
   - URL: `https://YOUR_PROJECT.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.payment_succeeded`

4. Copy webhook signing secret → set as `STRIPE_WEBHOOK_SECRET`

### 4. Admin Dashboard (Netlify)

```bash
cd admin-dashboard
npm install
```

Create `.env.local`:
```
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key
```

Deploy to Netlify:
```bash
# Option A: Netlify CLI
netlify deploy --build --dir dist

# Option B: Connect GitHub repo to Netlify
# Base directory: admin-dashboard
# Build command: npm run build
# Publish: dist
```

**Set Netlify domain:** `app.getsprintai.com`

**Create admin user:**
1. Go to Supabase → Authentication → Users → Invite User
2. Email: `jason@fanway.com`
3. After signup, run in SQL editor:
   ```sql
   UPDATE auth.users
   SET raw_user_meta_data = '{"is_admin": true}'
   WHERE email = 'jason@fanway.com';
   ```

### 5. Signup Page

Add to `getsprintai.com`:
- Replace `YOUR_SUPABASE_URL` in `signup-page/index.html`
- Replace `pk_live_YOUR_PUBLISHABLE_KEY_HERE` with your Stripe publishable key
- Replace `price_STARTER_PRICE_ID_HERE` etc. with real Stripe Price IDs
- Deploy `signup-page/index.html` and `signup-page/success.html` to getsprintai.com

---

## Environment Variables

All secrets for Edge Functions are set via `supabase secrets set`.
Toast credentials are per-tenant and stored in the `integrations` table (JSONB config).

---

## Toast Integration

For restaurants with Toast POS:

1. Get Toast API credentials (client_id + client_secret) from Toast developer portal
2. Via admin dashboard: Tenant Detail → Add Integration → Toast
3. Or via API:
   ```bash
   curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/admin-api/tenants/TENANT_ID \
     -H "Authorization: Bearer SERVICE_KEY" \
     -d '{"type":"toast","config":{"clientId":"...","clientSecret":"...","restaurantGuid":"..."}}'
   ```
4. Run menu onboarding: calls `toast-order` with `action=get_menu_for_onboarding`

---

## Testing

**Test SMS:**
```bash
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/chat-sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=%2B16105551234&To=%2B16103792553&Body=What%20are%20your%20hours%3F&MessageSid=test123"
```

**Test onboarding:**
```bash
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/onboard-tenant \
  -H "Authorization: Bearer SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"TENANT_UUID","website_url":"https://example.com"}'
```

---

## Success Criteria

- [ ] Text 610-379-2553 → get AI response based on a real business's website
- [ ] Sign up on getsprintai.com → pay → auto-provisioned → working chatbot within 60 seconds
- [ ] Text "I want a large pepperoni pizza" → bot confirms → order appears in Toast
- [ ] Admin can view conversations, edit knowledge base, see billing status
- [ ] All runs on Supabase + Netlify. Zero dependency on OpenClaw or Jason's MacBook.

---

## Costs (at scale)

| Service | Cost |
|---------|------|
| OpenAI GPT-4o-mini | $0.15/1M input tokens |
| OpenAI text-embedding-3-small | $0.02/1M tokens |
| Twilio SMS | $0.0079/message |
| Twilio phone number | $1.15/mo each |
| Supabase | ~$25/mo (Pro plan) |
| Netlify | Free tier |

**Margin at 100 tenants (Starter avg):** ~$9,900 revenue - ~$500 infra = **$9,400/mo**
