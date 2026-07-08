# SPEC — Command Center: restore full program view, keep it LIVE

**From:** SprintAI_bot (lead) · **To:** John Walsh (builder) → Melvin (verify)
**Branch:** `feat/command-center-restore` off `origin/main` (69687db)
**Why:** The "live" rebuild (`0ebbecd`) kept 4 operational panels but DROPPED the
entire program-management dashboard the original Command Center existed for. Jason:
"you lost most of its functionality. Go back and review the original spec and bring
back the functionality but make it live."

The original spec = `feat/command-center-stage1:command-center/BUILD-NOTES.md` and the
HTML at `feat/command-center-auth-gate:command-center/command-center.html`. Read both.

## The governing rule (do not violate)
Original = hand-edited HTML arrays (drifts). Rebuild = "never hand-maintained" (lost the
content). The synthesis Jason is asking for: **every original section comes back, but
backed by editable DB rows + live-derived rollups**, never hand-edited HTML in the bundle.
- Editorial content (epics, tasks, milestones, risks, decisions, open decisions,
  compliance, team, activity feed, series-A) → **DB rows** (admin-RLS tables), edited by a
  row write, exactly like the existing `program_items` table. No redeploy to update.
- Rollups (overall build %, vitals, per-epic %, kanban column counts, roadmap NOW marker)
  → **derived at view-time in the component** from those rows. Never stored, never typed.
- Keep ALL 4 existing live panels too (migrations ledger, conversation-quality, onboarding/
  tenant counts, program_items blockers). Nothing currently live is removed.

## Sections to restore (from the original, in this order)
1. **Hero** — title + overall build % + vital signs (workstreams / tracked tasks /
   blockers / open risks). All derived.
2. **Launch Critical Path** — prominent highlighted card directly under hero (the most
   important section). From `program_launch_path` rows: step #, title, detail, state
   (progress|blocked|todo|done) + label.
3. **Progress by epic** — from `program_epics` (meta) + `program_tasks`; per-epic
   done/total + % derived.
4. **Task board (kanban)** — columns To Do / In Progress / In Review / Done / Blocked from
   `program_tasks.column`; Done cards show their `evidence` ref; Blocked cards show `blocker`.
5. **Roadmap / phase timeline** — from `program_milestones` (start/end/status) with a
   computed NOW marker against an axis (store axisStart/axisEnd as two rows in a small
   `program_meta` key/value table, or constants — your call, but keep them changeable).
6. **Risk register** — from `program_risks` (risk, severity, likelihood, status, mitigation).
7. **Decisions locked** + **Open decisions** — from `program_decisions` (kind = 'locked' |
   'open'; open rows carry an owner).
8. **Compliance & readiness** — from `program_compliance` (item, status text, state).
9. **Build team / agents** — from `program_team` (name, role, model, load).
10. **Activity feed** — from `program_activity` (when label + html-safe text). Render as
    plain text, not innerHTML.
11. **Series A readiness** — from `program_series_a` (item, status text, state).

## Implementation
- **Page:** rewrite `admin-dashboard/src/pages/CommandCenter.tsx`. Keep it under the authed
  Layout / ProtectedRoute (already mounted). Reuse `card`/`btn-secondary` design system.
  Apply the original brand accent feel within the existing Tailwind system (orange brand-600
  already in use). Do NOT introduce a second CSS framework or Google Fonts CDN — keep it in
  the React app's existing styling. Responsive: kanban scrolls horizontally, panels stack on
  mobile, `prefers-reduced-motion` respected for any animation.
- **Data:** one new migration `019_command_center_program.sql` (+ `.down.sql`), ADDITIVE
  ONLY, idempotent (CREATE IF NOT EXISTS, guarded policies, seed via WHERE NOT EXISTS by a
  stable key column). New tables: `program_epics`, `program_tasks`, `program_milestones`,
  `program_launch_path`, `program_risks`, `program_decisions`, `program_compliance`,
  `program_team`, `program_activity`, `program_series_a` (and `program_meta` if you use it
  for axis dates). Each gets the SAME admin-only RLS policy shape as `program_items`
  (`auth.jwt()->'user_metadata'->>'is_admin' = 'true'`), an `updated_at` trigger, and a
  stable unique key column for idempotent seeding.
- **Seed** every table with the EXACT current program state from the original HTML's `DATA`
  object (I pasted it below — transcribe it faithfully; do not invent or inflate metrics).
  Where the original marked something unknown/honest, keep it honest.
- All reads use the admin user's JWT via the existing `supabase` client. **No service-role
  key, access token, or any secret in the bundle or in committed files.** Same hard rule the
  current page already honors.
- The live order path (chat-sms and friends) must not be touched. These are read-only
  internal operator tables; nothing in the order/messaging/billing path reads or writes them.

## Acceptance criteria (Melvin verifies — independent)
1. All 11 original sections render with the seeded real data; nothing from the original is
   missing. Side-by-side against `command-center.html` confirms parity of content.
2. Overall %, vitals, per-epic %, kanban counts, and the NOW marker are DERIVED in the
   component (grep: no hard-coded "67%"/"17.8%" literals; they compute from rows).
3. All 4 previously-live panels still work (migrations, conversation-quality, onboarding,
   program_items). Nothing live was removed.
4. Migration 019 applies cleanly on the TEST project, is idempotent (re-run = no error, no
   dupes), and its `.down.sql` reverses it. ADDITIVE only — no drops/edits of existing tables.
5. Every new table is admin-RLS gated; a non-admin JWT reads nothing (same proof shape as
   program_items). No secret anywhere in the bundle (`grep -ri "service_role\|sk_live\|sk_test\|access_token" admin-dashboard/dist` finds nothing new).
6. `admin-dashboard` builds clean (`npm run build`), no TS errors; route still mounts under
   ProtectedRoute; no order-path file changed (`git diff --name-only` shows only dashboard +
   the new migration + build notes + dist).
7. Editing a row (e.g. flip a `program_tasks.column` to 'Done', or a launch step state)
   changes the page on reload WITHOUT a redeploy — prove with one before/after.

Write BUILD-NOTES-command-center-restore.md with files changed, the per-section data source,
and the proof steps. Do NOT merge or deploy — hand to Melvin first.

---

## ORIGINAL DATA TO TRANSCRIBE (faithful seed — from command-center.html)
See `feat/command-center-auth-gate:command-center/command-center.html` lines ~378–510 for
the authoritative source. Transcribe epics, tasks (with evidence/blocker), milestones
(axisStart 2026-04-01 / axisEnd 2027-07-01), launch_path, risks, decisions (locked),
open decisions (with owner), compliance, team, feed, seriesa EXACTLY as written there.
Pull the live copy with:
  git show feat/command-center-auth-gate:command-center/command-center.html > /tmp/cc-orig.html
Then read /tmp/cc-orig.html lines 378–510.
