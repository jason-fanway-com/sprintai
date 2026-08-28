# SprintAI — 10DLC Compliance Obligations (Implementation Handoff)

**For:** the SprintAI OpenClaw agent that builds and maintains SprintAI / getsprintai.com
**From:** Jason (via Claude, Mac side)
**Date:** 2026-08-28 (updated after Telnyx SE call with Chris — corrections to ISV model, throughput, and send-gate)
**Status of registration:** APPROVED by all carriers

---

## Why this document exists

SprintAI's A2P 10DLC campaign is registered and approved with TCR and all seven MNOs. That registration is a set of **binding declarations about how the system behaves**. Everything below is something we told the carriers we do; the implementation must actually do it. Divergence is a compliance violation — penalties are campaign suspension or brand blacklisting, which takes the whole product offline with no quick appeal.

**Treat this file as a spec, not guidance.**

## ⚠️ 2026-08-28 CORRECTIONS (Chris, Telnyx SE)

### Correction 1: No ISV/reseller re-registration needed
"there is no real reseller or ISV tag on 10DLC currently — right now it's the same for everyone." The `isReseller: false` and `brandRelationship: BASIC_ACCOUNT` fields on brand BJ8MUGY are irrelevant. Do not change them. The prior ISV re-registration freeze is lifted — there is nothing to fix.

### Correction 2: Throughput is per-campaign, not pooled
T-Mobile: 2,000 segments/day **per campaign** (not platform-wide). AT&T: 240 TPM **per campaign**. At ~300-400 orders/month per shop, 20-30x headroom. External brand vetting to raise T-Mobile tier is unnecessary.

### Correction 3: The send gate is mapping status, NOT campaignStatus
`campaignStatus` and `operationStatus` both read APPROVED while sends were blocked for a week. The authoritative check:
```
GET /v2/10dlc/phone_number_campaigns/{phoneNumber}
```
Both `tmobileNumberMappingStatus` AND `nonTmobileNumberMappingStatus` must return `ADDED`. Anything else = do not send. Build this as the provisioning gate.

## The registration model (per-merchant)

```
Telnyx ACCOUNT (SprintAI, the ISV layer — gets no 10DLC approval)
  └── BRAND per merchant (requires that merchant's EIN)
        └── CAMPAIGN per brand (CUSTOMER_CARE)
              └── NUMBER assigned to campaign → carrier approval per number
```

Timings: brand ~2 hours, campaign 48-72 hours, carrier mapping per number ~minutes to 2 hours (the real bottleneck).

Demo numbers: use SprintAI's own brand (BJ8MUGY) with disclosure "demo by SprintAI" in message text + a demo page on getsprintai.com. Do not impersonate a real shop without disclosure — TCR detects it.

Per-merchant CTA pages at `getsprintai.com/<shop-slug>` are CONFIRMED ALLOWED.

## The SprintAI registration

| Field | Value |
|---|---|
| Provider | Telnyx |
| Brand | SprintAI (SprintAI LLC) |
| TCR Brand ID | `BJ8MUGY` |
| TCR Campaign ID | `CSMB9HG` |
| Telnyx Campaign ID | `4b30019f-fc16-9471-9d17-5533e185444c` |
| Use case | CUSTOMER_CARE |
| Carrier status | AT&T, T-Mobile, Verizon, US Cellular, Interop, ClearSky, Liberty — all APPROVED |
| AT&T throughput | 240 TPM per campaign |
| T-Mobile throughput | 2,000 segments/day per campaign |
| Renewal | 2026-11-13 |

---

## 1. Keyword handling — MUST be implemented exactly

Registered keyword sets. Case-insensitive; work regardless of surrounding whitespace/punctuation.

**Opt-out — registered:** `STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT`
On any of these from a consumer number: (1) immediately stop all further messages to that number for that shop; (2) send the registered opt-out confirmation once (§3); (3) send nothing further until they opt back in. Opt-out persists across orders, sessions, restarts, deploys. Not a per-conversation flag.

> **Telnyx enforces this at the platform level — not your app.** Telnyx detects stop words, adds the number to an opt-out list, auto-sends a generic unsubscribe reply, and blocks subsequent sends. Your app still receives the inbound webhook (can observe) but cannot message afterwards.
>
> **Matching is whole-message only.** `stop all` recognised; `please stop all messages` not. `I want to cancel this order` does NOT opt out. Case-insensitive.
>
> **Real risk: bare keywords as replies** — a customer replying single word `cancel`/`end` gets opted out of the whole program. Mitigation (required): never print `CANCEL`, `END`, `STOP`, `QUIT`, `UNSUBSCRIBE` as an instruction anywhere except the mandatory STOP disclosure. Always offer a non-keyword alternative, e.g. "Reply YES to confirm, CHANGE to edit, or NEVERMIND to drop it."
>
> Telnyx recognised list: `stop, stopall, stop all, unsubscribe, cancel, end, quit`. Opt back in: `start, unstop`. Do NOT fix by removing keywords from the registered set — escalate to Jason first.

**Help — registered:** `HELP, INFO` → registered help message (§3). Must work even for opted-out numbers.

**Opt-in / resume — registered:** `START, UNSTOP` → clears opt-out, resumes service, send registered opt-in confirmation (§3).

## 2. Opt-in model — consumer-initiated only

Declared: inbound message = opt-in for order-related replies only; no numbers purchased/rented/shared; no messages to consumers who haven't messaged first.

- **Never message a number that has not texted us first.** No imports, uploaded lists, POS/reservation/loyalty/shop-provided lists.
- **Consent is per shop.** Opt-in state keyed on (consumer number, shop).
- **Order-related content only** — menu, order building, payment links, confirmations, pickup/status. NOT promotions, win-backs, "we miss you", loyalty, review requests, upsells.

> ⚠️ **ARCHITECTURAL CONSTRAINT — one messaging profile per shop.** Telnyx opt-out blocks are scoped to the **messaging profile**, not the number. Shared profile → STOP to one shop blocks every shop. Profiles are free; numbers from many profiles can attach to the same campaign. One profile per shop is the required architecture.

Existing repo guards (`BUILD-NOTES-kill-unsolicited-outbound.md`, `BUILD-NOTES-outbound-watchdog.md`) — verify they enforce per-shop consent scoping and opt-out persistence.

## 3. Registered message texts

Use these, or text carrying every element they carry. Do not drop elements to save segments.

**Opt-out confirmation:**
> You've been unsubscribed and will receive no further messages from this restaurant. Reply START to opt back in.

**Help response:**
> SprintAI text ordering. Text your order to this number to order from this restaurant. Message frequency varies by order, typically 3-8 messages per order. Support: support@getsprintai.com. Msg & data rates may apply. Reply STOP to opt out.

**Opt-in / first-contact confirmation:**
> Thanks for texting! You'll receive order-related messages from this restaurant. Message frequency may vary. Msg&data rates may apply. Reply HELP for help, STOP to opt out.

**First-contact disclosure is mandatory.** On the first message to a consumer number in a conversation, the reply must include: the msg & data rates disclosure, `Reply HELP for help`, `Reply STOP to opt out`. Cannot be dropped for brevity.

## 4. Registered message samples

Carriers approved these four. Production traffic must be recognisably the same kind of content.
1. `Thanks for texting Tony's Pizza! Reply with your order and we'll get it started. Msg&data rates may apply. Reply HELP for help, STOP to opt out.`
2. `Got it - 1 large pepperoni and a 2L Coke. Total $24.18 for pickup. Reply YES to confirm or tell us what to change.`
3. `Order confirmed at Tony's Pizza. Pickup at 6:45pm, 123 Main St. Pay here: https://pay.getsprintai.com/o/8Kd2 Reply STATUS anytime for an update.`
4. `Your order at Tony's Pizza is ready for pickup. Thanks! Reply STOP to opt out.`

Constraint is on **category** (order-taking, confirmation, payment, status), not wording. Any new category of outbound = a registration change, not a feature.

**For per-merchant campaigns:** submit the maximum 5 sample messages, be elaborate. Reviewers want the spirit of the traffic, not literal matching. Include opt-out language in at least one sample.

## 5. Declared content types

| Declared | Value | Meaning |
|---|---|---|
| `embeddedLink` | true | Links permitted — payment, menus, receipts |
| `embeddedPhone` | true | Phone numbers in bodies permitted |
| `numberPool` | true | Many numbers under one campaign (one per shop) |
| `ageGated` | false | Must NOT send age-gated |
| `directLending` | false | Must NOT send lending/credit |
| `affiliateMarketing` | false | Must NOT send affiliate marketing |

Use branded domain `pay.getsprintai.com`. No public shorteners.

## 6. Number provisioning

- Every sending number assigned to a campaign (unassigned = filtered).
- `numberPool` true → one number per shop is the registered architecture.
- A shop's number must only ever send for that shop.
- **Send gate:** after assignment, poll `GET /v2/10dlc/phone_number_campaigns/{phoneNumber}` until both `tmobileNumberMappingStatus` AND `nonTmobileNumberMappingStatus` = `ADDED`. Number is not live until both read ADDED.

## 7. Scaling limits

- T-Mobile: 2,000 segments/day per campaign — 20-30x headroom at pilot volumes.
- AT&T: 240 TPM per campaign — queue and pace.
- Per-merchant campaigns mean scaling limits are per-shop, not platform-wide.

## 8. Changes that require re-registration (escalate to Jason first)

- Changing any opt-in/opt-out/help keyword.
- Changing how consent is obtained (anything other than consumer-texts-first).
- Sending a new category of message (marketing, promo, win-back, review, loyalty).
- Sending declared-false content (age-gated, lending, affiliate).
- Changing the published call-to-action on getsprintai.com.

### The website CTA is part of the registration
The CTA at https://getsprintai.com is quoted verbatim in the filing. Carriers re-fetch and verify. Must contain **all six** elements:
1. A specific path to opt in (text this number)
2. `Reply HELP for help`
3. `Reply STOP to opt out`
4. `Message frequency varies by order, typically 3-8 messages per order.`
5. `Msg & data rates may apply`
6. A working link to https://getsprintai.com/privacy

**First MNO submission was rejected (code 806) solely because element 4 was missing.** Any edit risks re-rejection of a live campaign. Treat both homepage disclosure blocks as compliance-critical code.

### Per-merchant CTA pages
Each merchant gets a CTA page at `getsprintai.com/<shop-slug>` with the same 6 elements, branded to that merchant. These are part of the per-merchant campaign registration — carriers verify them.

## 9. Verification checklist (before first send, and after any messaging-logic change)

- [ ] Each of STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT halts messaging and returns the opt-out confirmation.
- [ ] Opt-out persists across restart and redeploy.
- [ ] Opt-out scoped per (consumer number, shop) — via messaging-profile-per-shop, not just app state.
- [ ] No flow prints CANCEL/END/STOP/QUIT/UNSUBSCRIBE as an instruction, except the mandatory STOP disclosure.
- [ ] Confirmation prompts offer a safe alternative word (CHANGE / NEVERMIND).
- [ ] HELP and INFO return registered help text, including for opted-out numbers.
- [ ] START and UNSTOP resume service.
- [ ] First reply to a new number contains rates disclosure + HELP + STOP.
- [ ] No code path can send to a number with no prior inbound message.
- [ ] All sending numbers assigned to a campaign.
- [ ] `tmobileNumberMappingStatus` AND `nonTmobileNumberMappingStatus` both `ADDED` for each sending number before first send.
- [ ] No public URL shorteners in outbound.
- [ ] Live homepage contains all six CTA elements: `curl -s https://getsprintai.com/ | grep -c 'Message frequency varies by order'` → 2
- [ ] Per-merchant CTA page at `getsprintai.com/<shop-slug>` contains all six CTA elements.

---

## Open items (Jason)

- Campaign CSMB9HG failed number assignment (error 10036). Can be converted to a testing campaign. Production flow uses per-merchant brands/campaigns.
- Twilio remains blocked at business-profile verification — Telnyx is the working path.