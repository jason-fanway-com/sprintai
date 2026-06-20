# Stripe API Verification — Specs 01 & 02

**Builder:** John Walsh · **Date:** 2026-06-20 · **Mode:** Stripe TEST only
Every API name flagged "VERIFY" in the source specs was confirmed against current
`docs.stripe.com` before coding. Results below.

**UPDATE 2026-06-20 (direct-charge rebuild):** The earlier destination-charge
BLOCKER is RESOLVED — the model is now DIRECT charges (confirmed by Jason). All
VERIFY items re-confirmed for the direct-charge variant, including an **empirical**
Stripe API test of the Express controller config. See §§10.3 / 10.4 / 10.6 below.

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

## §10.3 — Express controller config for DIRECT charges (RESOLVED, empirically tested)

**The spec asked us to confirm the exact controller combination for an Express
account doing DIRECT charges with the restaurant bearing fees. We tested it live
with the TEST key.**

### Empirical finding 1 — you CANNOT set `fees.payer='account'` on an express dashboard
Attempting `controller.stripe_dashboard.type='express'` + `controller.fees.payer='account'`
+ `controller.losses.payments='stripe'` is **REJECTED** by Stripe:

> `invalid_request_error`: "When `stripe_dashboard[type]=express`, your platform
> must collect fees and be liable for negative balances or refunds and chargebacks."

So the spec's literal instruction (`controller.fees.payer='account'` on an Express
account) is **impossible**. Recorded here as the authoritative correction.

### Empirical finding 2 — use `type:'express'`, which yields `application_express`
The correct way to get the intended economics (restaurant bears processing +
disputes for DIRECT charges) on an Express-dashboard account is to create it with
**`type: 'express'`**. Stripe assigns such accounts the fee-payer behavior
**`application_express`**. Per
`docs.stripe.com/connect/direct-charges-fee-payer-behavior` (fetched 2026-06-20),
the behavior table for `application_express` on **direct charges** is:

| Product | application_express |
|---|---|
| Stripe payment processing fees | **Connected Account** |
| Dispute fees | **Connected Account** |

That is exactly the intended posture: the **restaurant bears Stripe processing fees
and owns/bears disputes**, and Sprint keeps the full flat `application_fee_amount`
(§10.4). NOTE: `application_express` is NOT a value you can pass at creation — it is
assigned automatically to `type=express` accounts. We therefore create Express
accounts with `type:'express'` and do **not** override the controller.

### Confirmed `controller` property vocabulary (for Standard/OAuth, §10.1)
  - `controller.fees.payer` — `'account'` | `'application'`
  - `controller.losses.payments` — `'stripe'` | `'application'`
  - `controller.stripe_dashboard.type` — `'express'` | `'none'` | `'full'`
  - `controller.requirement_collection` — `'stripe'` | `'application'`
  Standard/OAuth accounts default to `fees.payer='account'` (restaurant bears fees
  on direct charges) — no override needed.

### Express account creation (as built in connect-create-express)
`stripe.accounts.create({ type: 'express', country: 'US', email,
  business_profile: { mcc: '5812', name }, capabilities: { card_payments: {
  requested: true }, transfers: { requested: true } }, metadata: { shop_id } })`.

### Pre-flight blocker for the live capability proof
**Connect is NOT enabled on the test platform account.** Account creation returns:
> "You can only create new accounts if you've signed up for Connect, which you can
> do at https://dashboard.stripe.com/connect."
So the **DIRECT-charge capability proof on a test Express account is BLOCKED** until
Connect is enabled in test mode. The controller question itself is fully resolved
above via the rejection + the docs table.

## §10.4 — DIRECT-charge Checkout Session params (RESOLVED)
**Confirmed against `docs.stripe.com/connect/direct-charges` (web=stripe-hosted), 2026-06-20:**
- Create the Checkout Session **with the `Stripe-Account: <connected_account_id>`
  header** — "This header indicates a direct charge for your connected account."
  In the Stripe Deno SDK this is `connectedAccountOpts(id)` =>
  `{ stripeAccount: id, idempotencyKey }` passed as the 2nd arg to
  `stripe.checkout.sessions.create(params, opts)`.
- `payment_intent_data.application_fee_amount` (integer cents) — confirmed; the
  doc: "After the payment is processed on the connected account, the
  `application_fee_amount` is transferred to the platform." => Sprint keeps the
  full $0.99 whole.
- **NO** `transfer_data.destination` and **NO** `on_behalf_of` — those are
  destination-charge params and are absent by design. (Their names remain valid
  Stripe params; they are simply not used in the direct-charge model.)
- Idempotency: pass `idempotencyKey` in the request options; because the
  `Stripe-Account` header scopes the request to the connected account, the key is
  effectively per-connected-account. We key it on `checkout_<order_cart_id>`.

### Economic correctness (the whole reason for the rebuild)
On a **direct charge** with `application_express`/`account` fee-payer, Stripe debits
the **connected (restaurant) account** for processing, and the `application_fee_amount`
is transferred to the platform intact. So on a $30 order charged $30.99, Sprint nets
the **full $0.99** and the restaurant absorbs the ~$1.20 processing fee as cost of
acceptance — matching the canonical §4. This structurally fixes the −0.21/order loss
that destination charges caused.

### §10.6 — Refund of the application fee (RESOLVED, Jason 2026-06-20)
**Confirmed against `docs.stripe.com` (direct-charges + connect refunds/disputes):**
- "Application fees aren't automatically refunded when issuing a refund." → the
  $0.99 is NOT returned unless we ask.
- To return it on a **FULL** refund, pass **`refund_application_fee: true`** on the
  Refund create call (`stripe.refunds.create({ payment_intent, refund_application_fee:
  true }, { stripeAccount })`). "The application fee refund amount is proportional to
  the payment refund amount."
- **PARTIAL** refunds: we do NOT set it → Sprint keeps the $0.99 (documented in
  `refund-order/index.ts`).
- Refunds on direct charges are created "using your platform's secret key while
  authenticated as the connected account" → i.e. with the `Stripe-Account` header.

### §10.7 — Connected-account webhook delivery shape (RESOLVED)
- For DIRECT charges, `charge.refunded` and `charge.dispute.created` are delivered
  as **connected-account events**: the Stripe `Event` object carries
  **`event.account = <connected_account_id>`** (and the connected-account webhook
  delivery sets the account context). `account.updated` is a **platform-level**
  Connect event (no `event.account` for the platform's own listener routing; the
  account object is in `event.data.object`). The webhook reads `event.account` to
  distinguish the two and routes connected-account order events to the shop by
  `stripe_connected_account_id`. Idempotency is keyed on
  `(event_id, stripe_account)` so platform and connected deliveries never collide.

---

### ✅ RESOLVED (was: BLOCKER) — destination-charge economics, superseded by DIRECT charges
The section below is the ORIGINAL blocker analysis, kept for the decision record.
It is the reason Jason switched the model to direct charges. **No longer blocking.**

#### ⛔ (historical) economic model conflict on destination charges
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
| `STRIPE_SECRET_KEY` (Supabase) | ⚠️ **LIVE** | all functions read this; currently `sk_live_…` |
| `STRIPE_TEST_SECRET_KEY` (.secrets) | ✅ `sk_test_…` | the TEST key used for all verification calls here |
| `STRIPE_WEBHOOK_SECRET` | ✅ | webhook sig verify (confirm it's the **test** endpoint secret) |
| `STRIPE_CONNECT_CLIENT_ID` | ❌ **MISSING** | OAuth Path A (`connect-oauth`) |
| `STRIPE_OAUTH_REDIRECT_URL` | ❌ **MISSING** | OAuth Path A redirect/callback |
| Connect enabled (test mode) | ❌ **NOT ENABLED** | any connected-account creation/charge |

> **⚠️ KEY HYGIENE — ACTION REQUIRED.** The masked prefixes in `~/.openclaw/.secrets`
> show `STRIPE_SECRET_KEY=sk_live_51O8…` (LIVE) and a separate
> `STRIPE_TEST_SECRET_KEY=sk_test_b9d7…` (TEST). The edge functions read
> `STRIPE_SECRET_KEY`, which in Supabase currently resolves to the **LIVE** key.
> **Before any test deploy, repoint Supabase `STRIPE_SECRET_KEY` to the TEST value**
> (and `STRIPE_WEBHOOK_SECRET` to the test endpoint secret). I did NOT run any
> account/charge against the live key. All verification API calls above used
> `STRIPE_TEST_SECRET_KEY` only.
>
> Outstanding to unblock live tests: (1) enable Connect in test mode, (2) add
> `STRIPE_CONNECT_CLIENT_ID` + `STRIPE_OAUTH_REDIRECT_URL`, (3) repoint
> `STRIPE_SECRET_KEY` to test for the deploy.
