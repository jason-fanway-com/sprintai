# SprintAI — 10DLC Compliance Obligations (Implementation Handoff)

**For:** the SprintAI OpenClaw agent that builds and maintains SprintAI / getsprintai.com
**From:** Jason (via Claude, Mac side)
**Date:** 2026-08-14
**Status of registration:** APPROVED by all carriers

---

## Why this document exists

SprintAI's A2P 10DLC campaign is now registered and approved with The Campaign
Registry and all seven mobile network operators. That registration is a set of
**binding declarations about how the system behaves**. The carriers approved us
on the strength of those declarations.

Everything below is something we told the carriers we do. The implementation
must actually do it. Divergence is not a bug — it is a compliance violation, and
the penalties are campaign suspension or brand blacklisting, which would take
the whole product offline with no quick appeal.

**Treat this file as a spec, not as guidance.**

## The registration

| Field | Value |
|---|---|
| Provider | Telnyx |
| Brand | SprintAI (SprintAI LLC) |
| TCR Brand ID | `BJ8MUGY` |
| TCR Campaign ID | `CSMB9HG` |
| Telnyx Campaign ID | `4b30019f-fc16-9471-9d17-5533e185444c` |
| Use case | CUSTOMER_CARE |
| Carrier status | AT&T, T-Mobile, Verizon, US Cellular, Interop, ClearSky, Liberty — all APPROVED |
| AT&T throughput | 240 TPM |
| T-Mobile brand tier | LOW (daily volume cap — see "Scaling limits") |
| Renewal | 2026-11-13 |

---

## 1. Keyword handling — MUST be implemented exactly

These keyword sets are registered. Handling must be **case-insensitive** and must
work regardless of surrounding whitespace or punctuation.

### Opt-out — registered keywords
```
STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT
```
On receiving any of these from a consumer number:
1. Immediately stop all further messages to that number for that shop.
2. Send the registered opt-out confirmation **once** (text in §3).
3. Send nothing further to that number until they opt back in.

An opted-out number must stay opted out. This state persists across orders,
sessions, restarts, and deploys. It is not a per-conversation flag.

> ### Telnyx enforces this at the platform level — not your app
> Telnyx detects stop words itself, adds the number to an opt-out list, auto-sends
> a generic unsubscribe reply, and **blocks your subsequent sends**. Your app
> still receives the inbound webhook, so you can observe the opt-out — you just
> cannot message that number afterwards. Do not assume application-side logic is
> what enforces this.
>
> ### Matching is whole-message only
> Telnyx recognises a stop word **only when it is the entire message**. Per their
> docs: `stop all` is recognised, but `please stop all messages` is not. So
> `I want to cancel this order` does **not** opt anyone out. Normal conversation
> is safe. Assume matching is case-insensitive.
>
> ### The real risk: bare keywords as replies
> The exposure is a customer replying with the single word `cancel` or `end`.
> Our registered sample says *"Reply YES to confirm or tell us what to change"* —
> a customer who changed their mind may well reply just `cancel`, and be opted
> out of the entire program.
>
> **Mitigation — required:** never print `CANCEL`, `END`, `STOP`, `QUIT`, or
> `UNSUBSCRIBE` as an instruction anywhere in the flow except the mandatory
> STOP disclosure. Always offer an explicit non-keyword alternative, e.g.
> *"Reply YES to confirm, CHANGE to edit, or NEVERMIND to drop it."* Given a
> safe word, customers use it.
>
> Telnyx's recognised list: `stop`, `stopall`, `stop all`, `unsubscribe`,
> `cancel`, `end`, `quit`. Opt back in: `start`, `unstop`.
> Do **not** try to fix this by removing keywords from the registered set —
> escalate to Jason first. Re-opening an approved campaign is the riskier move.

### Help — registered keywords
```
HELP, INFO
```
Respond with the registered help message (§3). This must work even for a number
that has opted out.

### Opt-in / resume — registered keywords
```
START, UNSTOP
```
Clears the opt-out state and resumes normal service. Send the registered opt-in
confirmation (§3).

## 2. Opt-in model — consumer-initiated only

We declared to the carriers:

> Sending an inbound message constitutes opt-in for order-related replies only.
> No phone numbers are purchased, rented, or shared, and no messages are sent to
> consumers who have not messaged first.

Hard constraints that follow:

- **Never message a number that has not texted us first.** No imports, no
  uploaded lists, no numbers sourced from POS systems, reservations, loyalty
  programs, or shop-provided customer lists.
- **Consent is per shop.** A customer texting Tony's Pizza has not consented to
  messages from Vito's. Opt-in state is keyed on (consumer number, shop).

  > ⚠️ **ARCHITECTURAL CONFLICT — resolve before building shop provisioning.**
  > Telnyx opt-out block rules are scoped to the **messaging profile**, not the
  > phone number. Per Telnyx: *"If a user opts out from one number on your
  > profile, they're opted out from all numbers on that profile."*
  >
  > If every shop's number sits on one shared messaging profile, a customer
  > texting STOP to one shop is blocked from **every shop on SprintAI**. That is
  > both bad product behaviour and inconsistent with the per-shop consent model
  > described above.
  >
  > **Intended fix: one messaging profile per shop.** Profiles are free and are a
  > Telnyx-side grouping, independent of the TCR campaign — numbers still attach
  > to campaign `CSMB9HG`. **Verify that multiple messaging profiles can share a
  > single 10DLC campaign before building on this**; if they cannot, escalate to
  > Jason rather than defaulting to the shared-profile model.
- **Order-related content only.** The consent we described covers menu
  information, order building, payment links, confirmations, and pickup/status
  notices. It does not cover promotions, win-backs, "we miss you", loyalty
  offers, review requests, or upsells to lapsed customers.

There appear to be existing guards in the repo (`BUILD-NOTES-kill-unsolicited-outbound.md`,
`BUILD-NOTES-outbound-watchdog.md`). **Verify they enforce the above**, in
particular the per-shop scoping of consent and persistence of opt-out state.

## 3. Registered message texts

These are the texts on file with the carriers. Use them, or text that carries
every element they carry. Do not drop elements to save segments.

**Opt-out confirmation:**
> You've been unsubscribed and will receive no further messages from this
> restaurant. Reply START to opt back in.

**Help response:**
> SprintAI text ordering. Text your order to this number to order from this
> restaurant. Message frequency varies by order, typically 3-8 messages per
> order. Support: support@getsprintai.com. Msg & data rates may apply. Reply
> STOP to opt out.

**Opt-in / first-contact confirmation:**
> Thanks for texting! You'll receive order-related messages from this
> restaurant. Message frequency may vary. Msg&data rates may apply. Reply HELP
> for help, STOP to opt out.

### First-contact disclosure is mandatory
On the **first** message to a consumer number in a conversation, the reply must
include:
- the msg & data rates disclosure,
- `Reply HELP for help`,
- `Reply STOP to opt out`.

This is what we told the carriers happens on first contact. It cannot be
silently dropped for brevity.

## 4. Registered message samples

The carriers approved these four samples. Production traffic must be
recognisably the same kind of content.

1. `Thanks for texting Tony's Pizza! Reply with your order and we'll get it started. Msg&data rates may apply. Reply HELP for help, STOP to opt out.`
2. `Got it - 1 large pepperoni and a 2L Coke. Total $24.18 for pickup. Reply YES to confirm or tell us what to change.`
3. `Order confirmed at Tony's Pizza. Pickup at 6:45pm, 123 Main St. Pay here: https://pay.getsprintai.com/o/8Kd2 Reply STATUS anytime for an update.`
4. `Your order at Tony's Pizza is ready for pickup. Thanks! Reply STOP to opt out.`

Since the AI generates message text dynamically, the constraint is on
**category**, not wording: order-taking, confirmation, payment, and status. Any
new *category* of outbound message is a registration change, not a feature.

## 5. Declared content types

| Declared | Value | Meaning |
|---|---|---|
| `embeddedLink` | **true** | Links are permitted — payment links, menus, receipts |
| `embeddedPhone` | **true** | Phone numbers in message bodies are permitted |
| `numberPool` | **true** | Many numbers under one campaign (one per shop) |
| `ageGated` | false | **Must not** send age-gated content |
| `directLending` | false | **Must not** send lending/credit content |
| `affiliateMarketing` | false | **Must not** send affiliate marketing |

Link shorteners: use your own branded domain (e.g. `pay.getsprintai.com`).
**Do not use public shorteners** — bit.ly, tinyurl and similar are widely
filtered by carriers and are a common cause of silent message blocking.

## 6. Number provisioning

- Every sending number must be assigned to campaign `CSMB9HG`. An unassigned
  number sends as unregistered traffic and gets filtered or blocked.
- `numberPool` is declared true, so one number per shop is the registered
  architecture.
- A shop's number must only ever send for that shop.

## 7. Scaling limits

- **T-Mobile brand tier is LOW**, which caps daily message volume. Fine for the
  pilot; a real constraint as shop count grows.
- Raising it requires **external brand vetting** (a paid third-party vet, around
  $40, submitted through Telnyx). Do not initiate this — flag to Jason when
  volume approaches the cap.
- AT&T allows 240 TPM. Throughput is shared across all numbers on the campaign,
  so per-shop throughput falls as shops are added. Queue and pace sends
  accordingly rather than assuming per-number capacity.

## 8. Changes that require re-registration

Escalate to Jason **before** implementing any of these. They invalidate the
current registration and need a campaign update and re-review:

- Changing any opt-in, opt-out, or help keyword.
- Changing how consent is obtained (anything other than consumer-texts-first).
- Sending a new category of message — marketing, promotional, win-back, review
  requests, loyalty.
- Sending content in a declared-false category (age-gated, lending, affiliate).
- Changing the published call-to-action on getsprintai.com.

### The website CTA is part of the registration
The CTA published at https://getsprintai.com is quoted verbatim in our campaign
filing. Carriers re-fetch and verify it. It must continue to contain **all six**
elements:

1. A specific path to opt in (text this number)
2. `Reply HELP for help`
3. `Reply STOP to opt out`
4. `Message frequency varies by order, typically 3-8 messages per order.`
5. `Msg & data rates may apply`
6. A working link to https://getsprintai.com/privacy

**The first MNO submission was rejected (code 806) solely because element 4 was
missing.** Any edit to that block risks re-rejection of a live campaign. Treat
those two disclosure blocks on the homepage as compliance-critical code.

## 9. Verification checklist

Before first production send, and after any change to messaging logic:

- [ ] Each of STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT halts messaging and returns the opt-out confirmation.
- [ ] Opt-out persists across restart and redeploy.
- [ ] Opt-out is scoped per (consumer number, shop) — confirmed by messaging-profile-per-shop, not just app-side state.
- [ ] No flow prints CANCEL/END/STOP/QUIT/UNSUBSCRIBE as an instruction, except the mandatory STOP disclosure.
- [ ] Confirmation prompts offer a safe alternative word (CHANGE / NEVERMIND) instead of inviting "cancel".
- [ ] HELP and INFO return the registered help text, including for opted-out numbers.
- [ ] START and UNSTOP resume service.
- [ ] First reply to a new number contains rates disclosure + HELP + STOP.
- [ ] No code path can send to a number with no prior inbound message.
- [ ] All sending numbers are assigned to campaign `CSMB9HG`.
- [ ] No public URL shorteners in outbound messages.
- [ ] Live homepage still contains all six CTA elements:
      `curl -s https://getsprintai.com/ | grep -c 'Message frequency varies by order'` → 2

---

## Open items (Jason)

- `isTMobileRegistered` reads `false` while T-Mobile shows APPROVED. Confirm it
  flips before first production send.
- Twilio remains blocked at business-profile verification (unrelated to this
  registration) — Telnyx is the working path.
