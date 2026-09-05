# Command Center — every tile from a source that cannot drift

Jason directive 2026-09-05. He wants to watch build progress without asking for updates.

## The rule

Every tile reads from a source that cannot drift. No hand-entered status, no
"illustrative" anything. **If a number cannot be derived from real data, do not show it.**

## What is wrong today (verified, not assumed)

- `program_items` holds **3 rows, last touched 2026-06-29** — 68 days stale. It feeds
  THREE tiles: "Progress by epic", "Task board", "Risk register".
- "Phase timeline" is labelled `Illustrative plan — editable`.
- These are hand-maintained snapshots seeded by migrations 016/019. Same failure class as
  the stale AGENTS.md and the `{{DEMO_NUMBER}}` QR codes.

## Sources that are real

| Source | Reaches the browser how |
|---|---|
| `docs/specs/2026-09-03-READINESS.md` | machine publisher → DB |
| `git log` | machine publisher → DB |
| deployed function versions (Supabase Mgmt API) | machine publisher → DB |
| `test_transcripts` | direct live query (super-admin RLS already allows SELECT) |

The browser cannot read the repo or run git. A publisher on the machine derives the data
and writes it to the DB; the dashboard reads the DB. Derived on every run — never typed.

## Deliverable 1 — migration 098

Tables (service-role writes; super-admin SELECT via RLS, mirroring existing admin tables):

- `build_status_items` — `item`, `what`, `status`, `blockers`, `blocked_on_jason bool`
- `build_status_commits` — `sha`, `subject`, `committed_at`, `author`
- `build_status_functions` — `slug`, `version`, `deployed_at`
- `build_status_meta` — single row: `generated_at`, `head_sha`, `readiness_mtime`, `publisher_ok`, `publisher_error`

Full replace per run inside one transaction (delete+insert or upsert), so a removed board
row disappears rather than lingering. No UPDATE/DELETE policy for `authenticated`.

## Deliverable 2 — `scripts/publish-build-status.sh`

Derives and writes, in this order:

1. Parse the READINESS.md markdown table → one row per item (`item`, `what`, `status`,
   `blockers`). Parse the real table; do not hardcode A–N — items get added.
2. `blocked_on_jason` is DERIVED, never typed: true when the item's Blockers or Validated-how
   text matches `/Jason|BLOCKED ON JASON|Jason's (action|integration test)/i`. The tile shows
   the board's own words, so it cannot say something the board does not.
3. `git log` since local midnight America/New_York → sha, subject, committed_at, author.
4. Supabase Management API `/functions` → slug, version, deployed_at.
5. Write `build_status_meta` LAST with `generated_at = now()`, plus `publisher_ok=false` and
   the error text if any step failed. **A failed run must never leave a green, stale board.**

Shell-first: if `HEAD` and the READINESS mtime are both unchanged since the last run, exit 0
without writing anything except a `generated_at` heartbeat. Costs nothing on a quiet minute.
No model is ever invoked by this script.

## Deliverable 3 — launchd `ai.openclaw.sprintai.buildstatus`, every 5 minutes

Plus a `post-commit` git hook firing the same script, so "what shipped today" appears within
seconds of a commit rather than up to five minutes later. Register in
`~/.openclaw-sprintai/SCHEDULED-REGISTER.md` with interval, idle cost, stop condition, owner.

## Deliverable 4 — CommandCenter.tsx

**Tiles, in Jason's priority order:**

1. **Build progress** — every readiness item, status badge, one-line `what`. Grouped by
   status (`building` / `in verification` first, `built` collapsed).
2. **Shipped today** — commits with time (ET) and subject. Empty state says "nothing shipped
   yet today", never a fabricated number.
3. **Test Kitchen activity** — live query on `test_transcripts where source='public-tester'`,
   newest first: tester name (or "anonymous"), reporter note, time, shop. Plus a count of
   distinct testers. This is the loop Jason cares most about.
4. **Blocked on Jason** — the `blocked_on_jason` items, showing the board's blocker text.

**DELETE (illustrative or stale):** Phase timeline, Progress by epic, Task board, Risk
register — and the `program_*` queries feeding them.

**KEEP (already live queries):** deploy/migration status, evals, shops, tenants, ticket
reliability. Verify each still reads a live table before keeping it.

**Freshness guard (mandatory).** Every publisher-sourced tile shows `as of <generated_at>`.
If `generated_at` is older than 15 minutes, or `publisher_ok=false`, the tiles render a
plain "Build status is not updating — publisher last ran at X" banner INSTEAD of the
numbers. A dashboard that silently shows stale data is the thing we are fixing.

## Acceptance criteria — prove each, live

1. Every tile traces to a source. No literal status/percentage/date typed in the component.
2. Change a status in READINESS.md, run the publisher, reload → the tile changes.
3. Make a commit → it appears in "Shipped today" with the right ET time.
4. Submit a Test Kitchen transcript → it appears newest-first with its note.
5. An item whose board text names Jason appears under "Blocked on Jason"; one that does not, does not.
6. Stop the publisher / force `publisher_ok=false` → the stale banner replaces the numbers.
7. `tsc --noEmit` and `npm run build` both exit 0.
8. No `program_*` query remains in CommandCenter.tsx.

## Deploy

Admin dashboard deploys by Netlify CLI (`netlify deploy --prod --dir=admin-dashboard/dist
--site=sprintai-chat-admin`); the GitHub Action path is still blocked on PAT scope. Build
and commit, but **do not deploy** — the lead verifies through the real front door
(`getsprintai.com/admin`) after Melvin.
