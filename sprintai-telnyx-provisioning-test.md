# SprintAI — Telnyx Provisioning & Delivery Test

**For:** the SprintAI OpenClaw agent
**Date:** 2026-08-14
**Read with:** `sprintai-telnyx-integration-runbook.md` and
`sprintai-10dlc-compliance-handoff.md`

---

## Why we are running this

The Telnyx campaign record is internally inconsistent and we cannot resolve it
by reading the API. Current live state:

| Field | Value | Reading |
|---|---|---|
| `campaignStatus` | `TCR_ACCEPTED` | moved off `MNO_REJECTED` — good |
| `operationStatus` (all 7 MNOs) | `APPROVED` | carriers approved — good |
| `failureReasons` | 806 CTA rejection still present | unclear — stale or live? |
| `isTMobileRegistered` | `false` | unclear, against an APPROVED T-Mobile |
| `submissionStatus` | `CREATED` | normal; this is not a failure signal |

**Background:** the campaign was rejected by the carriers (code 806) because the
published call-to-action on getsprintai.com lacked a message frequency
disclosure. That was fixed and deployed yesterday, and the campaign's
`messageFlow` was updated to quote the live CTA. `campaignStatus` then moved from
`MNO_REJECTED` to `TCR_ACCEPTED` and all seven carriers now report `APPROVED`.

But `failureReasons` still carries the 806 text and has not cleared with time.
Two possible explanations:

- **(a)** It is a sticky historical field Telnyx does not clear on update. The
  campaign is genuinely approved.
- **(b)** The 806 is still open and the per-carrier `APPROVED` values are stale.

We cannot distinguish these from the API. **Message delivery is ground truth** —
a campaign with a live MNO rejection will not deliver. This test settles it.

A support ticket is open with Telnyx in parallel; do not wait on it.

## Budget

- Number: $1.00 upfront + $1.00/month
- Messaging profile: free
- **Do not spend beyond this.** Anything else, escalate to Jason.

## Setup

**Auth:** `Authorization: Bearer $TELNYX_API_KEY` — Jason supplies the key.
Base URL `https://api.telnyx.com/v2`.

**Campaign to assign to:** `CSMB9HG`
(Telnyx campaign id `4b30019f-fc16-9471-9d17-5533e185444c`)

### Step 0 — record the pre-test state
```
GET /v2/10dlc/campaign/4b30019f-fc16-9471-9d17-5533e185444c
GET /v2/10dlc/campaign/4b30019f-fc16-9471-9d17-5533e185444c/operationStatus
```
Save both verbatim. If any MNO is no longer `APPROVED`, **stop and escalate** —
that changes the picture.

### Step 1 — messaging profile
Create one profile named `sprintai-test`
(`POST /v2/messaging_profiles`). Set the inbound webhook URL to the ordering
engine in **test mode**.

> One profile for this test only. Do **not** design shop provisioning around a
> shared profile — see the compliance handoff §2 on profile-scoped opt-out.

### Step 2 — find a number
```
GET /v2/available_phone_numbers?filter[country_code]=US&filter[national_destination_code]=610&filter[features][]=sms
```
Verified working; returns Allentown-area numbers at $1/mo + $1 upfront.

### Step 3 — order it
`POST /v2/number_orders`. Confirm the order completes before continuing.

### Step 4 — attach the number to the `sprintai-test` messaging profile

### Step 5 — assign the number to the campaign
Use `/v2/10dlc/phoneNumberCampaign`, then **verify**:
```
GET /v2/10dlc/phoneNumberCampaign
```
The number must appear against campaign `CSMB9HG`. **A number that is not
assigned sends as unregistered traffic and will be filtered — that would
invalidate the whole test.** Do not proceed until the assignment is confirmed.

## The test — inbound first

**Critical:** our registration states that no message is ever sent to a consumer
who has not messaged first. That applies to testing too. **Do not send an
unsolicited outbound to start this test.** The tester texts the number first.

Tester: Jason, from a real mobile handset (not a simulator, not a VoIP line).

| # | Tester sends | Expected | Capture |
|---|---|---|---|
| 1 | `hi` | Reply arrives. Must contain the msg & data rates disclosure, `Reply HELP for help`, and `Reply STOP to opt out` | inbound webhook payload, outbound message id, **final delivery status** |
| 2 | `can I get a dozen everything bagels` | Conversational order-building reply | message id + delivery status |
| 3 | `HELP` | The registered help text (compliance handoff §3) | delivery status |
| 4 | `I want to cancel this order` | **Must NOT opt out.** Telnyx matches stop words only when they are the whole message. Normal conversational handling | delivery status; confirm number is still sendable |
| 5 | Complete an order to a payment link | Link on `pay.getsprintai.com`, not a public shortener | delivery status |
| 6 | `STOP` | Opt-out confirmation; number blocked at Telnyx | delivery status |
| 7 | — attempt one outbound to that number — | **Must fail.** Confirm the app handles the rejection cleanly: no crash, no retry loop, opt-out state recorded | the exact Telnyx error code and body |
| 8 | `START` | Service resumes | delivery status |

**Delivery status matters more than the API accepting the send.** A `200` on
`POST /v2/messages` only means Telnyx queued it. Follow each message to its final
DLR — `delivered` vs `sending_failed` / `delivery_failed` — and record the error
code on any failure.

## How to read the result

- **All messages reach the handset and show `delivered`** → the campaign is
  functional, `failureReasons` is a stale historical field, we are clear to
  proceed with shop provisioning. Report this.
- **Messages fail, are filtered, or never arrive** → capture the exact error
  codes and **stop**. That means the 806 is live, and no amount of provisioning
  will work until it clears. Escalate to Jason immediately with the codes.
- **Mixed results by carrier** → note which carrier. The tester's handset only
  exercises one; a partial result still tells us something.

## Report back

1. Pre-test campaign + operationStatus snapshots (step 0)
2. The provisioned number, profile id, and the campaign assignment confirmation
3. For each of the 8 steps: message id, final delivery status, and the exact
   reply text for steps 1, 3, and 6
4. Step 7's error code and how the app handled it
5. Post-test `GET` of the campaign record — has `failureReasons` or
   `isTMobileRegistered` changed after real traffic?

Item 5 is genuinely informative: if `isTMobileRegistered` flips after live
traffic, that explains the flag as lazily-populated rather than a problem.

## Do not

- Send to any number that has not messaged first.
- Provision more than one number.
- Modify the campaign registration.
- Proceed past step 5 of Setup if the campaign assignment is unconfirmed.
