ALTER TABLE public.shops
  DROP COLUMN IF EXISTS welcome_email_status,
  DROP COLUMN IF EXISTS welcome_email_error,
  DROP COLUMN IF EXISTS welcome_email_last_attempt_at;
