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
