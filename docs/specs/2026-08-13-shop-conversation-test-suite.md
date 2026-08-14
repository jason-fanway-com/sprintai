# Shop Conversation Test Suite — Design Spec

**Date:** 2026-08-13
**Owner:** Lead (SprintAI_bot). Design here; implementation in bounded, approval-gated phases — NO autonomous crew loops, NO unbudgeted runs.
**Roadmap tie-in:** activates the long-standing "onboarding acceptance suite" (auto-gen ~100 cases per shop, judge as go-live gate). This is the per-shop self-validation that lets Sprint onboard thousands of restaurants without a human checking each one.

## Goal

For any shop, **auto-generate ~100 customer conversations from that shop's own menu**, run each to completion against the ordering bot **in an isolated test environment**, have an LLM judge grade each against a structured rubric, produce a suite scorecard, triage failures into ranked fixes, and re-run after fixes. The suite doubles as the **go-live gate**: a shop can't go live until it passes.

## The QA program this serves (the pitch, made real)

The sales promise: *AI is probabilistic and can drift; we are professionals who are vigilant about it, transparently.* The system must back that with three real, owner-visible layers:

1. **Pre-live acceptance suite (this spec).** ~100 happy-path + adversarial cases run before a shop goes live — the go-live gate. Shown to the owner as their "Store Readiness" report. *We test it, and we show you the tests.*
2. **Continuous per-interaction judge (mostly exists — `eval-sweep` / `conversation_evals` / `issue-detector`).** An LLM judge grades **every real customer conversation** and alerts us to anomalies. Owner sees a live quality signal, not a one-time cert.
3. **Periodic drift battery (new).** On a schedule (monthly/quarterly per shop), re-run the full suite against the live system, compare to the go-live **baseline**, and flag any regression as **drift**. Owner sees dated re-test results.

**Honest expectation-setting is a feature, not a disclaimer.** The owner-facing copy says plainly: it won't be perfect — it's AI — but we are vigilant on drift and keep quality the best the tools allow. The reporting UI is what makes that credible.

## A test case

```
{
  id, category,                       # happy | edge | adversarial | compliance | regression
  persona,                            # short customer description (drives simulated mode)
  mode,                               # "scripted" | "simulated"
  opening,                            # first customer message
  turns[],                            # scripted follow-ups (mode=scripted)
  goal,                               # what the customer is trying to achieve (mode=simulated)
  success_criteria[],                 # STRUCTURED assertions, not vibes
  criticality                         # normal | critical
}
```

- **scripted** = fixed turns, for precise/deterministic cases.
- **simulated** = an LLM plays the persona toward `goal`, deviating like a real customer (typos, changes mind, vague). Realism.
- **success_criteria are objective assertions** the judge checks, e.g.: order line-items match expected; **order total = $X exactly**; 86'd item refused + alternative offered; out-of-radius delivery declined gracefully; STOP → opt-out honored + no further sends; tip captured on delivery; ticket shows TAKEOUT vs DELIVERY.

## The 100 cases — two sources

1. **Menu-derived (auto-generated from the shop's menu):** walk the shop's items/categories/sizes/modifiers/combos to build realistic happy-path orders. For NJB: bagels by flavor, dozen=14 quirk, loukoumades small/large, cream-cheese-by-the-pound, Greek corner, omelette platters, wraps. The generator is menu-structure-driven, so it works for any shop.
2. **Adversarial + compliance library (menu-agnostic, every shop):**
   - **Edge/curveball:** ambiguous order, multi-item run-on in one message, change-mind mid-order, invalid/nonexistent item, quantity extremes, split pickup/delivery confusion.
   - **Adversarial:** price challenge, argue with the bot, prompt-injection attempts, off-topic, abusive input.
   - **Compliance (business-critical):** STOP/opt-out honored immediately + permanently; quiet-hours; consent; no wrong-price charge.
   - **86 behavior:** owner 86s an item → next order refuses it + suggests alternative (the NJB hard requirement).
   - **Regression:** every real bug we fix becomes a permanent case, so it can never silently return.

## Grading

- **Rubric-based**, per success_criterion — pass/fail + reason. Never string-match (the bot is non-deterministic — proven by the menu-intake silent-price bug).
- **Non-determinism handling:** run **critical** cases N times (≥3), take **worst-case**. A case that passes 2/3 and leaks a wrong price 1/3 is a FAIL.
- **Tiered pass (not a single average):**
  - Overall **≥ 95%** of cases pass, **AND**
  - **100%** of the **critical subset** passes — wrong price, 86 leakage, opt-out ignored, cross-tenant leakage. Zero tolerance. Averaging hides the one catastrophic failure.
- **Scorecard output:** per-case pass/fail + reason, subscores by category, overall grade, and an explicit **critical-failures list** that blocks go-live regardless of the average.

## Drift detection (layer 3)

- The go-live run is stored as the shop's **baseline**.
- A scheduled job re-runs the full suite per shop on a cadence (config: monthly/quarterly).
- Compare each re-run to baseline: any drop below the pass bar, or any **new** critical failure, is flagged as **drift** → alert us + surface on the owner's readiness page as a dated re-test with what changed.
- Drift runs obey the same isolation + cost guards below (isolated test shop, budgeted, approval-gated for now — automate the cadence only once cost is proven and capped).

## Hard guardrails (from the 2026-08-09 incidents)

1. **Isolation — runs ONLY against a disposable test shop or a separate test project. NEVER a real/demo shop.** Pointing a test harness at the real NJB shop_id is exactly what wiped its menu. The harness must create throwaway shops (seeded from a menu snapshot) and tear them down; it must refuse a real/protected shop_id. Depends on the protected-shop guard (see the 2026-08-12 prod-data-safety spec).
2. **Cost-bounded, approval-gated.** Estimate tokens/$ before any full run; cap it; prefer a cheaper model for the simulated-customer and judge where quality holds. **No autonomous fix→re-run loops** — every re-run is Jason-approved. (The $300 lesson, now a standing rule.)

## Messaging-safety guardrails (HARD — account-protecting)

- **Tests NEVER go through Twilio.** The harness invokes the ordering/chat edge function **directly** with a synthetic inbound message; it must **never** call the Twilio messaging API and must never use a real Twilio-provisioned number. The test clone has **no** `phone_number_e164`. Twilio therefore never sees test traffic.
- **Opt-out / STOP cases:** assert the bot's **in-app** consent/opt-out behavior (DB consent flag, correct reply) via direct invocation only. A test STOP must **never** register a real Twilio opt-out — Twilio can't tell a test from a real customer, and inflated opt-out ratios can get the A2P account suspended. Before running any STOP case, verify the STOP code path does not propagate to Twilio (stub/skip any Twilio call in test mode).
- **Synthetic phone numbers only** for test conversations — never a real customer number, never a real Twilio number.
- No outbound SMS of any kind is emitted during a test run.

## The loop

run → structured scorecard → triage (judge proposes ranked fixes with evidence) → **Jason approves** which to make → implement → re-run. Gated at every step; nothing auto-iterates.

## Reporting & admin UI (visible results)

Persist every run so results are viewable, not just a console dump.

- **Data model:** `test_runs` (shop_id, started_at, model_tier, overall_grade, pass/fail counts, category subscores, critical_failures[], status) + `test_case_results` (run_id, case_id, category, criticality, transcript, success_criteria[], judge_verdict, pass/fail, reason). Tenant-scoped via RLS like all shop data.
- **Two audiences, two framings:**
  - **Superadmin (global):** a "Test Suite" view — all shops' runs, drill into any case's full transcript + judge reasoning, triage, compare runs over time. This is the operator's QA console.
  - **Shop owner (tenant-scoped):** a **"Store Readiness"** tab that tells the whole three-layer story: (1) the pre-live cert — overall score + green/red checks by category ("Ordering ✓, Out-of-stock handling ✓, Delivery ✓"), (2) a live quality signal from the continuous judge (recent interactions monitored, anomalies flagged), and (3) dated periodic drift re-tests. Owner-facing wording — curveballs shown as "resilience checks," not raw "adversarial." Honest framing baked in: "It's AI — not perfect — and here's how we stay on top of quality for you." Ties to go-live: "Your store passed — ready to go live."
- **Why it matters:** turns an internal QA loop into a professional, trust-building artifact the owner sees at onboarding and can revisit. Reinforces the go-live gate.
- Placement recommendation: reuse the existing admin/shop split (superadmin app = global Test Suite; shop app = Store Readiness tab). Reuse existing dashboard components/styling.

## Leverage

Build on existing eval infra in the repo — `eval-sweep`, `_shared/judge-rubric.ts`, `conversation_evals`, `issue-detector`. Don't reinvent the judge. Reuse the admin/shop dashboards for the reporting UI.

## Rollout (bounded, cheap-first)

1. **This spec** → Jason sign-off on schema + pass bar.
2. **10-case pilot** (cheap): generator produces 10 mixed cases for NJB, run in isolation, judge grades, produce a scorecard. Proves the machinery for pennies. **Cost-estimated + approved before running.**
3. **Scale to 100** once the pilot machinery is validated.
4. **Integrate as go-live gate** — auto-gen at onboarding; shop blocked from live until pass.

## Pass bar (adopted default; change on request)

**≥95% overall AND 100% of the critical subset (price accuracy, 86, opt-out, tenant isolation).**

## Open questions

- Simulated-customer + judge model tier (cost vs fidelity) — decide at pilot.
- Exact critical-subset membership — proposed above; confirm.
