# Spec — Trimmed self-serve onboarding (mobile signup → welcome email → desktop setup)

Owner: Jason (2026-08-23). Build: John Walsh. QA: Melvin.

## North Star fit
Self-serve onboarding with zero Sprint hands-on. Owner signs up on phone in 30s,
gets a warm branded email, finishes menu setup at their desk. Generalizes to every shop.

## Scope (deferred: payment, number provisioning, go-live — NOT in this flow)
Signup collects 4 fields. Email sends a tokenized setup link. Setup page = menu + special
instructions only. Subscription/Stripe/number/go-live are handled later by Sprint/Erin, off
this self-serve path. Do not add them here.

## 1. DB migration (new migration file, next number)
Add to `shops`:
- `owner_name TEXT`
- `onboarding_token TEXT UNIQUE` (unguessable, set on create)
Index on `onboarding_token`. Backfill existing rows: leave null.

## 2. onboarding-save edge function
- `create`: accept `account.owner_name`; store it. Generate `onboarding_token` =
  `crypto.randomUUID()` twice concatenated (or 32+ hex chars). Store on the shop.
  After shop insert, send welcome email via Resend (reuse the template pattern in
  `stripe-webhook/index.ts` ~lines 983–1117). From `SprintAI <hello@getsprintai.com>`.
  To the owner email. Subject warm ("Welcome to the SprintAI family, <owner_name> 🎉").
  Body = branded responsive HTML, "welcome to our family" tone, big button →
  `https://getsprintai.com/signup-page/setup.html?t=<onboarding_token>`.
  If `RESEND_API_KEY` unset or send fails: log, DO NOT fail the request.
  Return `{ ok, shop_id, slug, onboarding_step, onboarding_token, setup_url }`.
- `resume`: also accept `{ action:"resume", token }` → look up shop by `onboarding_token`.
- Keep create→resume→save working (already fixed today: tenant slug, no `status` col).
- CORS already allows apikey — do not regress.

## 3. Mobile signup (repurpose signup-page/index.html + wizard.js step 1)
Trim the account step to EXACTLY 4 inputs: Restaurant name, Owner name, Email, Website.
Remove phone/timezone/address from signup (default timezone America/New_York; collect
later in setup if needed). Mobile-first layout. On submit → create → success screen that:
- Shows "Check <email> for your setup link" AND the setup link on-screen (email may lag/spam).
- Link → setup.html?t=<token>.

## 4. Desktop setup page (new signup-page/setup.html, responsive)
Loads `?t=<token>` → resume by token → render:
- Menu upload (reuse parse-menu-pdf + import-menu-csv flow already in wizard.js).
- Special instructions textarea → saves to `ai_instructions` via onboarding-save `save`.
- Save/Finish. Desktop-first but responsive (works on phone).
No payment/number/go-live steps.

## Acceptance criteria (Melvin must verify live against getsprintai.com origin)
1. Signup shows exactly 4 fields; submit creates a shop with owner_name + onboarding_token.
2. Welcome email attempted via Resend (verify send path returns 200 with a test key, or logs
   cleanly when unset); email HTML renders on mobile; setup button links to setup.html?t=token.
3. Success screen shows the setup link even if email fails.
4. setup.html?t=<token> resumes the correct shop; menu upload + instructions save; mobile-responsive.
5. Token unguessable (≥128-bit); raw shop_id not required in the setup URL.
6. No regression: create→resume(by id/email/token)→save all 200.
7. CORS still allows apikey on all touched functions.

## Phase 2 — production gate: EIN + Stripe payout (with test bypass) [ADDED 2026-08-23]
Production go-live requires the owner to provide their **EIN** and connect a **Stripe** payout
account. Test/demo shops must be able to **bypass both**.

- DB: add `shops.ein TEXT` and `shops.is_test BOOLEAN NOT NULL DEFAULT false`.
- Setup page (desktop): after menu + instructions, add a "Go live" section with an **EIN field**
  and a **Connect Stripe** button (reuse `connect-create-express`). Real payouts = Stripe Connect.
- Requirement gating keys off `is_test`:
  - `is_test = false` (real signup): EIN + connected Stripe are REQUIRED before go-live.
  - `is_test = true`: EIN + Stripe optional; go-live allowed without them (test/demo only).
- **How `is_test` gets set (the mechanism Jason uses to run a test setup):**
  1. **Email allowlist (primary, server-side in `onboarding-save` create):** if owner email matches
     a Sprint allowlist, set `is_test = true` automatically. Allowlist = configurable (env/config):
     `jason@fanway.com`, any `@getsprintai.com`, plus a small list. Jason runs a test by signing up
     with his own email — no UI toggle. Match server-side only.
  2. **Admin toggle (backup):** a "Test mode" switch on the shop in the admin dashboard (superadmin)
     to flip `is_test` on any shop.
- **COMPLIANCE — bypass must not be exploitable by real shops.** Do NOT expose a public control
  (checkbox / URL param) that flips `is_test`. Only the server-side allowlist and the admin toggle
  set it. A public production signup with a non-allowlisted email is always `is_test = false`.
  Never move money or waive EIN for a non-test shop. Preserves the hard rules (no money movement
  without authorization; collect legally-required identity).
- `go-live` function: enforce the above server-side (never trust the client). Refuse go-live for a
  non-test shop lacking EIN or an enabled Stripe payout account. Keep existing Connect gate.
- Never log or echo the full EIN; store it, don't print it.

Note: the whole environment is currently on Stripe TEST keys and pre-customer, so in practice all
shops are effectively test today. This flag makes the production behavior correct in advance and
gives Jason a clean bypass for his test restaurants now.

## Phase 3 — "Confirm what we found" (pre-crawl + prepopulate) [ADDED 2026-08-23]
Turn setup from "tell us about you" into "confirm what we found." This is the owner's first
wow moment. Reuse `scrape-shop` (Firecrawl + Claude).

- **On signup `create`:** kick off `scrape-shop` for the website URL (async — do not block the
  create response; the owner opens the email link minutes later, by which time it's done).
- **scrape-shop extracts structured fields** (extend its Claude extraction to return these), saved
  to the shop: business hours (`open_hours`), an "about"/description, and any **menu links/URLs**
  found on the site. Keep `shop_context` too.
- **Setup page renders pre-filled + editable** ("Here's what we found — confirm or fix"):
  hours, about, and menu. Every field editable and saved via onboarding-save `save`.
- **Menu input:** menu may be one or several links. Provide **4 text fields** to paste menu URLs,
  PRE-FILLED with any menu links the crawl found, PLUS the existing PDF/CSV upload. Owner can use
  links, upload, or both.
- If the crawl found nothing / failed: fall back to empty editable fields (never block; never show
  a broken/half state). Show a gentle "we couldn't auto-read your site — fill these in" message.
- Cost note: this runs Firecrawl + Claude once per signup. High-leverage (self-serve wow), once per
  shop — acceptable. Flag if a shop re-runs the crawl repeatedly.

## Phase 4 — full setup page (menu edit, Stripe, what-to-expect, delivery) [ADDED 2026-08-23]

### 4a. Editable menu
Show the shop's parsed menu (menu_items) in an editable grid on the setup page: item name, price,
category, description; add/edit/remove rows; save. Populated from the menu source (upload / CSV /
parsed menu link). If empty, prompt to add via the 4 menu-link fields or upload. (Stretch: auto-parse
the scraped menu link into items so it's pre-filled — flag cost; defer if it balloons scope.)

### 4b. Stripe Connect (hosted onboarding — NOT collected by us)
Compliance: never collect/store bank/SSN/identity ourselves; Stripe KYC must be entered with Stripe.
- Use `connect-create-express` to create the Connect Express account (prefill business name + email).
- Give the owner the Stripe-hosted onboarding LINK/button. On return, show connected status.
- Gated by `is_test` (Phase 2): test shops can skip; real shops must connect before go-live.
- At the end of setup: a **"Go to my Shop"** button → the owner's Shop view (tenant-scoped app).

### 4c. "What to expect" section (bottom)
- Copy: you can manage your shop anytime in the admin console (link it).
- Show the shop's **unique QR code** that opens the shop chat on the owner's phone, so they can text
  commands like "86 <item>" or "turn off delivery." QR encodes the merchant chat entry point
  (the shop's SMS number once provisioned; until then, the owner web-chat/admin link — pick the
  available target and note the dependency). Warm, friendly tone (SOUL §9).

### 4d. Delivery section
- On/off indicator + toggle (`delivery_enabled`).
- Delivery hours (add a `delivery_hours` JSON column if none exists; else reuse).
- Delivery fee (`delivery_fee_cents`). Save via onboarding-save `save` (extend ALLOWED_FIELDS).

### 4e. Fix hours prefill
scrape-shop returned `open_hours: null` even though hours were in the summary text. Extend the
structured extraction so `open_hours` is populated and the setup page's hours box pre-fills.

## Phase 5 — structured 7-day hours editors (open + delivery) [ADDED 2026-08-23]
Both "Open hours" and "Delivery hours" become 7-day editors (Mon–Sun rows) with dropdown time
selectors, defaulting to the hours the shop is open.

- **Data shape (structured, replaces the free-text string):**
  `open_hours` and `delivery_hours` = object keyed by day:
  `{ "mon": {"closed": false, "open": "10:00", "close": "22:00"}, ..., "sun": {...} }`
  Times in 24h "HH:MM". `closed: true` for closed days.
- **scrape-shop:** emit `open_hours` in THIS structured shape (not a summary string). Map e.g.
  "Mon–Sun 10 AM–10 PM" → all 7 days open 10:00–22:00. If a day/hours can't be determined, leave a
  sensible default and let the owner fix it. (4e currently returns a string — upgrade it.)
- **Setup page — Open hours:** 7 rows (Mon–Sun), each with a "Closed" toggle + open/close time
  dropdowns (15- or 30-min increments). Pre-filled from crawl `open_hours`.
- **Setup page — Delivery hours:** same 7-row editor, in the Delivery section. Defaults to the
  Open hours values when `delivery_hours` is empty (copy open→delivery on first render).
- **Compatibility:** find every reader of `shops.open_hours` (e.g. chat-sms hours logic) and make it
  handle the structured shape. Do NOT break existing hours behavior. Migrate/normalize existing rows.
- Save both via onboarding-save `save` (ALLOWED_FIELDS already includes open_hours; add delivery_hours).

## Phase 5b — auto-populate menu items from the crawl [ADDED 2026-08-23]
The setup menu grid is empty because scrape-shop finds menu LINKS but never parses ITEMS.
Zio's has 0 menu_items → owner sees a blank grid. Fix so the real menu is visible + editable.

- scrape-shop: from the crawled menu content and the discovered menu_links, extract structured
  menu items via the LLM (OpenRouter): name, price, category, description. Insert into `menu_items`
  for the shop (match the columns the existing Phase-4 save_menu upsert uses).
- Idempotent: don't duplicate items on re-crawl (clear-and-replace crawl-sourced items, or upsert
  by (shop_id, name)). Never wipe owner-edited items silently — if the owner already edited/saved
  the menu, do not overwrite. Only auto-populate when the menu is empty.
- Owner-edit wins: once populated, the setup grid (get_menu/save_menu) edits and persists normally.
- Verify live on Zio's: after crawl, get_menu returns a real item list; grid renders them editable.

## Phase 6 — Google Business Profile lookup at signup [ADDED 2026-08-23]
Before the setup page is presented, look up the shop's Google Business listing and pre-fill from it.
Google is authoritative for hours/address/phone; website crawl is better for menu/about. Merge both.

- On signup `create` (alongside scrape-shop), call Google Places:
  Find Place (by name + address/website) → place_id → Place Details
  (fields: name, formatted_address, formatted_phone_number, opening_hours, website, rating,
  user_ratings_total, types). Key = `GOOGLE_MAPS_API_KEY` (Supabase secret, GCP `sprint-geocoding`).
- **Verify Places API is enabled on that key/project** — the geocoding project may only have the
  Geocoding API on. If Places is disabled, enable it (or flag to Jason) — don't fail silently.
- Map `opening_hours` → the structured `open_hours` shape from Phase 5 (per-day open/close). Prefer
  Google hours over crawl-derived when both exist. Fill address/phone if missing.
- Store rating + review count + place_id on the shop (add columns if needed) for later use.
- Setup page: pre-filled fields reflect the merged Google + crawl data; all editable ("confirm").
- Cost: ~1–5¢ per signup (Places Details). Once per shop, idempotent. Flag actual cost after first run.
- Precedence rule: Google → hours/address/phone; crawl → menu/about. Owner edits override everything.

## Deliverables
Migration file, onboarding-save changes, signup page (4-field), setup.html, welcome-email HTML.
Report: files changed, deploy status, Melvin verification with evidence (curl/screenshots).
