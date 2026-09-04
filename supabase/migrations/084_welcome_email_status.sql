-- 084 — Item C (INSTRUCTION-10 §C): make resume/welcome email outcome visible.
-- The welcome email is the only bridge from signup to onboarding. Today its
-- send outcome is only console-logged and signup always reports success. Persist
-- the true outcome per shop so signup can surface failure and offer a resend.

ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS welcome_email_status text
    CHECK (welcome_email_status IN ('sent', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS welcome_email_error text,
  ADD COLUMN IF NOT EXISTS welcome_email_last_attempt_at timestamptz;

COMMENT ON COLUMN public.shops.welcome_email_status IS
  'Outcome of the last welcome/setup-link email send: sent | failed | skipped (RESEND_API_KEY unset). Server-written only.';
