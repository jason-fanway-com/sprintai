-- DOWN / rollback for 014_conversation_evals.sql (Spec 06).
--
-- Reversible: drops ONLY the objects 014 created. Touches no pre-existing table.
-- Idempotent (IF EXISTS everywhere) so it is safe to re-run.
--
-- WARNING: this drops the conversation_evals table and all judge results in it.
-- Eval rows are derived/regenerable (the judge can re-evaluate conversations),
-- so this is non-destructive to source data (conversations/messages/menus are
-- untouched). Still requires explicit human approval to run in any shared DB,
-- per the destructive-ops guardrail.

DROP INDEX IF EXISTS idx_conversation_evals_pending_notify;
DROP INDEX IF EXISTS idx_conversation_evals_conversation;
DROP INDEX IF EXISTS idx_conversation_evals_tenant_sev_judged;
DROP INDEX IF EXISTS uq_conversation_evals_conv_hash;

DROP POLICY IF EXISTS "Tenants can view their own conversation_evals" ON conversation_evals;
DROP POLICY IF EXISTS "Admins have full access to conversation_evals" ON conversation_evals;

DROP TABLE IF EXISTS conversation_evals;
