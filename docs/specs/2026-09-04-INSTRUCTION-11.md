# INSTRUCTION 11 — Rename SprintAI → OrderFare, in phases

**Date:** 2026-09-04 · **From:** Claude (outside product owner) → OrderFare
**Authority:** Jason, 2026-09-04: *"The product is being named OrderFare. I got the domain,
I am migrating the site to that. I will register OrderFare as a DBA under SprintAI LLC."*

Scope: **143 files** contain "SprintAI"; **59** hardcode `getsprintai.com`.
This does not happen in one pass, and one phase can revoke our ability to send SMS at all.

---

## ⛔ HARD STOP — do not touch SMS compliance copy

`chat-sms/index.ts:34` holds `COMPLIANCE_HELP`:

> "SprintAI text ordering. Text your order to this number… Support: support@getsprintai.com.
> Msg & data rates may apply. Reply STOP to opt out."

That string is **10DLC carrier compliance text**, tied to Telnyx brand `BJ8MUGY` /
campaign `CSMB9HG` — TCR_ACCEPTED on all 7 carriers. Message content is expected to match
the registered brand. Changing the brand name customers see in SMS, while the registration
still reads SprintAI LLC, risks the campaign being flagged or blocked.

**That registration is the hard-won permission to send commercial SMS at all. Losing it
ends the product.** No SMS-visible string changes until the Telnyx registration has been
reviewed and Jason has decided. Same applies to `docs/10dlc-compliance-obligations.md` and
`sprintai-10dlc-compliance-handoff.md` — those are records of what was registered; do not
retro-edit them.

---

## Legal name is NOT being replaced

**SprintAI LLC remains the legal entity. OrderFare is a DBA.** Do not blanket-replace
"SprintAI LLC" — it is still the company that signs things and pays taxes.

Where a legal entity is named — `terms.html`, privacy policy, billing descriptors — the
correct form is **"OrderFare, a DBA of SprintAI LLC"**, not "OrderFare" alone. Anything
that changes legal text waits for Jason's confirmation that the DBA is registered.

---

## Phase 1 — safe now: visible product name on web surfaces

Replace the visible brand string **SprintAI → OrderFare** in:
page titles, headings, footers, nav, button copy, alt text, meta descriptions, and the
admin/owner UI.

**In scope:** `signup-page/`, `signup/`, `admin-dashboard/src/`, `dashboard/`,
`merchant-ui/`, `shop-chat/`, `checkout/`, `welcome/`, `demo/`, `widget/`, `public/`.

**Out of scope in this phase:** any URL or domain, any SMS string, any legal text, the
email sender identity, and the Stripe account business name (Jason's, in the Dashboard).

**Validated when:** a grep for `SprintAI` across those directories returns only URLs,
legal text, and code identifiers — no visible customer-facing brand copy.

## Phase 2 — blocked on Jason: legal text

`terms.html`, privacy, and any billing descriptor → "OrderFare, a DBA of SprintAI LLC".
Do not start until Jason confirms the DBA is registered.

## Phase 3 — blocked on 10DLC review: SMS copy

`COMPLIANCE_HELP` and any other SMS-visible brand string. Requires reviewing the Telnyx
registration first and an explicit decision from Jason. **Assume blocked.**

## Phase 4 — blocked on DNS: domain and email identity

59 files hardcode `getsprintai.com`, including `create-subscription`'s fallback base URL
and `onboarding-save`'s setup links. The order-ticket sender is
`"SprintAI Orders <orders@getsprintai.com>"`.

Switching the email sender needs `orderfare.com` DNS records verified in Resend first, or
**every order ticket silently stops being delivered.** Do not switch the sender before the
domain is verified. Prefer replacing hardcoded domains with an env var so the cutover is
one config change rather than 59 edits.

---

## Also — a name collision to resolve

**You are named OrderFare.** The product is now also OrderFare. Every future instruction
saying "OrderFare" becomes ambiguous — the agent or the product. Recommend renaming the
agent. Flag this to Jason; do not rename yourself unilaterally.

---

## Rules

1. Phase 1 only until Jason clears the others. Report and stop at each boundary.
2. One commit per phase. Do not bundle.
3. Never weaken a gate. Gate count stays 13, fail-closed.
4. Verify before claiming — run the grep that would prove your claim false.
5. No synthetic evidence (AGENTS.md, Definition of Done).
6. Do not touch the Telnyx brand or campaign.
