# SprintAI — Telnyx Integration Runbook

**For:** the SprintAI OpenClaw agent
**Date:** 2026-08-28 (updated after Telnyx SE call with Chris)
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
| AT&T throughput | 240 TPM per campaign |
| T-Mobile throughput | 2,000 segments/day per campaign |

Numbers must be provisioned through Telnyx and assigned to a campaign. An unassigned number sends as unregistered traffic and gets filtered.

## 2. Credentials

Bearer token on every request: `Authorization: Bearer $TELNYX_API_KEY`
Base URL: `https://api.telnyx.com/v2`

Jason supplies the key separately — do not commit it, do not accept it pasted into a chat log. Store as a production secret.

## 3. ⚠️ CRITICAL CORRECTIONS (2026-08-28 — Chris, Telnyx SE)

### 3a. No ISV/reseller re-registration needed
Chris: "there is no real reseller or ISV tag on 10DLC currently — right now it's the same for everyone." The `isReseller: false` and `brandRelationship: BASIC_ACCOUNT` fields on brand BJ8MUGY are **irrelevant**. Do not change them. Do not freeze registration pending an ISV fix — there is nothing to fix. This instruction supersedes any prior ISV-related blockers.

### 3b. Throughput limits are PER CAMPAIGN, not pooled
- T-Mobile: 2,000 segments/day **per campaign**
- AT&T: 240 TPM **per campaign**
At ~300-400 orders/month per shop, this is 20-30x headroom. **External brand vetting to raise T-Mobile tier is unnecessary.** Do not initiate it. Do not worry about pooled throughput.

### 3c. The authoritative "cleared to send" check is mapping status, NOT campaignStatus or operationStatus
`campaignStatus` and `operationStatus` both misled us for a week (reading APPROVED while sends were blocked). The real gate:

```
GET /v2/10dlc/phone_number_campaigns/{phoneNumber}
```

**Both fields must read `ADDED`:**
- `tmobileNumberMappingStatus` === `"ADDED"`
- `nonTmobileNumberMappingStatus` === `"ADDED"`

Anything else = do not send. The `assignmentStatus` field (ASSIGNED/PENDING_ASSIGNMENT) is separate — both dimensions must be checked.

Build this as the provisioned-but-not-live gate: a number enters "pending mapping" after assignment, and the shop goes live only when both statuses read ADDED.

## 4. The registration model (per-merchant, confirmed)

```
Telnyx ACCOUNT (SprintAI, the ISV layer — gets no 10DLC approval)
  └── BRAND per merchant (requires that merchant's EIN)
        └── CAMPAIGN per brand (CUSTOMER_CARE)
              └── NUMBER assigned to campaign → carrier approval per number
```

Timings:
- Brand approval: ~2 hours, often minutes
- Campaign approval: 48-72 hours
- Carrier approval per number (mapping status → ADDED): minutes to ~2 hours — **this is the real bottleneck**

Everything in the portal is the same public API we already have keys for. **Do the first one or two manually through the portal** to see the flow before automating.

## 5. Verified API surface

| Purpose | Call |
|---|---|
| Account balance | `GET /v2/balance` |
| Brand record | `GET /v2/10dlc/brand/{brandId}` |
| Create brand | `POST /v2/10dlc/brand` — set `mock: true` for free testing |
| Campaign record | `GET /v2/10dlc/campaign/{campaignId}` |
| Create campaign | `POST /v2/10dlc/campaign` — under mock brand = auto-mock, free |
| Campaign update | `PUT /v2/10dlc/campaign/{campaignId}` |
| Per-carrier approval status | `GET /v2/10dlc/campaign/{campaignId}/operationStatus` |
| Carrier metadata / limits | `GET /v2/10dlc/campaign/{campaignId}/mnoMetadata` |
| Number ↔ campaign assignments | `GET /v2/10dlc/phoneNumberCampaign` |
| **Single number mapping (SEND GATE)** | `GET /v2/10dlc/phone_number_campaigns/{phoneNumber}` |
| Assign number to campaign | `POST /v2/10dlc/phoneNumberCampaign` |
| Messaging profiles | `GET /v2/messaging_profiles` |
| Create messaging profile | `POST /v2/messaging_profiles` |
| Search available numbers | `GET /v2/available_phone_numbers` |
| Number orders | `GET /v2/number_orders` |
| Order number | `POST /v2/number_orders` |
| Send message | `POST /v2/messages` |

## 6. Messaging profile architecture

**Telnyx opt-out block rules are scoped to the messaging profile, not the number.** If a consumer texts STOP to any number on a profile, they're blocked from every number on that profile.

With one number per shop, a shared profile means one STOP blocks that customer across all of SprintAI — unacceptable, and contradicts the registered per-shop consent model.

**Architecture: one messaging profile per shop.** Profiles are free, Telnyx-side grouping, separate from the TCR campaign — numbers from many profiles can attach to the same campaign.

## 7. Provisioning flow (per shop)

1. Create a messaging profile for the shop — `POST /v2/messaging_profiles`. Set inbound webhook to the ordering-engine endpoint.
2. Create a brand for the merchant — `POST /v2/10dlc/brand` with the merchant's EIN + business details (must match IRS CP-575 for "Verified" status).
3. Wait for brand verification (~2 hours, often minutes).
4. Create a campaign under that brand — `POST /v2/10dlc/campaign`, use case CUSTOMER_CARE. Submit the maximum 5 sample messages, be elaborate (reviewers want spirit of traffic, not literal match). Campaign approval 48-72 hours.
5. Search a local number in the shop's area code, filtered to SMS.
6. Order the number — `POST /v2/number_orders`.
7. Attach the number to the shop's messaging profile.
8. Assign the number to the campaign — `POST /v2/10dlc/phoneNumberCampaign`.
9. **Poll mapping status** — `GET /v2/10dlc/phone_number_campaigns/{phoneNumber}` until both `tmobileNumberMappingStatus` AND `nonTmobileNumberMappingStatus` read `ADDED`. This is the real send gate.
10. Record shop ↔ number ↔ profile ↔ brand ↔ campaign in our own data model. Do not rely on Telnyx as source of truth.

A number is ready to send ONLY when steps 7, 8, AND 9 are all confirmed.

## 8. Demo / testing numbers

Demo numbers should be under **SprintAI's own brand** (BJ8MUGY), because SprintAI genuinely is the sender for demos.

To demo as a named shop:
- Publish a demo page on getsprintai.com (e.g. "Jason's Pizza") showing the demo relationship. No DBA needed.
- Include "demo by SprintAI" or similar disclosure in the message text.
- Do NOT impersonate a real shop without disclosure — TCR detects it and blocks numbers.

For API testing: use **mock brands and campaigns** (free, no fees, no vetting). Set `mock: true` on brand creation; any campaign under a mock brand is automatically mock. Mock campaigns cannot carry real traffic but are perfect for testing provisioning pipelines and webhook events.

## 9. Per-merchant CTA pages — CONFIRMED ALLOWED

Host per-merchant CTA pages at `getsprintai.com/<shop-slug>`. Each must carry all 6 required CTA elements (see `10dlc-compliance-obligations.md` §8). This was an open question — Chris confirmed it's allowed.

## 10. Campaign submission best practices (from Telnyx support docs)

- Submit the **maximum 5 sample messages**, be elaborate — reviewers want the spirit of the traffic, not literal matching.
- Consistency: brand name, website, sample messages, and email domain must all align.
- Opt-out language must appear in at least one sample message.
- Embedded links/phone in campaign attributes → must appear in sample messages.
- Privacy policy must cover both sale AND sharing of mobile data (not just "won't sell").
- Brand info must match IRS CP-575 for "Verified" status.
- Campaign must have Opt-in, Opt-out, and HELP radio buttons set to "True" or TCR rejects.
- Campaign created before brand is verified → TCR ID starts with `4b3` → failed, must re-create.

## 11. Inbound / outbound wiring

- Inbound arrives at the profile's webhook. Every inbound (including stop words) is delivered, so the app can observe opt-outs even though Telnyx enforces the block.
- Outbound is `POST /v2/messages`, `from` the shop's number, `to` the consumer.
- Never send to a number that has not messaged that shop first (compliance handoff §2).
- Use branded link domain `pay.getsprintai.com`. No public URL shorteners (bit.ly etc. are filtered → silent failures).
- Pace outbound against AT&T 240 TPM ceiling, per campaign. Per-shop throughput falls as shops are added — queue, don't burst.
- T-Mobile 2,000 segments/day per campaign — monitor if approaching.

## 12. First test — required before any shop goes live

**Setup:** create profile `sprintai-test` (inbound webhook → ordering engine test mode); provision one 610 number; attach to profile; assign to campaign; poll mapping status until both ADDED.

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

## 13. Known issues

- Campaign CSMB9HG failed number assignment with error 10036. Chris suggests converting it to a testing campaign to get a test number quickly. For production, we'll use the per-merchant brand→campaign→number flow.
- T-Mobile brand tier LOW caps daily volume at 2,000 segments/day per campaign. Fine for pilot; raising needs external vetting (~$40 via Telnyx). Do not initiate — flag to Jason near cap.

## 14. Escalate to Jason before

- Spending beyond per-number cost ($1/mo + $1 upfront) + registration fees ($4 brand + $50 T-Mobile campaign + $30 upfront campaign + $0.03/number assignment).
- Any campaign registration change.
- Changing opt-in/opt-out/help keyword handling.
- Adopting a shared messaging profile across shops.
- Sending to any number that has not messaged first.