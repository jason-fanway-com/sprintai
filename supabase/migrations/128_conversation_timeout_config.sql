-- 128: conversation timeout window, configurable via app_config.
--
-- WHY
-- ---
-- The conversation-lifetime fix (migration 127's sibling change in
-- chat-sms/index.ts, findActiveConversation()) hardcoded its inactivity
-- window at 3h. Jason's final spec (2026-09-09) calls for 2h, and — same
-- reasoning as customer_retention_months (migration 121) — CONFIGURABLE
-- without a deploy, not hardcoded, since this is a business tuning knob
-- (how long a customer can step away before their cart is gone) that may
-- need to change based on real usage.
--
-- Read by findActiveConversation() in chat-sms/index.ts on every lookup that
-- finds an existing active conversation; falls back to 2 in code if this row
-- is ever missing or malformed (e.g. non-numeric), so a bad edit here fails
-- safe to the shipped default rather than breaking ordering.

INSERT INTO app_config (key, value) VALUES
  ('conversation_timeout_hours', '2'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE app_config IS
  'Small generic key/value config store for flags that must flip without a deploy (e.g. public_tester_enabled, customer_retention_months, conversation_timeout_hours). Service role writes; super-admins can read/write through the dashboard.';
