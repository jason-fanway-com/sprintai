-- Revert 088 — ticket destination columns.
ALTER TABLE shops
  DROP COLUMN IF EXISTS ticket_destination_type,
  DROP COLUMN IF EXISTS ticket_destination_detail;
