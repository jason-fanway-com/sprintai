# SprintAI — Handoff

Last updated: 2026-09-11

What an incoming engineer needs to understand this system and start contributing
within a day. Not a reference — a map.

---


## State as of 2026-09-05 10:34

Written from the code and `git log`, not from specs. Where they disagree, the code wins.

### What is LIVE right now

| Thing | Where | State |
|---|---|---|
| Public tester link | `getsprintai.com/test-kitchen` | Live, `public_tester_enabled = true` (`/try` 301s here) |
| `public-tester` edge function | Supabase | Deployed |
| Migration 096 (tester tables, `app_config`) | Supabase | Applied |
| Migration 097 (`owner_edited`, owner INSERT/DELETE RLS) | Supabase | Applied |
| `test_transcripts` capture from the simulator | Admin dashboard | Shipped (095 applied) |
| Expo Screen, Demo Kit, menu confidence curation | Admin dashboard | Shipped |

### What is committed but NOT deployed

- `import-menu-csv` honouring `owner_edited` — changes import behaviour for real shops'
  menus. Needs QA before it goes anywhere near NJB or Zio's.
- Branch `shop-editor-admin-shape` — the admin-shaped menu/config editor, reverted off
  `main` because the feature was redefined as owner-facing. Kept for reuse.

### The public tester, in one paragraph

`test-kitchen.html` (root, allowlisted in `scripts/build-public-site.sh`) talks only to the
`public-tester` edge function. That function holds the service role and is the single place
the kill switch, the test-shop guard, the 20-turn cap and the three rate limits are
enforced — nothing is trusted from the browser, including the transcript, which the
function accumulates itself turn by turn. Kill it with
`update app_config set value='false'::jsonb where key='public_tester_enabled';`.
Cost is quadratic in turns: ~$0.08 for a 9-turn order, ~$30 for 100 testers × 3 orders.

### Open, and who has to move

- **Owner-facing menu/config editor** — designed and specced
  (`docs/specs/2026-09-05-shop-editor.md`), including the requirement that the admin chat
  and the structured form are two views of ONE operations layer. Awaiting Jason's go.
- **A `support` app role** — RLS gives cross-shop scope to super-admins only, so giving
  the product owner that scope today also hands them Toast secrets and the money screens.
  Jason's call.
- **Hours fall-through in `chat-sms`** — a missing day key in `open_hours` falls past the
  closed-message block and the bot takes the order anyway. Latent today (all real shops
  have seven day keys), likely the moment owners edit their own hours.
- **`SettingsTab` exposes `toast_client_secret` and `phone_number_e164`** as editable
  fields. Pre-existing, not from this week's work, but it is why "just give the product
  owner the settings tab" is not free.
- **`delivery_hours`** is a column and is validated on write, but `chat-sms` does not read
  it anywhere. It has no runtime effect yet.

## State as of 2026-09-05 21:02

Supersedes the 10:34 snapshot above for anything it contradicts; that snapshot is left
in place as a record, not corrected in place. Full narrative: `docs/DAILY.md`.

### What is LIVE right now (new since 10:34)

| Thing | Where | State |
|---|---|---|
| Owner-facing Menu & Settings editor | `/menu-settings` in the admin dashboard | Live. Writes go through `admin-chat`'s registry under the owner's own JWT, never service-role. Nine operations including `ADD_ITEM`/`REMOVE_ITEM`. Migrations 097/101/104 applied. |
| `import-menu-csv` v38 | Supabase, confirmed via CLI | Deployed. Owner-edited option groups/choices now survive re-import (items already did under v37). |
| `scrape-shop` v73 / `parse-menu-pdf` v93 | Supabase, confirmed via CLI | Deployed. Source-priority ladder (own site → owner PDF/photo → Google listing → aggregator last resort) with per-item provenance (migration 102). v73 adds deadline-aware timeouts on the largest menus — see "State as of 2026-09-06" below. |
| chat-sms | Supabase | v226 per the readiness log (not independently reconfirmed via CLI this pass). Clause-aware phantom-add guard; delivery-availability now requires coordinates AND a configured radius. |
| Judge panel | Admin dashboard, under the chat simulator | Live, read-only/advisory. No code path writes a proposal back into a live prompt or config. |
| Public tester rate limits | `public-tester` edge function | Per-IP and per-browser hourly limits REMOVED; global daily cap raised 150 → 1000. Turn claiming is now atomic (RPC, migration 098). |
| `test-kitchen.html` | root, was `try.html` | `/try` and `/try.html` now 301 to it. |

### What changed from "committed but NOT deployed" (10:34 list)

- `import-menu-csv` honouring `owner_edited` — now deployed as v38 (see above), and the
  gap it closes turned out narrower than first reported: the original claim that the
  deployed importer had zero `owner_edited` handling was wrong (a bad `supabase functions
  download` grep measured a file that was never in the extraction). Corrected on the
  record at 21:05 EDT.
- Branch `shop-editor-admin-shape` (the admin-shaped editor) — still reverted off `main`,
  still kept for reuse. Unchanged.

### What is committed but NOT deployed / NOT independently reconfirmed

- Everything above marked "per the readiness log, not independently reconfirmed via CLI"
  — treat as likely true (internally consistent with commit timestamps) but not verified
  by this pass the way `import-menu-csv`/`scrape-shop`/`parse-menu-pdf` were.
- Working-tree changes to `scripts/imsg-bridge.sh`, `scripts/test-suite/run.ts`,
  `vitos-demo.html`, and `deno.lock` are UNCOMMITTED as of this writing — not staged, not
  part of any commit today.

### New standing operational risk

**Admin dashboard auto-deploy has been broken since 8/22** (stated in a82ab23's own
commit message). Bundles are deployed by hand and then committed to git after the fact
so `main` has a record of what's actually live — `main` was found stale today (carrying
`index-FezUO85U` while the front door served `index-C6h_btXT`). See RUNBOOK.md.

## State as of 2026-09-06 04:00

Supersedes the 21:02 snapshot above for anything it contradicts.

- **`scrape-shop` v73** (52f4caf) — confirmed deployed via `supabase functions list`
  (2026-09-06 03:32 UTC). Fixes the item-K remeasure2 failure on the two largest
  menus: `MENU_LLM_TIMEOUT_MS` exceeded the platform's ~150s function ceiling, so
  the biggest extractions died to a gateway 504 and one of them left its shop stuck
  `crawl_status='running'` forever. Every bounded network call in the function is
  now budget-aware and skips itself rather than firing into a deadline it can't
  meet. Also fixes a silent no-op: the PDF-rung provenance write was targeting a
  menu row that `parse-menu-pdf` had already replaced. See RUNBOOK.md for detail.
  **Not yet re-measured against the item-K sample** — that remeasure is still the
  open item on `docs/specs/2026-09-03-READINESS.md`.
- Working-tree state is unchanged from the 21:02 snapshot: `scripts/imsg-bridge.sh`,
  `scripts/test-suite/run.ts`, `vitos-demo.html`, and `deno.lock` are still
  uncommitted, plus a number of untracked spec docs and `scripts/tmp-*` scratch
  files from the item-K measurement runs. None of that is reflected as shipped.

## State as of 2026-09-06 20:45

Supersedes the 04:00 snapshot above for anything it contradicts. Full narrative:
`docs/DAILY.md`. This was a 51-commit day dominated by a real P0 revenue bug in
`chat-sms` and a new customer-facing feature.

### What is LIVE right now (new since 04:00)

| Thing | Where | State |
|---|---|---|
| `chat-sms` v259 | Supabase, confirmed via CLI | Deployed 00:43 UTC 09-07 (00:43 = 20:43 EDT), one minute after the day's final commit — the whole 17-commit guard chain is live, not just committed. Fixes a real P0 (cart doubled $37.97→$74.95 on a bare "Looks good" after a fuzzy-match upsell line sat unresolved in history), a pending-disambiguation/pending-option persistence layer (9 commits), and five iterations on a new duplicate-item-name guard (GUARD 7c). See DAILY.md for the full chain — several of the intermediate guards were themselves broken on first commit and fixed same-day. |
| `getsprintai.com/m/<slug>` | Netlify Edge Function (`menu-proxy.js`) + `public-menu` Supabase fn v7 | Live, verified just now via `curl`: 221 real items, correct `text/html` Content-Type, no dev placeholder text. No auth, no ordering — read-only menu link, texted to strangers. |
| `issue-detector` v18 | Supabase, confirmed via CLI | Deployed 14:31 UTC. Was fail-open (any unauthenticated POST ran a live owner-SMS escalation sweep) — now requires a bearer secret, fail-closed. Verified live: no-auth/wrong-bearer/anon-key all 401. |
| `public-tester` v6 | Supabase, confirmed via CLI | Deployed 13:51 UTC. Records `user_agent` + `client_first_seen_at` per session (IP alone can't separate testers behind one household NAT). |
| Vito's Pizza QA twin, NJB test clone | Database rows, applied directly (not via a tracked migration — see below) | Both retired: renamed `ZZ RETIRED`, paused, slug changed, rows kept for audit. Standing rule now in RUNBOOK: one shop per real-world restaurant. |

### Migration-tracking is unreliable on this project — verify directly, don't trust the CLI alone

`supabase db push --dry-run` reports migrations 105–111 (all of today's `qa_ro`
reporting work) as **not applied to remote**. That is not proven true: a live probe
of migration 109's actual change (POSTing to the deployed `public-tester` function)
shows its columns exist and work on the real database right now. The
`supabase_migrations.schema_migrations` tracking table has drifted from actual
schema state — this project has applied schema changes directly against the
database at least twice today (migration 109, and the two shop-retirement UPDATEs,
neither of which appears in any migration file) without going through `supabase db
push`. Practical effect: "not applied" per `supabase migration list` is not reliable
evidence of "not live" here. 105–108/110–111 specifically are unverified either way —
they only affect `qa_ro` views, reachable solely via credentials on Jason's Mac, not
from this environment. Verify directly (`qa_ro.schema_migrations`, itself from 111)
before assuming any of them are missing or present.

### What is committed but NOT deployed

- `scripts/test-suite/proof.ts`, `supabase/functions/test-runner/index.ts`, and
  `scripts/test-suite/cart-ops.ts` carry a new `verifyRequiredOptionsCovered`
  deterministic invariant plus a new `category-coverage.ts` case generator —
  **uncommitted** in the working tree as of this writing (confirmed passing,
  5/5, when run directly).

## State as of 2026-09-07 04:00

Supersedes the 20:45 snapshot above for anything it contradicts. Two commits
landed overnight, both in `scripts/test-suite/` and its
`supabase/functions/_shared/test-suite/` mirror — no chat-sms or admin-facing
change.

1. The `category-coverage.ts` generator and the two new invariants noted
   above (`verifyRequiredOptionsCovered`, `expectedLineCount`) are now
   **committed** (`fe37f88`), not uncommitted. Also fixed a fail-open defect
   here: `verifyStatedTotal`, `verifyStopOptOutHonored`, `verifyCheckoutFinalize`,
   and `verifyRequiredOptionsCovered` all used to report `passed:true` on a
   transcript-less run — now `passed:false`, since a check that can't see
   what happened hasn't verified anything.
2. `1412ef1` made the test-suite safety gate channel-aware (`safety-gate.ts`):
   a `"web"`-channel run (which is all this harness ever does — it POSTs
   JSON to `chat-sms`, never Twilio) now skips the protected/phone checks
   that previously blocked Proof from running against any shop with a real
   phone number. This closes the exact structural gap `fe37f88`'s commit
   message flagged as "not fixed here" — Proof can now gate Vito's Pizza
   itself, not just a phone-less QA twin.

**Still NOT deployed**: `test-runner` (Supabase edge function) was last
deployed 2026-09-04 14:22 UTC, version 28 — both commits above post-date that
deploy, so the live autonomous test-runner is running the OLD code (no
category-coverage cases, no fail-open fix, old unconditional safety gate).
`supabase functions deploy test-runner` has not been run. The CLI-driven
`scripts/test-suite/` path picks up both changes immediately since it runs
from the working tree.

**CLOSED 2026-09-07 07:05 EDT** — deployed `test-runner` v29, confirmed live
via `supabase functions list` (ACTIVE, version 29, deployed 2026-09-07
11:05:07 UTC). `deno check` clean pre-deploy, working tree clean. The
pg_cron-driven autonomous Proof suite now runs `fe37f88` (category-coverage
invariants + fail-open fix) and `1412ef1` (channel-aware safety gate), not
the stale 09-04 code.

## State as of 2026-09-07 22:30

Supersedes the 04:00 snapshot above for anything it contradicts. This was a large
day (~65 commits) dominated by a new "conversation-ready-menu Phase 0"
schema/compiler subsystem plus the usual chat-sms guard-chain churn. Full detail in
`docs/DAILY.md`'s `## 2026-09-07` entry; this section is the live-vs-committed
summary only.

### What is LIVE right now (new since 04:00)

- `chat-sms` (v282) — the self-contradiction ordering fix
  (`zero-option-attribute-hint.ts`, runs before the model composes a reply, not
  after) plus GUARD 12/13/16/17 work from today. Live-verified against real NJB
  conversations, independently re-verified by a second reviewer.
- `scrape-shop` (v76) — chunk-drop/truncation honesty signal (migration 120
  columns) and the wall-clock-timeout chunking fix, with its own same-day
  `Deno.serve` regression caught and fixed before this deploy.
- `compile-menu` (v4) — exists and is callable, but is **stale relative to main**:
  it predates today's `normalize.ts` multi-clause parser fix. Do not invoke it
  against a real shop's menu until it is redeployed, or it will re-run the old
  parser and can re-corrupt data the way it did on Zio's before the `.in()`-batching
  fix (183 items wrongly marked `blocked` from one silently-failed 492-ID query).
- `test-runner` (v29) — includes category-wide order coverage and the
  channel-aware safety gate (both closed out in the 04:00 entry above). Does **not**
  include the three Proof false-failure fixes or the undefined-cart guard committed
  later the same day (see below).

### What is committed but NOT deployed

- `396c85d` (3 classes of Proof harness false-failures) and `ba6efd7` (undefined-
  cart guard) post-date the `test-runner` v29 deploy — the pg_cron-driven
  autonomous Proof suite is running without them. Only the CLI-driven
  `scripts/test-suite/` path has them (it runs from the working tree).
- `chat-sms-mtest`'s share of the menu-option-caps fix (`fe85bb4`) — the deployed
  mtest function is a full day older than that commit.
- The new item-8 compiled ordering engine (`ask-plan-engine.ts`, migration 118's
  `compiled_ordering_engine_enabled` flag) is deployed in `chat-sms` but **on for
  no shop** — every shop defaults `false`, and Vito's (the canary) must never be
  flipped on per the column's own SQL comment. Treat this as shipped-but-inert
  until a shop is explicitly turned on.
- `planOwnerQuestionsRefresh` — built and live-verified against Not Just Bagels
  (found 3 stale `priority` values, a display-order-only bug) but **not applied**
  to NJB's real data pending an explicit sign-off decision.

### New standing operational risk: a live P0 shipped from the guard chain today

GUARD 12 briefly flagged every pending required-option question as a false claim —
live, on Vito's Pizza, the production canary — before being caught and fixed same
day (`bc2e0bc`). This is the guard-chain fragility risk already named in the
2026-09-06 handoff, now with a concrete production instance: a new guard broke
correct behavior on the shop real customers use. No process change has been made
in response yet; flagging so it isn't quietly repeated.

### Open decision needed from Jason

`order_carts.notes` sometimes isn't actually written even when the bot's reply
says a kitchen note was recorded — confirmed live on NJB (~1 in 3 turns, direct DB
query, not inferred). Same class of bug as the self-contradiction fix just shipped,
but in the notes field, with real kitchen-facing impact. Not fixed; needs a
priority call, not silent absorption into the backlog.

## State as of 2026-09-08 22:20

Supersedes the 2026-09-07 22:30 snapshot above for anything it contradicts. Full
detail in `docs/DAILY.md`'s `## 2026-09-08` entry; this section is the
live-vs-committed summary only.

### Standing operational risk, escalated: unreviewed code went to production twice tonight

Not a new class of bug — the same guard-chain fragility flagged 2026-09-06 and
2026-09-07 — but tonight it happened via **direct, unreviewed deploys**, not a
merged-and-tested regression: `chat-sms` was pushed live twice off uncommitted
code (v295→v296, then v301→v302→v303) without an acceptance battery run first.
The second time produced a real-money defect (wrong topping added, customer
undercharged $3) and the bot falsely told two customers who did nothing wrong
that it "got mixed up." Both were caught and rolled back same night; `chat-sms`
is now **v306**, confirmed byte-identical to committed HEAD (`a351622`'s
version of `index.ts`). The root cause of the wrong-topping bug was never
found. **Do not deploy `chat-sms` from a dirty working tree without first
running the PO's live acceptance battery** — this is the second time in one
night that skipping it reached a real customer.

### What is LIVE right now (new since 22:30 on 2026-09-07)

- `chat-sms` (v306) — RESET now clears conversation history in addition to the
  cart (real-money P0, `b865d3a`); the D1 multi-item modifier-merge fix
  (`f76d84f` + `947ccb9`, validates model-asserted options against real
  compiled choices before writing); NJB's "served with" clause parser recovery
  (`a351622`); Zio's required-singleton-group fix (`ac8f69d`). Does **not**
  include `pizza-topping-compose.ts` or `guard19-fuzzy-item-match.ts` — see
  risk note above, both are uncommitted and were reverted out.
- `scrape-shop` (v78) — ChowNow's client-rendered menu now scrapes correctly
  (`waitFor: 5000` for that aggregator only); live-verified at 109 recovered
  items, independently reproduced by a second reviewer.
- `compile-menu` (v9) — current with today's archetype/bread-guard fixes.
- Zio's Pizzeria's menu data — the size-fold is **applied and live** (220→301
  active items), including a same-day fix for a bug in that same reapply
  (exploded size rows had lost their topping/modifier option groups; cloned
  back + backfilled).
- `customer-crm` (v1) — first deploy of the new owner-facing Customer CRM
  screen's backing function.

### What is committed but NOT deployed

- `customer-crm`'s phone-canonicalization fix (`bccc6e2`) — the live v1 deploy
  predates it by ~4 hours; profiles keyed off a rotating iMessage-bridge session
  ID may still fragment into duplicates until redeployed.
- `chat-sms-mtest` (v20) — predates both `fd4412d` (opt-out phone_number fix)
  and the `sms_opt_outs` schema fixes; the test double is behind the primary
  bot on this compliance fix.
- `public-tester` (v8) — likely predates `a3609e4` (Vito's carrier-number
  allowlist) by ~5 minutes; unconfirmed either way, redeploy to be safe before
  relying on Test Kitchen against Vito's live number.
- The Hot/Cold Subs bread gap on Zio's Pizzeria (25 items blocked) — diagnosed
  as pre-existing and unrelated to the size-fold, but no fix shipped this
  range. Needs a PO decision.
- NJB's bread-fact extractor (`1e47f97`, unblocks 23/38 items) — built and
  verified but the recompile that would apply it to NJB's real data was not
  authorized this session.

### Open and unresolved: migration 121/122 live-status conflict

`supabase migration list` says migrations 121 (`customers` table) and 122
(`sms_opt_outs` fix) are not applied on the remote tracker. Tonight's own build
log claims both were applied out-of-band via the Management API and verified
live via direct `pg_constraint` queries — a precedent this project has used
before (see RUNBOOK's migration-tracker-drift entry). This session had no
service-role DB credential to check directly (only read-only `qa_ro`, which
doesn't expose either table). **Whether the compliance fix and the CRM table
are actually live cannot be confirmed from this session** — verify directly
against the primary database before relying on either.

### Open decision needed from Jason (carried over, unchanged)

`order_carts.notes` sometimes isn't actually written even when the bot claims a
kitchen note was recorded (2026-09-07 finding). Still not fixed.

## What SprintAI is

SprintAI replaces restaurant phone ordering with AI. A customer texts a
restaurant's phone number, an LLM handles the full ordering conversation
(menu, bundles, delivery address, checkout), and the order is charged via Stripe
Connect. No app download, no website — just text. There is also a web chat
fallback (PWA) and an AI-powered admin dashboard where shop owners manage menus
and delivery by talking to the system in plain English.

The business model is a flat $99/mo subscription plus a $0.99 service fee per
order (one offering, one price — no tiers). The codebase is built from day one
to self-serve thousands of restaurants — every onboarding step, number
provision, and menu import is automated.

---

## The big ideas

1. **LLM as state machine.** The ordering conversation is not a form wizard.
   It's an LLM with a system prompt, a tool loop (`submit_order`, `add_to_cart`,
   `show_menu`, etc.), and structured outputs. The conversation IS the UX.

2. **Conversational admin.** Shop owners don't click through CRUD forms. They
   tell the AI "make the poppy seed a dozen special for $14.99 on Saturdays" and
   the AI proposes a change. The owner confirms, it executes. Everything is
   undoable and audited.

3. **Automated quality monitoring.** `eval-sweep` (the "Conversation Judge") is
   an out-of-band worker that reads completed conversations, scores them against
   a rubric, and flags issues. It never touches the live order path. The
   `issue-detector` turns those flags into actionable alerts.

4. **Relentless automation.** Number provisioning, menu import, knowledge-base
   scraping, merchant onboarding wizard — all self-serve, no human-in-the-loop
   for routine operations. The North Star is thousands of restaurants with
   minimal manual intervention.

5. **Safety by construction.** The outbound guard is a structural chokepoint:
   every customer-facing message must pass through `guardedSend()` with a valid
   reason. Default is deny. There is no other door.

---

## Repository layout

```
sprintai-ordering/
├── admin-dashboard/          # React + Vite admin SPA (login-gated)
│   └── deploy-root/          # What gets deployed to sprintai-chat-admin
├── shop-chat/                # React + Vite PWA for customer web chat
├── supabase/
│   ├── config.toml           # Function JWT settings + project config
│   ├── functions/            # Edge functions (Deno, deployed to Supabase)
│   │   ├── chat-sms/         # Core ordering state machine
│   │   ├── admin-api/        # REST API for dashboard
│   │   ├── admin-chat/       # Conversational admin
│   │   ├── create-checkout/  # Stripe Checkout (direct charge)
│   │   ├── pay-redirect/     # Short-branded pay.getsprintai.com → Stripe 302 redirect
│   │   ├── stripe-webhook/   # Billing events → tenant lifecycle
│   │   ├── eval-sweep/       # Conversation quality judge
│   │   ├── issue-detector/   # Issue detection from evals
│   │   ├── onboard-tenant/   # Website scrape → knowledge base
│   │   ├── train-tenant/     # Text paste → knowledge base
│   │   ├── import-menu-csv/  # CSV menu importer
│   │   ├── create-subscription/  # Stripe $99/mo Checkout (subscription mode)
│   │   ├── connect-*/        # Stripe Connect onboarding
│   │   ├── go-live/          # All-or-nothing go-live gate
│   │   ├── provision-number/ # Auto-buy Telnyx number
│   │   ├── merchant-auth/    # PIN auth for sold-out manager
│   │   ├── shop-financials/  # Shop financial reporting (KPIs, ledger, payouts)
│   │   ├── test-runner/       # Autonomous acceptance suite (pg_cron, server-side)
│   │   └── _shared/          # Shared libraries
│   │       ├── outbound-guard.ts      # THE chokepoint — every send goes here
│   │       ├── connect.ts             # Stripe helpers + isShopLive() gate
│   │       ├── test-mode.ts           # Test key allowlist
│   │       ├── stripe-financials.ts   # Real Stripe fees + payout reconciliation
│   │       ├── telnyx-error.ts        # Classify Telnyx opt-out/blocked rejections
│   │       ├── judge-*.ts             # Evaluator rubric + notify + autofix
│   │       └── test-suite/            # Shared test library: generator, runner, judge,
│   │                                  # scorecard, persist, cart-ops, hours-closed, fix
│   └── migrations/           # SQL migrations (001–070)
├── scripts/
│   ├── imsg-bridge.sh        # iMessage bridge (runs on the Mac)
│   ├── build-public-site.sh  # Allowlist build for public origin
│   ├── check-issues.sh       # Issue monitoring helper
│   ├── create-qa-twin.py     # Clone any shop as QA twin for Proof testing
│   ├── create-vitos-pizza-demo.py  # Create Vito's Pizza demo from Jack's Slice CSV
│   └── test-suite/           # Per-shop conversation QA suite
│       ├── run.ts            # CLI driver (generates, runs, judges, fixes, persists)
│       ├── generator.ts      # Auto-generates menu-derived cases per shop
│       ├── library.ts        # 15 conversational multi-turn + 16 adversarial cases
│       ├── runner.ts         # Web/simulated multi-turn driver with timeout+retry
│       ├── judge.ts          # Rubric judge — grades full transcripts
│       ├── scorecard.ts      # Aggregate scoring (≥95% pass, 100% critical)
│       ├── fix.ts            # LLM root-cause + proposed-fix generator for failures
│       ├── persist.ts        # Writes results to test_runs / test_case_results
│       ├── cart-ops.ts       # Shop-aware CartOps battery + Proof invariants (P1/P2/P3)
│       ├── hours-closed.ts   # Deterministic closed-hours gate case
│       ├── proof.ts          # Deterministic acceptance engine (100% gate)
│       ├── quick.ts          # Fast 25-case deterministic runner (~2–4 min)
│       ├── alias-unit.ts     # Alias resolution regression coverage
│       ├── verify-cycle-4.ts # Cycle 4 verification suite
│       └── worker.ts         # launchd worker — drains test_run_queue (onboarding QA)
├── how-it-works.html         # Mobile sales explainer (signup→kit→2wk→pricing)
├── vitos-demo.html            # Vito's Pizza demo page (self-serve, QR-coded)
├── docs/demo/                # Erin (NJB) demo kit — 3-QR walkthrough email
├── netlify/
│   └── functions/            # Netlify serverless functions
│       └── stripe-webhook.js # B2B subscription checkout
├── public/                   # Built output (allowlist, gitignored)
├── netlify.toml              # Root site build + proxy rewrites
├── RUNBOOK.md                # Operational reference
├── BUSINESS.md               # Business context (this repo)
└── VERIFIED.md               # Stripe API verification notes
```

---

## Key files to read first

1. `supabase/functions/chat-sms/index.ts` — the core ordering bot. This is the
   system. System prompt builder, tool loop, bundle logic, checkout transition,
   transactional events. ~1200 lines.

2. `supabase/functions/_shared/outbound-guard.ts` — the safety chokepoint.
   Understand this before touching any send path.

3. `supabase/functions/admin-chat/index.ts` — the conversational admin model:
   LLM proposals, confirmation cards, undo.

4. `scripts/imsg-bridge.sh` — the iMessage bridge. Polls Messages.app, judges
   freshness, forwards to the edge function.

5. `netlify.toml` — build, publish, admin proxy. The topology document.

6. `supabase/migrations/` — skim 038 (tenant isolation), 039 (delivery flow),
   040 (test mode fixes), 041 (ops-table RLS lock), 042–045 (kitchen-ticket
   idempotency, order-number hardening, audit log, inbound dedup),
   046 (PII-table RLS forced + admin transcript INSERT gate),
   047/048 (issue-detector pg_cron schedule), 050 (7-column menu schema +
   owner sign-off), 051 (protected-shop guard), 052 (test suite results),
   053 (test-suite read RLS), 054/055 (case-fix tracking: proposed_fix,
   fix_status, root_cause), 056 (sms_opt_outs), 057–059 (onboarding fields:
   owner_name/onboarding_token/ein/is_test/crawl), 060–061 (delivery_hours +
   structured hours normalization), 062 (Google Places fields),
   063 (delivery radius + geo), 064 (test_run_queue),
   065 (bot_segments + reached_checkout for auto segment tracking),
   066 (scorer_version for freeze-gated scoring).
7. `docs/specs/menu-intake-standard.md` — canonical schema, QA validator (§A),
   double-extract fidelity check (§B), mandatory owner sign-off (§C).
   This is the contract every menu must satisfy before go-live.
8. `docs/specs/2026-08-12-prod-data-safety-and-njb-restore.md` — the 2026-08-09
   NJB menu-wipe incident and the non-destructive / isolation rules it spawned.
9. `docs/specs/2026-08-13-shop-conversation-test-suite.md` — the ~100-case
   per-shop acceptance suite (go-live gate + drift detection).
10. `docs/specs/2026-08-16-multi-turn-conversational-cases.md` — the suite's
    conversational mode: 15 LLM-driven multi-turn cases per shop (realistic,
    messy exchanges) judged on the whole transcript, not a single exchange.
11. `admin-dashboard/src/lib/roles.ts` — role derivation from app_metadata
   (super_admin / shop_owner), route guards, shop-scoped dashboards.
12. `admin-dashboard/src/lib/useOwnerTenant.ts` — `useEffectiveTenant()` hook
    that every owner-facing page uses to self-scope to the correct tenant
    (owner's own, super-admin's preview, or null = global). This is the shared-
    dashboard design: one page serves both roles, scoping at query time.
13. `scripts/test-suite/proof.ts` — deterministic acceptance engine. Per-shop
    battery of real order conversations graded by code invariants only (never
    an LLM judging an LLM). 100% pass or the shop does not go live.
14. `scripts/create-qa-twin.py` — clone any shop as an unprotected, phone-less,
    is_test=true twin for safe Proof testing. Uses import-menu-csv for identical
    menu. Idempotent.
15. `docs/specs/2026-08-30-proof-acceptance-engine.md` — Proof architecture and
    acceptance criteria.
16. `docs/specs/2026-08-30-orderbrain-deterministic-render.md` — OrderBrain
    Phase A: money/status lines code-rendered from Ledger, never LLM prose.
17. `supabase/functions/test-runner/index.ts` — pg_cron-driven autonomous
    acceptance suite. Server-side, no Mac/launchd dependency. Same test
    battery (Proof + CartOps) as the launchd worker, but runs in Supabase
    on a 60s cron tick with per-case checkpointing.

---

## Short branded payment links

`checkout_order` in chat-sms creates a Stripe Checkout Session, then generates
an 8-char hex short code, inserts a row into `pay_links`
(`{cart_id, short_code, stripe_url}`), and emits
`https://pay.getsprintai.com/o/<code>` as the `checkoutUrl` instead of the raw
612-char Stripe URL. The `pay-redirect` edge function (public, no-JWT) looks up
the code and 302s to Stripe. The raw Stripe URL is stored in `pay_links` as a
fallback. The `/o/*` → function rewrite is in `netlify.toml`.

**Why:** (1) Raw Stripe URL = 4-5 SMS segments; branded link = 35 chars.
(2) The 10DLC campaign samples show `pay.getsprintai.com` — production traffic
must match what carriers approved. No public URL shorteners.

---

## How data flows

```
CUSTOMER TEXTS "I want a dozen bagels"
 → iMessage bridge or Telnyx webhook receives it
 → chat-sms edge function
   → loads shop config, menu, hours, knowledge base
   → builds system prompt with effective menu + ground truth
   → calls OpenRouter (DeepSeek Flash) with tool definitions
   → LLM returns structured tool calls or plain text
   → each tool call is validated, executed, guarded
   → send reply via SMS (through outbound-guard → Telnyx or imsg)
 → conversation stored: messages + conversation row
 → when order placed: order_cart + cart_items created
 → checkout: create-checkout → Stripe Session → payment capture
 → post-order: stripe-webhook → invoice sent, eval-sweep judges it later
```

---

## The tool loop (chat-sms)

The LLM returns structured JSON. The system has these tools:

| Tool | Effect |
|------|--------|
| `show_menu` | Display menu — the LLM never hallucinates a menu item name |
| `add_to_cart` | Add items + modifiers to cart |
| `show_cart` | Read-back what's in the cart |
| `remove_from_cart` | Remove one item |
| `clear_cart` | Empty everything |
| `submit_order` | Finalize: capture customer name, delivery/pickup preference |
| `checkout_order` | Transition to payment — Stripe link (phantoms prevented) |
| `pass_to_human` | Escalate to shop owner |

Each tool call is validated server-side before execution. Menu lookups are
by ID, not name. Quantities are checked against daily limits and availability.
Pricing is server-authoritative — the LLM's calculation is verified.

---

## Bundles

The system supports a "dozen bagels" bundle: customer picks 12 bagels (with
flavor constraints), the system tracks progress, charges $19.99. The bundle
logic is embedded in the `add_to_cart` and `show_cart` tools.

---

## Deployment conventions

- **Public site**: `git push main` → Netlify auto-deploy. `build-public-site.sh`
  assembles the allowlist into `public/`.
- **Admin dashboard**: `npm run build` in `admin-dashboard/`, copy `dist/` to
  `deploy-root/admin/`, then `netlify deploy --dir deploy-root --site
  sprintai-chat-admin`. The SPA uses `<BrowserRouter basename="/admin">`
  (vite.config.ts `base: "/admin/"`); `deploy-root/_redirects` serves `/admin/*`
  → `/admin/index.html` (SPA fallback). Verified live 2026-08-19.
- **Edge functions**: `supabase functions deploy <name>`.
- **Commit format**: functional prefix (`feat:`, `fix:`, `docs:`, `chore:`).

---

## Environment variables

The authoritative list is `.env.example` in the repo root. Key groups:

- **OpenRouter**: `OPENROUTER_API_KEY` (with `ANTHROPIC_API_KEY` fallback)
- **Supabase**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
- **Stripe**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_TEST_*`
- **Telnyx (live SMS provider)**: `TELNYX_API_KEY`
- **Twilio (deprecated)**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- **Resend**: `RESEND_API_KEY` (email receipts)
- **OpenAI**: `OPENAI_API_KEY` (embeddings for knowledge base)
- **Firecrawl**: `FIRECRAWL_API_KEY` (website scraping)
- **Anthropic**: `ANTHROPIC_API_KEY` (fallback)

Secrets live in Supabase/Netlify environment settings, never in code.

---

## Segment economics are structural, not aspirational

The business model assumes 8 SMS segments/order. Above ~8.8, the $0.99 service
fee doesn't cover SMS cost. Real conversations measured 14-16 segments before the
reductions shipped 2026-08-22. Every chat-sms prompt change or reply format
decision is a segment-cost decision. Segment count is now **auto-tracked on every
QA suite run** — `persist.ts` computes `bot_segments` per case and the run summary
prints mean segments per checkout-completing order, so the `segment-count.ts`
standalone script is only needed for ad-hoc spot-checks:
```bash
deno run --allow-net --allow-env scripts/test-suite/segment-count.ts --live <shop_id>
```
See `BUILD-NOTES-payment-links-compliance-segments.md` for the full breakdown.

---

## Things that will surprise you

- **The admin dashboard is a separate Netlify site.** It's not in the public
  build. It deploys manually. The proxy in `netlify.toml` routes
  `getsprintai.com/admin` → `sprintai-chat-admin.netlify.app/admin`. The SPA
  uses `<BrowserRouter basename="/admin">` (vite.config.ts `base: "/admin/"`);
  `deploy-root/_redirects` serves `/admin/*` → `/admin/index.html` (SPA fallback).
- **Role-gating is in the JWT.** Users have `role` (super_admin / shop_owner)
  and `tenant_id` in `app_metadata`. The frontend (`roles.ts`, `RoleContext`)
  reads these and guards routes. Shop owners see only their shop, super_admins
  see everything. Legacy `is_admin` in `user_metadata` is a fallback.

- **The iMessage bridge is a bash script running on a Mac.** It polls
  Messages.app via AppleScript. It's the only non-cloud piece of infrastructure.
  If the Mac is down, SMS still routes through Twilio but the primary number
  (+14842018054) stops working.

- **verify_jwt is set per-function in `supabase/config.toml`**, not in the
  function code. If you change a function's auth model, change the config file.

- **The LLM never creates a menu item.** The menu is imported via PDF/photo
  (`parse-menu-pdf`) or CSV (`import-menu-csv`), scraped from a website
  (`onboard-tenant`), or managed conversationally (`admin-chat`). The ordering
  bot only reads it. Every menu is validated against the Menu Intake Standard
  (`docs/specs/menu-intake-standard.md`) and requires owner sign-off before
  go-live — Sprint never guesses a price.
- **Menu intake was destructive by design — now guarded.** `parse-menu-pdf`
  historically hard-deleted a shop's menus/items before inserting the new
  parse, with no transaction and no empty-result check. This wiped NJB's real
  menu in a 2026-08-09 test run. Prevention: `parse-menu-pdf` is being made
  non-destructive (transaction, verify item count > 0, soft-archive), and
  migration 051 blocks menu deletes for `protected` shops at the DB layer.
  See `docs/specs/2026-08-12-prod-data-safety-and-njb-restore.md`.

- **Test mode is real.** When `test_mode=true` on a shop, all charges route to
  Stripe test keys. The test-mode gate (`_shared/test-mode.ts`) allowlists only
  `sk_test_` / `rk_test_` prefixes — a live key will be rejected, not silently
  used.

- **eval-sweep is completely out-of-band.** It never runs inline during
  ordering. Crash it, kill it, deploy it wrong — the ordering bot is unaffected.
  They share zero code paths and zero table writes.
- **eval-sweep DMs but does not mark notified.** `eval-sweep` sends the digest
  for newly-flagged evals but deliberately does NOT set `notified_at`. The
  `issue-detector` is the single actioner: it creates the tracked issue row,
  then sets `notified_at`. If a flagged eval has `notified_at` set, it has a
  corresponding `issues` row — invariant, not convention.
- **Pickup-only is NOT a delivery pause.** A shop with `delivery_enabled=false`
  is permanently pickup-only. It is not "paused right now" and must not trigger
  the pickup-only pause message on every greeting (that bug blocked all
  pickup-only shops from taking orders). Only a future `delivery_paused_until`
  triggers the temporary pause message.
- **Cart-population: required options no longer drop items.** Multi-item
  messages where one item has a required modifier no longer silently drop the
  optioned item. Items enter the cart with `pending_options[]` — base charged
  now, surcharge on resolution, checkout rejected until all resolved.
- **Fake-checkout gate is deterministic.** After `submit_order` returns a real
  checkoutUrl, the reply is replaced with the real payment link — the model can
  never emit a hallucinated "order placed" confirmation.
- **Same-name items are disambiguated by category.** Duplicate canonical names
  (e.g. "tuna" in salads vs wraps) are qualified by category suffix in the
  system prompt so the LLM can tell them apart.
- **Menu importer now persists option data.** `import-menu-csv` (and the menu
  pipeline's `import-plan.ts`) no longer silently drop `prompt_for`, `upsell`,
  and `modifiers_json` on import — the bot previously invented phantom required
  choices because it had no real option data.
- **The QA suite runs autonomously server-side.** `test-runner` edge function
  (pg_cron, every 60s) drains `test_run_queue` and runs the full Proof/CartOps
  battery with per-case checkpointing and incremental scoring — no Mac/launchd
  dependency for the primary QA loop. Supports smoke mode (`max_cases` +
  `case_filter` for capped deterministic subset), split proof/quality scoring
  (SCORER_VERSION=3: LLM judge demoted to advisory, three-state proof with
  null=ungraded, graded-only `proof_pass_pct`, `proofUngraded > 0` hard gate),
  and `applied_invariants` reason-recording. The launchd worker (`worker.ts`)
  is the local fallback.
- **The ordering bot now answers direct customer questions regardless of context.**
  If a customer asks "do you have gluten-free bagels?" while also declining to
  order more, the bot answers the question before advancing. Questions mixed with
  declines or order-completion signals are still answered. Category-level
  declines (e.g. "do you have coffee?" when the shop doesn't carry it) get a
  clean "we don't carry that" response. Repeated questions still get a fresh
  answer — the bot never ignores a customer question to push the order forward.
- **The At a Glance dashboard ships real business data.** Owner landing page
  shows today's revenue, a Store Health ring (blend of checkout completion,
  conversation quality, store readiness), KPI row with prior-period deltas,
  revenue tiles across time ranges, top sellers vs no-sales items, and the last
  5 conversations — all tenant-scoped via `useEffectiveTenant()`.
- **Financial Reporting is live for shop owners.** The full shop-financials
  page (ledger with real Stripe fees, KPIs, revenue chart, payout
  reconciliation, QuickBooks CSV export) renders owner-scoped at
  `/financial-reporting` without code duplication — the same page component
  serves both super-admin (`/shop/:id/financials`) and owner views.
- **The word "cancel" is banned from all system prompts and bot replies.**
  CANCEL is a registered 10DLC opt-out keyword enforced by Telnyx at platform
  level — a customer typing it alone opts them out of the entire program.
  SprintAI cannot intercept it. At every abandon-or-modify point, the bot offers
  CHANGE or RESTART. The checkout restart regex no longer includes CANCEL.
- **Compliance disclosure is code-driven, not prompt-driven.** The first-contact
  footer ("Msg & data rates may apply...") now appears ONLY on the lifetime first
  contact per (consumer, shop) pair — keyed on `conversations`, not session
  expiry. On every subsequent reply it's stripped by regex (~183 chars saved per
  reply on return sessions).
- **`sms_opt_outs` table** durably records per-(phone, tenant) opt-out state.
  `upsertOptOut()` is called from all STOP/START handlers and the Telnyx
  send-rejection path. Telnyx is the authoritative enforcer; this is the
  application-level record. START clears `opted_back_at` without deleting the row.
- **EIN is a hard gate.** SprintAI does not sell to sole proprietors. A merchant
  without an EIN fails out of signup cleanly — no alternate path. Permanent
  decision by Jason.
- **Telnyx brand/campaign is live and approved** (all 7 carriers). Brand BJ8MUGY verified; campaign CSMB9HG is TCR_ACCEPTED. ISV/reseller re-registration is NOT needed (per Chris, SE, 2026-08-28 call). Throughput is per-campaign (2K seg/day T-Mobile, 240 TPM AT&T), not pooled. The send gate is mapping status (both ADDED), not campaignStatus/operationStatus. The per-merchant model: brand → campaign → number, with per-merchant CTA pages at `getsprintai.com/<slug>`. Demo numbers use SprintAI brand + disclosure; no DBA needed. Mock brands/campaigns documented for free API testing. `failureReasons` still carries an 806 CTA rejection that may be stale — the first-delivery test is the ground-truth gate. Do not modify the campaign.

- **campaign_assignment_status tracks per-number approval** (migration 081, applied 2026-09-03). Column on `shops`: `not_started | submitted | approved | rejected`. `go-live` gate (#13) refuses non-test shops unless `approved`. `is_test` shops are exempt. `campaign-status-reader` function polls Telnyx GET-only and advances `submitted→approved` when both mappings `ADDED`. `chat-sms` raises a critical issue on 10036 for non-approved shops; a distinct issue type for approved shops (approval regression). **Open gate: migration 083 (the hourly pg_cron schedule) is unapplied, blocked on Jason setting `TELNYX_API_KEY` and `DAILY_RESET_SECRET` as Supabase function secrets.** Add via Supabase Dashboard → Project Settings → Edge Functions → Secrets, then apply 083. Until then `campaign_assignment_status` never auto-advances past `submitted`; a shop must be manually set to `approved` for go-live to pass. A separate trap was found and fixed 2026-09-04: the deployed function had `verify_jwt=true`, which would have rejected 083's shared-secret cron POST at the platform edge (401, wrong error class) before it ever reached the function's own secret check — the job would have silently 401'd forever even after Jason set the secrets. Now `verify_jwt=false`; the function's own check is unchanged.
- **First delivery test is a hard go-live gate.** Before any shop goes live, the
  Telnyx provisioning + delivery test (`sprintai-telnyx-provisioning-test.md`,
  8-step real-handset script) must pass — it is the ground-truth check that the
  campaign actually delivers, since the API's 806 `failureReasons` flag may be a
  stale historical field rather than a live rejection.
- **Owner detail pages show real not-found states**
  ConversationDetail, IssueDetail, and ShopChatDetail now render a clear
  "not found — may belong to another account" message instead of a white
  shell when an RLS-blocked record is accessed. `.single()` → `.maybeSingle()`
  to prevent zero-row error objects.
- **The ordering loop only returns when tools are done.** DeepSeek Flash can
  emit `tool_use` blocks and `stop_reason=end_turn` in the same turn. The loop
  executes any pending tool calls before returning; if nothing is produced it
  degrades to a soft cart read-back.
- **10DLC carrier rejection 806 drove the disclosure copy.** The homepage CTA
  and footer carry the exact message-frequency sentence carriers require. Legal
  pages point at `getsprintai.com`; `getsprintai.net` is retired.
- **SMS now runs on Telnyx, not Twilio.** Twilio's business-profile verification
  rejected the LLC EIN four times (error 18602). The 10DLC campaign is approved
  on Telnyx (brand `BJ8MUGY`, campaign `CSMB9HG`) by all seven carriers. `chat-sms`
  parses Telnyx inbound JSON, sends outbound via the Telnyx Messages API (still
  through `guardedSend`), handles DLRs, and implements STOP/HELP/START with the
  exact registered strings. Provider is chosen by `resolveSmsProvider()` — Telnyx
  when `TELNYX_API_KEY` is set, Twilio behind it for rollback. See
  `docs/telnyx-integration-runbook.md` and `docs/10dlc-compliance-obligations.md`.
- **One offering, one price.** SprintAI sells a single $99/mo order-by-text plan
  plus the $0.99/order fee. The legacy 3-tier "SprintAI Chat" pricing
  ($99/$247/$497) and the HVAC/chat-product surfaces are purged from the public
  site and checkout.
- **The QA suite is now multi-turn with inline fix tracking.** The per-shop
  acceptance suite added 15 conversational cases: an LLM customer-simulator plays
  a persona across up to 6 turns on one `session_id`, and the Judge grades the
  whole transcript — catching drift, loops, and lost context that scripted
  single-turn cases can't. The admin dashboard drills down: run → case →
  transcript + judge findings + root cause + proposed fix, with fix_status
  (open/proposed/fixed/harness/test-data/wontfix). An LLM fix script
  (`scripts/test-suite/fix.ts`) auto-generates root-cause analysis for every
  failing case. The admin nav labels the page "Production Readiness". See
  `docs/specs/2026-08-16-multi-turn-conversational-cases.md`.
- **The order-taker got sharper.** Modifier price changes (e.g. "add cheese
  +$1") now actually add to the cart item price (was silently dropped — a money
  bug). A multi-item message with one off-menu item now adds the valid items
  instead of rejecting the whole message (partial acceptance). Ordering a plain
  bagel by exact name no longer triggers a cream-cheese upsell; combo items like
  "Bagel with Jelly" at $0.75 are recognized as complete standalone items at
  their listed price — the bot never asks for a base bagel flavor. The bot
  quotes the menu's exact item names and units; the prompt enforces item-name
  precedence: the AVAILABLE MENU is authoritative over SPECIAL INSTRUCTIONS.
  The checkout flow now explicitly states the fee-inclusive total from the
  authoritative `order_carts.total_cents` (incl. $0.99 service fee, delivery,
  tip) — disclosure is code-driven, not model-hoped.
- **Deterministic grounding guards are live.** Eleven code-path intercepts in
  `chat-sms` prevent LLM hallucination:
  - Guard 1b: off-menu portion/container words ("tub", "pint") not in the
    shop's menu vocabulary are suppressed.
  - Guard 1c: claims an item is in the cart when the authoritative cart row
    disagrees (including empty-cart assertions) are blocked.
  - Guard 1g (post-turn menu hallucination): `claimsOffMenuItem` helper
    checks if the model invented items not on the shop's actual menu;
    falls back to honest cart summary.
  - Guard 3b: "added X to your cart" claims when the cart didn't actually
    mutate this turn are caught.
  - Guard C: cart cannot be saved with `phase=checkout` unless a Stripe
    checkout session already exists — downgraded to `review`.
  - D1 (checkout-completion driver): when cart is submittable and user
    signals checkout intent, deterministically calls `submit_order` to
    create a real Stripe session — prevents "what else?" / re-ask loops.
  - D2 (kill re-ask): when `order_type` is already set, strip lingering
    pickup/delivery questions from the reply.
  - E1 (cross-turn `clear_cart` guard): suppress `clear_cart` when user
    message has additive intent (also, and a, etc.) and cart has items.
  - C2 (name→submit shortcut): when last assistant message asked for pickup
    name and the customer's next message looks like a short name and cart
    is submittable, bypass LLM entirely and call `submit_order` directly —
    prevents LLM hallucination (doubling cart via spurious `add_item`) on
    the pickup-name turn.
  - Guard 4 v2/v3 (under-populated cart backstop): when the LLM silently
    drops items from the cart on multi-item messages, the guard appends
    one warm upsell/ask line ("Want me to add the shrimp scampi too?").
    V2 fires on closing replies; V3 catches drops on non-closing replies
    where the current message contains ordering conjunctions. Hard rule:
    cart NEVER auto-adds — upsell/ask only.
  These are code-path intercepts, not prompt preferences — they fire
  regardless of what the LLM intended.
- **The phantom-add guard (1d) missed a real production SEV-1.** A live order
  said "Added the Chicken Parmesan sandwich for mom (comes with fries)!" with
  the cart never actually mutated — a real customer would have paid for and
  picked up an order missing an $11.99 item, caught only because he happened
  to ask. All three detectors missed it: the cart-phrasing pattern only
  recognized the customer as recipient ("for you/ya/u"), not a third party
  ("for mom") — natural in a family group order; and the item-phrase match
  terminated only at `[.!?\n]`, so the parenthetical `(comes with fries)`
  broke the match outright. Fixed 2026-09-04: recipient can now be anyone
  (him/her/them/mom/dad/grandma/a personal name), and `(` / end-of-string
  now terminate the item phrase too. Every broadening is paired with a
  regression pin, since this guard discards the model's reply when it fires
  and a false positive is its own kind of bug (e.g. "I'll put your order in
  for Pickup" must NOT trigger it).
- **The bot cannot invent menu options it doesn't have.** A customer was told
  wings could be "mixed and matched" among "hot, mild, BBQ, sweet & spicy" —
  none of that existed in the menu data; the bot assembled it from other
  items and general knowledge. Root cause: 431 active items across 18 shops
  require a choice (`prompt_for` set, e.g. "which wing flavor(s)") but record
  no actual list of choices, and the prompt never surfaced `prompt_for` or
  read it. Fixed 2026-09-04: OPTION GROUNDING (a prompt rule covering
  flavors, sauces, dressings, toppings, cheeses, breads, sizes) forbids
  naming any option not listed on that exact item's own menu entry, and bans
  inventing shop policy (mixing, splitting, substitutions) in either
  direction. `prompt_for` now reaches the prompt as "REQUIRES A CHOICE — the
  available choices are NOT recorded. ASK the customer" with no example
  choices given, since an example becomes the invented answer. Wing-specific
  policy (`wing_flavors_included` / `wing_mix_extra`) also now reaches the
  prompt, tri-stated: unset renders as "NOT CONFIGURED — do not assert either
  way" rather than defaulting to a guess, since every shop's columns were
  still at their unset default. Backfilling real option data for the ~16 live
  affected items needs the owners — Jason's call, not automated.
- **7-minute unacknowledged-order owner escalation is live.** A paid order
  whose kitchen ticket was delivered but never acknowledged on the Expo
  Screen escalates once by SMS to the owner's mobile (`shops.owner_mobile`).
  Protects the restaurant from a missed order sitting silently in the queue
  and protects the diner from being forgotten. Runs on a dedicated `pg_cron`
  job every 2 minutes (migration 093) — the existing 10-min `issue-detector`
  sweep is too coarse for a 7-minute SLA. Sends route through
  `outbound-guard`'s default-deny reason enum via a new `owner_escalation`
  reason. Melvin's independent QA (driven against the live function, not
  taken on the builder's word) confirmed exactly-once delivery under
  concurrent sweeps and that the recipient is structurally the owner only —
  the function never loads a diner phone column.
- **order_type is set on cart creation.** Cart insert sets `order_type`:
  'pickup' for delivery-disabled shops, null for delivery-enabled ones.
  The C2 name-turn deadlock breaker and phantom-link guard both default to
  pickup when still null — pickup-only shops can no longer deadlock on
  `submit_order`'s C1 gate.
- **CartOps integrity — `cart_json` is the single source of truth.** A bare
  tip reply never mutates items (the LLM spuriously calling `add_item` on a
  tip turn was the bug); quantity corrections ("just one") write back to
  `cart_json` and persist BEFORE any reply; every quoted total is computed from
  `cart_json` (subtotal + $0.99 fee + delivery + tip). The invariant
  `quoted_total == charged_total == sum(cart_json) + fees` holds — no path lets
  an LLM-supplied number reach Stripe. Backed by an adversarial CartOps battery
  (`scripts/test-suite/cart-ops.ts`) that runs per shop at 100%. The battery
  is shop-aware — cases are built from the shop's real menu items. Total
  integrity is deterministic via CartOps Invariant 1
  (`quoted_total_matches_cart`, compared against actual `cart_json`), never
  judge arithmetic. The separate `expectedItemCents` stated-total override is
  rescue-only: it force-passes on a match but defers to the judge on a
  mismatch, since fixture-guessed totals can't prove a bot error.
- **The closed-hours gate is deterministically tested.** `chat-sms` accepts a
  gated `test_hours=open|closed` param (never honored on live keys) that
  forces the closed branch via `effectiveOpen`; the suite's `hours-closed`
  critical case verifies the bot refuses with a "kitchen is closed" message,
  no cart, no payment link — proving per shop that the bot never takes an
  order the kitchen can't fulfill.
- **Delivery zone is fail-closed.** A delivery address is accepted only as a
  positively-qualified, in-zone street match (`status=OK`, `partial_match !==
  true`, `location_type` ∈ {ROOFTOP, RANGE_INTERPOLATED}, distance ≤
  `delivery_radius_mi`). Centroid-only (`APPROXIMATE`/`GEOMETRIC_CENTER`),
  `ZERO_RESULTS`, non-OK, and transient geocode failures (one retry) all refuse
  the address and offer pickup — never a guessed delivery. A delivery-enabled
  shop without coordinates can't go live (`delivery_geo` gate); go-live
  backfills coords from the shop's own address so the gate is enforceable.
- **Onboarding now creates a real Production Readiness run.** Saving a menu at
  onboarding enqueues a `test_run_queue` row; a launchd worker
  (`scripts/test-suite/worker.ts`) drains it and runs the full generate → run →
  judge → scorecard → persist pipeline, writing a real `test_runs` row +
  `test_case_results` the owner sees in Production Readiness. Fire-and-forget
  from setup.html — a failure never blocks menu save. `run-worker.sh` sources
  `~/.openclaw/.secrets` first (launchd doesn't inherit shell env).
- **Google Places is a real onboarding step.** `onboarding-save` fires
  `google-places-lookup` when the shop's address is known (not at create, when
  only the name existed) and `google_place_id` is still null — idempotent,
  fire-and-forget. Places enriches the shop with authoritative
  `formatted_address`, hours, rating/review_count, and `latitude`/`longitude`
  (the coords the delivery zone depends on).
- **At a Glance embeds a live test-chat sandbox.** The owner landing page shows
  glance tiles on the left ~2/3 and a `ShopChatTest` panel on the right ~1/3,
  forced into test mode (`forceTest`) — an owner fires practice orders with no
  real charge immediately. Same component, embedded; no new chat widget.
- **The Judge rubric is sharper with fewer false flags.** `wrong_total` fires
  only when the assistant explicitly states a dollar total. `invented_item` is
  narrowly scoped to items genuinely absent from the menu, its descriptions,
  AND modifiers — clarifying questions, real modifiers, and descriptive
  ingredients are never flagged. The Judge evaluates only assistant messages;
  customer prompt-injection attempts are never flagged as assistant failures.
  The menu-ground-truth format (`JudgeGroundTruth.menu`) now carries
  `description` and `modifiers` fields so the Judge can accurately distinguish
  off-menu items from real add-ons — and the `$0.99` service fee is incorporated
  into total-price comparison so legit orders don't false-flag.
- **The admin dashboard is now shared, not admin-only.** Shop owners get their
  own nav sidebar (At a Glance, Conversations, Quality, Production Readiness,
  Issues, Chat with your shop, Financial Reporting) — the same pages super-
  admins use, but tenant-scoped via `useEffectiveTenant()`. A shop owner can
  see their own conversation quality, run their own test suite, and track their
  own issues without SprintAI involvement. This is the self-serve dashboard: an
  owner doesn't need to ask a SprintAI employee what their store's readiness
  score is — they check it themselves. The Admin⇄Owner toggle lets super-admins
  preview any shop's owner perspective for demos and support.

---

## Live vs committed — 2026-09-09 snapshot

As of the 2026-09-09 journal entry (`docs/DAILY.md`), verified directly
against `supabase functions list` and the live DB via the service-role REST
key (not assumed from commit messages):

- **`chat-sms` — v341, current with `HEAD`.** Everything committed today
  (the money-bug fixes, the turn lock, the conversation timeout, the
  same-item-merge fix) is live.
- **`compile-menu` — v14, current with `HEAD`.**
- **`admin-chat` — v35, STALE.** Three fixes committed today are NOT live:
  two phantom-success fixes (`627d8a3`, `952fc67`) and a real,
  live-demonstrated cross-tenant write vulnerability in the confirm-time
  proposal flow (`3f76dd1`, see RUNBOOK). Redeploy before relying on any of
  the three.
- **`test-runner`** has not been redeployed since a `_shared/test-suite` fix
  landed (`4098a8e`) — the deployed test runner still has the false-positive
  bug in its cart-ops invariant checker; this affects test scoring, not
  customer orders.
- **Migrations 123–125, 127, 128 confirmed live** (column/table/row-level
  checks against production). **126 and 129 were not independently
  re-verified this session** — no read-only way was found to confirm a
  trigger/function body applied without a raw SQL credential; taking the
  authoring sessions' own live-verification claims at face value.
- **`buildSystemPromptV2` / instruction-layer prompt renderer (items C1/C2)
  and the `menu_overrides` actor wiring (item 9) are committed and their
  migrations are live, but functionally inert** — gated on `shops.prompt_version`,
  which is `null` for every shop (confirmed live).

### Update — 2026-09-10

- **`admin-chat` redeployed to v36** (`supabase functions list`, updated_at
  2026-09-10 11:32 UTC), closing the gap above. The two phantom-success
  fixes and the cross-tenant confirm-time write vulnerability fix
  (`3f76dd1`) are now live — no commits landed on `admin-chat` between the
  v35 snapshot and this deploy, so v36 is current with `HEAD`.
- **`test-runner`** is still v34 as of this check — the `4098a8e`
  false-positive fix has not been redeployed.

### Update — 2026-09-10, end of day (41 commits, `d811c24..HEAD`)

Verified by downloading each deployed function's source and byte-diffing
against local `HEAD`, plus direct REST queries against production — not
from commit messages. Full detail in `docs/DAILY.md`'s 2026-09-10 entry and
`RUNBOOK.md`'s same-day entries.

- **`chat-sms` v359, `stripe-webhook` v82, `admin-chat` v47,
  `google-places-lookup` v38 — all current with `HEAD`.** This includes a
  real P0 fix (paid Stripe orders silently vanishing on an order-number
  collision, `d84f2c2`) and a real P0 fix (owner console address save could
  write the wrong business's address, `c27c7c1`).
- **`test-runner` still stale** (v40, predates today) — four more
  `_shared/test-suite` fixes landed today on top of yesterday's gap.
  `compile-menu`/`eval-sweep`/`generate-test-cases` untouched today.
- **Migrations 130/131/133 are live in production** despite
  `supabase migration list` showing them as not-applied — confirmed by
  querying the actual columns/trigger effects, not the CLI tracker. They
  were applied via the Management API rather than `db push`. Migration 132
  (the stripe-webhook fix) is tracked normally.
- **`buildSystemPromptV2` is live for two of the three real shops** —
  Zio's Pizzeria and Vito's Pizza have `prompt_version=1`; Not Just Bagels
  is still `null` and runs the legacy renderer. (A same-day RUNBOOK entry
  says "all three" — that's off by one; corrected in RUNBOOK.)
- **Not closed, despite the commit messages**: today's GUARD 12/16 fixes
  (`b2e1ebf`, `c2f8e3c`) narrowed a kitchen-ticket false-flag leak but
  explicitly did not touch pricing. An uncommitted live-verification run
  *after* tonight's deploy found the underlying "modifier bleeds onto the
  wrong line" bug still causes a real money leak on Vito's Flatbreads in
  25 of 25 test runs. See RUNBOOK's "OPEN, LIVE MONEY BUG" entry — this is
  the top open item, not the address or payment P0s above.

### Update — 2026-09-11: Vito's Flatbread money leak, now CLOSED

The bug flagged as the top open item above is fixed. Root cause and fix
detail in RUNBOOK's "~~OPEN, LIVE MONEY BUG~~ — FIXED 2026-09-11" entry;
short version: `matchReactiveExtras` was matching against the raw,
unscoped whole-turn message, so a word from any phrase (including a word
inside an item's own name) could price a modifier onto the wrong line.
Fixed via `scopedModifierText` (scopes matching to the item's own claimed
phrase, strips the item's own name first) plus `suppressedReactiveMatchIds`
(per-item, not per-turn, suppression when phrase attribution is genuinely
ambiguous). Commits `bf6023b`..`f9f3b2c`.

**Verified live post-deploy:** 20/20 PASS across comma/and/conversational
phrasings — correct subtotals, no cross-item charges. One known residual:
a fully unpunctuated "bare-list" dump of four items (a synthetic worst
case, not how real customers text) can't be phrase-scoped and correctly
suppresses to an undercharge ($0.50 topping goes to `unverified_requests`
for manual kitchen-ticket resolution) rather than an overcharge —
"missing beats wrong" by design, not a new bug.

`chat-sms` is at **v368** (`supabase functions list`, updated 2026-09-11
10:24 UTC / 06:24 EDT) — current with `HEAD` (`ebc2a36`, NJB duplicate-line
fix). `test-runner` remains stale at v40 (2026-09-09); the
`_shared/test-suite` fixes since then affect test scoring only, not
customer orders. Admin bundle live at `getsprintai.com/admin/dashboard`:
`assets/index-B9clOHvN.js`, built from `70d6beae` (2026-09-10 16:29 EDT,
upsell toggle) — confirmed by curling the live page, not assumed from git.

## HALT — 2026-09-11 08:50 EDT, Jason's instruction, effective until he says otherwise

Development on chat-sms/the ordering engine is stopped: no fixes, no
refactors, no guard work, item 6, item 8, or resolver cleanup. All
testing (suites, matrices, canaries, background runs) is stopped. No
further deploys. Facts only, no plan — a plan is Jason's to write.

**In flight at halt:**
- The overnight chat-sms change-set (GUARD 12/16, legacy reactive-modifier
  scope, GUARD 7c, phrase-count safety net, bare-list ambiguity, NJB
  duplicate-line — commits `b2e1ebf`..`ebc2a36`) is finished, committed,
  and deployed as v368 above. Each fix's own dispatch reported live
  verification at the time; none of that was re-checked in aggregate
  before the halt landed.
- A `test_runs` traceability change (adds required `trigger_type` /
  `change_set_ref` / `initiated_by` so every future test run records what
  triggered it) was mid-flight in a builder subagent when the halt order
  arrived. Commit `f1d9219` is pushed to `main` — migration + `persist.ts`
  changes to `scripts/test-suite/`. **Not verified**: the builder's
  independent-QA (verifier) handoff had not confirmed PASS before the
  halt. **Not resolved**: whether `supabase/functions/_shared/test-suite/persist.ts`
  is a live second copy needing the same change, or dead — the builder
  was investigating that when stopped. **Not deployed**: `test-runner`
  is still v40; nothing from this change reached it.
- I could not confirm the builder subagent actually stopped. A gateway
  fault (`ws://127.0.0.1:18790` closing mid-connection, error 1006) blocked
  every attempt to message it a stop signal — `subagents list` still
  showed it `running` (1h22m) as of this halt. I did not restart the
  gateway to force the issue; that's a bigger, more disruptive action
  than this warranted, and Jason asked to be told about anything that
  looks on fire rather than have it fixed unilaterally. Whether it made
  any further changes after this note was written is unknown until
  someone checks `git log` on `main` and `supabase functions list` for
  `test-runner` again.

## Update — 2026-09-11 21:30 EDT: un-halted, full day's work, two P0s closed, one standing rule broken off-commit

Development resumed after the 08:50 halt above (per
`docs/specs/2026-09-11-single-writer-po-role.md`, a PO-role collision
incident mid-day — two Claude sessions both drove the crew as "the outside
PO" for ~2 hours with contradictory halt/un-halt instructions; spec only,
fix not built). Full narrative: `docs/DAILY.md` 2026-09-11.

**What is LIVE right now (new since the halt):**

| Thing | Where | State |
|---|---|---|
| `chat-sms` | Supabase | **v390**, 2026-09-12 01:25:06 UTC — confirmed current with `HEAD` by downloading and content-checking the live bundle, not just the timestamp. |
| Two P0 double-charge bugs on the compiled ordering engine | `chat-sms` | Fixed and deployed (`8580903`, `a1b8979`) — cart-line identity surviving a menu recompile, and a disambiguation-resolution code path silently falling through to the legacy add-item branch on a compiled-engine shop. |
| Vito's flatbread pepperoni/modifier price leak | `chat-sms` | Closed (`bf6023b`..`f9f3b2c`), after being left open in the previous entry. 20/20 PASS live post-deploy; one known undercharge residual on a synthetic bare-list input, by design. |
| `test_runs` provenance (migration `134`) | Supabase DB | Applied — confirmed by direct query. Enforcement (`persist.ts`) cannot take effect until `test-runner` is redeployed (still v50, now five fixes behind). |
| `deploy-function.sh` / `check-switches.sh` | `scripts/` | New, local-only tooling: type-checked/tested/version-confirmed deploys, and a live per-shop flag printout. Built after three same-day "shipped, did nothing" incidents. |

**Standing rule contradicted by production state, not yet resolved**:
`RUNBOOK.md` says Vito's `compiled_ordering_engine_enabled` must never be
`true`. Queried live tonight: it is `true`. A same-day PO spec recorded it
`FALSE` at ~15:00 ET and authorized only a menu recompile, explicitly not a
flag change. No commit changes this DB column, so there is no record here
of who flipped it or exactly when — only that it happened between ~15:00
and ~16:57 ET on 2026-09-11. Both of tonight's P0 fixes above are bugs in
that exact compiled path, on this exact shop. See RUNBOOK's "Correction:
Vito's IS on the compiled engine" entry. This is a fact to check live
before trusting either document, not something resolved by this update.

**Still true from the halt note above, unchanged:** `test-runner` remains
stale (now v50, last deployed 2026-09-09 — five fixes behind, not just the
four noted at the halt). Whether the mid-flight builder subagent made
further changes after the halt was never independently reconfirmed here.

## Update — 2026-09-12 08:20 EDT: GUARD 7 disambiguation backstop fixed for real; flag-flip tooling shipped

- **GUARD 7 disambiguation** (`ac79c06`, `dbb6290`) — the customer-facing fix
  (re-ask uses `display_name`, not the raw ambiguous menu name) and a 2-turn
  backstop were both built the same night as the entry above, but the
  backstop didn't actually work: a customer who guesses wrong every turn
  re-trips GUARD 7 itself, which reset the counter meant to stop it. Fixed
  this morning — see RUNBOOK's GUARD 7 entry for the mechanism. 18 unit
  tests added; not yet re-verified live post-deploy.
- **`set-compiled-engine.sh`** (`3203ca9`) — closes the exact gap the entry
  above called out: `compiled_ordering_engine_enabled` can now only be
  changed through a script that verifies the write and prints a commit
  command, instead of a raw REST `PATCH` with no git record. Doesn't retroactively
  explain who flipped Vito's on 2026-09-11 — only prevents the next
  unrecorded flip.
- Neither of tonight's two changes has been deployed yet as of this entry —
  confirm `chat-sms` version with `check-switches.sh` / `deploy-function.sh`
  before assuming the backstop fix is live.

## Update — 2026-09-12 22:18 EDT: defect class C4 — mitigations shipped and deployed, but the real fix is not

Full detail in `docs/DAILY.md`'s 2026-09-12 entry; RUNBOOK has the
turn-reconciler and `DEPLOY_SHA` mechanism entries. Summary of what's
actually live vs. committed, confirmed by downloading and grepping the
deployed artifact (not inferred from git history):

- **`chat-sms` v412 is live and its `DEPLOY_SHA` stamp reads `59833e02`** —
  that is the second of two same-day reverts of attempted C4 fixes. Today's
  other fixes ARE in this deploy (GUARD 1d/1f P0 fix, GUARD 21, the
  show-my-order fix, the C1 option-group-rename sweep, TODAY'S HOURS,
  returning-customer delivery offer's submission-time write). **Defect class
  C4 itself (cart-growth aggregation from multiple valid same-turn add
  proposals) has no live mitigation right now** — two per-call-site patch
  attempts (`2d6d55a1`, `f471525a`) were each committed and reverted the
  same day, and `main` currently sits at the second revert.
- **The real fix — `turn-reconciler.ts`, replacing GUARD 9/13/20/21 —
  exists only on unmerged branch `fix/turn-reconciler-20260912`
  (`b7bd0404`).** Its own commit message says not to merge or deploy until
  an acceptance matrix runs clean against staging; that script exists
  (`scripts/tmp-turn-reconciler-acceptance-matrix-20260912.ts`) but is
  untracked and there's no evidence it has been run. The branch's test
  suite also has 4 known failures (stale `guard9`/`guard13` tests that grep
  `index.ts` for call sites this commit deleted) that were not cleaned up
  in the same commit.
- **The returning-customer delivery-memory feature (`8cb73036` and
  follow-ups) is half-deployed.** Its submission-time write path is live in
  `chat-sms` v412. Its payment-time write path and a race-condition fix live
  in `stripe-webhook`, which is still v92 from 2026-09-10 — none of today's
  `stripe-webhook` changes are deployed. `chat-sms-mtest` (v39, 2026-09-08)
  and `parse-menu-pdf` (v114, 2026-09-05) are similarly stale against
  today's commits to those functions.
- Migrations 135 (`customer_delivery_memory`) and 136
  (`order_carts_delivery_offer_made`) are both confirmed **applied** to
  production by direct query — not blocked on anything above.
- **Before doing anything with C4 or the turn reconciler**: check out
  `fix/turn-reconciler-20260912`, run the acceptance matrix script, fix the
  4 stale test failures, then follow the normal `deploy-function.sh` path
  and confirm the `DEPLOY_SHA` moves to `b7bd0404` (or whatever it's
  rebased to) before telling anyone C4 is closed.

## Update — 2026-09-13 01:37 EDT: turn reconciler closed and deployed — C4 has a live fix now

Follow-up to the entry above, which left C4 (cart-growth aggregation)
unmitigated in production. Since then, `main` picked up the turn-reconciler
work (`2ac3ea1a`..`ffcc26479`): two acceptance-matrix cases got real fixes
(C2b-name plain-add confirm, checkout-phase deterministic add-item), the
full 9-case matrix + a 10-case Proof-suite subset ran clean against a local
in-process server, and 4 stale tests asserting the retired guards' call
sites were removed. Detail in RUNBOOK's "Turn reconciler" entry.

**Confirmed live, not just committed**: downloaded the deployed `chat-sms`
artifact directly — v413, deployed 2026-09-13 05:37:28 UTC, `DEPLOY_SHA`
stamp reads `ffcc26479d6c86d7e324fac50cfa816ef206c86c`, current `main` HEAD.
Defect class C4 is closed in production.

**Unchanged, still stale** (checked same pass): `stripe-webhook` v92
(2026-09-10), `parse-menu-pdf` v114 (2026-09-05), `chat-sms-mtest` v39
(2026-09-08) — none of this window's commits touch those three functions'
live state. Migrations 135/136 remain the most recent applied; no new
migration since.

---

## Update — 2026-09-13 20:02 EDT: x16 pizza bug root-caused, checkout insulation + reply inversion shipped and live

Follow-up to the entry above. `main` moved a lot further today
(`2ac3ea1a`..`ed312900`); the two threads worth knowing about for anyone
picking this up:

- **A live $341.98 money bug (Large Cheese Pizza x16) was root-caused and
  fixed.** `reconcileAddProposals` was reading a bare number out of
  `source_phrase` — a model-supplied field, not verbatim customer text —
  to detect an explicit quantity. Vito's pizza item is named
  `Cheese - Large (16")`; the "16" in the item's own name was being read
  as a customer-stated quantity. Fixed (`820a9b37`): `source_phrase` is
  only trusted for quantity when it verifiably appears in the customer's
  own message. Three earlier same-day attempts fixed *other*, related bugs
  (a 15x relative-delta merge bug, an item-adjacent scoping fix) but not
  this one; the survivor was proven by a 5-run repro matrix, not a single
  smoke run. See RUNBOOK's "`source_phrase` may never be trusted for
  quantity" entry. Not yet given a defect-class letter in
  `docs/DEFECT-CLASSES.md`.
- **Checkout insulation shipped**: the name-ask ("Putting this in for X?")
  is no longer usable as an implicit checkout trigger — it's now gated
  behind explicit, persisted customer checkout intent
  (`checkout-intent-gate-20260913.ts`, migration 139). Four live defects
  from the first merge (content loss, a false hallucination flag, ignored
  explicit intent) were all fixed same-day.
- **Reply inversion shipped, partially**: cart-mutation replies
  (`action-confirmation.ts`) and 8 more fact-list sites now render their
  factual claims from the actual write action, not model prose — closing
  the class of bug where the bot narrates an item count that doesn't match
  the cart. The spec's own acceptance bar (guard count <32, `reply=` sites
  <48, GUARDs 1c/1d/1f/1g deleted) was **not** met, by the implementing
  commit's own admission — those guards are still required on the
  untouched no-mutation reply path. Don't remove GUARDs 1c/1d/1f/1g
  expecting reply-inversion to have made them redundant; it hasn't, yet.
- Migration 137 (`error_log`) ships a working error-persistence path around
  Supabase's 1-minute log retention, wired into `chat-sms` only so far.

**Confirmed live, not just committed**: `chat-sms` v432, deployed
2026-09-13 20:02:19 UTC — 14 seconds after `main`'s final merge commit
(`ed312900`) — and the deployed bundle contains the reply-inversion,
checkout-insulation, and `source_phrase` symbols directly. **Caveat**: this
deploy carries no `DEPLOY_SHA` stamp (it did not go through
`scripts/deploy-function.sh`), so "live" here rests on a version/timestamp
match, not the SHA-proof mechanism documented elsewhere in this file —
redeploy through the script before treating it as ironclad.

**Unchanged, still stale**: `chat-sms-mtest` v39 (2026-09-08) — today's
GUARD 1d, reply-inversion, and checkout-insulation source changes are all
committed to this function's files (kept byte-identical to `chat-sms`
where shared) but none are deployed to it. `stripe-webhook` (v92) and
`parse-menu-pdf` (v114) are untouched by today's commits and remain at the
versions noted in earlier entries.

## Update — 2026-09-14 22:23 EDT: lettered-defect burn-down (B, C, C2, D, G, H) shipped and live; GUARDs 1c/1d/1f/1g now actually retired; Turn Engine Phase 1 drafted but uncommitted

Correction to the note directly above: as of 2026-09-13, GUARDs 1c/1d/1f/1g
were still required because the reply-inversion prompt rule alone didn't
reliably stop the model from narrating cart claims. Today's `c996df0b`
(07:55) adds an explicit ITEM/CART-CLAIM SCOPE rule to both system-prompt
blocks — the model may never enumerate cart contents or narrate a
mutation in prose at all — and `f19cf0ab` (07:55) then deletes GUARDs
1c/1d/1f/1g on the reasoning that they have nothing left to catch
(~1,131 lines removed, including `phantom-add-guard.ts` and
`guard1f-correction-claim-20260909.ts` in full). **This is a bet on the
prompt rule holding, not a proof** — `e1821f88` (08:00) adds a static
source scan of every `reply=` site as a partial backstop against a *new*
hand-authored cart claim, but nothing catches the model simply ignoring
the new prompt rule the way it used to ignore the old one. Watch
`error_log` and live canaries for a phantom-add/correction-claim reply
reappearing with no guard left to catch it.

Six more live defects fixed today, each cited against its own repro in
the commit message (not just a unit test) — full detail in
`docs/DAILY.md`'s 2026-09-14 entry:

- **Item B** (`b1d709f2`) — "drop the pepperoni" was unsatisfiable
  (required matching every word of the option's display name) and its
  correction was invisible to the reconciler's apply-gate (identity keyed
  on item+quantity only, not options).
- **Item C** (`0c4c5837`, `72cd4676`) — the upsell offer is now
  code-rendered (`upsell-offer-20260914.ts`), not left to model prose that
  `extractQuestionsOnly` strips on sight; a second pass fixed the case
  where the offer was structurally missing for any item whose required
  option resolves on a later turn than the add.
- **Item C2** (`577ded72`, `7342fc3a`) — a driver-tip prompt rule racing
  the same-turn upsell-offer render, and a bare decline landing on a turn
  with no open question on record (~22% of delivery-flow runs before the
  fix).
- **Item D** (`1accaa05`) — the last two bare-cart-count fallbacks now
  render the itemized recap instead.
- **Item G** (`49dfb1db`, `d36d298f`) and an earlier, unlettered sibling
  (`c23f0a4d`, 13:21) — a cart-wipe: a required-slot answer on a later
  turn ("medium") could fail to ground against its own line and get
  deleted outright as "unauthorized," not overcharged, the whole order
  gone. Fixed by widening what counts as a pre-existing line across three
  passes; the PO's rule going forward is that `dropped_unauthorized` may
  only ever apply to a line with zero prior existence in any form.
- **Item H** (`0a66af6f`) — a `source_phrase` stitched from customer words
  across *different* turns (model defers the real `add_item` call by more
  than one turn) couldn't ground against any single-turn check; and the
  reply-inversion enforcement above only ran on turns that actually
  mutated the cart, leaving the unmutated path free to narrate a phantom
  add in prose. Both fixed.

**Confirmed live, not just committed**: `chat-sms` **v444**, updated
2026-09-15 01:27:05 UTC — the downloaded deployed artifact's entrypoint
carries `// DEPLOY_SHA: 0a66af6f...`, the item H commit, matching the last
code change of the day (everything after it, `624f9660`..`HEAD`, is
docs-only). Unlike 2026-09-13's v432, this deploy has a proper
`DEPLOY_SHA` stamp — it went through `scripts/deploy-function.sh`.
`chat-sms-mtest` remains stale at v39 (2026-09-08), now six days further
behind.

**Not committed, not deployed, not wired in**: the working tree (not
`HEAD`) has an untracked `turn-engine.ts` (665 lines) and
`dialogue-signals.ts` implementing "Turn Engine Phase 1" — a code-owned
ANSWER/DECIDE/ASK/RENDER dialogue-state module proposed in today's
`docs/specs/2026-09-14-turn-engine-oversight.md` as the actual fix for the
structural cause behind the whole lettered-defect list (dialogue state
reverse-engineered from model prose by 26 separate guards). Its own header
says it is deliberately "New Files Only" this phase — not wired into
`index.ts` pending explicit go-ahead. The only live edit in the working
tree is `dialogue-signals.ts` itself being extracted out of `index.ts`
(three predicates moved, no behavior change, `deno check` clean) — whoever
picks this up next should commit that extraction and the new module
together, or decide not to and revert the uncommitted `index.ts`/
`ask-plan-engine.ts` edits.

Also today: three docs-only commits (`624f9660`, `f63c31ea`, `851f196a`)
establish a new operating structure — an autonomous coding agent ("the
crew," on a separate machine) dispatched and verified by a human-in-the-
loop PO role — and two (`82e5616e`, `6728198e`) correct stale facts in
`docs/PO-BRIEF.md`: the deployed model is `deepseek/deepseek-v4-flash`,
not `-v4-pro`; the OpenRouter account backing both prod and the test
harness auto-tops-up (not a balance risk to throttle for).

## Update — 2026-09-15: Turn Engine Phase 1 is now committed, Phase 2 (`propose.ts`) shipped and bounced/fixed twice, item-E instrumentation deployed live

Correction to the entry directly above: "Not committed, not deployed, not
wired in" described `turn-engine.ts`/`dialogue-signals.ts` as an
**uncommitted** working-tree addition. That's stale — `cf6858f0` committed
Turn Engine Phase 1 ten minutes after that entry's own sync point
(`a983c250`, 22:34 EDT). Since then, six more commits landed on `main`
(full detail, real numbers, and caveats in RUNBOOK.md's "Turn Engine
Phase 1 committed, Phase 2 ships..." entry and `docs/DAILY.md`'s
2026-09-15 entry — this section is the summary):

- **Phase 1** (`cf6858f0`) — code-owned ANSWER/DECIDE/ASK/RENDER dialogue
  state, committed. Still **zero imports in `index.ts`**.
- **Phase 2** (`42850782`) — `propose.ts`, the PROPOSE-step model adapter,
  shipped. Also a pure module, also zero imports in `index.ts`.
- **Phase 2 PO bounce + fix** (`22bb5733`) — the first version derived its
  item-name lexicon at runtime and produced wrong-item resolutions in live
  testing (a plain "cheeseburger" resolving to the $10.99 Bacon
  Cheeseburger instead of the $8.49 Cheese Burger, 8/17 calls). Fixed by
  injecting the already-compiled, human-reviewed `lexicon` DB table
  instead of deriving one at runtime. Live re-acceptance after the fix:
  9/20 correct — the wrong-item defect is closed, but there is a real
  lexicon **data** gap (missing one-word terms) still open. Don't report
  this as fully solved.
- **Cart-widening fix** (`0ee960b9`) and **stable `line_key` fix**
  (`f686df46`) — two further propose.ts/turn-engine.ts fixes, both pure
  modules, both closing real defects found in live testing (in-cart
  modifies had no valid group/choice ids to use; multi-option-group items
  could get incorrectly declined on modify because their `line_key` went
  stale mid-turn).
- **Item-E instrumentation** (`3a5723a9`) — the one change in this batch
  that touches `index.ts` (18 lines, logging a model-API-fallback exit to
  `error_log`'s `tool_loop` stage). **This one is live**: verified
  directly against the Supabase project (`rvdqfxtrskxekfkqnegx`) —
  `chat-sms` is now **v445**, updated 2026-09-15 04:19:13 UTC, downloaded
  artifact stamped `// DEPLOY_SHA: 3a5723a979e7fd956ebeaa18d43434035528f62c`
  (the item-E commit). Everything else in this batch postdates that
  deploy and is not live.

**What Phase 3 still requires**: per `docs/PO-BRIEF.md`'s note on this
exact situation (the "resolver.ts trap," current instance), Phase 3 needs
an explicit PO go-ahead, a routing branch in `index.ts`, and a per-shop
`turn_engine_enabled` flag before either `turn-engine.ts` or `propose.ts`
affects a single live conversation. Until that branch exists, "committed
and tested" does not mean "in the live path" — check the import and the
flag, per module, every time, same as `resolver.ts` before it.

**Update, later the same day (2026-09-15) — Phase 3 landed and all three
shops are on it.** The above is now history, not current state; kept for
how the trap was reasoned about. What actually happened, in order:

- Item identity moved out of the model first (`5eb66a4d`): a new pure
  module, `resolve-item.ts`, does deterministic longest-match resolution
  of the customer's verbatim text against the compiled lexicon, because
  letting the model choose `menu_item_id` directly was still billing the
  wrong item on 10 of 20 live Vito's calls even with a correct lexicon.
- The routing branch landed (`13e9733d`, 06:09 EDT): one
  `if (shop.turn_engine_enabled)` in `index.ts`, verified directly against
  the diff, calling the new `turn-engine-runner.ts` pipeline and returning
  early — bypassing `runOrderingLoop`, the reconciler, and all ~26 legacy
  guards, not modifying them. Compliance disclosure (`d7f6c2fd`) and
  Stripe checkout (`462f3c96`, one call site, the legacy path refactored
  to share it rather than duplicating it) were wired into that branch the
  same day.
- Eleven more defects were found and closed the same day by live testing
  across all three shops — collision-blocked lexicon terms, a slot-key
  collision that made two different questions on the same NJB item read
  identically, a PostgREST 1000-row silent cap on the lexicon fetch, an
  unanchored ordinal match, a slot-answer bug that both repeated a
  question and silently added a phantom line, and a money bug where a
  bare `"2"` on Zio's wings silently added an $8.00 upcharge. Full detail,
  commit-by-commit, in `docs/DAILY.md`'s 2026-09-15 entry.

**Confirmed live tonight, not inferred**: `chat-sms` is **v453**,
downloaded artifact stamped `// DEPLOY_SHA: 0d259996da0d11ae1b8298002ffa0ffb79ca63c5`
— the exact current `HEAD`. `compile-menu` is **v42**, stamped
`4fe704356e088e35ef7eeb01a1ac7affa9ab1c10` — the exact last commit that
touches that function. `shops.turn_engine_enabled` is `true` on all three
real shops (Vito's, Zio's, Not Just Bagels — queried live via PostgREST),
Not Just Bagels for the first time only after the wings-bug fix shipped.

**What is still open, per the crew's own 19:30 handoff
(`docs/PO-HANDOFF-2026-09-15-1930.md`), not re-verified by me tonight**:
an unexplained retry bug on the name and order-type questions (works on
the second attempt, not the first, on all three shops — four hypotheses
already ruled out); `service_fee_cents` reads 0 on a pre-checkout engine
row; one-shot attribute+item adds ("medium cheeseburger") have never
worked on the engine path; `compile-menu` is not idempotent across
consecutive recompiles of unchanged data; and the intended automated
multi-turn test gate, `convogate.py`, is unusable — a review found its
own docstring promises a dropped-item check that was never implemented.
Every defect closed today was found by a human hand-designing a scenario
and running it three times; that does not scale, and closing that gap is
the stated next milestone, not a new feature.

**Update, 2026-09-16 — an exhaustive state-space sweep replaces hand-designed
scenarios for the `ask()` function, closes two invariant violations, plus two
more real turn-engine defects fixed on top.** Eight commits, 07:20–13:38 EDT,
all in `turn-engine.ts`/`turn-engine-runner.ts`. In order: ASK now sees this
turn's own ANSWER-resolved slots (was re-asking order type/tip/name it had
just been told); the address slot got a real deterministic (non-LLM)
geocoder wired into ANSWER, closing a defect where delivery could never
complete on the engine at all; ASK stops asking "Anything else?" over an
empty cart via a new `ordering` open-question kind; a new test enumerates
`ask()`'s actual input space (188,160 states, one `Deno.test`, diagnostic
only — it doesn't gate, it surfaces) and found two invariant violations,
both closed same day (a shop with delivery off could still be asked for an
address; declining final confirmation over an empty cart bypassed the
empty-cart guard via a second, undiscovered path); and the address geocoder
was widened to extract an address span from anywhere in a message, not just
when the whole message is the address, closing a case where a customer who
stated the address correctly kept being re-asked forever.

**Confirmed live, not inferred**: `chat-sms` is **v457**, downloaded
artifact stamped `// DEPLOY_SHA: fa42a01f89c9d12cd8f70619953e4c3a0fe049ec` —
exact current `HEAD`, deployed 13 minutes after the commit landed.
`shops.turn_engine_enabled` is still `true` on all three real shops,
re-queried live just now. Vito's canary re-run clean:
`cheeseburger`/`medium`/`thats it` → one line, Temp: Medium,
$8.49 + $0.99 = **$9.48**. Full `chat-sms`+`_shared` Deno suite: 1439
passed, 0 failed, 7 ignored (up from 1414 on 2026-09-15). No migrations
touched today.

**Still open, not touched today**: the name/order-type retry mystery from
yesterday's handoff (`"pickup"` alone doesn't advance but "pick up" does; a
bare first name doesn't advance but "First Last" does — on all three
shops, four hypotheses already ruled out) is unchanged; see `QUEUE.md`
(untracked PO working file) for the live investigation state.

## Update — 2026-09-17: slash-shorthand cart-emptying bug fixed and merged, but NOT yet deployed

**The bug**: a customer texting shorthand like `cheeseburger / medium / thats it` had
the order silently dropped 70-90% of the time (live A/B, n=8 each, deepseek-v4-pro) —
the model reads a whitespace-padded `/` as "or" rather than "and" often enough to empty
the whole cart with no error shown. The equivalent comma phrasing failed ~25% of the
time on the same model. A prompt-only fix did not move the rate; three commits
(`fcbe726e`, `11018994`, `3f57618b`, merged as `79da3d38`, 2026-09-16 23:00 –
2026-09-17 01:23 EDT) normalize the text itself upstream of the model call and both
engines, with a guard so it never rewrites a slash that's part of a real live menu
item's own name (Vito's has two items literally named `Cheesesteak / Chicken
Cheesesteak`), and a perf follow-up so the guard's DB lookup only runs when the message
actually contains a slash. Full technical detail in `RUNBOOK.md`.

**Confirmed live, not inferred — and this is the important part**: the downloaded
`chat-sms` artifact (project ref `rvdqfxtrskxekfkqnegx`) still carries
`// DEPLOY_SHA: fa42a01f89c9d12cd8f70619953e4c3a0fe049ec`, three commits and a merge
behind local `HEAD` (`79da3d38`). **This fix is committed but not deployed.** Live
traffic on all three real shops is still exposed to the empty-cart failure rate
measured above for any customer who types slash-shorthand, until the next deploy.

Independently re-verified for this doc sync: full `chat-sms` + `_shared` Deno suite run
locally at `HEAD` — 1446 passed, 0 failed, 7 ignored, matching the merge commit's own
claim. No migrations touched in this range.

## Update — 2026-09-17 (evening): confirm-gate + closure fixes are LIVE (payment links 0/500 → 55/100); modifier-set work committed but not deployed, and prod's `import-menu-csv` doesn't match this repo's history

**Yesterday's slash-shorthand fix is now deployed.** Confirmed by downloading the live
`chat-sms` bundle: `index.ts` carries `// DEPLOY_SHA: 9e8b7594019af9489a0e2729adf1f8e222e963d1`
— tonight's last commit. Everything in today's `chat-sms` work (12 commits, 06:15–21:32
EDT) is live, not just committed. Full detail in `docs/DAILY.md` under `## 2026-09-17`.

**Headline result**: per today's `docs/PO-BRIEF.md`, independently corroborated against
the code, a simulated order batch went from 0/500 to 55/100 reaching a real payment link.
The single biggest driver was a bug where the confirm check only matched a message that
was *exactly* "yes" — "Yes, confirm the order!" matched neither yes nor no and the bot
just sat there (`f2763eee`). A second driver: the "Anything else?" question had its own,
separately-broken copy of the closure-detection check that an earlier widening never
touched (`10e2af28`).

**New**: a second, dedicated AI call (`answer-interpreter.ts`) now helps resolve
disambiguation questions ("which one did you mean") when plain-text matching fails. It is
handed a closed list of options and cannot return anything outside that list; on failure
or timeout it falls back to asking again rather than guessing. It does not yet cover
ordinary slot questions ("what size?").

**NOT live**: `e4230d58` (modifier_sets P1a — shared option-list detection for CSV menu
imports) is committed but not deployed, and the gap is unusual — the deployed
`import-menu-csv` function's file layout (`ordering.ts`, `import-plan.ts`, `csv.ts`,
`validate.ts`, `types.ts`, no `index.ts`) doesn't match this repo's git history for that
function at all, and hasn't updated since 2026-09-08. Whoever has deploy access should
check directly what's actually running there. The new migration
(`143_modifier_sets_p1_schema.sql`) is also not applied to the production database —
confirmed by querying the live REST API directly (not just the CLI's migration tracker,
which is known to drift): `modifier_sets` and `option_groups.set_id` don't exist there.
Joins an existing backlog of roughly 15 unapplied migrations going back to at least
migration 124, not a new problem introduced today.

**Not checked today**: per-shop `shops.turn_engine_enabled` — which real shops are
actually exercising the fixes above. Needs DB access this environment didn't have.

## Update — 2026-09-18: the new engine is confirmed on for all three real shops; a security leak in the admin dashboard closed; read-back-before-checkout live

**`shops.turn_engine_enabled` is `true` for all three real shops** (Zio's Pizzeria, Not
Just Bagels, Vito's Pizza) — checked directly against the database, closing the "not
checked" item from 2026-09-17. Vito's is flagged `is_test: true` (the team's own sandbox,
Stripe test mode); Zio's and Not Just Bagels are not. Every ordering-bot fix below applies
to real customer traffic on the two real shops, not just the sandbox.

**LIVE right now (new since 2026-09-17 evening)**, confirmed by downloading the running
code directly (not by reading commit messages):
- `chat-sms` — `DEPLOY_SHA: 6ffb4e2dbff79258b51e8b0f9c79be44c3bf463a` (today's 21:33 commit).
  This one deploy carries everything committed before it today: read-back-before-checkout
  (full cart shown before "confirm?"), the address-question-loop fix (pickup switch, cancel,
  2-strike give-up), an add-on-named-with-its-item no longer double-charging, a quantity
  correction while confirm is open now applying on the first try, natural-language answers
  to "which one did you mean?", and several item-matching fixes (plural names, choice-tie
  narrowing, second request in the same text message no longer dropped). Full list in
  `docs/DAILY.md` under `## 2026-09-18`.
- `compile-menu` — `DEPLOY_SHA: 6898989f8cebf98d6390f8ee50c88d6a6c5269e9` (19:28). Carries
  today's menu-compiler fixes: shared bare item names (e.g. "cheesesteak") ask instead of
  silently guessing the wrong dish; every sized family (calzone, alfredo, etc.) matches on
  its plain name whether or not it has an unsized sibling.
- Admin dashboard's PIN/POS-secret leak (below) — confirmed live by fetching
  `getsprintai.com/admin` directly.

**Security fix, live**: the shop-settings page was loading a restaurant's real Toast POS
client secret and real staff PIN into the browser on every page load (any shop owner or
super-admin with devtools open could read them). Now only a yes/no "is one configured" flag
is sent (migrations 144, 145); the page writes new values through a blank field instead of
ever reading the old one back.

**Also fixed today**: a logging bug where every successful item-resolution log write had
been silently rejected since the feature shipped a few hours earlier (a database rule
didn't recognize the new log category) — fixed via migration 146. The deploy script now
refuses to ship uncommitted files or deploy mid-simulation-run.

**A live bug happened and was fixed the same day**: an item-matching change briefly broke
12 of Vito's 29 sized item families (calzone, alfredo, and others) — asking for a calzone
by name got "Sorry, I didn't catch that" for about 50 minutes in sandbox testing — fixed
before the evening's `compile-menu` deploy, so it was never in what's live now.

**Simulation result** (Vito's sandbox, Stripe test mode, same 50 simulated customers,
re-run through the day as fixes landed): orders reaching a real payment link went from
39/49 this morning to 46/50 tonight; items a customer asked for that never showed up in
the cart went from 11 to 2. Order totals were correct in all 19 runs measured today,
including before any of today's fixes.

**Not checked today**: Zio's and Not Just Bagels haven't been run through the same
simulation Vito's was — today's fixes are written as general rules, not Vito's-specific,
but that's untested on the other two shops. The ~15-migration backlog and the
`import-menu-csv` deployed-code mismatch (both flagged 2026-09-17) were not re-examined.

## Update — 2026-09-19: a full day of live-money-bug fixes shipped and confirmed live; the aggregate pass rate did not move

**LIVE right now**, confirmed by downloading the running code directly:
- `chat-sms` — `DEPLOY_SHA: 3fee38f04f161a95aa376f4260130ae3a4e14469` (today's last commit,
  22:26). Carries every one of today's ~60 commits.
- `compile-menu` — `DEPLOY_SHA: fc6a8ae6d65691f9df483f091ece74a478a549bf` (18:18). Nothing
  touched the compiler again today after that commit, so this is current too.

**Four real overcharges, reproduced against live Vito's data and fixed today** (full detail
in `docs/DAILY.md` under `## 2026-09-19`): a $83.83 charge for a $50.39 order (three stacked
gaps in one conversation, `cb37bda9`); a $91.30 cart still containing an item the customer
had explicitly asked to remove (`b4c1d848`); a second, deeper layer of an overcharge the
team believed was already fixed earlier the same day — $23.94 charged where $11.98 was owed
(`3b133f24`); and a roughly $107-vs-$85 overcharge from a decline that wasn't recognized as
one (`2412c833`). None of these are money-amount-per-item bugs — every individual price was
correct in all four; the defect was always extra or un-removed lines.

**Also fixed and live**: a phantom $20 gluten-free pizza added from a customer's own
question (`f20b9a5a`); a phantom $19.99 tip read out of an unrelated delivery-fee question
(`073210cc`); a "welcome back" greeting that was fully built and tested but silently
unreachable from the code path every shop on the newer engine actually runs, now reconnected
(`0f9aa913`); a customer stuck answering "Pickup or delivery?" 15 times with no way out, now
capped and rephrased on the third repeat (`4c2e46d2`); and a rewrite of how the bot handles
an item matching too many menu candidates — it now asks "what kind, what size" instead of
trying to text back a full list, which had gotten long enough (3,378 characters, real case)
for the carrier to silently drop the reply (`51773f5e`, `60d84445`).

**Went in circles, net no lasting change**: a pepperoni-topping mis-billing fix was written,
shipped, and reverted three separate times today before a working version landed from
different code later in the day. See `docs/DAILY.md` for which commits cancel out — don't
re-read the reverted ones as still-live behavior.

**The number that matters most did not move.** The team's own 50-simulated-customer run —
39/49 paid two nights ago, 46/50 last night — was still landing 44–47 of 50 as of the last
checkpoint tonight (21:00), after most of today's fixes had already shipped. By the team's
own account, a fix that saves one customer's order tends to let a different customer's
order fail instead. The last four commits of the night landed after that checkpoint and
have no simulation run against them yet in anything I could find.

**Not checked today**: same gap as yesterday — no evidence any of today's fixes were
re-verified against Zio's or Not Just Bagels, only Vito's. The `import-menu-csv` mismatch
and migration backlog were not re-examined.

## Update — 2026-09-20: a second batch of chat-sms fixes merged to main overnight, but production stopped running any code from that lineage by evening

Roughly 50 more real, live-reproduced conversation bugs closed and merged to `main` by 07:16
today (five of them real money bugs — a customer's empty-cart cheeseburger reply, a $22.99
wrong-item charge, a $46.97 shortfall from a wrongly-declined salad dressing, a $45.90
double-charge from an unresolved "X not Y" swap, and a whole-cart wipe from a topping-swap
edge case that was fixed, reverted, then re-fixed correctly the same day — see `docs/DAILY.md`
2026-09-20 for the diffs). `deno check` is clean and the full suite passes (1,804 tests, 0
failures) on the resulting `main` HEAD. **None of it is confirmed live.** I have no
`convo.sh` transcript against a deployed build for any of these fixes.

More importantly: **production is not running this lineage at all as of tonight.** The
deployed `chat-sms` bundle's build marker is commit `e608ec1f`, stamped 20:35 — the tip of a
separate branch, `engine/clean-sheet`, 47 commits, started at 11:30 today, that replaces the
whole ordering engine with a new implementation (a new `engine/` directory: interpreter,
runner, resolver, pricer) behind a new, not-yet-on-main flag, `clean_engine_enabled`. That
branch was cut from a point after this morning's ~50 fixes, so the fixed code exists inside
the deployed bundle — but `index.ts` checks `clean_engine_enabled` first, before the
`turn_engine_enabled` path this morning's fixes live on, and skips straight past it for any
shop where the new flag is on. I could not read the actual per-shop flag values from this
machine (no database access here). So: **the honest state of "what's live" is that I don't
know whether this morning's fixes affect any real shop's conversations right now** — not that
they're confirmed off, just unconfirmed. Whoever picks this up next should check
`clean_engine_enabled` and `turn_engine_enabled` per shop before assuming either lineage is
what a customer is actually talking to.

## Quickstart for development

```bash
# Clone
git clone git@github.com:jason-fanway-com/sprintai.git sprintai-ordering
cd sprintai-ordering

# Install root deps (for Netlify functions)
npm install

# Admin dashboard
cd admin-dashboard && npm install && npm run dev

# Shop chat PWA
cd shop-chat && npm install && npm run dev

# Edge functions — needs Supabase CLI + local project linked
supabase link --project-ref sprintai-chat
supabase functions serve  # local dev server

# Run a single function locally
supabase functions serve chat-sms
```

---

## Who to ask

- **Jason** — business decisions, Stripe dashboard access, Twilio console,
  A2P campaign management, secrets, customer relationships.
- **RUNBOOK.md** — how to deploy, troubleshoot, recover.
- **This file** — system mental model and conventions.
