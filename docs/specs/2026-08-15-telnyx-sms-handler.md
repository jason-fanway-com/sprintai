# Spec — Telnyx SMS handler in chat-sms

**Date:** 2026-08-15
**Owner:** John Walsh (build) → Melvin (verify)
**Why:** The app has zero Telnyx code. `chat-sms` is Twilio-only in both directions;
`TELNYX_API_KEY` is unused in the repo. Twilio is dead (EIN reject 18602). SMS +
number provisioning now run on Telnyx (brand `BJ8MUGY`, campaign `CSMB9HG`). Until
the app can receive a Telnyx webhook and send via the Telnyx API, no shop can take
an SMS order and the required delivery test cannot run. Build this so we are ready
the instant the campaign clears Telnyx approval (currently blocked, err 10036).

Read first: `docs/telnyx-integration-runbook.md` (wiring) and
`docs/10dlc-compliance-obligations.md` (binding behaviour — treat as law).

## Scope

Add full Telnyx inbound + outbound support to
`supabase/functions/chat-sms/index.ts`, alongside the existing Twilio path,
without breaking the web-chat test path or demo shops. Provider is selected by a
single switch; keep the Twilio code intact behind it for rollback.

**In scope**
1. Parse Telnyx inbound webhooks and drive the same conversational flow the
   Twilio SMS path drives today.
2. Send outbound (both conversational replies and shop-initiated order
   notifications) via the Telnyx Messages API.
3. Graceful handling of a send blocked by opt-out (Telnyx rejects it): no crash,
   no retry loop, opt-out state persisted.
4. Accept Telnyx delivery-receipt (DLR) webhooks without error.

**Out of scope (flag as follow-ups, do NOT build here)**
- Rewriting `provision-number` to Telnyx (it is still Twilio/simulated).
- Per-shop `sms_provider` column / mixed-provider routing. Not needed while
  Telnyx is the only live provider — a global switch generalizes fine.

## Design

### Provider resolution
- Add `resolveSmsProvider()` → returns `"telnyx"` when `TELNYX_API_KEY` is set,
  else `"twilio"`. Single source of truth. Since Telnyx is the only live
  provider, this makes every shop behave identically (works for shop #1 and
  #10,000 — SOUL generalization rule).
- **Reply-to-inbound ALWAYS mirrors the provider the inbound arrived on** — a
  Telnyx inbound is answered over Telnyx regardless of the global switch. This
  prevents cross-provider mismatch.

### Inbound routing (`Deno.serve` handler, ~L1678)
Current: `isSms` = content-type `application/x-www-form-urlencoded` (Twilio);
everything else falls to the JSON web-chat branch.

Telnyx also POSTs `application/json`, so the JSON branch must disambiguate
**before** the web-chat parse:
- If the JSON body has `data.event_type` → it is Telnyx. Handle here.
- Else → existing web-chat `{shop_id, message, session_id}` path, unchanged.

Telnyx inbound payload shape (`webhook_api_version: "2"`):
```
data.event_type            // "message.received" | "message.sent" | "message.finalized"
data.payload.from.phone_number   // consumer (E.164)
data.payload.to[0].phone_number  // the shop's SprintAI number (E.164)
data.payload.text                // message body
data.payload.id                  // Telnyx message id (use for dedup = messageSid)
```
- `message.received` → normalize into the SAME variables the Twilio branch sets
  (`shop`, `customerPhone`, `userMessage`, `sessionId="sms:<from>"`,
  `channel="sms"`, `messageSid`, `inboundReplyCtx`) and fall through to the
  identical downstream conversational logic. Shop lookup by
  `to` number against `shops.phone_number_e164` (same as Twilio).
- Any non-`message.received` event (DLR: `message.sent`/`message.finalized`/
  failure) → persist status if a message log exists, else `console.log`; return
  200. Never run order logic on a DLR.
- STOP/HELP/START keyword handling: reuse the exact same whole-message matching
  the Twilio branch uses (`SET.has(upper)` — whole message only, so
  "I want to cancel this order" is NOT an opt-out). Send the replies via the
  inbound provider (Telnyx here).

### Outbound — `sendSmsViaTelnyx`
Mirror `sendSmsViaTwilio` exactly: same signature, same `guardedSend(ctx, deliver)`
wrapper (do NOT bypass the outbound guard/watchdog). Only the deliver closure changes:
```
POST https://api.telnyx.com/v2/messages
Authorization: Bearer $TELNYX_API_KEY
{ "from": <shop number>, "to": <consumer>, "text": <message> }
```
Introduce one dispatcher `sendSms(ctx, provider, from, to, msg)` that routes to
Telnyx or Twilio. Replace the ~15 `sendSmsViaTwilio(...)` call sites with
`sendSms(ctx, replyProvider, ...)`. `replyProvider` = inbound provider for
reply-to-inbound; `resolveSmsProvider()` for shop-initiated sends
(order notifications, ~L1584/1608).

Response body: Telnyx only needs any 2xx as ack; the reply is sent via API, not
the response body. `emptyTwiml()` returns 200 — reusing it for Telnyx is
acceptable. Do not build a TwiML/JSON branch unless a real need appears.

### Blocked send (compliance test step 7)
When Telnyx rejects an outbound because the recipient opted out, `POST /messages`
returns a 4xx with an error code. `sendSmsViaTelnyx` MUST:
- Not throw uncaught, not retry.
- Detect the opt-out/blocked error, persist the per-(number, shop) opt-out state
  the app already tracks, and log the exact Telnyx code + body.
- Return cleanly so the handler finishes 200.

### Compliance texts — use the EXACT registered strings
The campaign registration (TCR `CSMB9HG`) defines these verbatim. The app's
keyword replies MUST match the registration. Use these strings:
- **HELP** (`helpKeywords: HELP,INFO`):
  `SprintAI text ordering. Text your order to this number to order from this restaurant. Message frequency varies by order, typically 3-8 messages per order. Support: support@getsprintai.com. Msg & data rates may apply. Reply STOP to opt out.`
- **STOP** (opt-out confirm):
  `SprintAI: You've been unsubscribed and will receive no further messages from this restaurant. Reply START to opt back in.`
- **START / UNSTOP** (opt-in):
  `SprintAI: Thanks for texting! You'll receive order-related messages from this restaurant. Message frequency may vary. Msg&data rates may apply. Reply HELP for help, STOP to opt out.`
- Opt-out keywords (whole-message match only): `STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT`.
- First-contact: the first reply to a new consumer MUST carry the msg & data
  rates disclosure + `Reply HELP for help` + `Reply STOP to opt out`
  (existing disclosure append at ~L452 — confirm it satisfies compliance §3).
- Never emit CANCEL/END/QUIT/STOP as a user instruction except the mandatory STOP
  disclosure; if offering an escape, use safe words (CHANGE / NEVERMIND).

## Acceptance criteria (Melvin verifies)
1. A simulated Telnyx `message.received` webhook (JSON, `data.event_type`) to
   chat-sms is parsed, matched to a shop by the `to` number, and drives a
   conversational reply — same behaviour as the Twilio form path. Prove with a
   local invocation / unit test using a captured Telnyx payload shape.
2. Web-chat JSON path (`{shop_id, message, session_id}`) is UNCHANGED — regression
   test passes.
3. Twilio form path still compiles and routes (no behavioural change) behind the switch.
4. Outbound over Telnyx hits `POST https://api.telnyx.com/v2/messages` with bearer
   auth and `{from,to,text}`, wrapped in `guardedSend` (guard not bypassed).
5. STOP / HELP / START whole-message matching works over Telnyx and returns the
   EXACT registered strings above. "I want to cancel this order" does NOT opt out.
6. A blocked/opt-out send: `sendSmsViaTelnyx` does not throw or retry, persists
   opt-out, logs the Telnyx code, handler returns 200.
7. DLR webhook (`message.finalized`) returns 200 and does not run order logic.
8. `deno check`/typecheck passes on chat-sms. No secrets committed.

## Report back (to the lead)
Result + files changed + how each acceptance criterion was exercised + any
open questions. Not a transcript. Do NOT deploy — the lead integrates and the
campaign is still blocked Telnyx-side, so there is nothing to test live yet.
