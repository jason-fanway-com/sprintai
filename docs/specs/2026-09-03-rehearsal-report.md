# Onboarding Rehearsal Report — INSTRUCTION-07

**Date:** 2026-09-03 · **Owner:** OrderFare · **Shop:** throwaway `is_test = true`

Rehearsing the full one-call-close onboarding flow end to end before Jason runs it.
Every defect found is logged below as a BREAK with evidence, then fixed and re-run.

---

## Leg 1 — Break List

### BREAK #1 — Subscription go-live gate passes with no money moving

- **Where:** `signup-page/wizard.js:181` writes `subscription_status: "active"` (plus
  `subscription_pm_set: true`) on a button press. No card collected, no charge.
  `supabase/functions/go-live/index.ts:280` gates on exactly
  `shop.subscription_status === "active"`.
- **Defect:** the subscription go-live gate is satisfiable by pressing a button. In the
  rehearsal the subscription step WILL sail through — recorded as a **BREAK, not a pass.**
  A gate that passes without the money moving is the same defect class Proof had.
- **Status:** LOGGED, not fixed (per PO 2026-09-03). Fix deferred.

### BREAK #2 — Owner-facing copy contradicts the actual gate

- **Where:** `signup-page/wizard.js:171` tells the owner: *"Order go-live is gated on your
  payout account being enabled — never on this subscription."*
- **Defect:** contradicts `go-live/index.ts:280`, which DOES gate go-live on
  `subscription_status === "active"`. Owner-facing copy is wrong.
- **Status:** LOGGED, not fixed. Fix deferred.

---

*(rehearsal continues — subsequent legs appended below)*
