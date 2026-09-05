-- Down for 099_build_status.sql. Reversible, idempotent (DROP ... IF EXISTS).
-- Drops only what 099 created. Leaves every other table/function untouched.

DROP FUNCTION IF EXISTS public.publish_build_status_meta(TEXT, TIMESTAMPTZ, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS public.publish_build_status_functions(JSONB);
DROP FUNCTION IF EXISTS public.publish_build_status_commits(JSONB);
DROP FUNCTION IF EXISTS public.publish_build_status_items(JSONB);

DROP TABLE IF EXISTS build_status_meta;
DROP TABLE IF EXISTS build_status_functions;
DROP TABLE IF EXISTS build_status_commits;
DROP TABLE IF EXISTS build_status_items;
