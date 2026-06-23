-- DOWN for 016_command_center.sql
-- Drops ONLY the objects 016 created. No existing table/data is affected.
-- Idempotent (IF EXISTS guards everywhere); safe to re-run.

DROP FUNCTION IF EXISTS public.command_center_deploy_status();

DROP TRIGGER IF EXISTS trg_program_items_updated_at ON program_items;
DROP FUNCTION IF EXISTS set_program_items_updated_at();

-- RLS policy is dropped with the table, but drop explicitly first for clarity
-- (and so re-running the down after a partial up is still clean).
DROP POLICY IF EXISTS "Admins have full access to program_items" ON program_items;

DROP TABLE IF EXISTS program_items;
