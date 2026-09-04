-- 088 — Order ticket destination (INSTRUCTION-09 §5 / INSTRUCTION-10 item E).
-- Today the signup email silently becomes the kitchen ticket destination — almost
-- always the wrong place. We now ask the owner explicitly during onboarding and
-- record the answer, including free text. We do NOT build the API integration for
-- "their own system" — we capture the named system only.
--
-- The Expo Screen is the guaranteed delivery path: orders land there by default for
-- every shop regardless of what is chosen here. This column records what ELSE the
-- owner wants, and is research across the first ten shops (report the distribution).
--
-- ticket_destination_type:
--   'expo'       — Expo Screen only (default; always active regardless)
--   'mailbox'    — a dedicated mailbox that exists only for orders (detail = address;
--                  the address is also written to email_ticket_recipient)
--   'own_system' — their own ticketing system via API (detail = named system; NOT built)
--   'other'      — free text (detail = whatever they said)
-- ticket_destination_detail: the mailbox address, named system, or free text. Nullable.

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS ticket_destination_type text NOT NULL DEFAULT 'expo',
  ADD COLUMN IF NOT EXISTS ticket_destination_detail text;

COMMENT ON COLUMN shops.ticket_destination_type IS
  'Where the owner wants order tickets to go, asked explicitly at onboarding (INSTRUCTION-09 §5). One of expo|mailbox|own_system|other. Expo Screen is always active regardless.';
COMMENT ON COLUMN shops.ticket_destination_detail IS
  'Free text / mailbox address / named ticketing system for the chosen ticket_destination_type. API integration for own_system is NOT built — this captures intent only.';
