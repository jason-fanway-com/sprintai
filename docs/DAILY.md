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
