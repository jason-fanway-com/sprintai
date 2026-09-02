# Spec: Number-to-campaign assignment — close the loop before a shop can text a customer

**Date:** 2026-09-01
**Owner:** Lead → John Walsh (build) → Melvin (verify)
**Priority:** 5 of 5. Small build, but it gates Erin's first real (non-demo) shop.

## Why this exists

A 10DLC number that is not assigned to an approved campaign gets filtered by carriers. `RUNBOOK.md` states the send gate is **mapping status (both ADDED)** — that is the condition that has to be true before a shop's number can carry A2P traffic on campaign `CSMB9HG`.

`provision-number` was rewritten to Telnyx on 2026-08-29 and does the first four steps well: searches by `national_destination_code`, orders the number, creates a per-shop messaging profile pointed at `chat-sms`, assigns the number to the profile. Then it stops.

```
provision-number/index.ts:19-20   "Number-to-campaign assignment is intentionally SEPARATE: it requires TNSP
                                   approval per campaign, so it happens in a parallel async flow (provision-campaign)."
provision-number/index.ts:249     pending_campaign_assignment: true,
```

Separating it was the right call — TNSP approval is genuinely asynchronous and cannot be inlined. But:

- **`provision-campaign` does not exist.** It is not in `supabase/functions/`.
- **Nothing reads `pending_campaign_assignment`.** Repo-wide grep returns exactly one hit: the write at line 249.
- **`go-live`'s `number` gate is `!!shop.phone_number_e164`** — non-null, nothing more. A number that has never been attached to the campaign satisfies it.

So a shop can go live on a number carriers will filter. And it fails quietly: `_shared/telnyx-error.ts` classifies error **10036 (campaign not approved)** as `transient`, and `chat-sms:2272–2277` logs it as a "campaign/system issue, not an opt-out" and leaves the conversation open. Correct handling for a genuinely transient blip; wrong signal for a shop that is structurally unable to send. The customer texts, nothing comes back, and no one is paged.

## Scope decision — manual first, per the existing plan

`RUNBOOK.md` already records the sequencing: *"Build queue: manual first 1–2 shops, then automate provisioning + polling."* That stands. This spec does **not** ask for full automation now. It asks for the state to be tracked truthfully and the gate to be real, so that the manual step cannot be skipped or forgotten under launch pressure.

## Fix

### Fix 1 — track real assignment state

Replace the write-only boolean with a status a human or a poller can move:

- `campaign_assignment_status` — `not_started` | `submitted` | `approved` | `rejected`
- `campaign_assignment_checked_at`, and the campaign id the number is mapped to.
- Backfill existing rows honestly: the demo 610 number's actual state, not an assumption. Per RUNBOOK the demo numbers ride the SprintAI brand with a demo disclosure — record what is actually true for `+16107358315` rather than defaulting it to approved.

### Fix 2 — a status reader, not yet a full automation

One small edge function (or an extension of the daily cron) that, for shops in `submitted`, queries Telnyx for the number's campaign mapping status and advances the row to `approved` when both mappings read `ADDED`. Read-only against Telnyx — it does not submit, it does not modify the campaign.

**Do not modify the campaign.** `HANDOFF.md` carries this as a standing instruction and the campaign is TCR_ACCEPTED across all seven carriers. This function reads mapping status only.

### Fix 3 — gate go-live on it

Extend the existing `number` gate in `go-live/index.ts:159`, or add a sibling `campaign` gate:

- Non-test shops require `campaign_assignment_status = 'approved'`.
- Demo/test shops (`is_test`) are exempt — they ride the SprintAI brand with the demo disclosure, which is the documented and approved arrangement.
- Refusal message: "Go-live refused: this shop's number is not yet assigned to an approved 10DLC campaign. Carriers will filter its messages. Submit the number for campaign assignment and wait for approval."

### Fix 4 — stop 10036 failing silently

Keep the `transient` classification — it is correct for retry behaviour. Add signal on top:

- On a 10036 for a shop whose `campaign_assignment_status` is not `approved`, raise a critical `issues` row. This is not a blip; it is a structurally undeliverable shop.
- Repeated 10036 on an `approved` shop is a different and more alarming thing (approval regressed, or mapping dropped) — raise it too, with a distinct message.

## Acceptance (Melvin verifies)

1. A non-test shop with `campaign_assignment_status != 'approved'` is refused by `go-live`, with the actionable message.
2. An `is_test` shop is not refused on this gate.
3. The status reader advances a `submitted` shop to `approved` when Telnyx reports both mappings `ADDED`, and leaves it alone otherwise.
4. The reader never issues a write to Telnyx. Verify by request log — read-only, and the campaign is untouched.
5. A simulated 10036 on a non-approved shop raises a critical issue; the conversation still stays open and the send still classifies as transient (no behaviour regression in `telnyx-error.ts`).
6. Existing demo path unaffected: Vito's demo on `+16107358315` continues to work exactly as it does today.

## Operational note for Erin's first shops

Until this is automated, someone must submit each new number for campaign assignment and wait for TNSP approval. **That wait is not instant and it is not in anyone's control.** Whatever window Erin quotes a restaurant between signing and going live has to include it, and the first one or two will teach us the real duration.

Pair this with spec 3's `delivery_test` gate: campaign approval is the paperwork saying delivery should work; the handset test is the evidence that it does. Both, in that order. RUNBOOK is explicit about why — the API's 806 `failureReasons` flag may be a stale historical field, so the real handset is the ground truth.

## Out of scope

- Full self-serve campaign automation (submit + poll + retry across thousands of shops). That is the Phase 2 scale build, and it should be specced once the first two manual shops have shown us the actual approval behaviour.
- Per-shop brand registration. Current model is one SprintAI brand, one campaign, per-merchant CTA pages — confirmed with Telnyx SE 2026-08-28, unchanged here.

## Definition of done

Status column and migration, backfilled truthfully. Read-only status reader. `go-live` gate enforced with test-shop exemption. 10036 escalation. Melvin verifies all 6 criteria, including that Telnyx receives no writes and the demo number still works.
