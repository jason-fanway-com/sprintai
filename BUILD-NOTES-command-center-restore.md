# BUILD NOTES — Command Center: restore full program view, kept LIVE

**Branch:** `feat/command-center-restore` (off `origin/main` 69687db)
**Builder:** John Walsh · **For verification:** Melvin
**Spec:** `SPEC-command-center-restore-live.md`

## What this does
Restores the original Command Center program-management dashboard (all 11 sections)
that the "live" rebuild (0ebbecd) dropped — but backs every editorial section with
admin-RLS **DB rows** instead of hand-edited HTML, and **derives every rollup at
view-time** in the React component. The 4 operational panels that were already live
are kept unchanged. Updating any program content is now a row write, not a redeploy.

## Files changed (only these — no order-path file touched)
- `supabase/migrations/019_command_center_program.sql` — NEW. 11 additive, admin-RLS
  tables + idempotent seed (faithful transcription of `command-center.html` DATA).
- `supabase/migrations/019_command_center_program.down.sql` — NEW. Reverses 019 only;
  fully idempotent; leaves `program_items` (016) and all pre-019 objects intact.
- `admin-dashboard/src/pages/CommandCenter.tsx` — REWRITTEN. Renders all 11 restored
  sections (top) + the 4 existing live panels (bottom). All rollups computed in-component.

(Build artifacts under `dist/` are NOT committed by this change.)

## Per-section data source (all 11 restored sections)
| # | Section | Source table(s) | Rollups derived in component |
|---|---------|-----------------|------------------------------|
| 1 | Hero (overall build % + vitals) | `program_epics`, `program_tasks`, `program_risks` | overall % = Done tasks / all tasks; vitals = workstreams, tracked tasks, Blocked count, open-risk count |
| 2 | Launch critical path | `program_launch_path` | — (ordered list) |
| 3 | Progress by epic | `program_epics` (meta) + `program_tasks` | per-epic done/total/% |
| 4 | Task board (kanban) | `program_tasks.column_name` | per-column counts; Done shows `evidence`, Blocked shows `blocker` |
| 5 | Roadmap / phase timeline | `program_milestones` + `program_meta` (axis dates) | bar positions from dates; NOW marker from today vs axis |
| 6 | Risk register | `program_risks` | — |
| 7 | Decisions locked / Open decisions | `program_decisions` (kind = locked\|open; open carries owner) | split by kind |
| 8 | Compliance & readiness | `program_compliance` | — |
| 9 | Build team / agents | `program_team` | — |
| 10 | Activity feed | `program_activity` | rendered as PLAIN TEXT (not innerHTML) |
| 11 | Series A readiness | `program_series_a` | — |

Operational panels (unchanged, still live): deploy ledger via
`rpc('command_center_deploy_status')`; conversation quality via `conversation_evals`;
onboarding/tenant via `shops`+`tenants`; known open items via `program_items`.

## Derived-not-typed (acceptance #2)
No hard-coded rollup literals in the component (`grep "67%|71%|17.8%"` → none). Overall %,
vitals, per-epic %, kanban counts, and the NOW marker all compute from rows at render.

## Proofs

### Build (acceptance #6)
`npm run build` in `admin-dashboard` → `tsc && vite build` PASS, no TS errors.
Output: `index-pr4lu6Tk.js` (550 kB) + css. Route still mounts under `ProtectedRoute`
(`App.tsx` line 71, unchanged). `git diff --name-only` shows only the 3 files above + these notes.

### Migration apply + idempotency (acceptance #4) — TEST project `rvdqfxtrskxekfkqnegx`
Applied via Supabase management SQL endpoint (`POST /v1/projects/{ref}/database/query`,
Bearer `$SUPABASE_ACCESS_TOKEN`).
- UP applied twice → both returned `[]` (success). Row counts after 2 applies (no dupes):
  epics 8, tasks 21, milestones 7, launch 4, risks 5, decisions 15, compliance 6, team 3,
  activity 6, series_a 5, meta 2 — exactly the single-seed counts. **Idempotent.**
- All 11 new tables: RLS enabled = true, exactly 1 admin policy each
  (`auth.jwt()->'user_metadata'->>'is_admin' = 'true'`).
- DOWN applied → 0 program_* tables remain (excluding `program_items`); re-run DOWN → `[]`
  (idempotent via DROP ... IF EXISTS). `program_items` untouched (3 rows). The pre-existing
  `command_center_deploy_status()` fn and `set_program_items_updated_at` survive.
- Re-applied UP to leave TEST seeded for Melvin (tasks=21, epics=8, program_items=3).

### Live edit, no redeploy (acceptance #7)
Flipped `program_tasks.task_key='wiz-4'` from `In Progress` → `Done` (single row write):
overall build % moved **67% → 71%** (derived). Reverted to seeded truth (`In Progress`,
67%) — matches the original HTML's computed overall of 67%.

### No secrets in bundle (acceptance #5)
`CommandCenter.tsx` contains no secret (grep service_role/sbp_/sk_/access_token/eyJ → none);
all 5+ reads go through the existing `supabase` client with the admin user's JWT. The only
JWT in `dist` is the **public anon key** (`"role":"anon"`) that ships in every build — no
service-role key, access token, or `sk_` secret added.

### Order path untouched (acceptance #6)
`git diff --name-only` contains no `supabase/functions/*`, chat-sms, stripe, checkout,
refund, toast, connect, webhook, or order file. These program_* tables are read-only
operator tables; nothing in the order/messaging/billing path references them.

## NOT done (by instruction)
- NOT merged to main. NOT deployed. Handed to Melvin for independent verification first.
