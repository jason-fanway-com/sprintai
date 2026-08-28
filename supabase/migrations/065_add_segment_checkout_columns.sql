-- 065_add_segment_checkout_columns.sql
-- Add bot_segments (total SMS segments across all bot replies in a case)
-- and reached_checkout (whether the conversation reached the checkout phase)
-- to test_case_results. Enables the QA suite to report segment cost per
-- checkout-completing order automatically on every run.

alter table test_case_results
  add column if not exists bot_segments int;

alter table test_case_results
  add column if not exists reached_checkout boolean default false;