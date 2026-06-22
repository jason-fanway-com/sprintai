// Migration proof for 015_eval_confidence (additive confidence column).
// Pure local throwaway Postgres via @electric-sql/pglite. NO remote DB.
//
// Applies 014 (to get the base table) then 015 UP / re-UP (no-op) / DOWN /
// re-DOWN (no-op), asserting: column added with default 'high', CHECK rejects
// bad values, sort index present, down removes column+index+constraint cleanly,
// and both up & down are idempotent.
//
// Run (pglite resolvable from /tmp): node run-migration-confidence-proof.mjs

// Resolve pglite even when this script lives in the repo (which has no
// node_modules). ESM resolves bare specifiers relative to THIS file's dir, so
// we fall back to PGLITE_PATH (or the known /tmp install used in this env).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  const p = process.env.PGLITE_PATH ?? '/tmp/node_modules/@electric-sql/pglite/dist/index.js';
  ({ PGlite } = await import(p).catch(() => require_(process.env.PGLITE_PATH ?? '/tmp/node_modules/@electric-sql/pglite')));
}

// Absolute migrations dir so this runs from anywhere (e.g. /tmp, where pglite
// is installed). Override with MIGRATIONS_DIR env if the repo lives elsewhere.
const DIR = process.env.MIGRATIONS_DIR
  ?? '/Users/joestrazza/sprintai-ordering/supabase/migrations/';
const base014 = readFileSync(`${DIR}014_conversation_evals.sql`, 'utf8');
const up = readFileSync(`${DIR}015_eval_confidence.sql`, 'utf8');
const down = readFileSync(`${DIR}015_eval_confidence.down.sql`, 'utf8');

const db = new PGlite();
const log = (...a) => console.log(...a);
let pass = true;
const assert = (n, c, e = '') => { if (!c) pass = false; log(`[${c ? 'PASS' : 'FAIL'}] ${n}${e ? ' :: ' + e : ''}`); };

console.log('=== 015_eval_confidence MIGRATION proof (pglite, throwaway) ===\n');

// minimal deps + base table (014)
await db.exec(`
CREATE TABLE tenants(id uuid primary key default gen_random_uuid(), name text);
CREATE TABLE shops(id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade, name text, created_at timestamptz default now());
CREATE TABLE conversations(id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade);
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
`);
await db.exec(base014);

const hasCol = async () => (await db.query(
  `select 1 from information_schema.columns where table_name='conversation_evals' and column_name='confidence'`
)).rows.length === 1;
const hasIdx = async () => (await db.query(
  `select 1 from pg_indexes where tablename='conversation_evals' and indexname='idx_conversation_evals_tenant_conf_sev_judged'`
)).rows.length === 1;
const hasCon = async () => (await db.query(
  `select 1 from pg_constraint where conname='conversation_evals_confidence_check'`
)).rows.length === 1;

log('-- baseline (014 only): confidence absent --');
assert('confidence column absent before 015', !(await hasCol()));

log('\n== APPLY 015 UP (1st) ==');
await db.exec(up);
assert('confidence column added', await hasCol());
assert('sort index added', await hasIdx());
assert('CHECK constraint added', await hasCon());

// default + check behavior
await db.exec(`INSERT INTO tenants(id,name) VALUES ('00000000-0000-0000-0000-000000000001','T1');`);
await db.exec(`INSERT INTO conversations(id,tenant_id) VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000001');`);
await db.exec(`INSERT INTO conversation_evals(tenant_id,conversation_id,transcript_hash,model,verdict,flags)
  VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c1','h-default','m/v1','clean','[]'::jsonb);`);
const defRow = await db.query(`select confidence from conversation_evals where transcript_hash='h-default'`);
assert("existing/new row defaults confidence='high'", defRow.rows[0].confidence === 'high', defRow.rows[0].confidence);

// explicit 'low' allowed
await db.exec(`INSERT INTO conversation_evals(tenant_id,conversation_id,transcript_hash,model,verdict,flags,confidence)
  VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c1','h-low','m/v1','clean','[]'::jsonb,'low');`);
const lowRow = await db.query(`select confidence from conversation_evals where transcript_hash='h-low'`);
assert("explicit confidence='low' accepted", lowRow.rows[0].confidence === 'low');

// bad value rejected by CHECK
let checkFired = false;
try {
  await db.exec(`INSERT INTO conversation_evals(tenant_id,conversation_id,transcript_hash,model,verdict,flags,confidence)
    VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c1','h-bad','m/v1','clean','[]'::jsonb,'medium');`);
} catch (_e) { checkFired = true; }
assert("CHECK rejects confidence not in (high,low)", checkFired);

log('\n== APPLY 015 UP (2nd, must be no-op) ==');
let reupOk = true;
try { await db.exec(up); } catch (e) { reupOk = false; log('reapply error:', e.message); }
assert('re-running UP is a no-op (no error)', reupOk);
assert('column still present after re-up', await hasCol());

log('\n== APPLY 015 DOWN ==');
await db.exec(down);
assert('confidence column dropped by DOWN', !(await hasCol()));
assert('sort index dropped by DOWN', !(await hasIdx()));
assert('CHECK constraint dropped by DOWN', !(await hasCon()));
// base table survives (only 015 objects removed)
const tblStill = (await db.query(`select 1 from information_schema.tables where table_name='conversation_evals'`)).rows.length === 1;
assert('base conversation_evals table untouched by 015 DOWN', tblStill);

log('\n== APPLY 015 DOWN again (idempotent) ==');
let redownOk = true;
try { await db.exec(down); } catch (e) { redownOk = false; log('re-down error:', e.message); }
assert('re-running DOWN is a no-op (no error)', redownOk);

console.log(`\n=== OVERALL: ${pass ? 'ALL PASS' : 'SOME FAIL'} ===`);
process.exit(pass ? 0 : 1);
