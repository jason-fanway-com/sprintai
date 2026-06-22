-- Migration proof harness for 014_conversation_evals (Spec 06 §5).
-- Seeds ONLY the minimal dependency tables (tenants, shops, conversations) so
-- the FKs resolve, then applies the UP migration TWICE (idempotency) and the
-- DOWN once (reversibility). Run against a throwaway Postgres — never a real DB.

-- ── minimal dependencies (subset of 001/003) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT
);
CREATE TABLE IF NOT EXISTS shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
);

-- auth.jwt() shim so the RLS policy bodies parse on a bare Postgres.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;

\echo '== APPLY UP (1st time) =='
\i /work/014_conversation_evals.sql

\echo '== columns after first apply =='
SELECT column_name FROM information_schema.columns WHERE table_name='conversation_evals' ORDER BY ordinal_position;

\echo '== APPLY UP (2nd time — must be a NO-OP, no errors) =='
\i /work/014_conversation_evals.sql

\echo '== indexes present =='
SELECT indexname FROM pg_indexes WHERE tablename='conversation_evals' ORDER BY indexname;

\echo '== policies present =='
SELECT policyname FROM pg_policies WHERE tablename='conversation_evals' ORDER BY policyname;

\echo '== insert a row (FKs resolve) =='
INSERT INTO tenants(id,name) VALUES ('00000000-0000-0000-0000-000000000001','T1');
INSERT INTO conversations(id,tenant_id) VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000001');
INSERT INTO conversation_evals(tenant_id,conversation_id,transcript_hash,model,verdict,flags)
  VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c1','hash1','m/v1','clean','[]'::jsonb);
SELECT verdict, max_severity FROM conversation_evals;

\echo '== unique (conversation_id, transcript_hash) enforced (expect error) =='
DO $$ BEGIN
  INSERT INTO conversation_evals(tenant_id,conversation_id,transcript_hash,model,verdict,flags)
    VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c1','hash1','m/v1','clean','[]'::jsonb);
  RAISE EXCEPTION 'DUP NOT BLOCKED';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'OK: duplicate (conv,hash) blocked by unique index';
END $$;

\echo '== APPLY DOWN (reversible) =='
\i /work/014_conversation_evals.down.sql

\echo '== table gone after down? (expect 0 rows) =='
SELECT count(*) AS conversation_evals_tables FROM information_schema.tables WHERE table_name='conversation_evals';

\echo '== APPLY DOWN again (idempotent — must not error) =='
\i /work/014_conversation_evals.down.sql

\echo '== MIGRATION PROOF COMPLETE =='
