# Onboarding Acceptance Test Suite (Go-Live Gate)
Date: 2026-08-06
Status: draft

## Problem
Today a shop can be made live to a customer without any automated proof it behaves correctly — right totals, honors 86, refuses out-of-radius delivery, no test-mode or cross-tenant leak. At one shop a human can eyeball it. At thousands, human QA per shop does not scale and off-vision. Without an automated gate, we either ship unverified shops (quality/liability risk) or keep a human in every onboarding (scaling debt). We need onboarding to end in a machine-run pass/fail gate so a shop only reaches the customer after it demonstrably works.

## User stories
- As a restaurant owner completing onboarding, I want the system to verify my shop works before it goes live so that my first real customer never hits a broken ordering flow.
- As Sprint (operator), I want ~100 shop-specific test cases auto-generated and run by Melvin as the last onboarding step so that no human has to QA each shop.
- As a customer of a delivery shop, I want the chat to tell me yes/no whether my address is in the delivery zone so that I am not taken through an order we cannot fulfill.
- As Sprint, I want out-of-radius delivery attempts to be refused in tests and in production so that we never accept an order we cannot deliver.

## Module decisions
- Delivery radius is a new onboarding/setup field: shop address geocoded once to lat/lng + radius_miles stored on shop.
- Runtime delivery-address qualifier in chat: geocode customer address -> haversine distance to shop origin -> in/out of radius. Geocode failure fails SAFE (refuse/hand off, never silently accept).
- Radius v1 = straight-line (haversine) circle. Drive-time polygons deferred. [FORK C — assumed]
- Test-case generation is data-driven: cases are generated from the shop's real structured data (menu rows, hours, delivery config, radius). The correct expected outcome for each case is COMPUTED BY CODE, not asserted by the LLM. LLM only proposes scenario phrasing.
- Test cases stored as rows keyed to shop (test_case table): scenario input, category, tier (MUST/SHOULD), computed expected outcome.
- Harness runs each case against the chat-sms edge function in TEST MODE (tenant isolation already closed), parallelized, as a background job. Onboarding UX is not blocked waiting synchronously.
- Verdict per case = deterministic assertions (totals, order_type, radius decision, 86 respected, no test-mode/cross-tenant leak) plus LLM-judge (reuse conversation_evals judge) for tone/quality cases.
- Two-tier pass bar: MUST-PASS (safety/correctness) require 100%; SHOULD-PASS (tone/quality) require >= 90%. [FORK A — assumed]
- Gate outcome: shop has an explicit go_live_status; shop reaches customer ONLY on PASS.
- On FAIL: auto-diagnose (which cases, why), notify Sprint + owner in plain English, allow re-run after config fix; human review is the exception path, not the default. [FORK B — assumed]

## Acceptance criteria
1. A shop record has a delivery_radius_miles field and a geocoded origin (lat, lng); saving a shop address populates lat/lng via the geocoder.
2. In the customer chat, a delivery address inside the radius is accepted and one outside the radius is refused with a clear message; a non-geocodable address is refused/handed off, never accepted.
3. Completing onboarding generates >= 100 test-case rows for the shop when the shop offers delivery, and generates only pickup-relevant cases (no delivery cases) when the shop is pickup-only.
4. Every generated test case has a category, a tier of exactly MUST or SHOULD, and a code-computed expected outcome stored with it.
5. For a delivery shop, the generated set includes at least one in-radius delivery case (expected: accepted) and at least one out-of-radius delivery case (expected: refused).
6. Melvin runs the full set against chat-sms in test mode as a background job and records a per-case verdict (pass/fail) with evidence.
7. The gate computes PASS only when 100% of MUST-tier cases pass AND >= 90% of SHOULD-tier cases pass; otherwise FAIL. (Thresholds configurable.)
8. A shop's go_live_status is PASS/FAIL/PENDING; a shop with status != PASS is not reachable by a real customer.
9. On FAIL, the system produces a plain-English diagnosis listing failing cases and reasons, and notifies Sprint and the owner; re-running the suite after a config change is possible without re-onboarding.
10. No test-suite run creates a real (non-test) order, charges a real card, or reads/writes another tenant's data.

## Out of scope
- Drive-time / road-network delivery polygons (v1 is straight-line circle).
- Multi-location / franchise radius composition.
- Delivery fee / minimum-order logic beyond the in/out radius decision.
- Live human-agent handoff UX beyond the notification.
- Blocking the NJB demo — this ships after the demo, before selling to any shop beyond NJB.

## Open questions (RESOLVED / remaining)
- FORK A — RESOLVED (Jason, 2026-08-06): pass bar = 100% MUST + >= 90% SHOULD.
- FORK B — RESOLVED (Jason, 2026-08-06): on fail = auto-diagnose + notify + retry, human review as exception (not pure hard-block).
- FORK C — RESOLVED (Jason, 2026-08-06): radius v1 = straight-line haversine circle. BUT geocoding is a NET-NEW dependency: no geocoding key exists in secrets, .env.example, or any edge function today. BUILD PREREQUISITE — provision a geocoding provider + key (recommend Google Maps Geocoding API; pay-per-use, ~free at low volume, cost scales with orders) before implementation. Needs Jason (credential + billing).
- REMAINING: Token/latency budget cap for running ~100 conversations per shop at onboarding — set at build time.