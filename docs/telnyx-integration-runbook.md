# SprintAI — Telnyx Integration Runbook

**For:** the SprintAI OpenClaw agent
**Date:** 2026-08-14
**Read with:** `10dlc-compliance-obligations.md` — that file defines what the messaging behaviour must do. This file defines how to wire it up.

---

## 1. What changed, and what you need to know

**We are now using Telnyx for SMS and for phone number provisioning.**

Twilio is blocked. Its business-profile verification rejected the LLC's EIN four times with error 18602, across both `42-4226215` and `424226215` formats, despite that same EIN verifying cleanly at The Campaign Registry through Telnyx. Twilio-side defect, still open with their Trust Hub team. Do not build against Twilio; do not spend time fixing it.

**10DLC registration is live and approved on Telnyx:**

| Item | Value |
|---|---|
| Brand | SprintAI (SprintAI LLC) — TCR `BJ8MUGY` |
| Campaign | TCR `CSMB9HG` / Telnyx `4b30019f-fc16-9471-9d17-5533e185444c` |
| Use case | CUSTOMER_CARE |
| Carriers | AT&T, T-Mobile, Verizon, US Cellular, Interop, ClearSky, Liberty — all APPROVED |
| AT&T throughput | 240 TPM (shared across all numbers on the campaign) |
| T-Mobile brand tier | LOW — daily volume cap, fine for pilot |

Numbers must be provisioned through Telnyx and assigned to campaign `CSMB9HG`. An unassigned number sends as unregistered traffic and gets filtered.

## 2. Credentials

Bearer token on every request: `Authorization: Bearer $TELNYX_API_KEY`
Base URL: `https://api.telnyx.com/v2`

Jason supplies the key separately — do not commit it, do not accept it pasted into a chat log. Store as a production secret. The setup key is being rotated.

## 3. Verified API surface

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

`operationStatus` returns MNO id → status; all seven read `APPROVED`. Use as go/no-go before sending.

**Not yet exercised — confirm shapes against Telnyx docs first:** `POST /v2/messaging_profiles`, `POST /v2/number_orders`, `POST /v2/10dlc/phoneNumberCampaign`, `POST /v2/messages`.

### Number availability and cost
`GET /v2/available_phone_numbers?filter[country_code]=US&filter[national_destination_code]=610&filter[features][]=sms`
Returned live 610 numbers at **$1.00/month + $1.00 upfront** each. Always filter `features[]=sms`.

## 4. Messaging profile architecture — decide this first

**Telnyx opt-out block rules are scoped to the messaging profile, not the number.** If a consumer texts STOP to any number on a profile, they're blocked from every number on that profile.

With one number per shop, a shared profile means one STOP blocks that customer across all of SprintAI — unacceptable, and contradicts the registered per-shop consent model.

**Intended architecture: one messaging profile per shop.** Profiles are free, Telnyx-side grouping, separate from the TCR campaign — numbers from many profiles can attach to campaign `CSMB9HG`.

**Before building provisioning:** confirm multiple messaging profiles can share one 10DLC campaign. If they cannot, stop and escalate to Jason. Do not default to shared-profile to keep moving.

## 5. Provisioning flow (per shop)

1. Create a messaging profile for the shop — `POST /v2/messaging_profiles`. Set inbound webhook to the ordering-engine endpoint.
2. Search a local number in the shop's area code, filtered to SMS.
3. Order the number — `POST /v2/number_orders`.
4. Attach the number to the shop's messaging profile.
5. Assign the number to campaign `CSMB9HG` — `/v2/10dlc/phoneNumberCampaign`. Verify via `GET` before treating as live.
6. Record shop ↔ number ↔ profile ↔ campaign in our own data model. Do not rely on Telnyx as source of truth.

A number is ready only when steps 4 AND 5 are both confirmed.

## 6. Inbound / outbound wiring

- Inbound arrives at the profile's webhook. Every inbound (including stop words) is delivered, so the app can observe opt-outs even though Telnyx enforces the block.
- Outbound is `POST /v2/messages`, `from` the shop's number, `to` the consumer.
- Never send to a number that has not messaged that shop first (compliance handoff §2).
- Use branded link domain `pay.getsprintai.com`. No public URL shorteners (bit.ly etc. are filtered → silent failures).
- Pace outbound against 240 TPM AT&T ceiling, shared across the campaign. Per-shop throughput falls as shops are added — queue, don't burst.

## 7. First test — required before any shop goes live

**Setup:** create profile `sprintai-test` (inbound webhook → ordering engine test mode); provision one 610 number; attach to profile; assign to `CSMB9HG`; confirm via `GET /v2/10dlc/phoneNumberCampaign`; confirm `operationStatus` still APPROVED across all 7.

**Test script (real handset):**

| # | Send | Expected |
|---|---|---|
| 1 | `hi` | Reply includes msg & data rates disclosure, `Reply HELP for help`, `Reply STOP to opt out`. Mandatory first-contact. |
| 2 | `can I get a dozen everything bagels` | Conversational order-building |
| 3 | `HELP` | Registered help text (compliance §3) |
| 4 | `I want to cancel this order` | Must NOT opt out — whole-message matching only |
| 5 | Complete order → payment link | Link uses `pay.getsprintai.com` |
| 6 | `STOP` | Opt-out confirmation; number blocked |
| 7 | Outbound send to that number | Must fail — Telnyx blocks. App handles failure gracefully, no crash/retry-loop |
| 8 | `START` | Service resumes |

Report: message SIDs, delivery status each, exact first-contact reply text, app behaviour on blocked send (step 7). Do not skip step 4 or 7.

## 8. Known issues

- `isTMobileRegistered` reads `false` though T-Mobile shows APPROVED — likely propagation lag. Re-check before first production send.
- T-Mobile brand tier LOW caps daily volume. Raising needs external vetting (~$40 via Telnyx). Do not initiate — flag to Jason near cap.

## 9. Escalate to Jason before

- Spending beyond per-number cost ($1/mo + $1 upfront).
- Any campaign registration change.
- Changing opt-in/opt-out/help keyword handling.
- Adopting a shared messaging profile across shops (§4).
- Sending to any number that has not messaged first.
