-- 028: Conversational Admin — add undone flag to admin_action_log for reliable undo
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name='admin_action_log' AND column_name='undone') THEN
    ALTER TABLE admin_action_log ADD COLUMN undone BOOLEAN DEFAULT false;
  END IF;
END $$;