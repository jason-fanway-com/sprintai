-- INSTRUCTION-10 item B / INSTRUCTION-09 §1 — split onboarding from go-live.
--
-- Phase A (nine owner gates) completing is a distinct, persisted milestone from
-- go-live (all thirteen). When the owner's nine gates pass we set
-- onboarding_complete = true and show the terminal completion screen; the four
-- QA gates (number, campaign_assignment, proof, delivery_test) are still
-- unsatisfied and go-live still refuses. Gate count stays 13, fail-closed.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS onboarding_complete     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS onboarding_complete_at  TIMESTAMPTZ;

COMMENT ON COLUMN shops.onboarding_complete IS
  'True once all nine Phase A owner gates pass (INSTRUCTION-09 §1). Distinct from live; the four QA gates and go-live are still evaluated separately.';
