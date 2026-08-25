# BUILD NOTES — Payment Links, Compliance & Segment Economics

Date: 2026-08-22 (uncommitted as of this writing)

---

## Short Branded Payment Links

### What changed
- **`pay_links` table** (`supabase/migrations/056_add_sms_opt_outs.sql`): `cart_id`, `short_code`, `stripe_url`, `created_at`. Stores the mapping from an 8-char short code to a full Stripe Checkout URL.
- **`pay-redirect` edge function** (`supabase/functions/pay-redirect/index.ts`): Public, no-JWT. Looks up `short_code` in `pay_links`, issues a 302 redirect to the Stripe URL. Supports both query-string (`?code=X`) and path-style (`/o/X`) routing — the Netlify rewrite feeds it via path.
- **Short-code generation** in `chat-sms` checkout path (`executeTool` `checkout_order`): After creating a Stripe Checkout Session, generates an 8-char hex short code from `crypto.randomUUID()`, inserts the row into `pay_links`, and emits `https://pay.getsprintai.com/o/<code>` as the `checkoutUrl`.
- **`checkoutUrl` in chat-sms** now emits the branded short URL, not the raw Stripe URL. The Stripe URL is stored as the fallback — if `pay.getsprintai.com` DNS or the edge function is down, the raw Stripe URL can be retrieved from `pay_links.stripe_url`.

### Why
The raw Stripe Checkout URL (`https://checkout.stripe.com/c/pay/cs_live_...`) is ~612 characters = 4–5 SMS segments before the bot reply adds its own text. An 8-message checkout could burn 7+ segments on the link alone. The branded link `pay.getsprintai.com/o/abc12345` is 35 characters = fits inside the bot's reply in a single segment.

Also: the registered 10DLC campaign sample messages specify a `pay.getsprintai.com` link. The carriers approved that sample. Production traffic must match what was approved — raw `checkout.stripe.com` URLs are not in the approved campaign sample and could trigger carrier filtering. Public URL shorteners (bit.ly, tinyurl, etc.) are prohibited entirely — carriers actively block them.

Key details:
- The Stripe URL is stored as a fallback in `pay_links.stripe_url`.
- `pay_links` has no expiry column yet — it lives as long as the row exists. RLS is TBD.
- The `pay-redirect` function uses the service-role key to read `pay_links`, so the table must not be anon-readable.

---

## Domain and Routing

### Netlify
- New redirect in `netlify.toml`: `/o/*` → `https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/pay-redirect/o/:splat` with `status = 302`, `force = true`.
- Uses 302 (not a proxy/200 rewrite) because the target itself 302s to Stripe — a proxy would swallow the Stripe redirect and hide it from the handset.
- `pay.getsprintai.com` registered as a Netlify domain alias on the `sprintai-dev` site.

### DNS
- **Was:** GoDaddy CNAME `pay` → `paylinks.commerce.godaddy.com` (GoDaddy Commerce / Poynt product — unrelated, a leftover from some prior project).
- **Now:** GoDaddy CNAME `pay` → `sprintai-dev.netlify.app`.
- Verified chain: `pay.getsprintai.com/o/<code>` → Netlify → 302 → Supabase `pay-redirect` → 302 → Stripe Checkout. Valid SSL at every hop.

### Supabase custom domain considered, rejected
The initial plan was to register `pay.getsprintai.com` as a Supabase custom domain under Edge Functions → Custom Domains and have the function serve directly. This was rejected because:
1. Supabase custom-domain coverage for edge functions is uncertain — docs are thin and the path isn't well-traveled.
2. Netlify already terminates SSL for `getsprintai.com` and its aliases (`pay.getsprintai.com`). Adding a 302 redirect rule is a one-line config change vs. an experimental Supabase feature.
3. If the Supabase custom domain route breaks, the Netlify path is the fallback anyway.

---

## Compliance

### Lifetime first-contact disclosure
The compliance footer ("Msg & data rates may apply. Reply HELP for help, STOP to unsubscribe.") is REQUIRED by 10DLC carriers on the first outbound message to a consumer. Before today, it was injected by the system prompt on every single reply — 232 chars of dead weight per message.

**Now:** The disclosure is code-driven, not prompt-driven. `isLifetimeFirstContact` queries `conversations` for any prior row with this `(tenant_id, customer_phone)` pair. If any exists — even from months ago — this is NOT a first contact and the footer is stripped from the reply via regex before send. On a return session this cuts ~183 chars, bringing a 232-char reply to ~49 chars. This is a structural change that saves 1-2 segments on every subsequent session.

The regex-based stripping is defensive — it matches several known disclosure phrasings, including Telnyx-registered variants. If the footer phrasing ever changes (e.g., by carrier mandate), the regex needs updating but nothing else does.

### SAFE WORDS rule — "cancel" is banned from instructions
**The word "cancel" is a registered opt-out keyword** (CANCEL, CANCEL ALL) enforced by Telnyx at the platform level. If a customer types "cancel" as a standalone message, Telnyx opt-outs the number from the entire program — SprintAI cannot intercept it, stop it, or reverse it without the carrier's involvement.

**What changed:**
- Added SAFE WORDS rule to the system prompt: at every abandon-or-modify decision point, offer CHANGE (to edit) or RESTART (to begin again). NEVER use the word "cancel" in a prompt or instruction.
- Removed "cancelled" from the checkout restart reply: "Your order has been cancelled" → "Starting fresh."
- Removed `CANCEL` from the checkout `wantsRestart` regex (`/\b(RESTART|START OVER|CANCEL|NEW ORDER)\b/` → `/\b(RESTART|START OVER|NEW ORDER)\b/`). This was unreachable dead code — CANCEL at the beginning of a message is caught by the whole-message STOP handler before the wantsRestart check — but the presence of "CANCEL" in the regex implied behaviour we do not have and could mislead a future reader.

### STOP/HELP/START opt-out persistence
**Previously:** STOP/HELP/START were handled (compliance reply sent) but the opt-out state was not durably persisted in our own database. Telnyx enforced the opt-out at the platform level, but we had no application-level record.

**Now:** `sms_opt_outs` table (migration 056) with UNIQUE constraint on `(tenant_id, customer_phone)`. `upsertOptOut()` is called from:
- Twilio inbound STOP handler
- Telnyx inbound STOP handler
- Telnyx send-rejection path (when Telnyx blocks an outbound send because the number is opted out)
- START handler (clears `opted_back_at`)

The table design:
```sql
tenant_id, customer_phone (UNIQUE), opted_out_at, opted_out_reason, opted_back_at, updated_at
```

START sets `opted_back_at` to now — it doesn't delete the row, preserving the audit trail. The UPSERT handles repeat STOPs idempotently. The function is non-fatal — Telnyx is the authoritative enforcer; this is our application-level record for visibility and cross-checking.

### STOP keyword matching — verified already correct
STOP words are matched on the **whole message, case-insensitive** (uppercased, then checked against a `Set`). The Telnyx-registered STOP keywords are: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT. A message containing "cancel" as part of a longer message ("can I cancel the bagel?") does NOT trigger a STOP because the set membership check is on the whole uppercased message string, not a substring match. This was confirmed correct before today's changes — it did not need fixing.

---

## Segment Cost Work

### Segment counter tooling
Two new scripts in `scripts/test-suite/`:
- **`segments.ts`**: Pure GSM-7/UCS-2 segment counter. Exports `segmentCount()`, `isGsm7()`, `analyzeReplies()`, `countSegments()`. Accepts stdin JSON with `{replies: string[]}`.
- **`segment-count.ts`**: Two-mode measurement tool. `--live <shop_id>` runs a representative 6-7 turn conversation against the live chat-sms endpoint and measures per-turn segment counts. `--db <test_run_id>` reads transcripts from a completed test run via Supabase and computes aggregate stats (per reply and per conversation).

### Baseline measurement
Suite run `17f309c7` (100 cases, 95 passed):
- 344 total segments across all replies
- Mean 3.44 segments per conversation
- But this is misleading: the scripted test suite averages 1.46 turns per case (heavily single-turn dominated — "hi", "add X", "checkout" with no back-and-forth). Real conversational cases (from the 15 multi-turn chat cases in the suite) measured 14-16 segments per full checkout conversation.

### Reductions shipped today
1. **Duplicate payment reminder collapsed** — the checkout-status reply no longer repeats the full "check your texts" message on repeated status checks. First check: "Your payment link was sent — check your texts for it. Reply CHANGE to edit your order or RESTART to start over." Repeat check: "Payment still pending — tap the link we sent to finish. Reply CHANGE to edit or RESTART to start over." Saves ~100 chars per repeat.
2. **Cart restatement trimmed** — system prompt now instructs the LLM to reply with the TOTAL and name prompt, not the full cart line-by-line. "That comes to $11.49. What name for pickup?" vs restating every item.
3. **Checkout confirmation shortened** — "That comes to $11.49. Confirm?" not the full itemised receipt.
4. **Compliance footer stripped after first contact** — saves ~183 chars on every subsequent-session reply (see above).
5. **Payment link shortened** — 612 → 35 chars (see above).

### Why this matters
The business model assumes 8 SMS segments per order at the current Telnyx pricing. Above ~8.8 segments/order, the $0.99 service fee no longer covers the SMS cost — unit economics turn negative. At 14-16 segments (pre-reductions real conversation), the model loses roughly $340K of ten-year operating profit across the projected restaurant base. Every segment cut is direct margin recovery.

The 8-segment target is a model assumption, not an engineering constraint — real segments will be measured continuously via `segment-count.ts --live` after every chat-sms change.

---

## Scope Decision: EIN Required

**SprintAI does NOT sell to sole proprietors. EIN is a required field in onboarding.** A merchant without an EIN fails out of signup cleanly — there is no alternate registration path (no SSN, no "I don't have one" override).

Decision by Jason, permanent. The rationale: the liability, tax, and payment-processing profile of sole proprietors is materially different from LLCs and incorporated businesses, and SprintAI's payment and compliance infrastructure is built for business entities. Supporting sole props would add a parallel compliance track for a segment that is not the target market.

This must not be softened, A/B tested, or "made friendlier" in the UI. EIN is a hard gate.

---

## Standing Constraint: Telnyx Brand/Campaign Freeze

**Do NOT modify the Telnyx brand or campaign registration** until the Telnyx solutions engineer call resolves the ISV mechanics.

- Brand `BJ8MUGY` (SprintAI LLC): **verified**, the only working asset on the account.
- Campaign `CSMB9HG` (Telnyx ID `4b30019f-fc16-9471-9d17-5533e185444c`): **TELNYX_FAILED** — approved by all 7 carriers at the TCR level but Telnyx's platform shows it as failed. The solutions engineer call is to resolve this status and clarify the ISV architecture.
- Each merchant will ultimately need its own brand + campaign (registry policy — 10DLC campaigns are per-business, not per-platform). The current shared campaign is acceptable for the pre-launch period because the platform has zero paying merchants; a shared campaign with live traffic would be a registry violation.
- Any modification to the brand or campaign — name, use-case, sample messages, EIN — before the engineer confirms the current state could reset verification, cost the campaign its carrier approvals, or lock the brand to the wrong entity type.

This freeze applies to all Telnyx Dashboard actions, API calls that mutate brand/campaign resources, and any code that provisions new brands or campaigns.