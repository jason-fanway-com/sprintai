# SprintAI — Telnyx Integration Runbook

**For:** the SprintAI OpenClaw agent
**Date:** 2026-08-14
**Read with:** `sprintai-10dlc-compliance-handoff.md` — that file defines what the
messaging behaviour must do. This file defines how to wire it up.

---

## 1. What changed, and what you need to know

**We are now using Telnyx for SMS and for phone number provisioning.**

Twilio is blocked. Its business-profile verification has rejected the LLC's EIN
four times with error 18602, across both `42-4226215` and `424226215` formats,
despite that same EIN verifying cleanly at The Campaign Registry through Telnyx.
It is a defect on Twilio's side, still open with their Trust Hub team. Do not
build against Twilio and do not spend time trying to fix it.

**Our 10DLC registration is live and approved on Telnyx:**

| Item | Value |
|---|---|
| Brand | SprintAI (SprintAI LLC) — TCR `BJ8MUGY` |
| Campaign | TCR `CSMB9HG` / Telnyx `4b30019f-fc16-9471-9d17-5533e185444c` |
| Use case | CUSTOMER_CARE |
| Carriers | AT&T, T-Mobile, Verizon, US Cellular, Interop, ClearSky, Liberty — **all APPROVED** |
| AT&T throughput | 240 TPM (shared across all numbers on the campaign) |
| T-Mobile brand tier | LOW — daily volume cap, fine for pilot |

Numbers must be provisioned through Telnyx and assigned to campaign `CSMB9HG`.
A number that is not assigned sends as unregistered traffic and gets filtered.

## 2. Credentials

Auth is a bearer token on every request:

```
Authorization: Bearer $TELNYX_API_KEY
```

Base URL: `https://api.telnyx.com/v2`

**Jason will supply the key separately — do not commit it, and do not accept it
pasted into a chat log.** Store it the same way you store other production
secrets for this project. The key used during setup is being rotated.

## 3. Verified API surface

These were exercised directly against the live account and behave as described.

| Purpose | Call |
|---|---|
| Account balance | `GET /v2/balance` |
| Brand record | `GET /v2/10dlc/brand/{brandId}` |
| Campaign record | `GET /v2/10dlc/campaign/{campaignId}` |
| Campaign update | `PUT /v2/10dlc/campaign/{campaignId}` |
| Per-carrier approval status | `GET /v2/10dlc/campaign/{campaignId}/operationStatus` |
| Carrier metadata / limits | `GET /v2/10dlc/campaign/{campaignId}/mnoMetadata` |
| Number ↔ campaign assignments | `GET /v2/10dlc/phoneNumberCampaign` |
| Messaging profiles | `GET /v2/messaging_profiles` |
| Search available numbers | `GET /v2/available_phone_numbers` |
| Number orders | `GET /v2/number_orders` |

`operationStatus` returns a map of MNO id → status; all seven currently read
`APPROVED`. Use it as the go/no-go check before sending.

**Not yet exercised — confirm request shapes against Telnyx docs before relying
on them:** `POST /v2/messaging_profiles`, `POST /v2/number_orders`,
`POST /v2/10dlc/phoneNumberCampaign`, `POST /v2/messages`.

### Number availability and cost
Verified working search for the Allentown area:

```
GET /v2/available_phone_numbers?filter[country_code]=US&filter[national_destination_code]=610&filter[features][]=sms
```

Returned live 610 numbers at **$1.00/month + $1.00 upfront** each. Always filter
on `features[]=sms`.

## 4. Messaging profile architecture — decide this first

**Telnyx opt-out block rules are scoped to the messaging profile, not the phone
number.** If a consumer texts STOP to any number on a profile, they are blocked
from *every* number on that profile.

With one number per shop, a single shared profile means one STOP blocks that
customer across all of SprintAI. That is unacceptable product behaviour and
contradicts our registered per-shop consent model.

**Intended architecture: one messaging profile per shop.** Profiles are free and
are a Telnyx-side grouping, separate from the TCR campaign — numbers from many
profiles can attach to campaign `CSMB9HG`.

**Before building provisioning:** confirm that multiple messaging profiles can
share one 10DLC campaign. If they cannot, stop and escalate to Jason. Do not
default to the shared-profile model to keep moving.

## 5. Provisioning flow (per shop)

1. **Create a messaging profile** for the shop — `POST /v2/messaging_profiles`.
   Set the inbound webhook URL to the endpoint that feeds the ordering engine.
2. **Search for a local number** in the shop's area code, filtered to SMS.
3. **Order the number** — `POST /v2/number_orders`.
4. **Attach the number to the shop's messaging profile.**
5. **Assign the number to campaign `CSMB9HG`** — `/v2/10dlc/phoneNumberCampaign`.
   Verify the assignment appears in the `GET` before treating the number as live.
6. **Record** shop ↔ number ↔ profile ↔ campaign in our own data model. Do not
   rely on Telnyx as the source of truth for which shop owns which number.

A number is only ready when steps 4 **and** 5 are both confirmed.

## 6. Inbound / outbound wiring

- **Inbound** arrives at the messaging profile's webhook URL. Every inbound
  message — including stop words — is delivered, so the app can observe opt-outs
  even though Telnyx enforces the block itself.
- **Outbound** is `POST /v2/messages`, `from` the shop's number, `to` the
  consumer.
- **Never send to a number that has not messaged that shop first.** See the
  compliance handoff, §2.
- Use the branded link domain (`pay.getsprintai.com`) for payment links. **No
  public URL shorteners** — bit.ly and similar are widely filtered by carriers
  and cause silent delivery failures.
- Pace outbound against the 240 TPM AT&T ceiling, shared across the whole
  campaign. Per-shop throughput falls as shops are added — queue, don't burst.

## 7. First test — required before any shop goes live

Run this end to end and report the results.

**Setup**
1. Create one messaging profile (`sprintai-test`) with the inbound webhook wired
   to the ordering engine in test mode.
2. Provision one 610 number, attach it to that profile, assign it to campaign
   `CSMB9HG`.
3. Confirm assignment via `GET /v2/10dlc/phoneNumberCampaign`.
4. Confirm `GET /v2/10dlc/campaign/{id}/operationStatus` still reads `APPROVED`
   across all seven MNOs.

**Test script** — from a real mobile handset, not a simulator:

| # | Send | Expected |
|---|---|---|
| 1 | Any greeting, e.g. `hi` | Reply includes: msg & data rates disclosure, `Reply HELP for help`, `Reply STOP to opt out`. This first-contact disclosure is mandatory. |
| 2 | A natural order, e.g. `can I get a dozen everything bagels` | Conversational order-building reply |
| 3 | `HELP` | The registered help text (compliance handoff §3) |
| 4 | `I want to cancel this order` | **Must NOT opt out** — whole-message matching only. Normal conversational handling. |
| 5 | Complete an order through to a payment link | Link uses `pay.getsprintai.com`, not a public shortener |
| 6 | `STOP` | Opt-out confirmation; number blocked |
| 7 | Attempt an outbound send to that number | **Must fail** — Telnyx blocks it. Confirm the app handles the failure without crashing or retry-looping |
| 8 | `START` | Service resumes |

**Report back:** message SIDs, delivery status for each, the exact first-contact
reply text, and what the app did on the blocked send in step 7.

**Do not skip step 4 or 7.** Step 4 verifies we haven't broken ordering UX with
opt-out matching. Step 7 verifies we degrade gracefully when Telnyx blocks us —
that path will happen in production.

## 8. Known issues

- `isTMobileRegistered` currently reads `false` even though T-Mobile shows
  `APPROVED`. Likely propagation lag. **Re-check before the first production
  send** and report if it hasn't flipped.
- T-Mobile brand tier `LOW` caps daily volume. Raising it needs external brand
  vetting (~$40 via Telnyx). Do not initiate — flag to Jason when volume nears
  the cap.

## 9. Escalate to Jason before

- Spending anything beyond per-number costs ($1/mo + $1 upfront).
- Any change to the campaign registration.
- Changing opt-in/opt-out/help keyword handling.
- Adopting a shared messaging profile across shops (see §4).
- Sending to any number that has not messaged first.
