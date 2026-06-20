# Stripe API Verification — Specs 01 & 02

**Builder:** John Walsh · **Date:** 2026-06-20 · **Mode:** Stripe TEST only
Every API name flagged "VERIFY" in the source specs was confirmed against current
`docs.stripe.com` before coding. Results below. **A material spec-vs-Stripe
conflict was found (see §10.4 / BLOCKER) and work was halted per hard constraints.**

---

## §10.1 — OAuth for existing (Standard) accounts
- **Confirmed mechanism:** Stripe Connect OAuth is still supported for connecting
  existing **Standard** accounts.
  - Authorize URL: `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=<CONNECT_CLIENT_ID>&scope=read_write&state=<signed_shop_id>`
  - Token exchange: `POST https://connect.stripe.com/oauth/token`
    with `grant_type=authorization_code&code=<code>` → returns `stripe_user_id`
    (the connected account ID).
  - SDK: `stripe.oauth.token({ grant_type: 'authorization_code', code })`.
- After connect, verify capabilities via `stripe.accounts.retrieve(acct_id)` →
  `capabilities.card_payments === 'active'` && `capabilities.transfers === 'active'`.
- **Note:** Stripe now also offers embedded/controller-based onboarding for
  existing accounts, but classic OAuth remains valid and is the lowest-friction
  path for a merchant who already has Stripe. Kept OAuth for Path A.
- **BLOCKER (secrets):** `STRIPE_CONNECT_CLIENT_ID` and `STRIPE_OAUTH_REDIRECT_URL`
  are **NOT present** in Supabase secrets (confirmed via `supabase secrets list`).
  The OAuth round-trip cannot be tested until these are added. Connect must also be
  enabled on the platform account and the redirect URI registered in the Stripe
  Connect settings.

## §10.2 — Embedded onboarding component + SDK init
- **Confirmed component:** `account-onboarding` (Connect embedded components).
- **Flow:**
  1. Create connected account (`stripe.accounts.create(...)`).
  2. Create an **Account Session**: `stripe.accountSessions.create({ account: acct_id, components: { account_onboarding: { enabled: true } } })` → returns `client_secret`.
  3. Front end mounts via `@stripe/connect-js` + `@stripe/react-connect-js`:
     `loadConnectAndInitialize({ publishableKey, fetchClientSecret })` then the
     `<ConnectAccountOnboarding />` component.
- Server returns `{ account_id, client_secret }` for the wizard to mount. (Wizard
  UI itself is spec 05; spec 01 only provides the session.)

## §10.3 — Express controller / fee-payer / loss-owner / dashboard
- **Confirmed (Accounts v1 `controller` properties):**
  - `controller.fees.payer` — `'account'` | `'application'`
  - `controller.losses.payments` — `'stripe'` | `'application'`
  - `controller.stripe_dashboard.type` — `'express'` | `'none'` | `'full'`
  - `controller.requirement_collection` — `'stripe'` | `'application'`
- For an Express-equivalent account: `stripe_dashboard.type='express'`, and Stripe
  **requires** `losses.payments='application'` and `fees.payer='application'` when
  dashboard is `express`.
- Account creation: `stripe.accounts.create({ controller: {...}, capabilities: { card_payments: { requested: true }, transfers: { requested: true } }, business_profile: { mcc: '5812' }, country: 'US', email, company/individual prefill })`.
  (Spec allows either `type:'express'` or controller properties; controller
  properties are the current recommended path and are backwards compatible.)

## §10.4 — Charge parameters (application_fee_amount / transfer_data.destination / on_behalf_of)
- **Confirmed names (Checkout Session):**
  - `payment_intent_data.application_fee_amount` (integer cents) ✅
  - `payment_intent_data.transfer_data.destination` (connected acct id) ✅ — this is what makes it a **destination charge**
  - `payment_intent_data.on_behalf_of` (connected acct id) ✅ — sets the **settlement merchant**
- All three names are current and correct.

### ⛔ BLOCKER — economic model conflict (load-bearing)
The spec's stated economics are **not achievable with a destination charge**:

> Spec/canonical §4: *"SprintAI keeps the full $0.99 application fee — it is not
> eroded by Stripe's processing cut"* and *"the restaurant bears the processing fee."*

Stripe docs state explicitly, in two places, that this is impossible for
destination charges:

1. Create destination charges (Checkout): *"Your account balance [the **platform**]
   is debited for the cost of the Stripe fees, refunds, and chargebacks… The
   `application_fee_amount` is then transferred back to the platform, and **the
   Stripe fee is deducted from the platform's amount.**"*
2. Connected-account configuration / `controller.fees.payer`: *"Defines who collects
   payment fees **for direct charges**… **(For destination [or separate] charges,
   Stripe always collects fees from your platform.)**"*

**What `on_behalf_of` actually does** (verified): it sets the *settlement merchant* —
i.e. whose statement descriptor the diner sees, the settlement currency/country, and
the fee *structure* country. It does **NOT** shift who pays the Stripe processing fee.
On a destination charge the **platform (Sprint) always pays the Stripe processing
fee**, no matter what `on_behalf_of` or `controller.fees.payer` are set to.

**Impact (US standard pricing 2.9% + $0.30):** On a typical $30 food order
(charged $30.99 incl. the $0.99 fee), Stripe's processing fee ≈ `$30.99 × 2.9% +
$0.30 = $1.20`. Stripe debits that **$1.20 from Sprint's platform balance**. Sprint
collects `application_fee_amount = $0.99` but nets **−$0.21 per order** under the
spec as written. The "$0.99 profit engine" runs at a **loss** on every order with the
current charge structure.

**Resolution requires a product/economics decision (escalated — not a code choice):**
- **Option A — raise `application_fee_amount`** to cover processing + the intended
  $0.99 margin (e.g. fee = `$0.99 + ceil(total × 2.9% + $0.30)`), and disclose that
  amount to the diner up front. Keeps Sprint margin intact; diner pays more; still
  not labeled a card surcharge (it's Sprint's service fee).
- **Option B — switch to DIRECT charges** (`stripe.charges`/PaymentIntent created
  **on** the connected account via the `Stripe-Account` header, with
  `application_fee_amount`). With **direct charges**, `controller.fees.payer='account'`
  genuinely makes the **connected account (restaurant) bear the Stripe fee**, and
  Sprint keeps the full `application_fee_amount` — which is the exact economics the
  canonical spec describes. **However** direct charges change the money-transmitter /
  merchant-of-record posture vs. the destination-charge design that §7 chose
  deliberately for MTL avoidance — so this is a legal-review fork, not a builder call.
- **Option C — recover the fee via the $49/mo subscription** and accept the per-order
  loss, treating $0.99 as a loss-leader. Contradicts "the $0.99 is the profit engine."

**I did not pick one.** Per hard constraints ("If a spec is ambiguous or Stripe
differs from spec, STOP and report rather than guess"), I halted before writing the
charge code in spec 02. Spec 01 (account creation + state machine) does not depend on
this and can proceed once the controller economics intent (A vs B) is confirmed,
because the controller `fees.payer` value chosen at **account creation time** must
match whichever charge model is approved.

## §10.5 — ACH pricing (informational, spec 03)
- Confirmed Stripe ACH Direct Debit: **0.8%, capped at $5.00** — matches canonical
  spec assumption. (Not built here; spec 03.)

---

## Environment / secrets status (Supabase)
| Secret | Present? | Needed for |
|---|---|---|
| `STRIPE_SECRET_KEY` | ✅ | all (must be a **test** key — confirm value is `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | ✅ | webhook sig verify (must be the **test** endpoint secret) |
| `STRIPE_CONNECT_CLIENT_ID` | ❌ **MISSING** | OAuth Path A (`connect-oauth`) |
| `STRIPE_OAUTH_REDIRECT_URL` | ❌ **MISSING** | OAuth Path A redirect/callback |

> Could not confirm whether `STRIPE_SECRET_KEY` is test vs live without printing the
> value (which is forbidden). **Jason/lead must confirm the configured key is a TEST
> key before any account creation runs**, since these functions will create real
> connected accounts in whatever mode the key targets.
