-- DOWN / rollback for 018_conversation_last_message_at.sql.
--
-- Removes ONLY the trigger and function this migration created. Idempotent and
-- guarded so re-running after a partial up is clean. Touches no column, no other
-- object, and no live order-path code.
--
-- THE BACKFILL IS NOT REVERSED — and cannot be. Once a conversation's
-- last_message_at has been corrected to its true newest message time, there is
-- no "wrong previous value" to restore (it was simply stale). Un-correcting it
-- would be both impossible to do faithfully and undesirable. This is expected:
-- the up migration documents the backfill as the one non-reversible step.
--
-- After this DOWN, last_message_at reverts to its original (buggy) behavior:
-- set at creation, never updated by the DB. The order path is unaffected either
-- way because the order path never depended on the trigger.

DROP TRIGGER IF EXISTS trg_bump_conversation_last_message_at ON public.messages;
DROP FUNCTION IF EXISTS public.bump_conversation_last_message_at();
