# SprintAI — Daily engineering journal

One dated section per day, appended by `ai.openclaw.sprintai.dailydocs` (22:30 daily,
registered in `~/.openclaw-sprintai/SCHEDULED-REGISTER.md`).

Rules the job follows, and that anyone writing here by hand should follow too:

- **Reality first.** Written from the actual `git log` and the actual code. Where a spec and
  the code disagree, the code wins and that is said out loud.
- **Intent is not outcome.** "Committed but not deployed" and "unverified" are stated
  plainly. Shipped means in the code and reachable.
- **Append, never rewrite.** Earlier days are a record, not a draft.

Started 2026-09-05. Work before that date lives in RUNBOOK.md, HANDOFF.md and
docs/BUSINESS.md; this file is the going-forward journal.

## 2026-09-05

Fifty commits today (04:03–21:02). Grouped by thread; each note reflects what the diff
actually does, not the commit message, and says plainly whether something is live,
merely committed, or still uncommitted.

### Public tester (`/try` → `test-kitchen.html`)

Renamed `try.html` → `test-kitchen.html`; `/try` and `/try.html` now 301 to it
(427f077), with real headline/subline copy (5f7fc18). The per-browser hourly rate
limit was dead code — it compared a freshly server-generated session id against
itself, so it could never match — and the turn cap was a read-then-write race, not an
atomic check. Turn claiming now goes through a Postgres RPC
(`public_tester_claim_turn`, migration 098) and per-browser matching uses a real
`client_hint` column (b2972d5). Rate limits were then loosened outright: per-IP
(5/hr) and per-browser (3/hr) limits removed entirely, global daily cap raised
150 → 1000 (f218d19). Separately: iOS text-zoom fixed (16px inputs, dropped
`maximum-scale=1.0`, ba88ed7), and the SMS-eligibility guard narrowed from "any
phone number on file" to "a carrier-issued number" (ad7a8a7). All of this sits in a
static HTML file plus the `public-tester` edge function, which holds the service role
and enforces every guard server-side. Deployment of this batch's specific commits was
not independently reconfirmed via the Supabase CLI this pass — treat "deployed" as
self-reported by the commit messages.

### chat-sms bot fixes — four defects (12:16) through QA close (15:35)

6cacb4c shipped four fixes explicitly marked "NOT YET DEPLOYED" (deployed function
was still v222 at commit time). Later commits (03cb0f4, bc184a5) refer to them as
already live and QA'd, so they did ship, but there is no deploy-log artifact in the
repo pinning the exact version jump — only cross-referenced commit messages.

QA on those four came back SHIP with two follow-up defects, both fixed same day
(bc184a5; "chat-sms v226" per the readiness log, not independently reconfirmed via
CLI): the phantom-add guard only split replies on periods, so a comma-joined reply
("we don't have pepperoni, but I can add the garlic knots now though") let one clause
silence the guard for the other, leaving an empty cart with no prompt — it now also
splits on `;`, dashes, and a leading but/though/however/although. Separately, the
delivery-availability flag was keyed on having coordinates alone, while the actual
zone check also requires a delivery radius; a shop with coordinates and no radius was
told delivery was available, then saved an address with no zone check ever run. Fixed
to require both — checked against the live shop table, only two throwaway test shops
flip to pickup-only, the one real delivering shop is unaffected.

Three "Test Kitchen" defects from one of Jason's own test transcripts, fixed same day
(3be60d5): a truncated reply that shipped literally as "the meantime. What flavor
were you thinking?" (the invented-action guard stripped a clause but never validated
what was left); a fabricated wing flavor ("Boosenberry") that reached a real ticket
because option values were never checked against the shop's real option groups (now
are — unverified guesses are threaded through as `unverified_requests` instead of
silently accepted); and repeated fee-line noise in the cart footer (new
`fee_disclosed_at` column, migration 100).

Also today: one shared `NAME_ASK` string so both order types ask for a name the same
way (c0089cc); zero-option-group items no longer hard-reject an add for lacking a
`prompt_for` (03cb0f4); the compliance footer was appearing on every `/try` reply
instead of just the first because web-channel replies never counted as "first
contact" (c0efec7); the page's suggested opener text was rewritten after failing
three separate ways in practice (901d4e7); and a first pass stopping the bot from
inventing an "ACTION" it never took (18bc28a). All of the above is edge-function code
(`supabase/functions/chat-sms/index.ts` plus a new `invented-action-guard.ts`) —
each requires a deploy to take effect, and 3be60d5 also requires migration 100.

### Item K — website menu reader, continued

This morning's false-success bug (reporting "done" over an empty menu) was fixed
before today's window opened; today's follow-ons: PDF menus are now routed to the PDF
parser with exponential backoff on Firecrawl 429s (d34f7eb), and PDF links are also
discovered by scanning the homepage HTML already fetched, no second network call
(afce671). Re-measured after the parse fix: 0/20 → 6/20 PASS (9c86b88) — the
underlying evidence for that number lives only in untracked scratch files
(`scripts/tmp-item-K-*`), not in git, so it would not survive those files being
deleted.

A source-priority ladder was added — own website → owner-provided PDF/photo →
Google listing → aggregator (last resort) — with provenance columns recording which
rung produced each item (migration 102, 3081937). Measured against 4 sites with no
usable rung-1/2 menu: 0/4 still came back empty even through the aggregator fallback
(Slice returns priced items but zero options/sizes; Toast and ChowNow are
JS-rendered storefronts a static scrape can't read at all). A same-day fix (c56ee2a)
added a longer timeout specifically for menu extraction and detects which
white-label ordering backend (Owner/Slice/Toast/ChowNow) a restaurant's own domain
is silently proxying to. Two of that commit's own headline numbers ("124/124" and
"27/27" priced items recovered) have no corresponding measurement file anywhere in
the repo — real or not, they're asserted, not demonstrated.

Deployed-version spot check via the Supabase CLI: `scrape-shop` v72,
`parse-menu-pdf` v93, `import-menu-csv` v38 — all consistent with the timestamps
claimed in their commit messages.

### Owner-facing Menu & Settings editor — built, reverted, rebuilt, now live

Reconstructed from the diffs, in order:

1. **10:29** (37142f8) — a full menu/option/hours editor was built, but placed inside
   the *admin* dashboard (Jason-operated), not owner-facing.
2. **10:34** (b192d65) — reverted off `main` five minutes later. Jason had redefined
   the feature as owner-facing before the build shipped; per the commit message it
   reached `main` "by a careless push" rather than a decision, and had already put
   bad data on the live QA shop (an invented "Wing Flavor" group), which was manually
   cleaned up. The underlying migration (097: `owner_edited` column + the owner
   INSERT/DELETE policies that were simply missing) was kept.
3. **14:33** (4a28993) — rebuilt owner-facing, at a route settled as `/menu-settings`
   (825772b resolves a naming conflict between two specs). Writes go through the same
   `admin-chat` operations registry used by chat, under the owner's own JWT, never
   service-role.
4. **15:50** (5520eec) — closed a remaining gap: owners can now add and 86/un-86
   items, not just edit existing ones.
5. **19:12** (a82ab23) — the admin dashboard's built JS bundle was committed directly
   to git, because **admin auto-deploy has been broken since 8/22** (stated plainly
   in the commit message); bundles are currently deployed by hand via `netlify
   deploy`, and `main` was carrying a stale hash. This is a real, unresolved deploy
   gap, not a one-off — the repo has done this same "commit the dist bundle"
   workaround for at least three weeks (same-day precedent: 049c1d4's command-center
   commit does it too).

What's live on `main` right now for menu/settings editing: the owner-facing editor at
`/menu-settings`, backed by an extended `admin-chat` registry (nine operations
including `ADD_ITEM`/`REMOVE_ITEM`) and migrations 097/101/104. The admin-only shape
from step 1 is dead on `main`, preserved only on branch `shop-editor-admin-shape`.

### The importer-durability gap — reported wrong, then corrected

Jason was told the deployed `import-menu-csv` had **zero** handling for owner-edited
data, based on a grep that returned 0 (cbb87e8, 17:33). That claim was itself wrong:
the grep ran over a `supabase functions download` output that never actually
contained the function's `index.ts`, so it measured an absent file and reported the
miss as a finding. Driving the *live* function instead showed the real gap was
narrower — owner-edited items were already protected; owner-edited option groups and
choices were not, and a $3.00 owner-set addon price would revert to $2.50 on the next
CSV re-import. Fixed and deployed as v38 (confirmed live via the Supabase CLI,
14a1d0c, 19:27), then the original overstatement was corrected in the readiness log
(749a4d2, 21:02). Worth keeping: the method note in that correction — a grep over
`supabase functions download` output is not proof of what's deployed; drive the
function instead.

### Judge panel (advisory only)

Backend (4098c03): a new `judge-transcript` edge function and migration 103 score a
submitted test conversation and write proposals. Frontend (870a75f): a read-only
panel under the chat simulator showing the critique, score, and any proposals, each
marked "Proposed — pending review." No code path applies a proposal automatically —
the spec requires this stay advisory, and the diff matches: it renders, it does not
write back to any live prompt or config. Same-day copy fix (734e66b) stopped the
panel's "jargon softener" from mangling grammatically correct English.

### Also today

- **Command-center** (049c1d4): tiles now render from a single source-of-truth feed
  rather than being individually wired, plus a `publish-build-status.py`/`.sh`
  pipeline and migration 099.
- **Build-status false alarm** (5a91b20): a "blocked on Jason" status was firing for
  an item that was actually built; fixed a regex in `publish-build-status.py`.
- **Demo Kit page** (10be919): owner-facing `/demo-kit`, QR/vCard/SMS builders
  consolidated into one shared module.
- **Chat simulator scroll bug** (33cb867): pressing Enter in the admin chat
  simulator yanked the whole page to the top because `scrollIntoView()` had no
  `block` option; the message list now scrolls itself, page scroll untouched.
- **Human test capture** (1bff8d5): "Copy transcript" / "Send for review" buttons
  under the simulator, backed by an append-only `test_transcripts` table (migration
  095) with no UPDATE/DELETE policy at all.

### Uncommitted in the working tree (not part of any commit today)

- `scripts/imsg-bridge.sh` — default demo shop switched from "Not Just Bagels" to
  Vito's Pizza, and made env-overridable (`SHOP_ID`/`SHOP_NAME`).
- `scripts/test-suite/run.ts` — the chat-function URL the test runner hits is now
  overridable (`TEST_CHAT_FUNCTION_URL`), apparently to A/B a second
  `chat-sms-mtest` function without touching production's URL.
- `vitos-demo.html` — the demo phone number changed to `+14842018054`, the admin
  link gained an explicit `https://` scheme, and the number is now pretty-printed as
  `(484) 201-8054` in both the header and the SMS link text.
- `deno.lock` — a dependency-lockfile update for `deno.land/std@0.208.0`; it doesn't
  correspond to any new import in today's diffs and looks like a backfill for an
  import that was already in use but never locked.
- None of these four files are staged or committed as of this writing.

### A loose end worth naming

Several spec docs cited by today's readiness log entries —
`2026-09-05-judge-panel.md`, `2026-09-05-menu-source-priority.md`,
`2026-09-05-shop-editor.md`, `2026-09-05-test-capture.md`,
`2026-09-05-testkitchen-defects.md`, plus two from prior days — exist on disk but
were never `git add`ed. They're real files with real content, not phantom
references, but they carry no history in the repo; if the only working copy that has
them were lost, the citations in the readiness log would point at nothing.

## 2026-09-06

51 commits, one continuous stretch from 2026-09-05 22:37 EDT to 2026-09-06 20:42 EDT.
The day has two throughlines: a real P0 money bug in `chat-sms` that triggered a
17-commit chain of guard fixes, and a new customer-facing public menu page. Both
verified live against production where stated below, not taken on commit-message
word.

### P0: cart doubled $37.97 → $74.95 after "Looks good"

A live tester ("Luca") ordered a pizza and wings. GUARD 4 (an "under-populated cart"
backstop) fuzzy-matched his own order text against every menu item name and appended
a customer-facing line — "Did you also want Chicken Bacon Ranch (Flatbreads), Chicken
(Quesadillas), and Ranch, or good to go?" — built from three unrelated near-name
matches. That unresolved 3-item offer sat in conversation history. Two turns later he
said "Looks good", a bare affirmation; the model read the full history including the
stale offer as consent and issued real `add_item` calls for all three, doubling the
total with zero customer intent (`0398d99`).

The fix removed GUARD 4's customer-facing suggestion (detection/logging stayed) and
added GUARD 9, a deterministic backstop meant to hold even if a future mechanism
leaves a stale offer in history again: on any bare-affirmation turn, diff cart
quantity per item between the true pre-turn snapshot and the post-tool-call cart, and
revert any growth the current message alone doesn't name. As shipped in that same
commit, GUARD 9 was wired to `cartItems` — the array `executeTool` mutates in place
during the tool loop that runs *before* the guard — so "before" and "after" were the
same mutated data and the revert branch could never fire. **This means the guard
built specifically to catch a P0 was dead code at the moment it was written.** It
never reached production in that state: independent review caught it before the
held-for-deploy commit went out, and the next commit (`7405a13`) rewired it to the
real pre-turn deep clone and extracted the diff logic into its own module with no
access to the mutable array, so this exact mistake can't recur. Confirmed by directly
running `guard9-unconsented-affirmation-add-20260906.test.ts` just now: 16/16 pass,
including one test that reproduces the original wiring bug on the mutated array to
prove the fix matters, not just a copy of the logic.

`chat-sms` shows deploy version 259, last updated 2026-09-07 00:43 UTC — one minute
after the day's final commit (`f5cd463`, 20:42 EDT) — consistent with "held for a
single combined deploy" and confirming everything below is live, not just committed.

### The rest of the day on `chat-sms`: 17 commits, one guard (GUARD 7c) needed five

Beyond the P0, the day added GUARD 7c (pre-LLM deterministic resolution of
duplicate-named menu items, e.g. two "Chicken Caesar" rows) and GUARD 10 (required
option values must match an `is_default` choice or a word in the customer's own
message — closes the model inventing a plausible but uncredited selection). GUARD 7c
needed five iterations in about 90 minutes: introduce → doesn't handle negation
("I don't want the chicken caesar salad") → doesn't handle a bare question ("how much
is it?") → its deny-list of question forms still leaks on rephrasing QA found within
the hour → replaced with a positive allow-list (require an order-intent phrase, or
zero leftover content words after stripping the item/category names). The allow-list
is a structurally sound move — a deny-list of question phrasing is open-ended and
English will always find a form it didn't enumerate, which is what happened twice in
a row; an allow-list is a small, closed decision space. It is the last commit of the
day.

Two other real regressions worth naming because they show same-day commits stepping
on each other's fixes with no test catching it either time: a deterministic em-dash
stripper added mid-afternoon (`7d4f047`) silently destroyed the itemized recap's
column padding and paragraph breaks a few commits later, caught by QA not tests
(`2e472b3`); and the itemized recap itself was dead code for a stretch because it was
attached to GUARD 2's reply specifically, while the model asks for the pickup name
unprompted more often than GUARD 2 forces it — fixed by moving the attachment to a
universal footer checkpoint (`2274cbf`), the same "reachable only via specific
phrasing" shape recurring again in `d662d1a`.

Test coverage caveat worth keeping: `chat-sms/index.ts` is a bare `Deno.serve()`
entrypoint with no exports, so most same-day test files work by copying the relevant
logic verbatim into the test and separately regex-checking that `index.ts` still
contains matching source text. That validates the copy's behavior plus a
marker-string presence check, not an import-and-exercise of the shipped function.
GUARD 9's test is the exception — it imports the real `guard9-unconsented-affirmation.ts`
module directly. Running the full `chat-sms/*.test.ts` suite just now: **252 passed,
0 failed.**

Overall read on the architecture, not just today's fixes: several commits explicitly
diagnose *why* the previous fix's shape was wrong (deny-list is whack-a-mole, the
sweep fixed instances not the cause) and respond by generalizing rather than
re-patching — that's real convergence. But every one of GUARD 7c's five holes was
found by a human firing real phrases at a live deploy, not by the same-day test
suite. An LLM plus an accumulating stack of regex/keyword guards will keep surfacing
adjacent gaps at roughly this rate; today raised the floor without changing that
dynamic.

### Pending disambiguation / pending required options: a new persistence layer, 9 commits

`3e01286` (11:58) built the first real state for "what did we just ask the customer":
a new `pending-disambiguation.ts` module and migration 112
(`order_carts.pending_disambiguation JSONB`) so a clarifying question ("which Chicken
Caesar — salad or wrap?") survives to the next turn instead of being re-litigated by
the model from raw history. Eight more commits through the evening closed gaps in it
one at a time: persisting the offer when the model asks in free text without calling
a tool (`ab8c2d0` — the fourth confirmed instance of "the happy path skips bookkeeping
only the failure path does," per RUNBOOK), a decline ("never mind the salad")
silently falling through to the LLM and getting re-interpreted as a selection
(`1c68647`), the same disambiguation trapping checkout by re-asking on "no thanks"
(`4ef99ac`), and a parallel `pending-option.ts` module for required-option answers
(size, temp) with its own double-add and stale-total bugs (`24d37bc`). Migration 112
is a single additive `JSONB` column with a matching `.down.sql`; both are already
live (see below).

Net effect: real, traced fixes, not guesses — but discovered in the same
one-at-a-time, live-QA-against-one-tenant pattern as the guard chain above.

### New: public per-shop menu page, `getsprintai.com/m/<slug>`

Server-rendered from the same tables `chat-sms` reads (menus → active menu_items →
option_groups → option_choices), no auth, no build step, no second copy of the menu
to disagree with the bot. Verified live just now: `curl -D-
https://getsprintai.com/m/vitos-pizza` returns `content-type: text/html;
charset=utf-8`, 221 items, no dev-facing placeholder text, real prices.

Two bugs found and fixed same day are worth flagging because of what they say about
the initial ship, not just the fix: the pagination fix (`3987ba2`) closes a defect
that would have hit **every shop except the one it happened to be tested against** —
PostgREST's default 1000-row cap silently truncated `option_choices` (Vito's alone
has 2640), with no error, so the first version of this page (`8ddc030`) shipped
already broken for its general case. The same commit also fixed an `open_hours`
shape assumption that would 500 on any shop using the newer flat-object hours format.
Separately, the Content-Type fix took two tries: `06a3cb7` set a Netlify
`[redirects.headers]` rule, which only affects request headers sent upstream and
could never have fixed a response header — a dead end shipped and superseded eight
minutes later (`8ef6871`) by an actual Netlify Edge Function
(`netlify/edge-functions/menu-proxy.js`) that fetches Supabase server-side and
re-serves the body with corrected headers. The edge function is what's live; the
`[[redirects]]` rule in `netlify.toml` is now a documented, inert fallback.

### Security: `issue-detector` was fail-open, now fail-closed

Before today, `issue-detector` (`verify_jwt=false`, fronts a live owner-SMS
escalation sweep) had **no auth check of any kind** — the commit message states this
was proven live, an unauthenticated POST returned HTTP 200 and ran the real sweep.
`e777259` adds a bearer-token gate (constant-time compare) requiring either a
dedicated `ISSUE_DETECTOR_BEARER` secret or the raw service-role key; `verify_jwt`
deliberately stays false because the alternative (`verify_jwt=true`) would accept the
public anon key shipped in the browser bundle, which is weaker, not stronger. One
designed exception to "fail closed," named honestly in the commit: if
`ISSUE_DETECTOR_BEARER` is ever unset, the gate falls back to accepting the raw
service-role key rather than 401ing every request on a missing-secret
misconfiguration. Deployed (`issue-detector` v18, updated 14:31 UTC — one minute
after the commit) and verified via a same-session live probe: no-auth, wrong-bearer,
and public-anon-key all 401; real cron bearer and service-role key both 200.

### Migration-tracking drift: the CLI's "not applied" can't be trusted on its own here

`supabase db push --dry-run` reports migrations 105–111 (qa_ro delivery-truth
columns, option_groups/choices exposure, tester attribution, the dead-clone-slug fix,
the non-PII scope widening) as **not applied to remote**, alongside a longer
pre-existing backlog (014–019, 048, 083, 084, 088, 099–101, 103). Taken at face
value that would mean none of today's qa_ro reporting work is live. It isn't that
simple: I live-tested migration 109's actual change — POSTed to the deployed
`public-tester` function and it wrote successfully to `user_agent` and
`client_first_seen_at`, the two columns 109 adds — so that schema change **is** live
on the database despite the tracker saying otherwise. This matches a pattern the
shop-retirement commits confirm independently: today's `dc542dd`/`0a7ddba` "retire"
UPDATEs (rename, pause, slug change) exist nowhere in either commit's diff — they
were applied directly against the database, outside `supabase db push`, exactly like
109 apparently was.

**Practical consequence:** `supabase_migrations.schema_migrations` has drifted from
actual schema state on this project, more than once, in a way that makes `supabase
migration list` an unreliable signal here. I could not independently verify
105–108/110–111 the same way (they touch `qa_ro` views only, reachable exclusively
via the `qa_readonly` credentials on Jason's Mac — not available in this
environment) — so their live status is genuinely unverified, not confirmed either
way. Recommend running the read-only check documented in RUNBOOK ("Reading the QA
data yourself") against `qa_ro.schema_migrations` (added by 111, itself unverified)
to settle it, and treating "committed" and "tracked as applied" as two different
claims on this project going forward.

### Also today

- **Item K (website-read reliability) → built** (`119ff92`, docs only): a fourth live
  measurement re-drove `scrape-shop` v73 against the three sites the prior fixes
  targeted. Both failure modes closed (no more 150s gateway 504 stranding a shop in
  `crawl_status='running'`; PDF-rung provenance now persists). Rate held at 12/20
  (60%) — the two fixed sites were never a pass — and a cost is named rather than
  hidden: one large-menu site that used to land 240 real items before dying to the
  timeout now imports 0 items honestly, because the tighter deadline budget appears
  to truncate the crawl rather than just avoid the timeout.
- **Shop cleanup**: the Not Just Bagels test clone and the Vito's Pizza QA twin were
  both retired (renamed `ZZ RETIRED`, paused, slug changed, rows kept for audit —
  not deleted) after the twin's stale zero-topping menu caused Jason to wrongly
  conclude a real fix hadn't landed. New standing rule recorded in RUNBOOK: one shop
  per real-world restaurant. As noted above, both retirements were applied directly
  to the database, not via a tracked migration.
- **Admin picker fix caught its own "committed but not live" gap**: `429d450` hid
  paused shops from the owner-preview picker, merged to `main`, but did not reach the
  live admin site until `3edf483` manually rebuilt and deployed the bundle 20 minutes
  later — the admin dashboard is still CLI/manual-deploy, not git-auto-deploy,
  reconfirming the operational risk already logged in HANDOFF from yesterday.
- **Uncommitted in the working tree**: a new `verifyRequiredOptionsCovered`
  deterministic invariant (fails a proof/test-runner case that reaches checkout with
  a required option group never answered) plus a new `category-coverage.ts` case
  generator (one realistic order per menu category, menu-agnostic). Confirmed by
  running it directly: `required-options-guard.test.ts` passes 5/5. Wired into
  `scripts/test-suite/proof.ts` and `supabase/functions/test-runner/index.ts`, but
  neither file nor the new scripts are staged or committed as of this writing.

## 2026-09-07

Commit range `f5cd463..057b375`, ~65 commits, 79 files, +18.3k/-206 lines. The bulk
of the day is a new schema/compiler subsystem ("conversation-ready-menu Phase 0")
built spec-item-by-item, plus the usual chat-sms guard-chain churn — including one
live P0 regression shipped and fixed same day. Facts below are read from the actual
diffs, not the commit messages.

### New subsystem: conversation-ready-menu Phase 0 (migrations 113–120 + `compile-menu`)

A new edge function, `supabase/functions/compile-menu/index.ts` (584 lines), plus
migrations 113–120, implement items 1–9 of
`docs/specs/2026-09-07-conversation-ready-menu-design.md`. This is **not** a
read-only report generator — read the code, not the "report" framing in some of the
early commit messages:

- **Writes it makes**: on every active `menu_items` row it overwrites
  `display_name`, `product_key`, `bot_state`, `bot_state_reason`, and `ask_plan`.
  It upserts `lexicon` rows and deactivates stale ones. It **inserts** new
  `owner_questions` rows but never updates or deletes an existing one — the one
  place in this function that deliberately protects a human's prior answer from
  being clobbered.
- **What it deliberately does not touch**: `option_groups`/`option_choices`. Those
  tables are read directly by `chat-sms`'s live order-taking path
  (`buildEffectiveMenu`) with no awareness of provenance, so anything the compiler
  derives stays a synthetic, non-persisted "derived:" slot feeding `ask_plan` only.
- **A real production bug, found and fixed the same day** (`b448444`): a single
  `.in()` filter with ~492 UUIDs failed silently at the transport layer, and 183 of
  Zio's Pizzeria's real menu items got wrongly written as `bot_state='blocked'`
  before anyone noticed. Fixed by batching `.in()` calls to 150 IDs and making the
  fetch helper throw instead of swallow. The same silent-truncation bug pattern hit
  a separate reporting script (`63e7da6`, `scripts/item-9-readonly-compile-report.ts`)
  and undercounted Zio's orderable items as 21/220 instead of the real 163/220.
- **Deployed but stale.** `compile-menu` has a live version (v4, per
  `supabase functions list` history cited in the commits), but by the end of this
  range that deployed version still predates the `normalize.ts` multi-clause parser
  fix (`a292618`) committed hours earlier — invoking the live HTTP endpoint today
  would re-run the old, buggy parser against real data. Nobody had redeployed it as
  of the last commit in range. **Not Just Bagels was never actually compiled this
  entire day** — it stayed at 170/170 `bot_state='blocked'`, `ask_plan=null`
  throughout, blocked on an explicit sign-off decision about applying
  `planOwnerQuestionsRefresh` (see below), not on a bug.
- **`planOwnerQuestionsRefresh`** (`c5deb20`): a new pure function that reconciles
  pending `owner_questions` against a fresh archetype/infer computation
  (update-if-key-still-there, delete-if-key-gone, never touch a row someone already
  answered). A dry run against NJB found 3 rows where a human had already
  hand-corrected `items_affected` but the derived `priority` value
  (`items_affected × 4`) was never recalculated — a display-order bug only, not a
  blocking bug. Built and verified live; **not applied** to NJB's real data pending
  sign-off.

### Migration 118 (`compiled_ordering_engine_enabled`) and migration 120 (`menu_extraction_incomplete`)

Both add columns to `shops`. `supabase migration list` reports both as **not
applied on the remote** as of this writing (local migration file present, remote
tracking row blank) — this matches a migration-tracker-drift problem already
documented in RUNBOOK for migrations 105–111. For 118 specifically, an RUNBOOK note
written today states the column was checked directly against the database and is
in fact live, despite the blank tracker row; I have not independently re-verified
that claim, and I found no equivalent direct-DB confirmation for 120's two columns
(`menu_extraction_incomplete`, `menu_extraction_note`) — their live-or-not status
is genuinely unverified here. Migrations 113–117 and 119 show local+remote agreement
and are applied.

118's flag is real, wired code, not a stub: `chat-sms/index.ts` reads
`shop.compiled_ordering_engine_enabled` (line 208, 4755) to gate the new
deterministic ask_plan sequencer/resolver (`ask-plan-engine.ts`, added this range,
413 lines: `matchChoiceInText`, `renderStepQuestion`, `resolveAskPlan`,
`applyCompiledAddItem`, `allSlotsResolved`), called from both `add_item` and a
separate-turn pending-answer path. The column's own SQL comment states the default
is `false` for every shop and that Vito's — the canary shop — "must never be set
true." **No shop has this flag on.** The entire item-8 engine is committed,
deployed, and structurally inert today.

### chat-sms guard chain: one live P0 regression, plus the self-contradiction fix

The guard chain (now GUARD 12, 13, 16, 17 touched or added today, on top of guards
from prior days) is still the dominant source of both new capability and new bugs
in `chat-sms/index.ts`, same pattern flagged in yesterday's entry.

- **GUARD 12 P0 regression, live on Vito's canary, fixed same day** (`bc2e0bc`):
  GUARD 12 was flagging *every* pending required-option question as an unresolved
  false claim — a real live bug on the production canary shop, not caught before
  merge. Root cause: the guard conflated "the bot is asking about a choice" with
  "the bot falsely confirmed a choice." Fix excludes any group already in
  `pending_options` from the unresolved-claim set. This is a concrete instance of
  the guard-chain fragility already named in the 2026-09-06 entry — a new guard
  broke an existing, correct behavior on the shop that customers actually use.
- **GUARD 17** (`9fcb7ed`, 5 revisions per its own code comments documenting v1–v5
  failure modes): detects a change-verb plus a named foreign descriptor near a
  zero-option item in the bot's *reply*, then appends a correction. Real, wired,
  matches its commit message.
- **GUARD 16** (`f679e1d`, +312 lines): a safety net for the compiled path — checks
  whether a reply names a real modifier choice absent from `ask_plan_selections`.
  Since the compiled path is gated off for every shop (see above), this guard is
  currently a no-op in production.
- **The self-contradiction ordering fix** (`4a65802`, `057b375`): the actual
  architecture change here is moving the fix from "correct the claim after
  composing it" to "give the model an honest heads-up before it composes." New
  module `zero-option-attribute-hint.ts` runs before `buildSystemPrompt`: if the
  customer's message uses change language against a cart item with
  `ask_plan.steps.length === 0`, the model gets an explicit instruction that turn
  to give one honest reply, not a claim-then-correction. This is a genuinely
  different mechanism from GUARD 17 (prevention vs. after-the-fact correction), not
  a bigger version of the same guard. Building it surfaced its own bug: GUARD 17
  didn't recognize an already-honest denial and appended a needless correction onto
  it, recreating the exact bug it was meant to prevent — fixed with a same-sentence
  negation check (v6). Both pieces are reported deployed and independently
  re-verified by a second reviewer against live NJB data (5 + 3 live repros,
  synthetic sessions cleaned up after).
- **New, unfixed, flagged gap: `order_carts.notes` sometimes isn't actually
  written.** Found live-verifying the fix above: in roughly 1 in 3 turns, the bot's
  reply says a preference was noted for the kitchen, but the `notes` column is
  confirmed (via direct DB query against real NJB data) to be stale or empty. This
  is the same claim-vs-actual-state honesty bug as the original self-contradiction,
  just in a different field, and it has real kitchen-facing impact (wrong item
  made). **Not fixed as of end of range** — explicitly left as a decision point for
  Jason on priority, not silently absorbed.
- **Other chat-sms fixes, verified as real and narrowly scoped**: `a894cd7`
  ("forget it" no longer wipes the cart), `73953d0` (required options asked
  one-at-a-time, not dropped across sequential `modify_item` calls), `2671f2c`
  (one-line `ReferenceError` fix — `conversation.id` used where `cartId` was in
  scope — regression from an earlier same-day revert, now covered by a regression
  test), `fe85bb4` (stop printing meaningless option caps like "pick up to 32
  toppings"), `a7e6daa` (contraction handling in the hallucination guard + a named-
  item-removal fix). **`8bdf49f` is explicit, honest WIP**: its own commit message
  says named-item removal ("remove the pizza") still fails to match and instructs
  not to deploy it — this is a real gap left open, not an oversold fix.

### Test-suite / Proof harness: real fixes, but the live cron runner is a day behind main

- **"Channel-aware" safety gate** (`1412ef1`): before today, the harness's
  protected-shop check had no way to say "this is a web-channel test call," so
  testing a real shop (like Vito's) required manually nulling out its
  `protected`/`phone_number_e164` DB fields before a run and remembering to restore
  them after — a manual, error-prone toggle ("flag-flipping"). Now an explicit
  `channel: "web" | "sms"` parameter is required; `"web"` (all this harness ever
  sends) skips those checks by construction, `"sms"` is unchanged.
- **Category-wide order coverage** (`fe37f88`): a new generator
  (`scripts/test-suite/category-coverage.ts`) builds one realistic order per real
  menu category straight from live `menu_items`/`option_groups`/`option_choices`
  data (no hardcoded item names), checked by two new invariants
  (`verifyRequiredOptionsCovered`, `expectedLineCount`).
- **Fail-open money checks, fixed** (`fe37f88`): four verification functions
  (`verifyStatedTotal`, `verifyStopOptOutHonored`, `verifyCheckoutFinalize`,
  `verifyRequiredOptionsCovered`) used to return `passed: true` whenever a run
  produced no transcript at all — meant as "nothing to check," but `proof.ts` only
  ever reads `.passed`, so a crashed/timed-out run was indistinguishable from a
  clean pass. Now `passed: false` on a missing transcript.
- **Three classes of Proof harness false-failures fixed** (`396c85d`, out of 37
  flagged in a 139-case run): a total-amount regex that could match across a line
  break on multi-line receipts; the required-options invariant failing cases that
  were still mid-conversation (never reached checkout); and generated single-turn
  test cases that ordered an item with required options but never scripted an
  answer turn. A fourth failure class (a retried message causing a duplicate cart
  line) was investigated and left unfixed, flagged as possibly a real product bug.
- **test-runner v29 is deployed but already one step behind main.** v29 (deployed
  2026-09-07 11:05:07 UTC, confirmed via `supabase functions list`) includes
  `fe37f88` and `1412ef1`. It does **not** include `396c85d` (the three
  false-failure fixes) or `ba6efd7` (a guard against `proof.ts` crashing on an
  undefined cart from a timed-out turn) — both committed after the v29 deploy, with
  no later deploy on record. The pg_cron-driven autonomous Proof suite is currently
  running with those bugs still present; only the CLI-driven `scripts/test-suite/`
  path (which runs from the working tree) has the fixes.

### scrape-shop: an honesty-signal fix, and a same-day regress/fix pair

- **`c8f91d7`**: `extractMenuItems()` splits a large menu's text into concurrent
  chunks (smaller, parallel AI calls instead of one big slow one) and merges the
  results. Until today, a chunk that errored or timed out was silently dropped, and
  a merge over the 300-item cap was silently truncated — either way the run could
  still report `crawl_status='done'` over a menu missing real items, with no
  signal anywhere. Fix extracts the merge logic into a testable pure module
  (`menu-extraction.ts`, with a real unit test file) and adds migration 120's two
  columns as a non-blocking honesty signal, deliberately not touching
  `crawl_status`/`crawl_error`, which other retry logic depends on.
- **`0c654ec` → `683a7ec`, same-day regress and fix**: `0c654ec` chunks
  `extractMenuItems()` calls to beat the function's wall-clock timeout on large
  menus (one real site went from 0 imported items to 240 after the fix, per live
  measurement) — but its own commit message says "do NOT deploy, leave for Jason to
  review," because it also changed `Deno.serve(handler)` to
  `Deno.serve({port}, handler)` for every environment, an unverified form against
  the real Supabase runtime, not just local testing. `683a7ec` gates that change so
  deployed behavior is byte-identical to before and only local test runs get a
  port. Net: real, live-measured fix, shipped same day, but only after catching its
  own deploy-shaped regression first.

### Zio's Pizzeria: one-off backfill scripts, not codebase changes — and a vendor constraint worth flagging

`9b9af9b`, `d80a444`, and `feb390b` only touch
`scripts/load-zios-firecrawl-options.mjs`, a standalone Node script (Firecrawl +
Playwright) written to backfill one restaurant's option data, not a change to the
reusable `scrape-shop` pipeline. Real bugs were found and fixed within it (a shared
browser context that crashed mid-run, a `const` reassignment that would have
thrown, a menu item that needed a longer wait before being correctly read as having
options) — legitimate fixes, but scoped to Zio's onboarding, not general
reliability. `d0056e0` documents an abandoned fallback script for the same task,
explicitly blocked on **Firecrawl running low on API credits (80 of 1000 left)** —
a real vendor-cost constraint on the onboarding pipeline, not a code issue, worth
tracking if more restaurants need this same manual backfill path.

### Deploy/migration audit for this range

Deployed and current with the last commit touching them in this range: `chat-sms`
(v282), `scrape-shop` (v76), `compile-menu` (v4 — see "stale" note above),
`public-menu` (v8), `test-runner` (v29 — see "one step behind" note above).
**Committed but not deployed**: `chat-sms-mtest` — its last change in this range
(`fe85bb4`, part of the menu-option-caps fix) is dated a full day after the
function's live version (18) was last updated, so the deployed test-harness
variant does not have that fix. Lower stakes than the primary bot since it's a test
double, but worth knowing before trusting an mtest run against today's menu-display
change.

## 2026-09-08

Commit range `057b3750..HEAD`, 40 commits, 84 files, +12.9k/-2.0k lines. Note on
scope: this range starts right after yesterday's entry's cutoff and runs to
tonight — the first three commits (`f6ea8c7`, `edab2d7`, and yesterday's own
journal commit `3a69bfc`) are timestamped 2026-09-07 evening, not today; the
substantive new work below is `e2a98eb` onward. Facts are read from diffs and
`BLOCKED.txt`, not commit messages, and cross-checked against `supabase
functions list` / `supabase migration list` run live in this session.

### Headline: unreviewed code deployed straight to production, twice, same evening — one real-money defect

- **First incident (~17:49 ET):** GUARD 19, part of the new customer-CRM build
  (below), went live as `chat-sms` v295→v296 via an uncommitted deploy. Its
  "bare quantity, no item named" cart-revert check didn't recognize Zio's
  compose-rule topping words, so real orders like "1 pepp, 1 plain, 1 hawaiin, 1
  meat lovers" got fully wiped to zero items. Caught and rolled back same
  session.
- **Second incident (~22:02 ET, `chat-sms` v301→v302→v303):** a subagent built
  `pizza-topping-compose.ts` and `guard19-fuzzy-item-match.ts` and deployed them
  live **without ever running an acceptance battery**. When the Lead ran the
  PO's required 3-run live acceptance test directly against v303 (agent tooling
  was down), run 1 added the **wrong topping** (Roasted Red Peppers instead of
  none) on a real order — a real-money defect, $92.95 charged vs. $89.95 owed.
  Runs 2–3 had correct carts but the bot's own reply falsely told the customer
  "Sorry, I got mixed up about your order" — a self-contradiction against a
  customer who did nothing wrong. 0 of 3 clean.
- Rolled back to the last clean **committed** HEAD at the time (`a351622`),
  redeployed as **v306** (2026-09-09 02:14:44 UTC / 22:14:44 ET) — confirmed
  current live state (`chat-sms/index.ts` at today's HEAD is byte-identical to
  what's deployed). The root cause of the intermittent wrong-topping bug was
  **never found**. `pizza-topping-compose.ts`, `guard19-fuzzy-item-match.ts`,
  and their test files remain **untracked, uncommitted** in the working tree —
  they never shipped cleanly; the only place they ever ran was live, broken,
  and unreviewed. `4eeba06` is the doc of this rollback.

### `chat-sms`: two P0s fixed, one re-diagnosed

- **Real-money P0 — RESET didn't clear conversation history** (`b865d3a`, deployed
  v295). The RESET handler now also marks the conversation `status='resolved'`
  (previously it only expired the cart), so the next message can't inherit old
  history. A separate, real-but-not-triggered-here cross-tenant gap on the web
  channel's active-conversation lookup was closed with an added
  `tenant_id` filter. A broader "Guard 18" backstop was built for the same class
  of bug but deliberately **not wired into `index.ts`** — it reverted legitimate
  Zio's orders (e.g. "pepperoni pizza" resolving to "Neapolitan Cheese Pizza,"
  whose own name never contains "pepperoni") — so it sits as dead code
  (`guard18-zero-grounding-item-invention.ts`).
- **"D1" multi-item modifier merge** (`f76d84f`): real root cause was one turn's
  `add_item` re-claiming a modifier choice meant for a later `add_item` of the
  same base item; fixed via `consumedModifierChoiceIds` in `ask-plan-engine.ts`,
  plus a new mid-turn backstop (`enumeration-shortfall-retry.ts`) and a lexicon
  collision guard in `compile-menu`. The commit's own message says a live
  acceptance battery was still outstanding. A same-day follow-up (`392894c`)
  found a deeper cause — `matchChoiceInText` never resolves abbreviations like
  "pepp" at all, and the compiled `add_item` path discarded the model's own
  resolved options — closed later the same day by `947ccb9`, which validates
  model-asserted options against real compiled choices before writing and routes
  `modify_item` through that same validated path instead of a legacy side
  channel.
- Smaller, narrowly-scoped fixes, verified real: `ac8f69d` (a required singleton
  option group now counts as a stated fact, not a manufactured question,
  unblocking Zio's Gyro items), `a351622` (NJB's description parser gains a
  second clause anchor, "served with," recovering a silently-dropped side slot
  on 11 Omelette/Egg Platter items — 155→166 of 170 orderable), `fa098f6` /
  `8329eb9` / `6883c66` (unify step rendering on `prompt_template` over raw
  `slot_key`, backfill Zio's slot_key mappings).

### Zio's size-fold: built, broke, rolled back, reapplied, and a real data bug caught after

Zio's 220 menu items each carry one required "Size" option group instead of
Vito's shape (one row per size). `_shared/size-fold.ts`'s `planSizeFold` explodes
a multi-choice size group into one new row per size (`retiresOriginal: true`);
a single-choice group is folded in place instead.

- `128cef9` (13:13 ET): code + dry run only, stopped at the PO's apply gate — no
  writes.
- Applied live (~13:45 ET); the recompile surfaced 51 newly-blocked items →
  `2af6373` (13:49 ET) emergency-rolled all the way back to the pre-fold 220
  items.
- Reapplied later (`a5197ff`, 17:53 ET): 220→301 active items, 298/301
  orderable on recompile.
- That reapply had its own real bug: the newly-exploded rows carried **zero**
  `option_groups` — toppings and "make it" modifiers were silently lost on all
  142 exploded rows, since `option_groups` FKs to `menu_item_id`. Fixed
  (`01907c6`, 22:18 ET) by cloning the item's other option groups/choices onto
  each new row, plus a one-time backfill script for the 142 already-damaged
  rows.
- **Current state: size-fold is live on Zio's data** (301 active items), with
  the clone bug fixed and backfilled.
- **The "Hot/Cold Subs bread gap"** that first surfaced during this work is
  explicitly diagnosed as **pre-existing, not caused by the fold** — an
  isolation test against the rolled-back (pre-fold) data still showed 25
  blocked items (vs. 51 with the fold, which just doubled the surface via two
  size rows per item under the same bread question). Root cause: these items
  carry no bread option group and no descriptive bread text. **Still open, not
  fixed in this range** — a real PO decision point.
- Related archetype work: `1e47f97` adds a bread-fact extractor unblocking
  23/38 NJB items at the `owner_questions` layer, **not yet live** (pending an
  NJB recompile that was not authorized this session); `1ac0f19` generalizes a
  wrap-only bread guard to sub/hoagie/hero/grinder/gyro/panini/bagel/roll/pita/
  baguette/croissant, so e.g. "Steak Sub" needs no bread question by name alone.

### New subsystem: Customer CRM ("remembered diner" + "the regular")

New `_shared/customer-profile.ts` backs a materialized per-`(tenant_id,
customer_phone)` profile (migration 121, `customers` table). `stripe-webhook`
upserts it on every paid order (name, order/spend counts, `favorite_items` —
ranked by count of distinct **paid orders** containing the item, not units).
`chat-sms` looks the row up only when `shop.customer_personalization_enabled
!== false` and the customer isn't opted out, and only injects it into the
system prompt as a greeting-by-name + an offered (never assumed) "regular" —
gated further by two new guards: **GUARD 19** (full cart revert on a bare
quantity with no item named — the guard behind the first incident above,
now fixed) and **GUARD 20** (the regular can only be added if the bot's
immediately-preceding message offered it and the customer confirmed that
turn).

- `bccc6e2` adds `canonicalizePhone()`, extracting a real E.164 number out of
  `web:imsg-p{digits}-{epoch}` iMessage-bridge session IDs (which rotate every
  24h) so the same diner isn't tracked as a new profile daily — a production
  backfill reportedly collapsed 12 profiles into 8 real ones. **Confirmed
  missing from the deployed `customer-crm` admin function** (v1, deployed
  2026-09-08 20:27:31 ET, ~4 hours before this 22:18 ET fix).
- The owner-facing screen (`3ff5c81`, `admin-dashboard/src/pages/
  ShopOwnerCustomers.tsx`) is real, wired UI, not dark — it calls a new
  `customer-crm` edge function that resolves the tenant server-side from the
  JWT and never lets the browser query `customers` directly. `dc88de8` is a
  pure built-artifact sync (minified bundle swap) with no logic change; actual
  live status of the static admin-dashboard hosting beyond this repo commit was
  not independently checked this session.

### Compliance bug found and fixed: `sms_opt_outs` had been silently failing since migration 056

Building Customer CRM surfaced a real compliance-severity bug: every live STOP
request since migration 056 shipped has silently failed to durably persist
(table confirmed to have 0 rows). Three independently-fatal causes, confirmed
live via `pg_constraint`/`information_schema` per migration 122's own header
comments: no unique constraint on `(tenant_id, customer_phone)` (only a legacy
`(phone_number, shop_id)` pair existed), a missing `updated_at` column the
write path wrote unconditionally, and two `NOT NULL` legacy columns
(`phone_number`, `shop_id`) that were never populated — the write's own error
handling swallowed all of it as non-fatal ("Telnyx has its own enforcement").
Fixed by migration 122 plus `8bda9c1`/`bccc6e2` (adds the real unique
constraint, the column, and loosens the dead legacy `shop_id` to nullable).
`fd4412d` is a distinct, narrower, earlier fix in the same incident — it only
adds `phone_number` to the write payload, and was itself a redeploy of a fix
that had been reverted as collateral during the first incident's rollback
above.

**Open, unresolved conflict — flagging rather than guessing:** `supabase
migration list` and `supabase db push --dry-run`, both run live in this
session, show migrations 121 and 122 as **local only, not applied on the
remote tracker**. But `BLOCKED.txt`'s own build log claims both were applied
directly via the Supabase Management API (bypassing `db push`, citing this
project's already-documented migration-tracker drift — see RUNBOOK) and
independently verified live via direct `pg_constraint`/`information_schema`
queries at build time. This session had no service-role database credential
available to re-check independently — the read-only `qa_ro` schema (the only
DB access available) exposes neither `customers` nor `sms_opt_outs`. Whether
the `customers` table and the `sms_opt_outs` fix actually exist on the live
database right now is **genuinely unverified** as of this entry.

### scrape-shop / public-tester / demo-kit

- **ChowNow scraping fixed and verified** (`5922868`): ChowNow's storefront is
  a client-rendered SPA that hydrates after initial HTML, so a plain scrape
  read an empty shell. Fix passes `waitFor: 5000` to Firecrawl for ChowNow
  specifically (`aggregator-render.ts`). Verified live against a real ChowNow
  storefront: 109 priced items recovered (was 0), independently reproduced by a
  second reviewer same day (`346cb04`). Toast remains explicitly out of scope
  (blocked by Cloudflare + reCAPTCHA even through Firecrawl). Deployed:
  `scrape-shop` v78 is current with this fix.
- **`public-tester` carrier-number allowlist** (`a3609e4`): a hardcoded
  allowlist so Vito's real Telnyx number no longer 503s Test Kitchen, while any
  other shop with a carrier number is still refused. **Timing gap**: the
  deployed `public-tester` (v8, 16:12:01 ET) is ~5 minutes older than this
  commit (16:17:14 ET) — the live function likely does **not** yet have this
  fix; unconfirmed either way this session.
- `dddcb50` restores QR codes to Vito's demo-kit email, now generated at build
  time from the live shop row and embedded with the decoded target printed
  underneath so a stale code is visually detectable.

### Deploy/migration audit for this range

- `chat-sms`: **v306** (22:14:44 ET) — current, matches committed HEAD exactly
  (post-rollback, see headline above).
- `chat-sms-mtest`: **v20** (18:48:17 ET) — predates `fd4412d` (20:23 ET) and
  the `sms_opt_outs` fixes (22:18 ET). **Committed but not deployed.**
- `customer-crm`: **v1** (20:27:31 ET) — first deploy; predates `bccc6e2` and
  everything committed after 22:18 ET. **Committed but not deployed.**
- `scrape-shop`: **v78** (16:47:51 ET) — current.
- `compile-menu`: **v9** (15:23:19 ET) — current with `1ac0f19`.
- `public-tester`: **v8** (16:12:01 ET) — likely stale relative to `a3609e4`
  (16:17 ET); unconfirmed.
- Migrations **121, 122**: tracker says not applied remotely; today's own build
  log claims otherwise with live verification. Unresolved — see above.

### Uncommitted working tree, not part of this range

`pizza-topping-compose.ts`/`.test.ts`, `guard19-fuzzy-item-match.ts`/`.test.ts`,
and several `guard10`/`guard12`/`guard15` test files are untracked in the
working tree as of this entry — not part of any commit. The first two are the
files behind the second live incident above; none of these should be read as
shipped or done.

## 2026-09-09

Commit range `dc88de8..HEAD`, 37 commits, 76 files, +12.8k/-0.8k lines. The
single busiest day in this journal's history for `chat-sms`: the same class of
real-money defect (a customer's stated topping/removal getting applied to the
wrong pizza, or silently dropped, or double-charged) recurred and was
re-fixed at least four separate times today, each time by a different session
working the shared worktree concurrently. Read the actual diffs and queried
the live DB/edge-function registry directly rather than trusting any single
session's own "fixed and verified" claim — several of today's own commits
document a prior same-day fix that turned out to be wrong or incomplete.

### Security/correctness fix in `admin-chat` — COMMITTED, NOT DEPLOYED

Three separate fixes landed on `admin-chat/index.ts` today, all the same root
cause: `executeAction()` (menu edits proposed and confirmed via the owner
chat) never checked that a write actually succeeded, or — worse — never
re-checked that the confirmed payload's item/special ids still belonged to
the calling shop:
- `627d8a3` (18:22 ET) — `REMOVE_ITEM`/`SET_ITEM_FIELDS` reported success even
  when the underlying RPC touched zero rows (bad or cross-tenant id).
- `952fc67` (18:32 ET) — same phantom-success bug in
  `EIGHTYSIX_ITEM`/`RESTORE_ITEM`/`ADD_SPECIAL`/`END_SPECIAL`.
- `3f76dd1` (20:11 ET) — the more serious one: the confirm-time flow re-parses
  whatever proposal JSON the client echoes back and calls `executeAction()`
  directly, without re-running `validateProposal()`'s shop-ownership check.
  Live-verified against production (test fixture shops) that a tampered
  confirm payload naming another tenant's `menu_item_id` wrote a real
  cross-tenant `availability_overrides` row before this fix. Migration 129
  adds a DB-level `BEFORE INSERT/UPDATE` trigger backstop on
  `availability_overrides`/`specials` so this holds regardless of app code,
  role, or RLS bypass.

**Verified via `supabase functions list`: `admin-chat` is live at v35, last
updated 2026-09-09 17:48:05 UTC (13:48 ET) — before all three of today's
fixes.** The code fixing a real, live-demonstrated cross-tenant write is sitting
committed on `main`, not deployed. Migration 129's schema-level trigger is a
separate matter (see migrations section below) but the app-level re-validation
it depends on to fail *before* touching the DB is not yet live either.

### `chat-sms` — the money-bug day, in the order it happened

- **11:36 ET, v316** — negated-topping autofill (`852e4df`): "no extra
  cheese" still charged Extra Cheese because the compiled ask-plan resolver
  had no negation check at all (the legacy path already did). Also fixed a
  false-correction-claim bug (GUARD 1f) where the bot said "removed the extra
  cheese" on a cart that hadn't changed, twice, live.
- **13:19 ET, v320** — real cart-mutation for priced-modifier removal
  (`7bd3ed9`): teaching the model to actually remove a topping (not just stop
  lying about it) surfaced a **worse, previously-undocumented** defect along
  the way — "remove the extra cheese" against a single-item cart matched the
  cart line by name-stem overlap and deleted the *entire order*, not the
  topping. Fixed by intercepting option-level removal before the older
  whole-item removal path ever sees it.
- **14:29 ET, v321** — post-mutation money footer (`ff3fb8f`): the correct,
  itemized receipt from the fix above was then run through a second
  "strip stray LLM dollar amounts" pass whose regexes matched across
  newlines, deleting the itemizer's own Subtotal line and stranding the Total
  figure next to "Service fee". Fixed with a `moneyFooterAlreadyRendered` flag
  so a code-rendered receipt is never re-processed.
- **16:11–16:21 ET** — Zio's had two active menu rows both display-named
  "Double Burger" (one a stale pre-restructure duplicate with zero modifiers);
  deactivated the stale one directly in the DB (`860013d`), a data fix, not a
  code deploy. Extending the menu-readiness gate (`01f833b`) to Not Just
  Bagels for the first time found a real, still-open product bug: NJB has
  **zero `option_groups` rows anywhere in its menu**, so every slot selection
  (side, bread, meat) an ask-plan resolves is silently dropped from the
  itemized receipt/kitchen ticket — invisible today only because NJB's
  `compiled_ordering_engine_enabled` flag is off; a hard go-live blocker for
  NJB specifically, not fixed.
- **~20:20 ET** — the NJB two-clause description parser fix (already
  committed last night as `a351622`) had never actually been redeployed;
  `ec62484` redeploys `compile-menu` and recompiles NJB (155/170 → 166/170
  orderable), and in the process finds and fixes an unrelated
  boot-blocking bug it surfaced: two `const staleIds` declarations in the
  same function scope, which took `compile-menu` down with a 503 `BOOT_ERROR`
  for every shop for the few minutes between the (bad) redeploy and the fix.
- **~21:15 ET, v334** — fourth recurrence of the "pepperoni bleeds onto every
  pizza" bug (`1baa81d`): the specific trigger this time was a typo
  ("hawaai" instead of "hawaiian") that a prior session's fix hadn't tested.
  Same commit also fixes a customer-visible debug-string leak ("Choices for
  Dressing: ...") caused by an item-name-stripping step that happened to erase
  the word "house" from both the reply and the choice names it was checking
  against.
- **19:04 ET (`49a34d1`)** — rather than patch `matchChoiceByStems` a fourth
  time, removed it: modifiers now resolve **only** from the model's explicit
  per-call assertion or the compose module's own topping-choice mapping, never
  from scanning reply text for stem overlaps. "Missing beats wrong" — an
  unresolved modifier is left off rather than guessed onto the wrong line.
- **18:48 ET (`6c52cf2`)** and **~23:02 ET (`d9b8251`… final `v340`/`v341`)**
  — a same-item-different-modifier merge bug, in two independent code paths:
  Zio's compiled path silently no-op'd a second, differently-configured order
  of the same base item (doubling its price instead of adding a second line);
  Vito's legacy path rejected any modifier on an item with no configured
  modifier list as a hard error, causing the model to retry without the
  modifier and merge two orders into one. Both fixed; verified live on both
  shops.
- **Conversation lifetime**: first patched as a hardcoded 3h inactivity
  timeout (`3e9b33b`, deployed v336), then revised same night to the PM's
  final spec (`68ab695`) — 2 hours, configurable via new `app_config` row
  (migration 128, confirmed live: `conversation_timeout_hours = 2`), with the
  expiry check moved into the single function that reads "the active
  conversation" so a caller can't skip it. Also adds a per-conversation
  turn-lock (migration 127) against a double-text race — deployed, bounded
  (60s stale-lock detection, 15s poll wait), with a documented residual: a
  turn that legitimately runs past ~15s can still race, now at least logged
  instead of silent.
- **rank-2 architecture note**: `49a34d1`'s commit message states outright
  that three prior "fixes" to this same defect only ever constrained the
  buggy search function without removing it, and each failed on the next
  phrasing — worth remembering before accepting the next narrow patch to this
  area as done.

**Verified live**: `chat-sms` is deployed at **v341, 2026-09-09 23:05:09
UTC** — 23 seconds after `49a34d1` (the last commit that touches the
`chat-sms` function directory today) landed. Current with `HEAD`.

### Test suite

`4098a8e` fixes a false-positive in the cart-ops invariant checker (a
correct "remove the pizza, keep the garlic knots" cart mutation was
misclassified as a no-mutation defect because `isQuestion()` matched "can
you" before the explicit removal command) and a real gap where
conversational test cases never propagated `expectCartShrink`, silently
skipping the `correction_reflected` check for every conversational case. This
is local test-harness code (`scripts/test-suite/`, mirrored into
`supabase/functions/_shared/test-suite/`) — the mirrored copy only reaches
production once `test-runner`/`eval-sweep`/`generate-test-cases` are
redeployed. `supabase functions list` shows `test-runner` last deployed
2026-09-09 20:50:53 UTC, before this fix's 19:06 ET commit — **not yet live**
in the deployed test runner either, though this affects test scoring, not
customer orders.

### Migrations — verified against the live DB directly, not `supabase migration list`

`supabase migration list`/`db push` both fail against this project with a
password-auth error (consistent with this project's already-documented
CLI/tracker drift — see RUNBOOK). Queried the live schema directly via the
service-role REST key instead:
- **123** (`sms_provider` column on `shops`), **124** (`shop_settings`/
  `shop_voice`/`shop_notes` tables), **125** (`menu_items.is_derived`),
  **127** (`conversations.processing_claimed_at`), **128** (`app_config`
  row `conversation_timeout_hours = 2`) — all **confirmed live** by direct
  query.
- **126** (menu-override actor RPC wrappers) and **129** (availability/
  specials shop-match triggers) were **not independently re-queried** this
  session (no safe way to introspect trigger/function definitions over the
  REST API without a raw-SQL credential) — taking the authoring session's own
  live-verification claims for 129 at face value, flagged rather than
  confirmed.

### Deploy status summary (edge functions touched this range)

- `chat-sms`: **v341**, 2026-09-09 23:05:09 UTC — current with `HEAD`.
- `compile-menu`: **v14**, 2026-09-09 20:13:33 UTC — current with `HEAD`
  (includes the D1 derived-pizza-rows commit `24d7275` and the `staleIds`
  rename).
- `admin-chat`: **v35**, 2026-09-09 17:48:05 UTC — **stale**, predates all
  three of today's phantom-success/ownership fixes (see above). Committed,
  not deployed.
- `_shared` (test-suite mirror only, this range): reaches production only via
  `test-runner`/`eval-sweep`/`generate-test-cases`; `test-runner` is one
  deploy behind this range's fix (see Test suite section above).

### Also shipped today, not covered above (lower-stakes / already self-documenting)

`f2d907b`/`8532ca5` (items C1/C2: instruction-layer schema + a
`buildSystemPromptV2` prompt renderer sourced from `shop_settings`/
`shop_voice`/`shop_notes` instead of a hardcoded shared template) and
`e54ecd0` (item 9: wires real UPDATE/DELETE callers to migration 114's
previously-inert `menu_overrides` actor trigger via new `owner_update_menu_item`/
`owner_delete_menu_item` RPC wrappers) are both **committed and their
migrations are live**, but gated off in practice: no shop has
`shops.prompt_version` set (confirmed live, sampled `null` across shops), so
`buildSystemPromptV2` is a permanent no-op until a shop is explicitly flipped.
`5c19835`, `d10fafb`, `a9c03a1`, `c375903`, `db2abe0` are earlier-in-the-day
resolver/prompt/refactor commits whose effects are already folded into the
`chat-sms` v341 status above; see each commit's own message for specifics.

## 2026-09-10

Commit range `d811c24..HEAD` (this journal's last entry, `59c1808`, closed out
the previous day), 41 commits, 07:33–21:55 ET. Headline: a P0 payment bug
(paid orders silently vanishing) was found, fixed, and confirmed deployed.
The "pepperoni bleeds onto every pizza" defect family — documented in the
2026-09-09 entry as fixed by deleting the reactive stem-scanner — recurred
again tonight in a new shape, and unlike everything else in this range, it is
**not closed**: uncommitted verification run after tonight's deploy shows a
live, 100%-reproducing money leak on Vito's Flatbreads that the commits
landed tonight explicitly did not touch. Verified directly against
`supabase functions list`, three downloaded deployed function sources
(byte-diffed against local `HEAD`), a live `supabase migration list`, and
direct REST queries against the production DB — not taken on commit-message
faith.

### Fixed and deployed: paid orders silently vanishing (P0)

`d84f2c2` (08:24 ET). Root cause: `checkout.session.completed` found the
cart and tried to write `payment_status`/`stripe_payment_intent_id`, but the
same `UPDATE` also ran the order-number trigger, which recomputes
`MAX(order_number)` scoped to `payment_status='paid'` rows only, while the
actual unique index spans every row regardless of status. One shop had an
`EXPIRED` cart already sitting on `order_number=6`, so every paid order
landed on the same number, threw a unique-constraint violation, and rolled
back the payment fields with it — Stripe took the money, the order left zero
trace beyond raw function logs. Confirmed against Stripe's own event log for
the specific incident (`evt_1UE68qFPm1l8Fm1TMrBWVgoH`), not guessed.

Fix: `assign_order_number()` now advances past a collision against all rows
regardless of status (migration `132_order_number_collision_retry.sql`); a
handler failure now returns HTTP 500 instead of 200 so Stripe's own retry
schedule actually fires (a 2xx response is never retried, no matter the JSON
body — the previous comment claiming otherwise was wrong); the
`if (!cartId) return` silent-exit branch now logs loudly instead.

**Confirmed live**: migration 132 shows applied in `supabase migration list`
(Local/Remote both `132`). `stripe-webhook` is deployed at **v82**,
2026-09-10 12:20:13 UTC — downloaded and diffed against local `HEAD`, byte-
identical (the ALERT log lines and the `vigil 684b7165` fix comments are
present in the deployed source). Current with `HEAD`.

### Fixed and deployed: owner console could save a wrong business address (P0)

`c27c7c1` (16:14 ET). `google-places-lookup`'s `mode:"set"` called Places'
`searchText` with `"<shop name>, <address>"` — a relevance search, not a
geocoder — so a same-named business could outrank the address actually
typed, and the pre-existing "no match" guard could never fire because
`searchText` almost always returns something plausible. It also overwrote
`google_place_id`/`google_rating`/`google_review_count`/`business_status` in
addition to the address fields. Fix switches to the real Geocoding API
against the raw address only, narrows the write to
`formatted_address`/`latitude`/`longitude`, and adds a `confirm:true` gate
keyed on Google's `partial_match` flag, house-number survival, and
`location_type` precision. No ticket/incident ID is attached to this one —
the only evidence is the commit's own narrative (specific addresses, "~1.4mi
off"); verification is "live-verified against the deployed function" in
prose, not an automated regression test.

Companion commits: `020269d`/`e359a50`/`e000449` collapse the owner console's
address lookup+confirm into one live-on-Enter flow and gate the delivery
toggle (client- and server-side) on having a confirmed lat/lng and a radius
`> 0`. `020269d` also fixes a real gateway bug: `google-places-lookup` was
deployed with `verify_jwt=true`, so Supabase's platform gateway 401'd every
call before the function's own internal-secret check ever ran;
`supabase/config.toml` now sets `verify_jwt=false` for it. Admin dashboard
rebuilt twice (`ec3a676`, plus the address-confirm rebuild in `e000449`).

**Confirmed live**: `google-places-lookup` v38 (2026-09-10 20:10:37 UTC) and
`admin-chat` v47 (2026-09-10 20:46:28 UTC) both downloaded and diffed against
local `HEAD` — byte-identical (only cosmetic bundler-comment differences).
Current with `HEAD`.

### `shops` → `shop_settings` sync: real fix, but the migration tracker lies about it

`519e15f` (08:06 ET) found that `admin-chat`'s delivery/hours/pause setters
write `shops.*`, while `buildSystemPromptV2` (the prompt renderer live for
any shop with `prompt_version=1`) reads the equivalent facts off
`shop_settings.*` — nothing kept them in sync. Migration
`130_sync_shop_settings_delivery_hours.sql` adds an `AFTER UPDATE` trigger
plus a one-time backfill; `131_shop_settings_sync_delivery_radius.sql`
(added inside `020269d`) extends it to `delivery_radius_mi`. `b3c77d4`
(16:29 ET) closes the one column the trigger didn't yet cover —
`shop_settings.upsell_enabled` had no owner-facing writer at all since row
creation — via migration `133_upsell_enabled_single_source.sql`, plus a real
`SET_UPSELL_ENABLED` admin-chat op and console toggle (`70d6bea`, not just a
rebuild: real changes in `OwnerSettingsPanel.tsx`/`shopOps.ts`/
`ShopOwnerMenuSettings.tsx`).

`supabase migration list` shows migrations 130, 131, and 133 with a blank
**Remote** column — the CLI's tracker thinks none of them are applied to
production. **They are.** Queried live directly instead: `shops.upsell_enabled`
and `shop_settings.upsell_enabled` both exist and agree (`true`) across
sampled shops; `shop_settings.fulfilment_modes`/`hours_line`/
`delivery_radius_miles` are populated correctly per shop (e.g. Vito's shows
`["delivery","pickup"]`, radius `3.00`; Not Just Bagels shows `["pickup"]`,
radius `null`) — the trigger is live and correct. This is the same
migration-tracker/CLI drift documented on 2026-09-09; today's docs commits
(`dc58ae8`) say these were applied directly via the Management API rather
than `db push`, which is why the tracker never saw them. Migration 132
(the stripe-webhook fix, above) *is* tracked normally — the drift is not
universal, just inconsistent.

**One correction to today's own RUNBOOK entry**: it states `buildSystemPromptV2`
is "live for all three shops, `prompt_version=1`." Queried live: only **Zio's
Pizzeria** and **Vito's Pizza** have `prompt_version=1`; **Not Just Bagels**
is still `null`. Two of three, not three of three — RUNBOOK overstates this
by one shop.

### Recurrence, not closure: the pepperoni-bleed defect family, again

`a062fa5` (19:50 ET), `5528fbf` (18:45 ET), `b2e1ebf` (21:47 ET), `c2f8e3c`
(21:55 ET) are four more fixes in the same defect family the 2026-09-09
entry described as closed by deleting the reactive stem-scanner. They are
real, targeted fixes to real bugs:

- `a062fa5`: Zio's has a menu item literally named "Mac & Cheese Bites."
  `splitCustomerPhrases()` breaks one SMS into per-item phrases on `,`/`&`/
  "and" — ordering it alongside anything else tore that item's own name into
  extra phrases and shifted every phrase index after it, corrupting the
  scoping every other guard depends on. Fixed by masking menu-item names
  containing a trigger character before splitting.
- `5528fbf`: `matchAssertedChoice` returned only the *first* matching
  modifier per step, so "pepperoni and mushrooms" priced pepperoni and
  silently dropped mushrooms' $3.00 — a real undercharge, paired with a
  self-contradictory reply that claimed both were added. Now resolves all
  matching choices per step.
- `b2e1ebf`/`c2f8e3c`: GUARD 16 and GUARD 12 (the compiled and legacy
  modifier-claim checks that decide whether to flag an "unverified" request
  onto the kitchen ticket) both scanned the **whole turn's raw text** for a
  modifier name, so a topping named in one pizza's own phrase satisfied the
  check for every other item touched that turn — a phantom "unverified"
  flag on tickets for items that never asked for it. Both now scope the
  match to the cart line's own `sourcePhraseIndex`. Both commits explicitly
  state pricing/GUARD 2c is untouched by this fix — they only claim to fix
  the ticket-flag leak, not a money leak.

**What the commits do not say, found in uncommitted scratch files written
after tonight's deploy** (`scripts/tmp-guard16-verify-results-20260910.log`,
`scripts/tmp-guard12-verify-results-20260910.log`, both untracked, mtimes
22:03 and 22:22 ET — after the 21:55 ET `chat-sms` redeploy): a live replay
matrix (5 phrasings × 5 runs each) against the real deployed endpoint shows

- **GUARD 12 (Vito's Flatbreads — chicken bacon ranch / BBQ chicken with
  pepperoni / cheesesteak / margherita, one order)**: a real **money leak**
  — the $0.50 pepperoni topping charge landed on a flatbread other than the
  one that asked for it — in **25 of 25 runs**, every phrasing. This is not
  a regression from tonight's commits (they never touched pricing on this
  path) but it is a live, currently-reproducing, unfixed instance of the
  exact same bug class ("modifier bleeds onto the wrong line") that this
  journal has repeatedly described as closed. It is not yet in RUNBOOK,
  PO-BRIEF, or any tracked test.
- **GUARD 16 (Zio's pizzas)**: the kitchen-ticket leak this fix targeted
  still fired in **15 of 25 runs** post-fix — the `sourcePhraseIndex`
  fallback-to-whole-turn path is apparently still reachable often enough to
  matter.
- A **Vito's canary** (a fixed 4-pizza order with a known-correct total)
  failed: final total `849` cents against an expected `948`.

None of this is committed, and none of it is reflected in RUNBOOK/PO-BRIEF
yet — it is sitting in the working tree as scratch output. Treat tonight's
GUARD 12/16 fixes as a real narrowing of scope (ticket-flag leak, partially),
not as a closed defect, and do not read `e191af3`'s "zero walk failures"
(below) as covering this scenario — it is a different harness testing a
different thing.

### Menu-readiness gate: rewired off dead code

`a934f71` (19:30 ET) found the §8.3/§8.4 readiness gate (single- and
multi-item ordering walks, `docs/specs/2026-09-03-READINESS.md`) was built
against `resolver.ts` — code `chat-sms` does not call. Rewired onto
`phrase-split.ts`'s `splitCustomerPhrases`/`resolveClaimedPhraseIndex`, the
functions the live pipeline actually uses, and fixed the §8.4 runner to
actually pass `modelAssertedChoiceTexts` into `applyCompiledAddItem` (it
never had, so every modifier-bearing multi-item case failed structurally
regardless of the resolver.ts problem). The rewire itself is unit-tested
(`menu-readiness.test.ts` rewritten with concrete pass assertions).
`e191af3` (21:13 ET) reports a real live run against Zio's/Vito's/NJB via
`scripts/item5-menu-readiness-live-report.ts` — 20/20, 20/20, 5/5 multi-item
walks, no failures — but this is a docs commit reporting a run, not a
checked-in, re-runnable proof, and as noted above it is a different test
surface than the GUARD 12/16 money leak found later the same night.
`menu-readiness.ts` is consumed only by that local script, not by any
deployed edge function — its rewire has no deploy dependency.

### Fixed: cart-restore was silently corrupting carts

`90d0ded` (15:37 ET). The PROOF-P2 cart-restore path was the only cart
write site that called `JSON.stringify()` before handing an array to
supabase-js, double-encoding `cart_json` into a jsonb *string* instead of a
jsonb array. Later code spread it (`[...cart.cart_json]`), which iterated
the string character-by-character into fake single-character cart items,
all colliding on the same line-key. Fixed by passing the array directly.

### Also shipped and deployed today (chat-sms, lower-stakes)

- `b58c636`: a model-fabricated markdown ledger (`**Subtotal:** $0.99`) slipped
  past `stripLlmMoneyLines` because markdown stripping ran too late; now runs
  first.
- `707da59`: removed dollar figures from cart/order data in the system prompt
  entirely, rather than just instructing the model not to quote them.
- `9be3ca5`: the itemized recap no longer gets appended to the "what name for
  pickup" reply.
- `d605031`: `set_note`'s structured-option backfill now requires a stem
  unique to one unresolved cart item, not any shared stem (mis-attribution
  risk QA found between similarly-named items).
- `41d5165`: one added prompt-rule line — the model must call `add_item`
  immediately for a standalone Extras/Add-Ins row rather than asking a
  clarifying question first.

All five are in `chat-sms` v359 (2026-09-11 01:55:21 UTC, i.e. 21:55 ET — the
same minute as `c2f8e3c`), confirmed via the GUARD 12/16 fix comments present
in the downloaded deployed source. Current with `HEAD`.

### Test-suite fixes: real, local-only, not in the deployed test runner

`228f9f1` (fee-strip regex crossing a newline, false-failing a Vito's Bleu
Cheese case — `\s*/\s+` could eat past a line break; fixed to
`[ \t]*/[ \t]+`), `8855278` (`correction_reflected` now tolerates steady
turns after a cart shrink already landed, instead of requiring every
consecutive turn pair to strictly decrease), `61d369c` (cart-ops verifier
was still zeroing bundle price pre-`complete`, while chat-sms has quoted the
full bundle price since 2026-09-09 — verifier just hadn't caught up), and
`39631ba` (persists `debug_perf.toolCallCount` per turn — pure
instrumentation, no pass/fail logic touched) all land in
`supabase/functions/_shared/test-suite/`. `d565b5e` similarly fixes
`item5-menu-readiness-live-report.ts` calling `compileMenu()` with no items,
which meant `buildOwnerQuestionSummaries` never ran and every real blocking
`owner_questions` was invisible to the report.

None of this reaches production directly: `_shared` only ships via
`test-runner`/`eval-sweep`/`generate-test-cases`, and `supabase functions
list` shows `test-runner` last deployed 2026-09-09 20:50:53 UTC — before all
four of today's `_shared` fixes. This affects test scoring, not customer
orders, but the gap is now four fixes deep instead of one.

Also uncommitted and in progress: `scripts/test-suite/category-coverage.ts`
has a local, uncommitted fix (found live against Vito's, run `9bc5adab`) to
stop generating test cases against `price_cents=0` menu rows that are
modifier/finish choices, not orderable items (e.g. Vito's "Bleu Cheese" under
a pizza-finish category) — the bot correctly refuses to order these
standalone, which was tripping an invariant the generated case was never
entitled to assert. Not yet committed.

### Deploy status summary (edge functions touched this range)

- `chat-sms`: **v359**, 2026-09-11 01:55:21 UTC (21:55 ET) — current with
  `HEAD`, confirmed by downloading the deployed source.
- `stripe-webhook`: **v82**, 2026-09-10 12:20:13 UTC — current with `HEAD`,
  confirmed by downloading the deployed source.
- `admin-chat`: **v47**, 2026-09-10 20:46:28 UTC — current with `HEAD`,
  confirmed by downloading the deployed source.
- `google-places-lookup`: **v38**, 2026-09-10 20:10:37 UTC — current with
  `HEAD`, confirmed by downloading the deployed source.
- `test-runner`: still **v40**, 2026-09-09 20:50:53 UTC — stale, predates
  four `_shared/test-suite` fixes from today (see above).
- `compile-menu`/`eval-sweep`/`generate-test-cases`: not touched by any
  commit in this range.

### Migrations touched this range

- **132** (`order_number_collision_retry`): tracked and applied normally —
  `supabase migration list` shows it in both Local and Remote.
- **130** (`sync_shop_settings_delivery_hours`), **131**
  (`shop_settings_sync_delivery_radius`), **133**
  (`upsell_enabled_single_source`): `supabase migration list` shows these as
  Local-only (blank Remote column), but direct REST queries against
  production confirm all three are actually live — applied via the
  Management API, not `db push`, which is why the CLI's tracker doesn't see
  them. Verify by data, not by the tracker, for any migration touched this
  way.

## 2026-09-11

Commit range `c2f8e3c..a1b8979`, 35 commits, 2026-09-10 22:42 ET through
2026-09-11 21:24 ET. Continues directly from the previous entry (which
closed at `5503950`, 22:42). Headline: a standing rule was violated
somewhere off-commit tonight — Vito's, the designated legacy-only canary
shop, is now running the compiled ordering engine in production, not by any
commit in this range — and two P0 double-charge bugs specific to that
engine were found and fixed the same night. Verified directly against a
downloaded `chat-sms` bundle and live REST queries against production, not
taken on commit-message faith.

### Reality check: Vito's is on the compiled engine, contradicting the standing rule — unresolved

`RUNBOOK.md` (§"`shops.compiled_ordering_engine_enabled`... do not flip on
for Vito's") states Vito's "must never be set `true`." The PO spec written
today at ~15:00 ET (`docs/specs/2026-09-11-vitos-compile-then-reply-inversion.md`)
independently confirms the flag was `FALSE` at that time and explicitly
authorizes compiling Vito's menu *without* touching the flag ("V1 — COMPILE
VITO'S... Do NOT touch the flag"). A commit message at 16:57 ET (`7044d7f`)
already refers to "after flipping `compiled_ordering_engine_enabled`" as a
settled fact. Queried live just now: `shops.compiled_ordering_engine_enabled`
is **`true`** for Vito's Pizza. No commit in this range changes that column —
it lives in the database, not in git, and whoever/whatever flipped it left no
record here. This is a real, current conflict between the written rule and
production state, not a misreading of either document — **the code/data
wins, and it says Vito's is compiled.** Both of tonight's P0 money bugs
below are bugs in that exact compiled path. Flagging; not mine to resolve.

### Two P0 double-charge bugs on the compiled path, fixed and deployed

Both hit the same symptom live on Vito's: the same cart line, charged twice.

1. `8580903` (21:22) — `applyCompiledAddItem`'s "already in cart" check
   compared `option_group_id`/`option_choice_id` pairs, which are not stable
   across a menu recompile (Vito's menu was recompiled twice today per the
   PO spec above). A line resolved against an older compile's ids and the
   same real choice resolved fresh against the current compile's ids looked
   like two different choices and both got priced. Fixed by comparing
   display-name pairs ("Medium"/"Beef") instead of ids — what a receipt
   actually shows, stable across a recompile.
2. `a1b8979` (21:24) — the *actual* root cause of the live double-charge,
   found by re-running the exact repro end to end after `8580903` landed:
   resolving a pending disambiguation (GUARD 7's "which one did you mean"
   follow-up) calls `executeTool("add_item", ...)` with only 8 of its
   positional arguments, leaving `compiledEngineEnabled` and everything
   after it `undefined` — so this one call path silently fell through to
   the **legacy** add-item branch even on a compiled-engine shop, creating a
   raw line invisible to `applyCompiledAddItem`'s identity checks entirely.
   The model's own next tool call for the same item then went through the
   correct compiled path and added a second, real, fully-priced line.
   `8580903`'s fix was real (it closes a genuine recompile-identity gap) but
   did not by itself explain the live incident; this did.

**Deployed and content-verified**: `chat-sms` is **v390**
(`supabase functions list`, 2026-09-12 01:25:06 UTC / 21:25:06 ET — seven
seconds after `a1b8979`'s commit timestamp). Downloaded the live bundle and
confirmed both fixes' distinguishing code are present (`compiledEngineEnabled,
customerMessage, shopPhone` passed at the GUARD 7 resolution call site;
`display_name` used in the resolved-add confirmation path) — not inferred
from the deploy timestamp alone.

### GUARD 7 disambiguation: wrong name shown, and a way to get stuck forever — fixed (`ac79c06`, 21:22)

Live loop on Vito's: both Gyro candidates share the same raw menu name
("Gyro (Beef or Chicken)"), so GUARD 7's re-ask rendered that identical
ambiguous string back to the customer every turn regardless of their
answer. Now uses the compiler's own disambiguated `display_name` ("Gyro
Salad"/"Gyro Sandwich") everywhere the customer reads it. Separately: a
customer answering with real words the resolver doesn't parse (a category
word, an ordinal, or a price — nothing else) could get the same open
question forever with no way to complete the order. After 2 consecutive
unresolved turns, the bot now forces a numbered list so a bare "1"/"2"
resolves through the existing ordinal path.

### Vito's pepperoni/modifier price leak — closed tonight, after being flagged unclosed yesterday

Yesterday's entry left this open as "not closed... a live, 100%-reproducing
money leak." Closed tonight across five commits (`bf6023b`..`f9f3b2c`,
22:42–00:50 ET): `matchReactiveExtras` was matching toppings against the
raw, unscoped whole-turn message, so a word from *any* phrase — including a
word inside an item's own name ("Bacon" in "Chicken Bacon Ranch") — could
price a modifier onto every item resolved that turn. Fixed with
`scopedModifierText` (scopes matching to the item's own claimed phrase,
strips the item's own name first) and `suppressedReactiveMatchIds`
(per-item, not per-turn, suppression when two items' phrase attribution
genuinely collides). Verified live post-deploy: 20/20 PASS across natural
phrasings. One residual, by design not by gap: a fully unpunctuated
four-item dump can't be phrase-scoped, so the ambiguous topping goes to
`unverified_requests` (undercharge) rather than being guessed onto the
wrong line (overcharge) — "missing beats wrong."

A same-night revert is part of this arc: `f9f3b2c` (00:50 ET) additionally
moved every non-required option to `unverified_requests` whenever an item
was phrase-suppressed, and was reverted 13 hours later (`e95c0cb`, 13:48 ET)
because it regressed the ordinary two-item sentence ("a pepperoni pizza and
some fries") — flagging one item as ambiguous doesn't mean a *different*
item's own topping should be demoted too. Caught live before it did
lasting damage; the underlying leak-fix commits it was layered on top of
were not affected.

Separately, a duplicate-line overcharge with the same symptom but a
different cause was found and fixed the same morning: `ebc2a36` (06:23 ET) —
a modifier follow-up ("Can I get provolone on that?") was routed through
`add_item` with a hallucinated quantity of 3, and because the new
unverified-request set didn't match the existing line's (empty) set, the
strict merge check refused to merge and pushed a duplicate line instead.
Three docs commits (`767c181`, `eef11c0`, `235248a`) worked through
distinguishing this real bug from two *other* same-morning "critical
failures" that turned out to be scoring artifacts, not defects (a fee-strip
regex crossing a newline on a zero-price modifier row; a correctly-merged
qty-2 line misread as a duplicate) — worth noting because it shows the
`critical_failures` field is not self-evidently a defect list; each one was
reproduced live before being treated as real or dismissed.

### GUARD 2b: delivery orders ticketed as pickup — fixed twice, the second time for real

`66232fa` (14:29 ET) fixed the logic: GUARD 2b was reverting `order_type`
back to null after a customer said "Delivery" and then gave an address with
neither word in it, and the phantom-link recovery path defaulted that null
to pickup — so a delivery order shipped as a ticket telling the customer to
come collect it. Live incident: orders #11/#12 on the demo shop, today.

`b31f1b7` (16:57 ET) found why the first fix didn't fire: the query feeding
`guardAddressSetThisTurn` never selected the `delivery_address` column, so
the check was always false. This type-checks clean only because
`supabase functions deploy` does not type-check — `deno test --allow-all`
fails `TS2339` on the exact line. This is the second of three incidents
today traced to the same gap (deploy succeeding on code that doesn't even
compile); see `deploy-function.sh` below.

### GUARD 20: a topped pizza reverted to the plain regular — fixed (`6af0f47`, 13:57 ET)

A returning customer whose saved "regular" is a plain Cheese-Large ordered a
large pepperoni pizza plus fries; the pizza was silently dropped from the
cart and the regular re-offered instead. Cause: on the legacy path, the
topped pizza's line shares its name and `menu_item_id` with the plain
regular's base row, differing only in `options.Toppings`; GUARD 20 compared
by name only and misread the topped line as the model re-offering the
regular. Reproduced in a sandbox with a synthetic customer before fixing.

### CHAT_MODEL: flash → pro → flash today, for real reasons each time, not model-blaming

`22d2298` (13:38) set flash, `1050c54` (13:54) reverted to pro after a live
test looped on the greeting and double-added fries, `91ca67c` (15:20) put it
back to flash once the real causes turned out to be three unrelated defects
(`6af0f47`, `66232fa`, `8547d64` — all above/below, none about the model).
Final state, confirmed in both the secret and the code fallback: **flash**
(~$0.017/order vs ~$0.182/order on pro at ~10 LLM calls/order; the
OpenRouter balance was down to $84.38 at the time of the last switch).

### SMS confirmation and reply shape

`8547d64` (14:47) trimmed the paid-order confirmation below one SMS segment
(264 → 159 chars on a representative order) by dropping a subtotal/fee
reconciliation that's already disclosed on the payment-link message and the
Stripe page, and made the "give us 10-15 minutes" line follow `order_type`
instead of always saying pickup — a delivery customer was being told to
come collect. Margin is thin: 159 of 160 chars on a two-item order; a longer
item list could overflow again. `7044d7f` (16:57) stopped the compiled
path's canonical slot questions from enumerating every choice by default
(the enumerated form is now a fallback only, triggered when the customer's
answer doesn't match or they ask what the options are) after a canary
regression (quality 70%→40% legacy-vs-compiled, same 10 cases) traced to
this, and fixed a second reply stacking two questions in one message.

### Archetype/ask-plan fixes (menu compiler, not the chat runtime)

`49a4840` (15:54) and `387a567` (16:00) fix the `side`/`egg_side` slot
wiring in `supabase/functions/_shared/archetypes.ts` — a slot with no
name-pattern to bind by now wires a genuinely unclaimed real option group
(Vito's 9 pasta-side items) instead of asking a question the data already
answers, restricted to archetypes with exactly *one* such no-bind slot
(independent review caught `eggs` having two, which the first version of
the fix would have mis-wired). This code only runs inside `compile-menu`,
not `chat-sms` — `chat-sms` never imports `archetypes.ts` directly.
`compile-menu` is deployed at **v35**, 2026-09-11 21:19:54 UTC (17:19:54
ET), after both fix commits, so the deployed function has the fix. **Not
verified**: whether any shop's menu has actually been recompiled since that
deploy to pick up the corrected wiring — the fix being deployed and a
shop's live `ask_plan` data reflecting it are two different claims, and I
only checked the first one.

### Test-suite and tooling

- `d1a8070` (15:58) — `run.ts`'s flag parsing only matched `--flag value`
  (space form); `--cases=a,b,c` (equals form) silently matched nothing, so
  "filtered" runs ran the full unfiltered suite with no signal that the
  filter was ignored. Extracted to `cli-args.ts`, both forms now work, and
  an unrecognized flag is now a hard error instead of a silent no-op.
- `d18bb05` (16:57) — per-turn test timeout raised 30s→100s; real
  multi-item turns on the compiled engine were observed taking 90s+, so the
  old timeout was failing the harness, not catching real hangs.
- `f1d9219` (07:36) — migration `134_test_runs_provenance.sql` adds
  nullable `trigger_type`/`change_set_ref`/`initiated_by` columns to
  `test_runs`, enforced non-null at the app layer by `persist.ts`'s
  `assertValidProvenance`, because nine unlabeled overnight test runs left
  the product owner reconstructing intent from commit timestamps. **Applied
  to production** — confirmed directly: `select trigger_type,
  change_set_ref, initiated_by from test_runs limit 1` returns the three
  columns (all null on existing rows, as designed; nullable at the DB level
  only). **Not live in effect**: `test-runner` is still **v50**, last
  deployed 2026-09-09 20:50:53 UTC, which predates this migration, `f1d9219`,
  and four other `_shared/test-suite` fixes from yesterday's range — the
  enforcement in `persist.ts` cannot run until `test-runner` is redeployed.
- `2393dd5` (17:20) — new `scripts/deploy-function.sh` (type-check, unit
  test, deploy, confirm the version moved, confirm the deployed artifact's
  literals trace to the working tree — aborts loudly on any failure) and
  `scripts/check-switches.sh` (prints `compiled_ordering_engine_enabled` per
  real shop and the live vs local `CHAT_MODEL` default). Built in direct
  response to three same-day incidents where something shipped and either
  silently did nothing (`--cases` filter) or shipped broken (the GUARD 2b
  `TS2339` above) because nothing gated "committed" from "actually works in
  production." Neither script changes runtime behavior; both are local dev
  tooling, not deployed functions.
- `459a1d4` (06:54) — deleted `guard18-zero-grounding-item-invention.ts`
  (confirmed dead: never imported into `index.ts`), corrected a RUNBOOK line
  number for "Guard F" pointing at the wrong place in `index.ts`, and added
  the first dedicated test for Guard 3 (payment-integrity phantom-link
  backstop) — all 10 new tests pass against current behavior; no fix, just
  the first coverage on a previously-untested money-path guard.
- `e0e42b1` (05:02) — `docs/specs/2026-09-11-guard-retirement-audit.md`:
  inventoried all 36 guards in `index.ts` against test coverage and incident
  history. Finding: 22 keep, 12 need coverage first (several on the money
  path), 1 safe to retire (`guard18`, acted on same day above), 0 other
  retirements actionable yet.

### Docs

- `07d18fb` (21:22) — records a same-day incident (detailed in
  `docs/specs/2026-09-11-single-writer-po-role.md`) where two separate
  Claude sessions both assumed the "outside PO" role simultaneously for
  ~2 hours, issued a halt and an un-halt ~100 minutes apart, and each
  mutated production (secrets, deploys, a menu compile) without visibility
  into the other. Proposed fix (an incumbency check on the PO skill) is
  **not built** — spec only.
- `df00ef1` (15:05) — PO spec authorizing compiling Vito's menu without
  touching the compiled-engine flag, as phase 1 of a larger "code renders
  the reply" inversion. Recorded as given, not executed past phase 1's own
  V0 (a question, not an action). See the flag-state discrepancy noted at
  the top of this entry — the spec's own "do NOT touch the flag" bound
  didn't hold by day's end, whatever the cause.

### Deploy status summary (edge functions touched this range)

- `chat-sms`: **v390**, 2026-09-12 01:25:06 UTC — current with `HEAD`,
  content-verified against two of tonight's fixes (see above).
- `compile-menu`: **v35**, 2026-09-11 21:19:54 UTC — deployed after the
  archetype fixes land in git; not independently content-verified, and no
  check was done on whether any shop's menu was recompiled against it.
- `test-runner`: still **v50**, 2026-09-09 20:50:53 UTC — stale, now five
  fixes behind (`f1d9219` plus the four from yesterday's range).

### Migrations touched this range

- **134** (`test_runs_provenance`): shows blank in `supabase migration
  list`'s Remote column (same drift pattern as 130/131/133 in yesterday's
  entry), but confirmed **applied** directly — `test_runs.trigger_type`,
  `change_set_ref`, `initiated_by` all exist and are queryable in
  production.

## 2026-09-12

### Headline: defect class C4 fixed on paper three times; the real fix is not in production

"C4" (name coined and registered today, `docs/DEFECT-CLASSES.md`) is: the
model sees a confirmation-shaped word ("yes", "pickup", a bare name) anywhere
in a turn and independently decides to add/re-add a cart item — sometimes
from more than one code path in the same turn. Each individual tool call is
individually valid; the sum is wrong (three legitimate "accept" calls → three
pizzas; a $42 charge for one $21 pizza). No per-call validator catches this,
because there is nothing wrong with any single call in isolation.

Three attempts shipped today, on three different branches:

1. `2d6d55a1` (19:27, on branch `c1-c4-fix-20260912`) — patched four call
   sites (name-confirm→submit, checkout-completion, plain-name→submit) with a
   shared `hasNonConfirmationContent` check. **Reverted** by `65416f7c`
   (19:42). The revert commit itself gives no reason — it is a bare `git
   revert` with no body. The next attempt's message says the sweep "missed a
   fourth instance," which is the closest thing to a stated cause I could
   find in the repo.
2. `f471525a` (20:24, on the same branch) — cherry-picked attempt 1's fix,
   added the fourth site (GUARD 9 itself was deleting a legitimate French
   Fries add), plus an unrelated cart-line identity fix (C1). Its own commit
   message admits an adjacent bug ("yep but drop the pepperoni") surfaced
   during its acceptance run and was **not fixed**, filed as out-of-scope.
   **Reverted** by `59833e02` (20:51) — again a bare revert, no stated
   reason. **`main` currently sits at this revert** — as of right now, `main`
   has none of today's C4 mitigations; the underlying bug is unfixed there.
3. `b7bd0404` (22:18, branch `fix/turn-reconciler-20260912`, current HEAD)
   — abandoned per-call patching entirely. New file `turn-reconciler.ts`:
   one pure function, `reconcileAddProposals(preTurnCart, loopFinalCart,
   proposals[], customerText)`, that owns the add/merge/no-op/drop decision
   for a whole turn's proposals together, instead of four separate guards
   each reacting to one call at a time. Verified by direct diff inspection
   (not just the commit message): GUARD 9/13/20/21's `computeGuardN(...)`
   call sites and their imports are actually deleted from `index.ts`, not
   left alongside the new code. 22/22 new unit tests pass (reconfirmed
   directly, `deno test`).

**This is not deployed, and not merged.** The commit message for `b7bd0404`
says so itself: *"Do not merge or deploy until full acceptance matrix (8
cases + C4 + Vito canary + Proof suite) runs clean against a staging
deploy."* That acceptance matrix script
(`scripts/tmp-turn-reconciler-acceptance-matrix-20260912.ts`) exists but is
untracked (`git status` shows it as `??`) — there is no evidence it has been
run. Directly confirmed against the live deployed artifact: `chat-sms` is at
version 412, and the deployed bundle's `DEPLOY_SHA` stamp reads
`59833e02...` — the second revert. **Production chat-sms currently has none
of today's three C4 attempts in it; whatever GUARD 9/13/20/21 looked like
before today is what's live.** Running the full `chat-sms` test suite
against the `fix/turn-reconciler-20260912` branch (836 passed / 4 failed)
turned up one more concrete fact: the four failures are `guard9-*.test.ts`
and `guard13-*.test.ts` assertions that literally grep `index.ts` for the
GUARD 9/13 call sites the reconciler commit deleted — those two test files
were not updated or removed when the guards were retired, so the branch as
it stands has known-broken tests, separate from the acceptance-matrix gap
above.

### Returning-customer delivery memory (feature, partially live)

New capability: a customer who previously ordered delivery or pickup gets
offered "delivery again to [address]?" / "pickup again?" instead of being
asked cold, and a known customer gets a "putting this in for [name], right?"
confirmation at checkout instead of being asked their name again.

- `8cb73036` (12:24) built it first with the write happening only at
  **payment** time, inside `stripe-webhook`'s `upsertCustomerProfile`.
  `b1aa8b3a` (16:51) found that essentially no carts in practice reach
  `payment_status='paid'` before the conversation ends, so that writer was
  dead code for this feature's purpose, and added a second, dedicated writer
  (`upsertOrderFulfillmentMemory`) called from `submit_order` at
  **order-submission** time instead — deliberately not reusing
  `upsertCustomerProfile`, which also increments order-count/spend/favorites
  and must stay paid-order-only. `1a1f7780` (18:14) then race-proofed both
  writers against a delayed webhook clobbering a newer order's data, keying
  off the order's own `created_at` instead of wall-clock write time.
  `44b65abe` (14:13, chronologically first commit of this cluster) backfills
  the two new columns for existing customers from order history. Net: the
  submission-time write is the primary path today; the payment-time write is
  a secondary reconciler, and the two are now mutually race-safe.
- `90b7452f` (15:11) fixed the offer's trigger window: it originally only
  fired on the conversation's literal first message, so any customer who
  opened with "hi" before ordering never saw it. Now it fires on whichever
  turn `order_type` is still unset, one-shot per cart via a new persisted
  column.
- `0841b9be`, `11115a0f`, `082d9aff` (16:39–16:45) are three follow-on
  patches making the generic ORDER TYPE gate and the DELIVERY AVAILABLE gate
  stand down while this specific offer is active, so the two systems don't
  ask the same question two different ways in the same reply.
- `a4a5dcc4` (12:36) makes the pickup-downgrade case (offering delivery to a
  returning customer when delivery is currently off) state an honest reason
  ("we're not doing delivery right now") instead of a generic non-answer.
- **Migrations**: `135_customer_delivery_memory.sql`
  (`customers.last_order_type`, `customers.last_delivery_address`) and
  `136_order_carts_delivery_offer_made.sql`
  (`order_carts.delivery_offer_made_at`) are both **confirmed applied** to
  production — checked directly with a live `select` against both tables,
  both columns exist and are queryable (not inferred from `supabase
  migration list`, which is known to show blank/drifted status for recent
  migrations independent of whether they're actually applied).
- **Deploy status is mixed and matters here**: `chat-sms` v412 (live) has
  the submission-time writer (`b1aa8b3a`), the trigger-window fix, and the
  gate suppressions — that half of the feature is live. `stripe-webhook` is
  still **v92, deployed 2026-09-10**, before any of today's commits — the
  payment-time writer (`8cb73036`'s original code) and the race-safety fix
  (`1a1f7780`) are **not deployed**. Since the submission-time path is now
  the primary one, the feature mostly works despite this, but the secondary
  reconciler path does not exist in production yet.

### Other P0 money-path fixes today (deployed, in `chat-sms` v412)

- `43f34471` (17:01) — concrete bug: customer says "Yes delivery. But I
  wanted a pepperoni pizza." The ordering loop correctly adds the pizza, but
  GUARD 1d/1f compared the model's reply against `cartItems`, an array
  already mutated in place earlier in the same turn — so the guard always
  saw the post-add state and couldn't tell a real add from a no-op. It
  overwrote the correct "pepperoni pizza added" reply with "your cart is
  empty," the customer believed the order failed and re-sent it, and the
  charge doubled to $42 for one pizza. Fixed by comparing against the
  untouched pre-turn snapshot instead (the same snapshot GUARD 9 already
  used correctly).
- `d9569e46` (17:14) — GUARD 21, a new backstop: reverts cart growth on any
  turn where the customer's message names no item and states no quantity at
  all (narrower and more general than the specific bugs above).
- `1033e851` (17:37) — three bundled fixes: a deterministic path for
  accepting a previously-offered item with a modifier in the same message,
  collapsing the greeting to one question instead of two, and an honest
  "your cart is empty" fallback instead of a fabricated one.
- `70af6255` + `866a4e65` (19:04–19:12) — concrete bug (conv `d79c1d98`):
  once a Stripe payment link existed, "Show me the order" was
  structurally unanswerable — checkout-phase code replied with a canned
  "payment link was sent" message before ever reaching the cart-summary
  shortcut, which only ran in the `building` phase. A related bug: "Show me
  the order. Yes it's for me" (a compound message) got read by
  `impliesOrderConfirmation`'s bare substring match as just "yes," silently
  firing `submit_order` and sending a payment link while dropping the read
  request entirely. Fixed by running the cart-summary check first in every
  phase, and gating the auto-submit paths on a narrower "does this message
  actually just want to see the order" check. `866a4e65` adds a live
  acceptance script against the deployed function; no committed output file
  proves it was run and passed, only that the script exists.
- `1687b8e3` (15:33) — C1 sweep (identity judged by name instead of a stable
  id): audited ~10 places the ordering loop compares option-group names,
  found 6 real breakage sites where a compiler rename would silently corrupt
  the cart (pending-item merge, stuck disambiguation, dropped stored options
  on `modify_item`, among others), fixed by snapshotting name→id at
  add/modify time and falling back to that snapshot when a live name lookup
  misses. `modifiers_json` is flagged as still having no id field — known,
  unaddressed debt.
- `de4aed0e` (13:17) — the "state the exact question, don't let the model
  paraphrase" guard only stripped a paraphrase of the *choices*
  ("rare/well done"); a paraphrase of the *question itself* ("What temp
  would you like it cooked?" instead of the canonical wording) shipped
  untouched. Now stripped too.

### TODAY'S HOURS fix (deployed)

`67bfe10c` + `3ae09769` (14:13–14:19) — the system prompt handed the model
the shop's full seven-day hours string labeled generically "HOURS" and let
it pick out today's row itself; on at least one live case it picked a
weekday's closing time on a Saturday. Fixed by computing "TODAY'S HOURS"
deterministically in code and keeping the full week as a separate "THIS
WEEK'S HOURS" block for week-level questions. Test adds a fixed
Saturday-timestamp regression across all three real shops' live hours data.

### Deploy-gate tooling (three bugs, fixed same day)

- `3155aca0` (13:47) — the artifact-verification step compared quoted
  string literals between local source and the deployed (transpiled)
  bundle; a regex bug let `\n` into the "literal" character class, so
  reflowed code produced false "foreign string" hits that hard-failed two
  genuinely correct deploys. Downgraded to advisory pending a real fix.
- `7426344d` (16:52) — added a schema pre-check to `deploy-function.sh`:
  before deploying, query `information_schema.columns` for the exact
  (table, column) pairs the function depends on and abort if any is
  missing. Built because a migration failing to apply before a deploy had
  already happened three times this week, including today's
  `delivery_offer_made_at`.
- `74a8734f` (17:02) — that same pre-check was broken minutes after landing:
  it grepped the Management API's response for the literal string `"1"` to
  detect a present column, but the API returns bare unquoted JSON numbers
  (`[{"?column?":1}]`), so the grep never matched, every column check
  reported failure, and `set -e` killed the deploy on the first check. Fixed
  by checking for the literal `"[]"` empty-array response instead.
- `6febc702` (14:13) — replaces the whole advisory string-comparison
  approach with a real identity check: `deploy-function.sh` now prepends a
  `// DEPLOY_SHA: <full commit sha>` comment to a temp copy of the
  entrypoint (never the working-tree file), deploys from that copy, then
  downloads the live artifact and greps it for the exact stamp. Present =
  proof this exact commit is live; absent = hard fail. This is the
  mechanism this journal entry used above to confirm `chat-sms`'s deployed
  code is stamped `59833e02`, not `b7bd0404` — i.e., the mechanism is
  already load-bearing for this entry's own claims.

### `docs/DEFECT-CLASSES.md` — new standing document

`9ac9bd8c` (11:53) opened the register with three classes: **C1** (identity
judged by rendered text/name instead of a stable id — five instances found
in two days), **C2** (code shipped and reported done that was never actually
wired or switched on — e.g. a flag flip, a CLI flag, `resolver.ts` itself),
**C3** (trusting a broken measurement and reacting to the noise instead of
the product — the test-suite Quality score swinging 40→90% on identical
code from judge/harness bugs alone). **C4** (see headline above) was added
later in the day by `2d6d55a1` (19:27) and rewritten to its final,
aggregation-focused shape by `b7bd0404` (22:18) — the three commits
describe C4 differently as understanding of it evolved over the day; the
version in the file right now is the last one.

### json-parsing consolidation (not on the ordering path)

`9ed8272e` (18:14) — three separate hand-rolled JSON-from-LLM-output parsers
(chat-sms's judge rubric, `parse-menu-pdf`'s truncation recovery, and a
third inline copy) each had their own fence-stripping and brace-balancing
logic, so a bug fixed in one never got fixed in the other two. Consolidated
onto one shared `extractLlmJson` in `_shared/llm-json.ts`. Confirmed by
import graph: this file is used by the judge, `parse-menu-pdf`,
`extract-menu-items`, and `scrape-shop` — **not** by `chat-sms`,
`chat-sms-mtest`, or `stripe-webhook`, so this has no effect on the live
ordering conversation. `parse-menu-pdf` itself is still deployed at v114
(2026-09-05), so even the functions this refactor does touch haven't picked
it up yet.

### Smaller fixes and test-suite hardening (committed; deploy status varies)

- `dbb6290f`, `3203ca96`, `08eb807c`, `01fda3c5` — GUARD 7 backstop re-trip
  fix, `set-compiled-engine.sh`, and `resolver.ts` deletion. Already
  documented in RUNBOOK.md/HANDOFF.md from earlier today; not repeated here.
- `68258603` (12:52) — `stripe-webhook` type-check fix, `SupabaseClient`
  instead of `ReturnType<typeof createClient>` across ~19 sites, fixing 92
  `deno check` errors. No runtime behavior change. Not deployed (stripe-webhook
  is still v92, 2026-09-10).
- `2e7b0417` (12:50) — a hardcoded example in the MONEY/SCOPE prompt rules
  raced the newer "only ask a known customer's name if unknown" gate,
  producing both a name-ask and a name-confirm in one reply to a returning
  customer. The example is now qualified on the same gate.
- `79d16eb0` / `540b92bb` (13:17–13:20) — the RESET command's reply
  hardcoded "the kitchen is closed" regardless of actual hours, in both
  `chat-sms` and its near-duplicate test-harness function `chat-sms-mtest`.
  `chat-sms`'s fix is live (v412); `chat-sms-mtest`'s is not (still v39,
  2026-09-08).
- `0c3e350f`, `ee32d9e6` (13:20–13:26) — extracted the hours-window check
  and reset-reply text into pure, unit-tested functions; no behavior change.
- `76247921` (13:58) — exported `executeTool` for direct unit testing, plus
  two bundled live fixes: same-turn duplicate `modify_item` calls on one
  line now merge instead of overwrite, and a `prompt_for` required-slot
  answer is now recorded as a structured selection (so `submit_order`'s
  existing gate actually blocks on it) instead of only as free text that
  nothing checked.
- `bead3f54` (10:31) — Netlify's ignore-build script was implicitly
  triggering a full build on script-only commits (12+ wasted builds over two
  days); now special-cased to skip unless the one script Netlify actually
  invokes changed.
- Test-suite/harness hardening (morning, `_shared/test-suite/*`): judge now
  compares cart contents by `menu_item_id` instead of rendered text and
  knows platform facts like the $0.99 fee (`392ff041`); a self-negating-flag
  filter gained and then had to be narrowed twice in the same day
  (`e28647af`, `5df5dce1` — the second commit fixes a real regression the
  first one introduced, wrongly suppressing genuine "not correct" flags);
  ungraded critical cases no longer fail the go-live gate (`4776a667`);
  ground truth for checkout now reads real `order_carts` rows instead of
  assuming test runs never touch Stripe (`8e811ac8`); harness turn-cap
  truncation is now tracked as a distinct flag instead of being spliced into
  the transcript text the judge reads (`17389de1`), and that flag itself was
  refined same-day to distinguish a genuine stall from a run that made
  progress but ran out of turns (`30b7eea6`). Also: a contraction ("theyre")
  was misread by the hallucination guard as a claimed item name, and the bot
  said "Got it!" in response to a bare "checkout" that supplied no new
  information (`6a0ffbf5`, `b78e979a`).

### Deploy status summary (edge functions touched this range)

Checked directly against the live project (Management API + downloaded
deployed bundle), not inferred from commit history:

- **`chat-sms`**: v412, deployed 2026-09-12 20:51:38 UTC. `DEPLOY_SHA` stamp
  in the deployed bundle reads `59833e02...` — confirmed to be the second
  C4 revert commit, i.e. everything on `main` through that commit is live,
  and nothing after it (the turn-reconciler work) is.
- **`chat-sms-mtest`**: v39, deployed 2026-09-08 22:48:17 UTC — stale,
  predates all of today's changes to this function.
- **`parse-menu-pdf`**: v114, deployed 2026-09-05 18:21:18 UTC — stale,
  predates today's json-parsing consolidation.
- **`stripe-webhook`**: v92, deployed 2026-09-10 12:20:13 UTC — stale,
  predates today's type-check fix and the payment-time delivery-memory
  writer/race-fix.
- None of these four functions carry a `DEPLOY_SHA` stamp except
  `chat-sms` — the other three were last deployed before the stamping
  mechanism (`6febc702`) existed, or without using
  `scripts/deploy-function.sh`.

### Migrations touched this range

- **135** (`customer_delivery_memory`) and **136**
  (`order_carts_delivery_offer_made`) — both confirmed **applied** to
  production via direct `select` against `customers` and `order_carts`;
  both new columns exist and are queryable live.

## 2026-09-13

### Headline: the x16/$341.98 pizza bug — root cause was the menu item's own name

Early today (`832...` through `820a9b37`, 09:00–14:24) production produced
"Large Cheese Pizza x16" from ordinary turns like "yep, and two cokes" or
even a bare "yes" with no number in it — one live run hit $341.98 for a
single pizza order. Four fix/revert cycles chased this before the real
cause was found and confirmed by `820a9b37` (14:24): `reconcileAddProposals`
parsed a bare number out of `source_phrase`, a field the **model** supplies
and which is frequently just the resolved menu item's own name — and
Vito's pizza item is literally named `Cheese - Large (16")`. The "16" in
the item's own name was being read as a customer-stated quantity of
sixteen, which is why the bug always produced exactly 16 and why it fired
on turns containing no number at all. Fix: a `source_phrase` is now only
trusted for quantity parsing when it actually appears verbatim in the
customer's own message text, never when it's the bot's/model's own
phrasing. This fix is in `HEAD` and confirmed live (see deploy status
below). Two earlier attempts today (`1ee2b7bc` scoping quantity to the
adjacent item token, and an initial "restore single-writer work" pass,
`84ec6b66`) were real fixes for *other*, related bugs (a 15x quantity-merge
bug and a relative-delta double-count) but did not fix this one. The
`1ee2b7bc` attempt was caught by a 5-run repro matrix — it passed runs 1
and 2 clean, then reproduced Large Cheese Pizza x16 + Coke x2 ($341.98) on
run 3 — meaning the standard single-run smoke test used earlier in the day
would have shipped it. This defect has not yet been given a class letter
in `docs/DEFECT-CLASSES.md` (C1–C4 exist; this would be a candidate C5 but
no one has written it up there).

Separately, `820a9b37` and its neighbors reconfirmed that the single-cart-writer
invariant (all cart mutation routed through `writeCartLine`/`reconcileAddProposals`,
no direct array pushes) survived its own same-day revert-and-restore cycle:
`grep` against `index.ts` at `HEAD` finds zero direct `cart.items` array
mutations outside the reconciler, and `enforce-single-cart-writer.test.ts`
is present and passing in the tree.

### Checkout insulation — the name-ask stops being the checkout trigger (live)

Per Jason (`docs/specs/2026-09-13-checkout-insulation.md`, after order #14):
the bot's name-ask ("Putting this in for X?") was functioning as the de
facto checkout trigger — it fired the moment an item landed, skipping the
upsell and the "anything else, or ready to check out?" question. Fix
(`3e11b51b`, new file `checkout-intent-gate-20260913.ts`): a name-ask/name-confirm
reply — however it was produced, forced by a guard or written by the model
on its own initiative — is now blocked unless the customer has already
given **explicit checkout intent** for this cart this conversation
(`isExplicitCheckoutIntent`: an affirmative answer to "ready to check out?"
or an explicit phrase like "that's it" / "ready to check out" / "send me
the link"). That fact is now persisted per-cart (migration 139,
`checkout_intent_confirmed_at`) so a later turn can tell "intent was
established two turns ago" from "intent was never established."

The first merge of this (`f42c3d59`, 18:10) produced four live defects
within minutes of deploy, all fixed same-day in `759e6905` (18:45):
1. The original redirect replaced the **entire** reply with a flat "you've
   got N items" tally, silently deleting legitimate upsell/confirmation
   text riding in the same reply.
2. Same root cause as #1 — any upsell prose was lost alongside the name-ask
   sentence. Both fixed together: `stripPrematureNameAskSentence()` now
   removes only the offending sentence and keeps the rest, falling back to
   the flat tally only if nothing survives.
3. Vito's reuses one base menu row across toppings, so a truthful "your
   Pepperoni is in your cart" failed an exact-match check and was wrongly
   flagged as a hallucination on an ordinary decline. Fixed in `cart.ts`
   (`matchesStandaloneExtra`).
4. The worst of the four: "yes im ready to check out" matched neither the
   bare-affirmative path nor the whole-phrase path (it has both a leading
   "yes" and trailing text), so the customer's explicit intent was ignored
   and they got re-asked instead of checked out. Fixed with new
   lead-in/suffix regexes, gated so "yeah, I'm not ready to check out"
   (caught during verification) still correctly blocks.

**Stale reference, not fixed today:** migration 138's SQL comment cites
`docs/specs/2026-09-13-checkout-mode-insulation.md` — that file does not
exist. The real spec is `docs/specs/2026-09-13-checkout-insulation.md`; the
code and the real spec agree with each other, the migration comment is just
wrong.

### Reply inversion — cart facts now rendered from code, not model prose (live, spec bar not fully met)

Triggering incident (per `action-confirmation.ts`'s header comment): the
model narrated "I've got your items: [lists 3]" against a cart that
actually held 2 — and the money footer was still arithmetically correct
(it's code-rendered), so nothing caught the false item-count claim in the
prose above it. Fix, in two stages:

- **Stage 1** (`2d3b885b`, 19:33) — one site (`reply = loopResult.reply`)
  now goes through a new `action-confirmation.ts`: `detectCartMutation()`
  diffs the cart before/after a write and classifies what happened
  (added/removed/qty changed/option added or removed/corrected);
  `renderActionConfirmation()` renders the one permitted fact sentence
  **from that classification**, never from the model's own words.
- **Stage 2** (`f05f2723`, 20:02) — the same discipline extended to 8 more
  hand-built fact-list sites (disambiguation joins, option-add confirms,
  item-not-found fallbacks, correction lists) via new shared renderers
  (`candidate-list.ts`, `pending-disambiguation.ts`).

A cart-mutating turn's reply is also run through `extractQuestionsOnly()`,
which keeps only the model's interrogative sentences and further scrubs
any question that still smuggles in a cart fact (price-shaped text,
quantity-shaped text, or a known item name) — a false claim can hide
inside a question ("...large plain cheese pizza — confirm?") as easily as
a statement. A turn that doesn't mutate the cart is not scrubbed at all.

**Merged as "Melvin-verified" (`ed312900`) but the spec's own acceptance
bar was explicitly not met, by the commit's own admission, not by omission:**
`docs/specs/2026-09-13-reply-inversion.md` called for guard count to drop
below 32 and `reply=` call sites below 48, with GUARDs 1c/1d/1f/1g deleted
as unreachable once code renders the facts. `f05f2723`'s own message
states plainly that both stages proved by test that those guards remain
load-bearing on the untouched "voice" (no-mutation) path, and that the
`reply=` site count went **up**, 68→70, with guard count flat. This is a
disclosed shortfall in the commit message, not a hidden one, but the
spec's stated exit criteria were not achieved. Two more gaps are
disclosed in code comments, not just prose: colloquial item references
("the pep pizza") are not scrubbed — evaluated and deliberately rejected as
too risky to pattern-match — and menu items with names ≤5 characters are
excluded from the fact-scrub to avoid deleting harmless real questions
("a water with that?").

### GUARD 1d — missed the present-progressive phantom-add ("adding") (live)

Live P0 (conv `2ba731f7`, Vito's): the bot replied "Got it, adding a large
plain cheese pizza..." and quoted a total for a cart that never actually
changed — no `add_item` call happened. GUARD 1d's existing
`claimsAddedWithoutMutation` check exists exactly to catch this, but its
verb list only covered past tense ("added", "put", "threw", "tossed"),
missing the present-progressive the model actually used. Fixed
(`25f453b3`) by extending the verb list to "adding"/"i'm adding"/"i am
adding"/"throwing"/"tossing" (and a gated "i'm putting"), applied
identically to both `chat-sms/phantom-add-guard.ts` and its
`chat-sms-mtest` duplicate — confirmed byte-identical in the current tree
even though only the `chat-sms` copy is actually deployed (see below).

### Runtime error persistence — edge-function logs live 1 minute, this survives (live)

Supabase's own function logs age out after ~1 minute, so a runtime failure
was previously undiagnosable shortly after it happened. Migration 137 adds
an `error_log` table (service-role only, 7-day `pg_cron` retention) and
`_shared/error-log.ts`'s `logError()` is a fail-open, best-effort write
into it, wired into two call sites in `chat-sms/index.ts` (the tool loop
and the outer turn handler). Confirmed live by direct query: the table
exists, the `error-log-retention` cron job is scheduled, and both new
`order_carts` columns from migrations 138/139 exist. The table currently
has 0 rows — consistent with no runtime errors since deploy, not evidence
the write path is broken (it hasn't been called yet).

### Deploy status summary (edge functions touched this range)

Checked directly against the live project (Management API + downloaded
deployed bundle), not inferred from commit history:

- **`chat-sms`**: v432, deployed 2026-09-13 20:02:19 UTC — 14 seconds after
  the final merge commit (`ed312900`, 20:02:05 -0400/00:02:05 UTC) on
  `main`. The deployed bundle contains `renderActionConfirmation`,
  `detectCartMutation`, `extractQuestionsOnly` (reply inversion),
  `isExplicitCheckoutIntent`, `shouldRedirectNameAskToCheckoutGate`
  (checkout insulation), and the `source_phrase`-scoping fix — everything
  through `ed312900` is live. **Caveat: this deploy carries no `DEPLOY_SHA`
  stamp** (`grep` of the downloaded artifact for the string finds zero
  matches), meaning it did not go through `scripts/deploy-function.sh`'s
  stamping path — the version-number-plus-timestamp match above is strong
  circumstantial evidence, not the SHA-proof the deploy script exists to
  provide. Confirm via `deploy-function.sh` (or manually stamp and
  redeploy) before relying on this as proof for anything higher-stakes.
- **`chat-sms-mtest`**: v39, deployed 2026-09-08 22:48:17 UTC — stale,
  predates all of today's changes to this function (GUARD 1d fix, reply
  inversion, checkout insulation source changes are all committed, none
  deployed to this function).
- **`_shared`**: not a standalone deployable function — its changes
  (`error-log.ts`, `outbound-guard.ts`) ship bundled inside `chat-sms`
  (and, once redeployed, `chat-sms-mtest`); confirmed live only for
  `chat-sms`.

### Migrations touched this range

- **137** (`error_log`) — confirmed **applied**: table exists, RLS policy
  present, `error-log-retention` cron job scheduled.
- **138** (`order_carts.name_confirm_pending_total_cents`) and **139**
  (`order_carts.checkout_intent_confirmed_at`) — both confirmed **applied**:
  both columns exist on `order_carts` in production.

## 2026-09-14

### Headline: a full burn-down of the lettered defect list (B, C, C2, D, G, H), plus a reconciler bug the list didn't have a letter for

Today worked through the specific defects named in yesterday's/this
session's review (`ARCHITECTURE-REVIEW-BRIEF.md`), one commit-verified fix
at a time, each with its own live repro before and after. In order:

- **Item B** (`b1d709f2`) — "drop the pepperoni" never worked. Cause 1:
  `isRemovalRequested` required the customer's text to contain *every*
  significant word of the option's display name ("Pepperoni (Whole
  pizza)" needed "whole" and "pizza" too) — unsatisfiable, so removal
  silently no-op'd. Cause 2: the reconciler's apply-gate compared only
  `menu_item_id` + quantity, so an options-only correction (same item,
  same count, different toppings) was invisible and got discarded. Both
  fixed; retiring GUARD 1f earlier today (`f19cf0ab`) had removed the old
  "I couldn't do that" message that used to at least make cause 1 visible.
- **Item C** (`0c4c5837`, `72cd4676`) — the upsell offer ("Want a Coke with
  that?") is now rendered from code (`upsell-offer-20260914.ts`) instead of
  trusted from model prose, which `extractQuestionsOnly` was stripping on
  sight (correctly — a real offer names a price, which that filter treats
  as a money-safety violation). First pass only wired the same-turn add
  path; `72cd4676` found the offer was structurally missing whenever an
  item's required option (e.g. Cheese Burger's Temp) resolved on a *later*
  turn than the add itself — not flaky, 100% of the time for any item with
  a required slot.
- **Item C2** (`577ded72`, `7342fc3a`) — two delivery-flow races between a
  standing prompt rule (the driver-tip ask) and the same-turn code-rendered
  add fact: the tip question could displace the food-upsell offer, and a
  bare "no thanks" to an offer could land on a turn with no open question
  on record, falling through to raw model prose with no cart shown (~22%
  of runs before the second pass).
- **Item D** (`1accaa05`) — two remaining sites that could hand back a bare
  "You've got 3 items in your cart" instead of the itemized recap (the
  post-upsell-decline degrade path, and GUARD 23's stripped-reply
  fallback) now both render the same itemized recap as checkout.
- **Item G** (`49dfb1db`, `d36d298f`) — a cart-wipe: answering a required
  slot on a later turn ("medium") could fail to ground against the item
  it belonged to and get deleted as an "unauthorized" new line — the
  customer's whole order, gone. Fixed in two widening passes (pending-line
  match, then any pre-turn line sharing the `menu_item_id` in any option
  state) per the PO's rule that `dropped_unauthorized` may only ever apply
  to a line with zero prior existence. Same commit also narrowed the
  upsell-accept check: it had been reusing a broad "sounds like
  checkout-ready" detector, so "that's it" (finishing the order) was
  silently read as "yes, add the offered fries."
- **Item H** (`0a66af6f`) — two more shapes of the same two failure
  families: a `source_phrase` built by stitching customer words from
  *different* turns (the model defers the real `add_item` call by more
  than one turn) couldn't ground against any single-turn check and got
  dropped; and on any turn the tool loop didn't mutate the cart, reply
  inversion had no enforcement path at all, so raw model sentences like
  "Got it — a Cheese Burger added" could still reach the customer with no
  code check behind them. Fixed with a multi-turn grounding window and a
  code-level scrub (`stripFalseMutationClaims`) for the unmutated path.
- **Not on the lettered list**: `c23f0a4d` (13:21, earlier than any of the
  above) — a live canary (cheeseburger → medium → "that's it") produced an
  empty $0 cart. Root cause: the reconciler's pre-turn line index keys on
  full identity (item + options); a line still waiting on a required slot
  has partial options by definition, so the turn that fills the slot can
  never match its own pre-turn entry and fell into the
  "genuinely-new-and-unauthorized" branch — deleting the entire line, not
  overcharging it. This is the same *family* of bug as item G, found and
  fixed earlier in the day; G's later passes are further widenings of the
  same fallback this commit introduced.
- **Also**: `db6c32f6` (13:46) — an added line with options/modifiers now
  always itemizes ("Large Cheese Pizza, extra cheese +$4.50") instead of
  sometimes rendering bare, depending on which code path a turn happened
  to take.

Every fix above cites a live repro or canary run in its commit message,
not just a passing unit test — several (item G, item C2) were caught only
because a >1-run or DB-level check was used instead of a single smoke
test, continuing yesterday's lesson from the x16 pizza bug.

### Reply inversion, phase 2: prompt-level prevention, not just a post-hoc scrub

Three commits (`f19cf0ab`, `c996df0b`, `e1821f88`, all 07:55–08:00) move
reply inversion from "catch it after the model writes it" toward "the
model was never told it's allowed to write it":

- `c996df0b` adds an explicit ITEM/CART-CLAIM SCOPE rule to both
  system-prompt blocks: the model may never enumerate more than one cart
  item per sentence, assert cart contents, or narrate an add/remove/change
  — that's code's job. The existing post-generation scrub
  (`extractQuestionsOnly`) is untouched and stays as the backstop.
- `f19cf0ab` retires GUARD 1c/1d/1f/1g (~1,131 lines deleted across
  `phantom-add-guard.ts`, `guard1f-correction-claim-20260909.ts`, parts of
  `cart.ts`, and their test files) on the reasoning that once the prompt
  forbids the vocabulary these guards existed to catch, they have nothing
  left to catch. This is a bet on the prompt rule holding, not a proof —
  see the architecture-review brief's own caveat below.
- `e1821f88` adds a static source scanner
  (`reply-inversion-enforce-cart-fact-renderer.test.ts`) that greps every
  `reply =`/`reply +=` site in `index.ts` (43 of them) for hand-interpolated
  cart fields, so a *new* hand-authored cart claim fails CI rather than
  waiting to be caught live. One legitimate exemption is marked
  `cart-fact:blessed` (a disambiguation prompt that names a menu search
  target, not a cart claim).

**Caveat, in the architecture-review brief's own words, not mine**: reply
inversion "is a lint, not the invariant" — it constrains what the model's
*prose* is allowed to claim, but the underlying turn structure (dialogue
state reverse-engineered from prose by 26 guards, cart state written from
23 separate `saveCart` call sites) is unchanged. That diagnosis is what
today's later docs commits (below) build on.

### Test-suite own-bugs fixed (not product defects)

- `96235a43` (07:08) — `run.ts` crashed on a pre-first-item turn where
  `cart` is `undefined`; matched the guard `proof.ts` already had.
- `e083c549` (07:10) — Zio's menu categories were missing from
  `CATEGORY_ORDER_QUALIFIER`, producing false FAILs on that shop's
  category-coverage cases (all 16 category names re-verified against the
  live menu).
- `9a9a6395` (17:50) — the quality-test harness was asserting only on cart
  state, not the actual reply text, so a wrong-but-cart-correct reply
  could pass; `e07e5ed5` (18:41) then fixed the new reply-text assertion
  itself, which had only accepted one of two equally-correct ways to give
  a name.

### Oversight restructuring: a new operating model, documented but not yet acted on

Five docs-only commits (21:30–22:23) describe a new way of running this
project rather than a code change:

- `624f9660` — a self-contained architecture-review brief for a fresh
  reviewing thread, stating plainly that reply inversion is a lint and
  naming two structural causes (dialogue state not owned by code; cart
  state written from 23 sites) that the ten known defects trace back to.
- `f63c31ea` — a "turn-engine oversight" spec proposing a code-owned
  dialogue state machine (ANSWER/DECIDE/ASK/RENDER) as the real fix for
  the root cause above, plus corrections to stale facts in `PO-BRIEF.md`.
- `851f196a` — a playbook for running an autonomous coding agent ("the
  crew," on a separate machine referred to as "the Air"/OpenClaw) under a
  human-in-the-loop "product owner" role that writes specs and verifies,
  never writes production code itself.
- `82e5616e`, `6728198e` — two corrections to `PO-BRIEF.md`: the deployed
  model is `deepseek/deepseek-v4-flash`, not `-v4-pro` as previously
  documented (verified by matching the `CHAT_MODEL` secret's digest), and
  the OpenRouter account backing both prod and the test harness auto-tops-up,
  so balance is not something to flag or throttle for.

**None of this changed any code that ships in `chat-sms`.** The one
concrete artifact that *did* result — see below — is uncommitted.

### Uncommitted at end of day: Turn Engine Phase 1 (pure module, not wired in)

The working tree (not `HEAD`) contains a new, untracked
`supabase/functions/chat-sms/turn-engine.ts` (665 lines) implementing the
ANSWER/DECIDE/ASK/RENDER data structure proposed in `f63c31ea`'s spec, plus
a new `dialogue-signals.ts` (also untracked) extracting three predicates
(`isAskingForPickupName`, `impliesUpsellAcceptance`, `impliesUpsellDecline`)
out of `index.ts` so both modules can share them. `turn-engine.ts`'s own
header states it is "New Files Only" for this phase — deliberately not
wired into `index.ts` pending the PO's explicit go-ahead for phase 3. The
one live change is the extraction itself: `index.ts` (modified, uncommitted)
now imports the three predicates from `dialogue-signals.ts` instead of
defining them inline, a 44-line net reduction with no behavior change —
confirmed by `deno check` passing clean on the current working tree. None
of this is committed; it will not appear in `git log` until someone commits
it, and it is not part of the deploy discussed below.

Also present but untracked: five `scripts/tmp-*-20260914.ts` diagnostic/repro
scripts (item C2, item F, item H canaries and acceptance checks) — throwaway,
matching this repo's existing convention for same-day scratch repros.

### Deploy status (edge functions touched this range)

Checked directly against the live project (`supabase functions list` +
downloaded deployed bundle), not inferred from commit history:

- **`chat-sms`**: **v444**, updated 2026-09-15 01:27:05 UTC. The downloaded
  bundle's entrypoint carries `// DEPLOY_SHA: 0a66af6f334062f825447100143a087dc4a016c5`
  — the item H commit, the last code change of the day (all docs-only
  commits after it need no deploy). Confirmed both item H functions
  (`sourcePhraseGroundedInWindow`, `stripFalseMutationClaims`) are present
  in the deployed `turn-reconciler.ts`/`action-confirmation.ts`. Unlike
  some previous days, this deploy carries a proper `DEPLOY_SHA` stamp —
  it went through `scripts/deploy-function.sh`, not a bare
  `supabase functions deploy`. Everything through `0a66af6f` is live;
  nothing from today's uncommitted `turn-engine.ts` work is deployed or
  could be (it isn't wired into `index.ts` yet, and isn't committed).
- **`chat-sms-mtest`**: v39, deployed 2026-09-08 22:48:17 UTC — still
  stale, now nine days behind `chat-sms`. None of today's fixes (or any
  fix since 2026-09-08) are deployed to this function.
- **`_shared`**: not independently deployed; its changes ship bundled
  inside `chat-sms` only, per prior days' notes.

### Migrations touched this range

None. No new migration files in this commit range.

## 2026-09-15

### Headline: Turn Engine Phase 1 committed, Phase 2 (`propose.ts`) ships, gets bounced by the PO over lexicon correctness, and picks up two more live-tested fixes — one change in the whole range reaches production

Continuation of the previous entry's late-night session (commits run
22:45 EDT 09-14 through 02:43 EDT 09-15) rather than a fresh day's work;
grouped here as one entry since the session never really broke.

- **Turn Engine Phase 1 committed** (`cf6858f0`, 22:45 EDT) — corrects the
  previous entry's "Uncommitted at end of day: Turn Engine Phase 1" note:
  `turn-engine.ts` and `dialogue-signals.ts` were committed ten minutes
  after that entry's own docs-sync point (`a983c250`, 22:34 EDT), not left
  in the working tree. No behavior change; `index.ts` still has zero real
  imports of `turn-engine.ts`.
- **Turn Engine Phase 2: `propose.ts`** (`42850782`, 23:00 EDT) — the
  PROPOSE step (§3b step 3), the one place left that calls the model.
  NLU only: menu index, cart (with `line_keys`), the open question, and
  the last six turns in; a structured `Proposal` out (the type is
  imported from `turn-engine.ts`, not redeclared). One forced tool call
  (`submit_proposal`), no tool loop, one retry max. Every terminal
  failure writes an `error_log` row (`stage: propose_call`) with both
  attempts' raw bodies — required an additive migration
  (`140_error_log_propose_call_stage.sql`) widening `error_log.stage`'s
  CHECK constraint, applied directly via the Management API. Fully
  dependency-injected; `propose.test.ts` (17/17) runs under zero Deno
  permissions. Live acceptance at ship time: 20/20 OpenRouter calls
  schema-valid across a six-phrasing matrix — schema-valid only, not yet
  correctness-checked.
- **`docs(PO-BRIEF)` — the resolver.ts trap, current instance** (`fc57624e`,
  23:05 EDT) — the PO's own doc (not touched here; PO-BRIEF.md is that
  role's lane) flags that `turn-engine.ts`/`propose.ts` exist, are tested,
  and are not in the live path until Phase 3 adds a routing branch and a
  per-shop `turn_engine_enabled` flag — the same trap `resolver.ts` (item
  3, deleted 2026-09-12) sat in for days.
- **Phase 2 PO bounce, lexicon fix** (`22bb5733`, 23:10 EDT) — the live
  acceptance run above only checked schema-validity, not correctness: a
  follow-up PO run found 8 of 17 non-ambiguous calls resolved a plain
  "cheeseburger" to Bacon Cheeseburger ($10.99) instead of Cheese Burger
  ($8.49) — wrong item for money. Root cause: `buildLexicon` derived a
  one-word alias per item at runtime, only when unique across the menu;
  on Vito's real 221-item menu neither "burger" nor "cheeseburger" is
  unique, so both items got an empty derived lexicon and the model fell
  back to substring-matching the bare `name`. Fix, exactly as ruled:
  `buildLexicon`/`GENERIC_LEXICON_WORDS`/`normalizeMenuName` **deleted**,
  not improved. `propose.ts` now takes the compiled, human-reviewed
  `lexicon` DB table as an injected input (`ProposeTurnInput.lexicon`),
  same DI pattern as every other dependency. `propose.test.ts` 19/19.
  **Live re-acceptance against the real table (303 rows): 9/20 correct**
  — confirmed working exactly where the customer's wording matches an
  actual lexicon term ("two cheese burgers" → the lexicon's own "cheese
  burger" term, 3/3 correct), still wrong for bare one-word "cheeseburger"
  because only the two-word "cheese burger" term exists in the real
  table. The commit message calls this "a real lexicon data gap, not a
  code defect" — worth repeating here rather than letting "PO bounce
  fixed" read as "resolution problem solved." It isn't, yet.
- **Cart-widening fix** (`0ee960b9`, 02:05 EDT) — `choices` came back
  empty on 20/20 live propose calls for in-cart modifies: `MenuIndexEntry`
  carried no group/choice id vocabulary at all, so a `modify`/
  `remove_choices` on an item already in the cart had nothing valid to
  reference (fresh adds are unaffected — ASK/ANSWER recover the slot next
  turn at zero model cost). `buildCartIndex()` now widens each cart line
  with its real `group_id`/`choice_id` vocabulary from that line's own
  `ask_plan`/`option_groups`. Live 5-run test: 5/5 carried a real compiled
  `choice_id`, never invented or a display-name string — the vocabulary
  defect is closed. Known model flakiness left as-is per the PO's stop
  conditions: 3/5 runs expressed the change via `choices`, 2/5 via
  `remove_choices` only (still real ids, just a different strategy).
- **Stable `line_key` fix** (`f686df46`, 02:43 EDT) — `line_key` was
  derived from mutable content, so a multi-option-group line's key went
  stale the moment its second group was answered; a modify carrying the
  stale key was DECLINED for an item plainly in the cart. Exposure was
  multi-group items only (27 of Vito's orderable items) — that's exactly
  why Phase 1's 22 tests were green over a real defect: every fixture
  used a single-group item. Fixed with a stable, opaque `line_key` minted
  once per line via an injected `newLineKey?: () => string`, resolved
  everywhere through one `effectiveLineKey()` helper that falls back to
  the old derived identity for any pre-existing keyless line. Prospective
  only, no migration needed.

### Deploy status — one change in this whole range is live

Checked directly against the live project (`supabase functions list` +
downloaded bundle, project ref `rvdqfxtrskxekfkqnegx`), not inferred:

- **`chat-sms`: v445**, updated 2026-09-15 04:19:13 UTC. Downloaded
  artifact's `index.ts` carries
  `// DEPLOY_SHA: 3a5723a979e7fd956ebeaa18d43434035528f62c` — the item-E
  instrumentation commit, deployed 33 seconds after it landed. Item-E
  (`3a5723a9`) is the only commit in this whole range that touches
  `index.ts` (18 lines, no new guard/retry/reply site); it's the only one
  live. Everything else — Phase 1, Phase 2, the lexicon fix, cart-widening,
  stable `line_key` — is a pure-module addition that never touches
  `index.ts`, and postdates this deploy where it doesn't. The deployed
  bundle's `index.ts` still shows zero real imports of `turn-engine.ts` or
  `propose.ts` (the three grep hits are comments), confirming Phase 1 +
  Phase 2 remain unwired in production, not just in the working tree.
- **`chat-sms-mtest`**: unchanged, still v39 (2026-09-08).

### Also present, untracked (scratch, not part of any commit)

`scripts/tmp-cart-widening-live-20260915.ts`,
`scripts/tmp-cartwiden-live-20260915.ts`,
`scripts/tmp-propose-instrument-proof-20260915.ts`, and
`supabase/functions/chat-sms/turn-engine-stale-line-key.test.ts` — same
same-session-scratch convention as the `tmp-*-20260914.ts` files noted in
the previous entry.

### Migrations touched this range

One: `140_error_log_propose_call_stage.sql` (`42850782`) — additive-only,
widens `error_log.stage`'s CHECK constraint to also allow `propose_call`.
Applied directly via the Management API (same pattern as migration 133),
verified against `pg_constraint`.

### Continued, same day: item identity moves out of the model, Phase 3 wires the turn engine into `index.ts` behind a flag, and all three shops go live on it — a four-attempt money bug closes at 20:50

Same session, not a new day: 32 more commits landed between `fdbcddeb`
(04:12 EDT) and `0d259996` (20:50 EDT, current `HEAD`). By the end of it,
the turn engine most of this file has so far described as "committed,
tested, zero imports in `index.ts`" is deployed and gated **on** for
Vito's, Zio's, and Not Just Bagels — confirmed below directly against the
live project, not inferred from a commit message.

**Lexicon surface forms, finished** (`7b88b233` 04:58, `6794f6ce` 05:08) —
`compile-menu.ts` gained a second, generic surface-form pass:
space-collapse, plural-of-stated, plural-of-collapsed, and trailing
word-runs (head nouns), each gated by the same rule as before — a
candidate is kept only if exactly one item claims it across the shop's
whole lexicon, dropped for every claimant otherwise, no tiebreak. Both
commits are additive and unit-tested (11 new tests combined); `6794f6ce`'s
own message notes it's catching committed code up to a lexicon state that
had already been recompiled live and uncommitted.

**Item identity moves out of the model — the real architectural change
today** (`5eb66a4d`, 05:21) — measured on Vito's, even with a correct
lexicon, letting the model choose `menu_item_id` directly still billed the
wrong item on 10 of 20 live calls (full numbers in
`docs/specs/2026-09-15-code-owned-resolution.md`). New pure module
`resolve-item.ts`: deterministic longest-match of the customer's verbatim
`item_span` against the compiled lexicon, returning exactly `resolved`
(one target), `ambiguous` (two or more tie — never broken by a heuristic,
per Jason's direction that a clarifying question is the product, not a
fallback), or `unresolved`. `propose.ts`'s `Proposal.adds` now carries
`item_span` instead of a model-chosen id; `turn-engine.ts`'s DECIDE phase
resolves every add through this function before it can touch the cart.

**Phase 3 wiring — schema, routing branch, compliance, checkout**
(`f1e1dc8e` 05:42 through `462f3c96` 06:46) — in order:
- `f1e1dc8e` — migration 141, schema-only: `order_carts.dialogue_state`
  (jsonb) and `shops.turn_engine_enabled` (boolean, default `false`). No
  code reads or writes either column yet.
- `13e9733d` — **the actual switch.** New `turn-engine-runner.ts` (334
  lines) sequences ANSWER → PROPOSE → DECIDE → ASK → RENDER with every
  dependency injected. `index.ts` gets one `if (shop.turn_engine_enabled)`
  branch, verified directly in the diff, that calls it and returns early —
  `runOrderingLoop`, the reconciler, and all ~26 legacy guards are
  structurally skipped, not modified, whenever the flag is true. Dead in
  production at this commit since 141 defaults every shop to `false`.
- `d7f6c2fd` — the new branch had bypassed the 10DLC first-contact
  disclosure check the legacy path uses; one shared helper closes it, no
  duplicated compliance string.
- `462f3c96` — new `checkout-session.ts` (247 lines) becomes the one
  Stripe `checkout.sessions.create` call site in the whole function
  (verified: exactly one occurrence, non-test, in `chat-sms/`); the
  legacy `submit_order` case was refactored to call it too, not
  duplicated. The turn-engine branch mints a session only on the turn
  that newly reaches `link_sent`, re-checking the DB for an existing
  `stripe_checkout_session_id` to guard against double-submit.

**Two live incidents, found and fixed same day:**
- `b2440886` (09:23) / `954a3093` (09:47) — `loadItemLexicon`'s
  unbounded `.select()` was silently capped at 1000 rows by PostgREST.
  First commit pages via `.range()`; review of that same commit found the
  paging loop treated a real fetch error identically to a clean
  short-page finish, so a mid-page failure would hand back a truncated
  lexicon as if it were complete. Second commit makes a page error write
  an `error_log` row (`stage: "lexicon_load"`, migration 142) and fail
  the turn rather than proceed on partial data, and adds an independent
  `count`-vs-`loaded` cross-check that logs (but does not block on) a
  mismatch after a clean finish.
- `930fc1cf` (10:07) — `persistTurn` wrote `cart_json`/`dialogue_state`
  to `order_carts` but never `subtotal_cents`/`total_cents`, so an
  engine-path row underreported its own money until checkout touched it.
  Now computed from the same `pricing.ts` function the reply footer and
  Stripe checkout use.

**compile-menu: four blocking/collision defects, found by live audit
across all three shops:**
- `8da2227c` (10:30) — the surface-form gate used to drop a candidate
  term entirely the moment two items claimed it. Now keeps one row per
  claimant instead of dropping all of them — a straight reversal of the
  prior day's "ambiguous is noise" design.
- `a258f801` (14:38) / `fb412089` (14:56) — a derived item term
  (`pizza`, `bagel`, `rye`) was being suppressed menu-wide whenever it
  collided with a stated *category* or *choice* term, before the
  collision-keeper above ever got a turn. Counts from the live audit
  cited in the commit messages: category collisions cost Vito's nothing
  (its categories never collided) but choice-term collisions suppressed
  44 head nouns at Zio's, 16 at NJB, and 39 at Vito's — `bagel` was a
  dead end at a bagel shop. Fixed by narrowing the exclusion set to real
  item terms only; safe because ANSWER has structural priority over
  PROPOSE, so an open slot question can never be hijacked by a lexicon
  hit (a new `turn-engine-runner.test.ts` case proves this directly).
- `5639013c` (16:53) / `4fe70435` (17:18) — NJB had 12 menu items whose
  two required option groups both compiled to the placeholder
  `slot_key: "choice"`, so both questions rendered identically and a
  customer couldn't tell them apart. Fixed in two steps: use the
  parser's captured clause `label` first (closed 1 of 12), then its
  captured `anchor` (`choice_of` / `served_with`) as a second fallback
  before the literal `"choice"` (closed the remaining 11). 0 of 12
  survive.

**turn-engine: closure coverage and a slot-answer bug that masqueraded as
three separate defects** (`0ffd5373` 11:01, `2a852f9b` 11:20, `1d34a389`
12:02) — `0ffd5373` added a closure/affirmation check ("thats it", "no
thanks") ahead of PROPOSE for five of `answer()`'s six open-question
kinds, explicitly leaving `slot`/`disambiguation`/`upsell` uncovered.
`2a852f9b` fixed disambiguation's question text (it had been rendering
as an apology, not a question) and a last-one-wins bug when a message
named two ambiguous items at once, via a carry mechanism nested inside
`open.disambiguation`. `1d34a389`, same day, replaced that nested carry
with a top-level `pendingAmbiguous` queue once it was shown not to
survive a turn where a required slot (which always outranks
disambiguation) won the turn — and, in the same commit, found the real
cause of a three-turn conversation repeating its own slot question and
silently adding a phantom third item: a heuristic in
`applyCompiledModifyItem` meant to split a multi-quantity line when a
*later* slot differentiates one unit from another was also firing on a
slot's very first answer, splitting a quantity-2 line into one resolved
and one still-pending line of quantity 1 each — which is what made the
question appear to repeat forever. A new `suppressUnitSplit` flag, on
only for the slot-answer call site, closes it; closure coverage was then
extended to all six kinds. A 138-line acceptance test reproduces the
full "two cheeseburgers and a large fries" / "medium" / "thats it"
transcript across three turns.

**RENDER enumeration — tried, reverted, same day** (`784cc701` 16:27,
`8ada849e` 16:51) — a one-line change made the slot RENDER case list out
every choice in the question text, to fix two NJB slot questions that
otherwise read identically. Reverted 24 minutes later: this had already
been tried once before (2026-09-11) and reverted after measuring a live
quality regression on Vito's; the revert commit says so explicitly and
points at the real fix, which is the `slot_key` collision fixed above
(`5639013c`/`4fe70435`) — **the rendering change from `784cc701` is fully
undone, not partially kept**; only its test file survives, rewritten to
pin the short-form question as the current, intended behavior.

**pending-disambiguation: an ordinal match that wasn't anchored**
(`2d725b2d`, 15:25) — `matchOrdinalPosition` searched for a digit or
ordinal word anywhere in the customer's message, so `"10 pieces"` on a
14-candidate disambiguation list silently added candidate #10 to the
cart. Now requires the entire message (minus one optional leading
qualifier and trailing filler word) to be exactly a bare number or
ordinal. Live money bug, confirmed and closed.

**The ask-plan-engine sequence — one bug hunt across four commits, three
of which explicitly say they have not fixed it yet** (`61c2eeea` 18:49
through `0d259996` 20:50) — the target: on Zio's Boneless Wings, a bare
`"2"` answering the piece-count slot was, on 5 of 6 identical calls,
resolved by the model's own asserted `choice_id` to **"20 Pieces"**,
silently adding an unrequested $8.00. In order:
- `61c2eeea` — a negated slot choice ("*not* well done") could still
  stem-match; fixed by reusing the existing `isNegated` helper. Not the
  wings bug; an adjacent defect found while tracking it.
- `2ab6cf27` — adds a `requireTextualSupportForSlots` flag that skips the
  model-trust path for slots, wired to the one free-text `answer()` call
  site. The commit's own body states this does **not** close the wings
  bug: that bug lives in `decide()`'s structured add path, which always
  calls the resolver with an empty customer message and never reaches
  this flag at all.
- `83f18a27` — `significantStems()` drops tokens under 3 characters, so
  digit-only choices like "10 Pieces" and "20 Pieces" both reduced to
  the same stem set. Made numeric tokens significant, but only for the
  narrow set of option groups where two or more choices are otherwise
  indistinguishable by stem — measured at exactly 2 of 186 live groups,
  both Zio's wings. Again explicit in the commit body: a bare `"2"`
  still resolves to nothing before and after this fix, correctly — it
  narrows how often the model is asked to guess, but doesn't touch
  `decide()`'s unconditional trust once determinism gives up.
- `0d259996` — closes it. Reuses the same 2-of-186 collision predicate
  from `83f18a27` as an independent gate directly on
  `matchAssertedChoice`: for a collision-set group, a model-asserted
  choice is never trusted, full stop, regardless of call site or flag —
  even on `decide()`'s structured path with no customer text at all.
  Every other option group (Temp, Size, and the other 184) is untouched,
  so one-shot adds like "medium cheeseburger" keep resolving without a
  model round-trip becoming untrustworthy everywhere. The commit body
  narrates three earlier, wrong-scoped attempts and why each failed
  (gating the shared resolver broke 4 legitimate tests; the free-text
  flag never reached the structured path; narrowing which calls counted
  as "asserted" left the bare-digit case still trusting the guess).
  Proven live on Zio's: a bare `"2"` now re-asks, no $8.00 appears.

**Narrowing questions — Jason's direction, recorded as a spec, not yet
implemented** (`6207ecea`, 19:36) — `docs/specs/2026-09-15-narrowing-questions.md`:
an ambiguous item should be asked about by facet ("What kind?" then "What
size?"), never a numbered list, with the full list rendered only if the
customer explicitly asks for it. This is a docs-only commit — no code in
`ask()`/`resolveItem` implements it yet; the numbered-list behavior it
describes as "gone as a default" is still what the code does today.

**Process notes worth keeping**: `05e77201` and `8858b4a2` (docs-only,
`PO-BRIEF.md`) record that once Phase 3's routing branch landed, the
open question stopped being "is the module imported" and became "is the
flag on" — and that a paginated fetch that ends cleanly can still be
silently short, the third shape of "built but not working" this project
has hit this month. `7c75aa25` records a fifth standing lesson: a test
gate only proves what it actually drives a conversation through — the
single-turn matrix that called the engine "green" earlier today
structurally could not reach any of the three-turn defects above, and
its intended replacement, `convogate.py`, promises a dropped-item check
in its own docstring that was never implemented, so a run that silently
drops an item currently scores as a pass. `684f9b45` opens a new backlog
item (`docs/SCALING-BACKLOG.md`) for an onboarding-hardening agent to
anticipate this class of per-shop phrasing gap before a new shop goes
live, rather than finding it live the way today did three times.

### Deploy status and live flags — checked directly against the project tonight, not inferred

- **`chat-sms`: v453**, updated 2026-09-16 00:59:13 UTC (2026-09-15
  20:59 EDT). Downloaded the artifact directly (project ref
  `rvdqfxtrskxekfkqnegx`): `index.ts` carries
  `// DEPLOY_SHA: 0d259996da0d11ae1b8298002ffa0ffb79ca63c5` — the exact
  current `HEAD`. Everything described above, including the wings-bug
  close, is live.
- **`compile-menu`: v42**, updated 2026-09-15 21:49:37 UTC (17:49 EDT).
  Downloaded artifact's `index.ts` carries
  `// DEPLOY_SHA: 4fe704356e088e35ef7eeb01a1ac7affa9ab1c10` — the exact
  last commit that touches `compile-menu/index.ts` today. No gap: the
  later `ask-plan-engine`/`turn-engine` commits don't touch this file.
- **`shops.turn_engine_enabled` is `true` on all three real shops** —
  queried live via PostgREST (anon key, read-only): Vito's Pizza, Zio's
  Pizzeria, and Not Just Bagels. This is new since the 12:02 handoff in
  this file's history, which had Zio's and NJB still on the legacy
  engine; Not Just Bagels was switched on for the first time only after
  `0d259996` shipped, per the crew's own 19:30 handoff
  (`docs/PO-HANDOFF-2026-09-15-1930.md`).
- Full `chat-sms`/`_shared` Deno suite run locally at this `HEAD`: **1414
  passed, 0 failed, 7 ignored** — matches the count `0d259996`'s own
  commit message cites.

### Migrations touched in this continuation

- `141_dialogue_state_turn_engine_flag.sql` — additive: `order_carts.dialogue_state`
  (jsonb) and `shops.turn_engine_enabled` (boolean, default `false`).
  **Confirmed applied**: both columns are live-queryable via PostgREST
  against the production project.
- `142_error_log_lexicon_load_stage.sql` — additive, widens
  `error_log.stage`'s CHECK constraint to also allow `lexicon_load`,
  same pattern as migration 140. **Not independently re-verified this
  session** — I could not reach `pg_constraint` directly (no service-role
  credential available in this environment) and no `lexicon_load` row
  exists yet to confirm a live write succeeded. Code that depends on it
  is live (`chat-sms` is deployed at `HEAD`), but the constraint itself
  is unconfirmed rather than assumed.

### Open and unresolved as of `HEAD` — per the crew's own 19:30 handoff, not independently re-run tonight

- **Name / order-type retries — open, unexplained, on all three shops.**
  `"pickup"` alone does not advance the order-type question but
  `"pick up"` does; a bare first name does not advance but "First Last"
  does — even though the regex and name-detector both test `true` for
  the failing input when run directly against the source. Four hypotheses
  were checked and rejected today, including one confabulated function
  name. Friction only — no wrong charge, no cart mutation.
- `service_fee_cents` reads `0` on an engine-path cart row before
  checkout; `persistTurn` never writes that column (checkout does).
  Not a money bug, but a pre-checkout row currently contradicts its own
  `total_cents`.
- One-shot adds that combine an attribute and an item in one phrase
  ("medium cheeseburger") have never worked on the engine path: the
  model folds the attribute into `item_span`, `choices` comes back
  empty, and `decide()` passes an empty customer message so nothing can
  resolve the slot. Pre-existing, not caused by anything today.
- `"choice of cheese"` on NJB's Cheese Omelette Platter is silently
  dropped — it becomes neither a slot nor a modifier.
- `compile-menu` is not idempotent: three consecutive recompiles of
  unchanged NJB data produced three different vanish/move counts.
- `convogate.py`, the intended automated multi-turn gate, remains
  unusable: a static review found its promised "dropped item" check was
  never implemented and its subtotal check is one-sided. Do not gate on
  it.
- Zio's `pizza` ties 76 candidates — safe, but not a usable SMS question
  (product-design gap, not a bug). `"mild"` resolved a different number
  of slots across three identical Zio's runs — unexplained.
