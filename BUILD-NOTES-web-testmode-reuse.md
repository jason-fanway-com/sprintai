# BUILD-NOTES — fix/web-testmode-and-reuse-window

Two coordinated, surgical fixes so Jason can run a full **order → pay → confirm →
success** test through the web/admin chat, and so stale web conversations stop
welding onto new sessions.

Branch: `fix/web-testmode-and-reuse-window` (off `origin/main` @ `6ea2ef2`).
**Not merged, not pushed, not deployed.**

---

## Files changed (exact line ranges)

| File | Lines (post-edit) | Change |
|---|---|---|
| `supabase/functions/chat-sms/index.ts` | **1359–1366** | Declare `let requestTestMode = false;` (default; SMS never sets it) |
| | **1427** | Add `test?: boolean` to the web request body type |
| | **1439–1447** | Derive `requestTestMode` from `body.test === true` **or** `?test=1` (web path only) |
| | **1463–1476** | FIX 2 — web reuse query gains `status='active'` + `started_at >= now-24h` freshness window; `.single()` → `.maybeSingle()` |
| | **1621–1634** | FIX 1 — `activatingTestMode = keywordTestMode \|\| (requestTestMode && !cart.test_mode)` |
| `admin-dashboard/src/components/ShopChatTest.tsx` | **28–36** | Module-level `WEB_TEST_MODE` = page URL has `?test=1` |
| | **167** | Send `test: true` in the chat-sms body when `WEB_TEST_MODE` |

The other 5 order-path files (`create-checkout`, `refund-order`, `stripe-webhook`,
`toast-order`, `scripts/imsg-bridge.sh`) are **unchanged** — empty `git diff` +
identical md5 (see `proof-web-testmode-reuse/untouched-5-files-md5.txt`).

---

## FIX 1 — Web/iMessage test-mode affordance

**Problem.** The only way to put a cart into test mode was the customer texting
the keyword `TESTMODE`. On the WEB / admin-dashboard chat there was no such
affordance, so Jason's web tests ran with `test_mode=false` → routed to the REAL
`/order-success` page and blocked by business-hours gating. He could not run a
clean end-to-end test.

**Fix.** The web JSON path now honors an explicit, gated `test` signal:
- `{ "test": true }` in the request body, **or** `?test=1` on the function URL.
- Only an explicit boolean `true` (or the literal string `"1"` param) counts —
  `"true"`, `1`, `false`, `0`, `test=true`, absence → all stay `false`.
- This sets the cart's `test_mode=true` with the **identical** effect as the
  `TESTMODE` keyword: `test_mode=true` persisted on the `order_carts` row, cart
  reset to a clean greeting, business-hours gating bypassed, and `success_url` →
  `https://getsprintai.com/order-success-test?cart=...` so a 4242 test payment
  lands on the test success page.
- The `TESTMODE` keyword is **unchanged** and still works on every channel.

**Why it doesn't wipe an in-progress test order.** The web client sends
`test: true` on *every* message of a test session (the flag lives in the page
URL). The keyword path always resets the cart (explicit user intent), but the
web flag only activates **once** — when `cart.test_mode` is not yet set:
`requestTestMode && !cart.test_mode`. After the first turn it's a no-op and the
order builds → checks out → pays → confirms normally through the test pages.

**Client wiring.** `ShopChatTest.tsx` (the admin dashboard "test this shop"
chat — the surface Jason actually uses; it already sends `shop_id` and reads
`data.reply`/`data.checkout_url`) reads `?test=1` from the dashboard page URL
once at module load and appends `test: true` to the body only when present.

### How Jason triggers a web test order (step by step)
1. Open the admin dashboard and navigate to the shop's chat-test view.
2. Append **`?test=1`** to the dashboard URL and load it
   (e.g. `https://<admin-dashboard>/...?test=1`). Click **New conversation** /
   reset so a fresh session starts under the flag.
3. Order normally in the chat. Because test mode is on, the kitchen-closed gate
   is bypassed, so he can test at any hour.
4. When the bot sends the payment link, open it and pay with Stripe test card
   **4242 4242 4242 4242**, any future expiry, any CVC/ZIP. (Works because the
   TEST project's `STRIPE_SECRET_KEY` is `sk_test_`, producing a `cs_test_`
   session.)
5. After payment, you land on **`/order-success-test`**, the webhook flips the
   cart to `confirmed`, and the dashboard chat shows "Payment received! Your
   order is confirmed."

> SMS/iMessage testing still works two ways: the `TESTMODE` keyword on any
> channel, or — for the iMessage bridge specifically — the keyword, since the
> bridge can't add a body flag. No bridge change was needed.

### No-behavior-change proof (real fresh diner)
A normal web/SMS/iMessage diner sends **no** `test` flag and **no** keyword:
- SMS path never assigns `requestTestMode` → stays `false`.
- Web path without the flag → `body.test === true` is false and `?test=1` absent
  → `requestTestMode = false`.
- `activatingTestMode` = `false || (false && …)` = **false** → cart stays
  `test_mode=false` → hours enforced → `success_url` = real `/order-success`.

Proven deterministically in `proof-web-testmode-reuse/logic-proof.ts`
(25/25 assertions pass), with each tested expression copied byte-for-byte from
the source (verified by grep against `chat-sms/index.ts`).

---

## FIX 2 — Web reuse freshness window

**Problem.** The web conversation-reuse query keyed only on `session_id` +
`channel='web'` with **no** freshness/status filter (the SMS branch already
applied a 24h `windowStart` + `status='active'`). A stale prior-day conversation
welded onto a new session forever — annoying Jason and feeding the judge a
multi-day blob (false-critical evals).

**Fix.** The web reuse query now mirrors the SMS branch: reuse only if
`status='active'` **and** `started_at >= now − 24h`; otherwise a new
conversation is created. `.single()` → `.maybeSingle()` so a deliberate
no-match (stale session) returns `null` cleanly instead of throwing/logging.
SMS branch untouched.

**In-window reuse preserved.** A real multi-message web order in one sitting
keeps the same conversation (its `started_at` is within 24h and status active).
Proven in `logic-proof.ts`: active conv 1h/23h old → REUSE; 25h old → NEW;
inactive 1h old → NEW.

---

## Pre-mortem (answered)

**1. Could a real diner trigger test mode / place a free order via `?test=1`?**
The flag is never set by the customer-facing widget and never defaults on. A
malicious visitor *could* in principle send `?test=1`/`{test:true}` to the
function, BUT test mode does **not** make orders free — the Stripe checkout
session is still created with the real line-item totals and must be paid. The
only effects are: hours-gating bypass and routing to `/order-success-test`.
The *real* protection against fake/unpaid orders is the existing
`stripe-webhook` confirm step (a cart only becomes `confirmed` on a real paid
session) — unchanged here.
**Residual risk (called out, not over-engineered):** in production (`sk_live_`)
a crafted `?test=1` would route a genuinely-paid order to the test success page
and bypass hours. It cannot create money out of nothing, but it is "test"
labeling on a live order. We did **not** hard-gate the flag to `sk_test_` keys
because (a) the test surface today is the TEST project (`sk_test_`), and (b)
adding a key-prefix gate touches the checkout path more than warranted for this
task. **Recommendation for the lead:** if/when this rides on a `sk_live_`
project, add a one-line guard so `requestTestMode` is only honored when
`STRIPE_SECRET_KEY` starts with `sk_test_`. Flagged as debt, not shipped.

**2. Could the reuse-window change fragment a real in-progress web order?**
No. The window is 24h and gated on `status='active'`; a single ordering sitting
is far inside it. Proven: in-window active conv → REUSE.

**3. Could touching chat-sms change real diner behavior?**
No. The change is additive and gated on a flag/keyword that the real flow never
sets. Byte-level reasoning + 25 passing assertions show the no-flag path is
identical to today. The 5 other order-path files are md5-identical to
`origin/main`. `deno check` error signatures on `chat-sms` are **identical**
before and after (78–79 pre-existing supabase-js type-inference notes, zero new
categories). `admin-dashboard` `tsc --noEmit` = 0 errors.

---

## Proof artifacts (`proof-web-testmode-reuse/`)
- `logic-proof.ts` — faithful, source-mirrored logic exercise (run with
  `~/.deno/bin/deno run proof-web-testmode-reuse/logic-proof.ts`).
- `logic-proof-output.txt` — saved output: **25 passed, 0 failed**.
- `untouched-5-files-md5.txt` — empty git diff + identical md5 for the 5
  other order-path files.

---

## Lead deploy steps (when approved)
1. **Redeploy the `chat-sms` edge function** to the target project
   (TEST `rvdqfxtrskxekfkqnegx` first for validation):
   `supabase functions deploy chat-sms --project-ref <ref>`
2. **Redeploy the admin-dashboard web client** (so the `?test=1` → `test:true`
   wiring is live): build + deploy `admin-dashboard` per its normal pipeline
   (`npm run build` in `admin-dashboard/`, then publish `dist/`).
3. Validate per "How Jason triggers a web test order" above on the TEST project
   with card 4242.
