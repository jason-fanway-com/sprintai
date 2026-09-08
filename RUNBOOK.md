# SprintAI — Runbook

Last updated: 2026-09-04

This is the operational manual for the SprintAI ordering system. It is the
canonical source of truth for how the system deploys, runs, and recovers. If
anything here disagrees with the code, the code wins — and fix this document.

---


## Shipped 2026-09-05 (07:57 – 10:34)

Documented from `git log` and the code as it stands, not from the specs. Where a spec and
the code disagree the code wins, and that is called out.

### Public tester link — `getsprintai.com/test-kitchen` (LIVE, behind an off switch)

A login-free page anyone can open on a phone, order pretend pizza, and file feedback.
Built so Jason can text it to friends and family with no explanation attached.

- `test-kitchen.html` at the repo root, allowlisted in `scripts/build-public-site.sh`, served
  at `/test-kitchen` off the root origin (renamed from `try.html` 2026-09-05; `/try` is a
  permanent 301 to it). Plain HTML/JS, no build step, no framework.
- `./public` is BUILD OUTPUT: wiped and regenerated each deploy, gitignored, every file
  stamped `GENERATED FILE — DO NOT EDIT` and chmod a-w. Never edit it; edit the root file.
- It talks ONLY to the `public-tester` edge function, never to `chat-sms` directly. Two
  reasons, both load-bearing: `test_transcripts` REVOKEs `anon` so a public browser cannot
  write a transcript, and every guard rail has to be server-side or it is bypassed in
  thirty seconds.
- Guards, all enforced per request: kill switch, target-shop hard guard
  (`is_test = true AND phone_number_e164 IS NULL`, re-checked every call because the
  config row is editable), 20-turn cap, and three rate limits — 3/hr per browser session,
  5/hr per IP, 150/day global. IPs are stored only as a salted SHA-256; the function
  REFUSES to run if `PUBLIC_TESTER_SALT` is unset rather than hash them unsalted.
- The transcript is accumulated SERVER-side, turn by turn. `submit` ignores any
  `messages`/`model` in the request body. On a public endpoint a client-supplied
  transcript means anyone can write into the corpus and "verbatim" means "whatever the
  browser claimed".
- Checkout stays live — it is test mode and routes to `order-success-test.html`.

**Kill switch:** `app_config.public_tester_enabled` (a DB row, NOT an env var, so it flips
without a deploy).
```sql
update app_config set value = 'false'::jsonb where key = 'public_tester_enabled';
```
Target shop is `app_config.public_tester_shop_id`, currently **Vito's Pizza**
`e0000000-0000-0000-0000-000000000001`. (Was the QA twin until 2026-09-06; the
twin is retired — see *One shop per restaurant* below.)

**Measured cost** (real OpenRouter spend, deepseek/deepseek-v4-pro, 221-item menu):
3 turns $0.018 · 9 turns $0.082 · 16 turns $0.226. Cost is QUADRATIC in turns — the whole
~17k-token system prompt is re-sent every turn. The turn cap is the cost control; the rate
limits are the abuse control. 100 testers × 3 orders ≈ $30, ~$100 worst case at the cap.

Migration 096: `test_transcripts.tester_name`, source check widened to include
`public-tester`, `public_tester_sessions`, and a generic `app_config` key/value store.

### Human test capture — `test_transcripts` (1bff8d5)

Two buttons under the chat simulator in `ShopChatTest.tsx`, so both mount points (the
shop's Chat Admin tab and the owner's At a Glance) get them: **Copy transcript** (plain
text) and **Send for review** (one-line "what felt wrong?", optional, with Skip).
Migration 095 adds the table plus its `qa_ro` view. Append-only by design: no UPDATE and
no DELETE policy at all. No FK on `shop_id` — a transcript must outlive its shop, and
`shop_name` is denormalised for the same reason. Messages are `{role, text, at}` and are
stored verbatim, cart footers included; nothing summarises or reformats that column.
`chat-sms` now returns `model` on the web JSON response so the corpus records what actually
served the conversation.

### Demo Kit page (10be919)

Owner-facing page at `/demo-kit`, rendered from the shop record — QR codes, the order
message, the phone number. All derived, nothing stored.

### Expo Screen (c361d71, b2661fd)

Kitchen order board at `/admin/expo` and `/expo`. Four states per PAID order:
`new → acknowledged → preparing → done`. Rows carry `ticket_delivery_status`
(`delivered | bounced | complained | delivery_delayed`) from the Resend webhook, so a
bounced ticket is visible on the board rather than silently lost.

### Menu curation by confidence (2819738, edd5abe)

`extract-menu-items` now returns a `confidence` per row and persists it to
`menu_items.confidence_score`. Below 75 it also writes `flag_review` plus a `flag_reason`
that is a specific plain-English QUESTION for the owner ("Is the Chicken Parm $14.99 for
the sandwich or the dinner plate?"), not a generic warning. Surfaced in the admin Menu tab
as "We have questions".

### Item K — website menu reader (838b2f9, d34f7eb, afce671)

The website reader was importing ZERO menu for real restaurants and reporting success.
Fixed in three parts: PDF menus are discovered from homepage HTML and merged BEFORE the
top-N cut (they were being truncated away), candidate PDFs are routed to `parse-menu-pdf`,
and Firecrawl 429s get exponential backoff — an unpaced batch had been collapsing 18/20
sites into false "no readable text" partials.

Measured after the fix: **0/20 → 6/20 PASS, honesty 5% → 100%** (9c86b88). Read that
honestly: 6/20 is the real pass rate. The 100% is *honesty* — the reader no longer claims
success when it imported nothing. Menu intake remains the real blocker for new shops.

### chat-sms honesty fixes (97f2db5, a7e088c, 23ebe36, 18bc28a, 801a8b1)

A run of fixes all pointing the same way — the bot must not invent, and the guards must not
overwrite the bot:
- **SEV-1 phantom add** shipped uncaught: an $11.99 item was silently dropped from a cart.
- Guards were overwriting the model's own correct replies with flat cart recitals; they now
  fire only when the model produced nothing coherent.
- The bot was inventing menu options and shop policy it had no basis for.
- Reply punctuation was being mangled and dangling-dash totals shipped to diners.
- `CHAT_MODEL` now defaults to `deepseek/deepseek-v4-pro` (3e6055d).

### Owner-editable option data — migration 097 (partially reverted, read this)

Migration **097 is applied to production**: `owner_edited` on `option_groups` and
`option_choices`, plus the INSERT and DELETE RLS policies shop owners were missing.
Before it, an owner could not add a wing flavor at all — they had SELECT and UPDATE only.

`import-menu-csv` was changed to honour `owner_edited` on groups and choices so a
hand-added flavor survives a re-import. **That change is committed but NOT deployed** and
has not been through QA; do not deploy it to a real shop's menu until it has.

The admin-dashboard UI from that build was REVERTED off `main` (b192d65) — Jason redefined
the editor as owner-facing, living in the shop owner portal, not an admin tool. The work is
preserved on branch `shop-editor-admin-shape` for the owner-facing rebuild.

### Known defect found while documenting — hours fall-through (NOT fixed)

In `chat-sms`, if a day key is absent from `shops.open_hours`, `dayWindows()` returns `[]`
so `isOpen` is false — but the closed-message block has no branch for the unconfigured
case. `isClosedAllDay` is false and `todayHours.length > 0` is false, so it falls through
and **takes the order anyway**. The code comment claims it distinguishes three cases
(explicitly closed / outside windows / unconfigured) and only handles two.

Not currently reachable: all three real shops have all seven day keys. It becomes likely
the moment owners edit their own hours, because "we're closed Mondays so I'll leave Monday
out" is the natural thing to do. Fix belongs with the owner editor.

## Shipped 2026-09-05, continued (11:00 – 21:02)

Full narrative in `docs/DAILY.md`. Operational deltas only, here.

### Admin dashboard deploy mechanism — CORRECTED AGAIN 2026-09-06 (this one is verified, do not re-open without new evidence)

Two wrong claims have now been written in this slot. For the record, both:

1. "Broken since 8/22, blocked on a GitHub PAT missing `workflow` scope" — FALSE.
   The GitHub-Actions path was never the real deploy path at all, so a PAT
   scope on it blocks nothing that matters.
2. "Auto-deploys through Netlify's own git integration" (written earlier today,
   2026-09-06 morning) — ALSO FALSE. This was inferred from `total_count: 0`
   GitHub Actions workflow runs, which only proves Actions isn't involved — it
   does not prove Netlify's git integration is. Proof it's false: `429d450` and
   `7fcb2c2` sat on `origin/main` for ~17 minutes with **zero** new deploys on
   `sprintai-chat-admin` (Netlify deploys API showed nothing newer than
   2026-09-05T19:49Z) and **zero** GitHub commit-status entries from Netlify on
   either commit (`pending` with an empty `statuses` array — Netlify's GitHub
   App never even saw them).

**What's actually true, confirmed by inspecting a real deploy object:** every
recent `sprintai-chat-admin` production deploy has `"deploy_source": "api"`,
`"commit_ref": null`, `"commit_message": null`. These are CLI/API deploys —
someone runs `npm run build` locally in `admin-dashboard/`, syncs `dist/` into
`deploy-root/admin/`, and runs `netlify deploy --dir admin-dashboard/deploy-root
--site e757a50b-e321-400a-91e2-7854e2b0eca0 --prod` by hand. This is exactly
what the still-correct "Admin dashboard (manual deploy)" section below has said
the whole time — line 289 ("The admin site is **manual deploy**") was never
wrong; the two "corrected" write-ups above contradicted a line 150 lines below
them without anyone cross-checking.

**Push to `main` alone does NOT ship an admin change.** The manual deploy
command must be run after every admin-dashboard commit that needs to go live.

**This resolves the open question from the previous version of this entry:**
the Netlify UI build settings (`base: unset`, `cmd: npm run build`, `dir: dist`)
are vestigial / unused — `netlify deploy --dir` uploads a pre-built local
directory directly via the API and never invokes Netlify's own build step at
all, so those settings don't need to "point at" `admin-dashboard/` for
anything to work.

**Consequence for retired shops:** the `Layout.tsx` picker filter (`429d450`)
was committed and pushed but sat undeployed until this was caught. Manually
built and deployed 2026-09-06 (`sprintai-chat-admin` deploy
`6a9d7f0887f7ec980c10d03e`, bundle `index-rp-l95IS.js`); verified live via
`curl https://getsprintai.com/admin/dashboard` — served bundle matches and
contains `.eq("is_paused",!1)` on the `all-shops-for-preview` query.

**Lesson: "no GitHub Actions blocker" and "auto-deploys" are not the same
claim.** Checking one does not verify the other. Before writing "X is live" or
"X auto-deploys" in this file again, either watch a push produce a new deploy
with a matching `commit_ref`, or check `deploy_source` on an actual recent
deploy object — don't infer it from an adjacent absence.

### Public tester rate limits changed

Global daily cap raised 150 → 1000. Per-IP (5/hr) and per-browser (3/hr) limits were
**removed entirely** (f218d19) — the 20-turn cap and the daily global cap are now the
only abuse controls. Turn claiming goes through a new atomic RPC,
`public_tester_claim_turn` (migration 098), replacing a read-then-write race.

### chat-sms

Per the readiness log, deployed version is v226 (not independently reconfirmed via
`supabase functions list` in this pass). Two guard behaviors changed today: the
phantom-add guard is now clause-aware (splits on `;`, dashes, and leading
but/though/however/although, not just periods), and the delivery-availability check
now requires BOTH shop coordinates AND `delivery_radius_mi > 0` — previously
coordinates alone were enough to tell a customer delivery was available, with no
zone check ever run for a shop that had coordinates but no configured radius.

### import-menu-csv v38 — confirmed live via Supabase CLI

Owner-edited option GROUPS and CHOICES now survive a re-import (previously only
owner-edited ITEMS did, under v37 — the initial readiness-log claim that v37 had
*zero* owner-edit protection was wrong; see the correction logged in
`docs/specs/2026-09-03-READINESS.md` at 21:05). Deliberate, not a bug: an
owner-edited item that's `active=false` stays inactive even if the CSV re-adds it —
owner intent wins over the CSV.

### scrape-shop v73 / parse-menu-pdf v93 — confirmed live via Supabase CLI

Source-priority ladder is live: own website → owner-provided PDF/photo → Google
listing → aggregator (last resort), with provenance recorded per item (migration
102: `menus.source_detail`, `menu_items.source`/`source_ref`). Aggregator rung
measured 0/4 on sites with no usable direct-site menu — Slice returns items with no
options/sizes, Toast and ChowNow are JS-rendered and return nothing to a static
scrape.

**v73 (52f4caf, deployed 2026-09-06 03:32 UTC, confirmed via `supabase functions
list`)** fixed a defect the item-K remeasure2 run surfaced: `MENU_LLM_TIMEOUT_MS=170s`
was longer than the platform's ~150s function ceiling, so the two biggest menus in
that batch (sites 9 and 20) died to a gateway 504 mid-extraction. Site 9's 240 items
had already landed in the DB but the shop was stuck `crawl_status='running'` forever;
site 20 got nothing. Every bounded network call in the function (context summarize,
hours, menu extraction, PDF fetch/parse, each ladder rung) now goes through
`remainingBudgetMs()` — it gets `min(desired timeout, wall-clock budget remaining)`,
computed from a 150s measured ceiling minus a 10s jitter margin minus a 5s
final-write reserve, and is skipped outright once there's no useful time left rather
than fired and cut off mid-flight. Separately, a PDF-rung provenance bug is fixed:
`parse-menu-pdf` replaces the menu row wholesale on a PDF win, so the menu id
captured earlier in the request pointed at a deleted row and the
`source_detail`/`source` write was a silent no-op — the shop's id is now re-resolved
by `shop_id` immediately before that write. Not yet re-measured against the item-K
sample; see `docs/specs/2026-09-03-READINESS.md` item K for the open remeasure.

### Owner-facing Menu & Settings editor — `/menu-settings`

Live, backed by an extended `admin-chat` operations registry (includes
`ADD_ITEM`/`REMOVE_ITEM`) and migrations 097/101/104. See `docs/DAILY.md` for the
build → revert → rebuild sequence — the admin-only shape from the first attempt is
dead on `main`, preserved only on branch `shop-editor-admin-shape`.

### Judge panel — advisory, does not write back

`judge-transcript` edge function (migration 103) scores a submitted test
conversation; a read-only panel renders the critique under the chat simulator.
Every proposal is stored as `status: proposed` — there is no code path that applies
one automatically.

### Uncommitted in the working tree as of 2026-09-05 21:00 EDT

Not part of any commit, so not reflected above as shipped: `scripts/imsg-bridge.sh`
(default demo shop changed to Vito's Pizza, now env-overridable), `scripts/test-suite/run.ts`
(chat-function URL now overridable via `TEST_CHAT_FUNCTION_URL`), `vitos-demo.html`
(demo number changed to `+14842018054`), and a `deno.lock` refresh. Whoever picks
this up next should check `git status` before assuming the repo matches this
document.

## System overview

SprintAI replaces a restaurant's phone ordering: customers text a shop's number,
an LLM handles the conversation (menu, bundles, delivery, checkout), and the
order is charged via Stripe Connect. A web chat PWA exists as a secondary
channel. Shop owners manage menus and delivery via an AI-powered admin dashboard.

The stack is Supabase (Postgres + Edge Functions) + Netlify (hosting + proxy) +
Telnyx (SMS + 10DLC) + iMessage bridge (Mac). LLM calls go through OpenRouter.
Twilio is deprecated — see "SMS / Telnyx" below.

---

## Architecture & topology

```
Customer SMS → Telnyx → webhook → chat-sms edge function
                                      ↕
Customer web → PWA (shop-chat) → chat-sms edge function
                                      ↕
                              Supabase Postgres
                                      ↕
Shop owner → admin dashboard → admin-chat / admin-api edge functions
                                      ↕
                              Stripe Connect (direct charges)
```

### The public site and the admin dashboard are SEPARATE

| Surface | Netlify site | Hostname | Content |
|---------|-------------|----------|---------|
| Public + shop chat | `sprintai-dev` | `getsprintai.com` | Marketing pages, `public/chat/` (shop-chat PWA) |
| Admin dashboard | `sprintai-chat-admin` | `getsprintai.com/admin` | Login-gated admin SPA |
| Payment short links | `sprintai-dev` (alias) | `pay.getsprintai.com` | `/o/*` → 302 → Supabase `pay-redirect` → Stripe |

- The `sprintai-dev` site is git auto-deploy from `main` (build: `npm install && bash scripts/build-public-site.sh`, publish: `public/`).
- The admin site is **manual deploy** — see "Admin dashboard deploy" below.
- The `/admin` and `/admin/*` routes on `getsprintai.com` are Netlify proxy rewrites to `sprintai-chat-admin.netlify.app/admin` — the admin source NEVER reaches the root origin.
- The admin SPA uses `base: "/admin/"` (vite.config.ts) and `<BrowserRouter basename="/admin">` (src/main.tsx). The deploy-root `_redirects` serves `/admin/*` → `/admin/index.html` (SPA fallback; real asset files served first). Verified live 2026-08-19.

### Supabase project

| Key | Value |
|-----|-------|
| Project ID | `sprintai-chat` |
| Functions | `supabase/functions/` (Deno) |
| Migrations | `supabase/migrations/` (001–081) |

---

## Deployment

### Public site (auto-deploy)

Push to `main` on `jason-fanway-com/sprintai`. Netlify auto-builds and publishes
`./public`. Build command and publish dir are in `netlify.toml`.

The public site is an **explicit allowlist** — `build-public-site.sh` copies
only marketing pages (`index.html`, `contact.html`, etc.) and the shop-chat PWA
build (`shop-chat/dist/` → `public/chat/`). Nothing from `supabase/`,
`admin-dashboard/`, `_proof/`, or `specs/` reaches the public origin.

**To deploy the public site:** push to `main`. Done.

#### When a build is skipped by the ignore rule

A commit that touches ONLY paths that never reach the root origin
(`*.md`, `docs/`, `_proof/`, `admin-dashboard/`, `supabase/`, `*.htmltext`)
is skipped by `scripts/netlify-ignore-build.sh` (declared as
`ignore =` in `[build]`). The Netlify deploy log shows the ignore
command output — a skip prints `"only off-origin paths changed —
skipping build"` and lists the changed files. A build prints
`"<file> can affect the origin — building"`. No deploy notification
is sent for skipped builds.

**To force a build** for a commit that would normally be skipped:
- Include a file that IS on the origin (e.g. add a comment to
  `index.html`).
- Or trigger a manual deploy from Netlify's dashboard (Retry
  deploy → Clear cache and deploy — this clears `CACHED_COMMIT_REF`,
  which forces the script to build because it can't determine what
  changed).
- Or push to a branch and open a deploy preview (previews always
  build).

See `BUILD-NOTES-netlify-build-credits.md` for the full rationale
and the off-origin path list.

### Admin dashboard (manual deploy)

The admin dashboard serves both super-admins (global operator view) and shop
owners (tenant-scoped self-serve view). Shared pages (Conversations, Quality,
Production Readiness, Issues, Shop Chat, Financial Reporting, At a Glance)
self-scope via `useEffectiveTenant()` — super-admins see all, shop owners see
only their own. **At a Glance** is the owner's landing page: today's revenue,
Store Health ring (checkout completion × conversation quality × store readiness),
KPI row with prior-period deltas, revenue tiles across time ranges, top sellers
vs no-sales items, last 5 conversations — all tenant-scoped. It also embeds a
live test-chat sandbox (the `ShopChatTest` panel forced into test mode) so an
owner can fire practice orders with no real charge immediately.

```bash
cd admin-dashboard
npm run build
# Vite outputs to dist/ (base="/admin/")
# Sync dist into deploy-root/admin/ (the proxy route at getsprintai.com/admin)
rm -rf deploy-root/admin/assets && cp -r dist/. deploy-root/admin/
# Deploy to the SEPARATE site. NOTE: --site by NAME fails ("Not Found");
# use the site ID e757a50b-e321-400a-91e2-7854e2b0eca0.
netlify deploy --dir admin-dashboard/deploy-root --site e757a50b-e321-400a-91e2-7854e2b0eca0 --prod
```

After deploy, verify the FRONT DOOR (not the origin) serves the new JS hash:
`curl -s https://getsprintai.com/admin/ | grep -o 'assets/index-[^"]*\.js'`
should match the hash in `admin-dashboard/dist/index.html`.

The live SPA is at `getsprintai.com/admin`; Vite `base` and `<BrowserRouter
basename>` are BOTH `/admin/`. `deploy-root/_redirects` rewrites `/admin/*` →
`/admin/index.html` (SPA fallback; Netlify serves real asset files first).

### Supabase edge functions

```bash
# Deploy a single function:
supabase functions deploy <name>
# Deploy all:
supabase functions deploy
```

Functions that need `verify_jwt = false` have it in `supabase/config.toml`.
New functions: add the entry before deploying.

---

## Services & integrations

### Demo shops & phone numbers — AUTHORITATIVE (Jason, 2026-09-05)

Settled. Do not re-derive this from old notes, old QA shops, or old specs.

| Shop | id | Number | Carrier / path | Status |
|---|---|---|---|---|
| **Not Just Bagels** | `b0000000-…0001` | `+16103792553` | Twilio | REAL restaurant. 10DLC **approved**. Both demo *and* a sellable property — Erin has spoken to them and they are willing. **Never touch this number.** |
| **Vito's Pizza** | `e0000000-…0001` | `+14842018054` | **iMessage bridge** | The real pizza demo account. |
| _(parked)_ | — | `+16107358315` | Telnyx | **NOT 10DLC approved** — pending with Chris. Assigned to **no shop**. Cannot carry commercial SMS until approval lands. |

- `+14842018054` is a **physical iPhone Jason pays for**, plugged into power at
  his house, always on. It runs through the iMessage bridge, **not a carrier**.
  It will never appear in Telnyx or Twilio inventory — its absence there is
  expected, not a bug.
  - Bridge: `scripts/imsg-bridge.sh`, launchd job `com.sprintai.imsg-bridge`
    (`KeepAlive`, `ORDERING_NUMBER=+14842018054`), hardwired to
    `SHOP_ID=e0000000-…0001`. It POSTs `{shop_id, message, session_id}` straight
    to `chat-sms` and speaks the reply back over iMessage. It does **not**
    resolve the shop by `phone_number_e164`.
- The **Twilio sole-proprietor listing can only ever hold one number.** That is
  the entire reason Telnyx exists alongside it.
- **Once Telnyx 10DLC clears:** `+16107358315` becomes the pizza demo, replacing
  the iPhone. Then provision a **second** Telnyx number for NJB.

**Deleted 2026-09-05 as fabricated / QA artifacts** — do not recreate:
`Mario's Pizza` (`d0000000-…0001`, invented during testing) and six
Melvin-created QA shops (`Melvin QA Diner`, `Melvins QA Diner` ×2,
`Melvin Menu Proof`, `Melvin Ungated Refusal`, `Melvin Queue Test - DELETE ME`),
each with its tenant row.


### Payments — short branded links

Checkout links are shortened to `https://pay.getsprintai.com/o/<8-char-hex>`
before emission. The raw Stripe URL (~612 chars, 4-5 SMS segments) is archived
in `pay_links.stripe_url` as a fallback. The `pay-redirect` edge function
resolves the code to the Stripe URL and issues a 302. No public URL shorteners
are used — carriers block them.

### SMS / Telnyx (live) — Twilio deprecated

SprintAI sends and receives SMS through **Telnyx**, not Twilio. Twilio's
business-profile verification repeatedly rejected the LLC EIN (error 18602)
and is abandoned as a provider; the same EIN verifies cleanly through Telnyx.

- **10DLC registration: APPROVED** by all seven carriers (AT&T, T-Mobile,
  Verizon, US Cellular, Interop, ClearSky, Liberty). Brand `BJ8MUGY`
  (SprintAI LLC), campaign `CSMB9HG` / Telnyx `4b30019f-fc16-9471-9d17-5533e185444c`.
- **Provider switch:** `resolveSmsProvider()` in `chat-sms` returns `telnyx`
  when `TELNYX_API_KEY` is set, else `twilio` (kept for rollback).
  Reply-to-inbound always mirrors the provider the inbound arrived on.
- **Inbound:** Telnyx messaging-profile webhook POSTs JSON
  (`data.event_type` = `message.received`) → `chat-sms`. DLR events
  (`message.sent` / `message.finalized`) are acknowledged and ignored.
- **Outbound:** `POST https://api.telnyx.com/v2/messages` (Bearer
  `TELNYX_API_KEY`), `{from, to, text}`, wrapped in `guardedSend` — the
  outbound guard is never bypassed.
- **Opt-out:** Telnyx enforces STOP/block at the messaging-profile level. A
  blocked outbound send is classified by `_shared/telnyx-error.ts`, persisted
  as opt-out, logged, and the handler returns cleanly (no crash / retry loop).
- **One messaging profile per shop** is the intended architecture (STOP scoped
  per shop, not globally). All numbers attach to campaign `CSMB9HG`.
  **ISV/reseller re-registration is NOT needed** (confirmed by Chris, Telnyx SE,
  2026-08-28). Throughput is per-campaign (2K seg/day T-Mobile, 240 TPM AT&T),
  not pooled. The send gate is mapping status (both ADDED), not
  campaignStatus/operationStatus. Per-merchant CTA pages at
  `getsprintai.com/<slug>` CONFIRMED. Demo numbers: SprintAI brand + disclosure,
  no DBA needed. Mock brands/campaigns documented for free API testing.
  Build queue: manual first 1–2 shops, then automate provisioning + polling.
  **provision-number is now built on Telnyx** (rewritten 2026-08-29):
  searches available numbers via `national_destination_code` + sms+voice,
  orders the number, creates a per-shop messaging profile (webhook → chat-sms),
  assigns the number to the profile, and persists shop/telnyx columns.
  Number-to-campaign assignment is separate (requires TNSP approval).
- The iMessage bridge on the Mac also handles inbound SMS → `chat-sms` for the
  primary number (`+14842018054`).

Twilio numbers (`+16109366213`, `+16103792553` via Messaging Service
`MG76067b4fbbb54eb914c3087f559c2f8b`) are legacy. The existing
`provision-number` is rewritten to Telnyx (v2 API, 2026-08-29).
The old Twilio version is retired. See `docs/telnyx-integration-runbook.md` (wiring) and
`docs/10dlc-compliance-obligations.md` (binding behaviour — treat as law).
The required first-delivery test (8-step real-handset script, in
`sprintai-telnyx-provisioning-test.md`) is the go/no-go gate before the first
shop goes live — message delivery is ground truth for whether the 806
`failureReasons` flag is stale or live. Root-level
`sprintai-telnyx-integration-runbook.md` and `sprintai-10dlc-compliance-handoff.md`
duplicate the `docs/` copies; the `docs/` files are canonical.

### iMessage bridge

Location: `scripts/imsg-bridge.sh`  
Runs on the Mac via launchd: `~/Library/LaunchAgents/com.sprintai.imsg-bridge.plist`

The bridge polls Messages.app for incoming SMS destined for `+14842018054`,
forwards them to the `chat-sms` edge function, and sends the LLM reply back via
`imsg send`. It enforces a 15-minute message age freshness gate and tracks
processed message IDs to prevent replay. Poll interval is 8s
(`POLL_INTERVAL`, env-overridable — raised from 2s to cut Messages.app churn).

Logs: `/tmp/sprintai-imsg-bridge.log`
PID file: `/tmp/sprintai-imsg-bridge.pid`
Processed IDs: `~/.sprintai-bridge/processed-ids.txt`

### Test-run worker (onboarding QA)

**Scorer is FROZEN at `SCORER_VERSION = 3` (2026-09-02).**
Bumped 1 → 2 for specs 1 (proof grading coverage: capability dispatch, verifyStatedTotal can fail)
and 2 (single-grader). Bumped 2 → 3 for instruction-02: `proof_score` / `quality_score` split
(judge demoted to advisory), proof three-state (null = ungraded, not pass),
material-application detection, and `applied_invariants` reason-recording.
Do not change scoring logic (invariants, judge weighting, pass/fail
thresholds) without bumping the version and recording why here.

Location: `scripts/test-suite/worker.ts` (Deno), launched via
`scripts/test-suite/run-worker.sh` → launchd
`com.sprintai.test-run-worker.plist` (mirrors the imsg-bridge job).

Onboarding menu save enqueues a `test_run_queue` row (reason `onboarding`).
The worker polls for the oldest `pending` row, marks it `running`, runs the full
test-suite pipeline (generate → run → judge → scorecard → persist), and writes a
real `test_runs` row + `test_case_results`. The generated suite includes a
deterministic `hours-closed` critical case (driven by a `test_hours=closed`
param on chat-sms that forces the closed branch through `effectiveOpen` —
never honored on live keys) and a shop-aware CartOps battery built from the
shop's real menu items, not hardcoded references. Success → `done`; failure → `error`
(terminal — no poison-loop; manual requeue). Idle poll interval default 15s
(`WORKER_POLL_INTERVAL`). `run-worker.sh` sources `~/.openclaw/.secrets` first —
launchd does not inherit shell env, so the worker reads empty keys and error-
loops without it.

### Proof acceptance engine (deterministic go-live gate)

The Proof engine (`scripts/test-suite/proof.ts <shop_id>`) is a **parallel**,
**deterministic** acceptance path separate from the LLM-judged suite. It runs
a battery of real order conversations against a shop's own menu and grades
every case with code-based invariants only — **never an LLM judging an LLM.**
Cart state, totals, checkout finalization, and menu grounding are all verified
deterministically from `cart_json` and the database. Exit 0 iff 100% pass.

Proof is the pre-launch guarantee: an owner gets Proofed before go-live and the
report shows that every money-path case passed against their exact menu.

Scoring is split into two signals (spec2, SCORER_VERSION=3):
- **proof_score** (deterministic): invariants applied per case —
  `proofPassed` is three-state: true (materially passed), false (materially
  failed), null (ungraded — no invariants ran). `proof_pass_pct` is computed
  over graded cases only, and `proofUngraded > 0` is a hard gate (every case
  that can carry invariants must be graded).
- **quality_score** (advisory): LLM judge is demoted to advisory — it can
  flag issues but cannot fail a Proof-valid case.

Smoke mode: `max_cases` + `case_filter` on the queue row cap a run to a
deterministic subset (filter-first, then cap). The fix-gen path is off on
capped/smoke runs.

Reason-recording: every case result carries `applied_invariants[]` — the
names of the exact invariants that ran — so a case with `proofPassed=null`
is auditable (no invariants applied = deliberately ungraded, not a bug).

Key files: `proof.ts` (entrypoint), `cart-ops.ts` (Proof invariants P1/P2/P3,
claim-first hallucination guard, verifyCartPersistence), `runner.ts` (hardened
with 30s/turn timeout + 2 retries + backoff — never hangs the whole run).
An LLM fix script (`fix.ts`) auto-generates root-cause analysis for failures.
Spec: `docs/specs/2026-08-30-proof-acceptance-engine.md`.

`category-coverage.ts` (2026-09-06) is an 11-category realistic-order case
generator wired into Proof and the production test-runner identically, plus
two new deterministic invariants: `verifyRequiredOptionsCovered` (every
required option group on a cart line must have a non-empty selection before
checkout) and `expectedLineCount` (cart line count matches what was actually
ordered — no phantom additions). All four money-relevant invariants
(`verifyStatedTotal`, `verifyStopOptOutHonored`, `verifyCheckoutFinalize`,
`verifyRequiredOptionsCovered`) now report `passed:false` on a transcript-less
run — they used to report `passed:true`, because `proof.ts`'s aggregate only
ever read `.passed` and never `.applied`, so a harness failure that produced
no transcript was indistinguishable from a clean pass (a fail-open defect,
found before it shipped).

**Safety gate is channel-aware (`safety-gate.ts`, 2026-09-07).**
`enforceSafetyGate(shop, channel)` used to refuse to run against ANY
`protected` or phoned shop unconditionally — which meant Proof could never
gate a shop once it had gone live with a real phone number, exactly when a
go-live gate matters most. The gate now takes an explicit `channel: "web" |
"sms"`. `"web"` skips both checks: this test harness only ever POSTs JSON to
`chat-sms`, which hard-routes that to `channel="web"` and never calls Twilio
for it, so a web-channel run cannot reach a real diner's phone no matter what
`protected`/`phone_number_e164` say. `"sms"` keeps both checks completely
unchanged — any caller that can actually reach SMS must state so and gets the
full gate. No default value on the parameter, so a future caller must declare
its channel rather than silently inheriting "safe". Extracted to its own leaf
module (`scripts/test-suite/safety-gate.ts`, mirrored in
`supabase/functions/_shared/test-suite/`) with zero top-level side effects, so
`deno test` on the gate's own test file runs without a permission prompt.
Practical effect: Proof can now run its full battery, including the new
category-coverage cases, against Vito's Pizza itself (protected + real
phone) via this harness — not just against a phone-less QA twin.

### QA-twin creator

`scripts/create-qa-twin.py` clones any shop as an unprotected, phone-less,
is_test=true twin for Proof suite testing — same menu (imported via
import-menu-csv Edge Function), separate tenant, no risk to the real shop.
Idempotent: if the twin exists it reports status and exits 0.

```bash
python3 scripts/create-qa-twin.py <source_slug> <twin_slug> <twin_name> [menu_csv_path]
```

First use: Vito's Pizza QA twin (`vitos-pizza-qa`), 128 cases generated, all
passed safety-gate rejection.

### Payments (Stripe Connect)

Model: **Direct charges** on the restaurant's connected account. Sprint takes a
flat $0.99 application fee per order. The restaurant bears Stripe processing fees.

Connect paths:
- **Path A (Standard)**: Existing Stripe merchant connects via OAuth (`connect-oauth` edge function)
- **Path B (Express)**: New-to-Stripe restaurant gets embedded onboarding via `connect-create-express`

Pre-go-live gate: `isShopLive()` — requires `charges_enabled=true`,
`payouts_enabled=true`, `connect_status='enabled'`, `connected_account_id` set.

Edge functions involved: `create-checkout`, `stripe-webhook`, `refund-order`,
`connect-create-express`, `connect-oauth`, `go-live`.

Netlify also hosts `stripe-webhook.js` for B2B subscription checkout (tenant
billing, separate from order checkout).

### LLM (OpenRouter)

Model: `deepseek/deepseek-v4-flash` for chat-sms (configurable via env).
API key: `OPENROUTER_API_KEY` with `ANTHROPIC_API_KEY` fallback.

Models per function:
- `chat-sms`: `CHAT_MODEL` env (default flash)
- `admin-chat`: `CHAT_MODEL` env (same)
- `eval-sweep`: `JUDGE_MODEL` env (default flash)

### Segment economics

The business model assumes 8 SMS segments/order. Above ~8.8, the $0.99 service
fee doesn't cover SMS cost. Every prompt change is a cost decision. Segment
count is **auto-tracked on every QA suite run** (persist.ts computes
`bot_segments` + `reached_checkout` per case; the run summary prints mean
segments per checkout-completing order). For ad-hoc measurement against a live
shop:
```bash
deno run --allow-net --allow-env scripts/test-suite/segment-count.ts --live <shop_id>
```
See `BUILD-NOTES-payment-links-compliance-segments.md`.

### Quick test runner

```bash
deno run --allow-net --allow-env scripts/test-suite/quick.ts
```
Runs ~25 fast, deterministic cases (21 CartOps + 1 hours-closed + 3 menu-checkout)
against the deployed function on the live TEST shop. No LLM judge, no persist.
~2–4 min. Exits 1 if any critical case fails. Money amounts are parsed via
`findQuotedTotal` with connector-tolerant regex and largest-amount fallback to
avoid the $0.99 service fee misread.

### Netlify rewrites — payment short links

`pay.getsprintai.com` is a domain alias on site `sprintai-dev` with a DNS
CNAME `pay` → `sprintai-dev.netlify.app`. The `/o/*` rewrite (302, forced)
routes to `https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/pay-redirect/o/:splat`.
The `pay-redirect` function uses service-role key to read `pay_links` (anon key
cannot access it). The old GoDaddy Commerce Poynt CNAME was deleted.

### Ticket delivery — send-then-claim with bounded retry

Kitchen ticket emails use a **send-then-claim** pattern to eliminate silent
ticket loss: serialize on `ticket_send_attempt_at` (short-lived ~30s lock),
call Resend, and set `ticket_emailed_at` only after confirmed 2xx. Up to 3
retry attempts (~1.2s / ~3.5s backoff / ~2 min total); on exhaustion a
CRITICAL `ticket_send_failed` issue is written. NULL `email_ticket_recipient`
on a paid order writes a CRITICAL `ticket_no_destination` issue instead of
silently skipping. `ticket_send_log.attempt_number` (migration 080) records
per-attempt audit trace. Subject lines dedupe on `order_number`.

The `issue-detector` runs two sev-1 ticket delivery reliability rules:
- `ticket_send_failed`: scans `ticket_send_log` for non-2xx rows, creates one
  issue per failed cart (deduped by `detection_rule` + `conversation_id`).
- `ticket_missing`: finds paid+confirmed `order_carts` older than ~15 min with
  no `ticket_emailed_at` and no existing open ticket issue.

A ticket reliability test suite (19 tests) covers send-then-claim, retry,
NULL recipient, issue-detector rules, concurrency, dedup, and outbound-guard
integrity.

The Command Center's At a Glance now shows a "Tickets delivered today" tile in
heroVitals when there are paid orders today.

**Owner escalation (7-minute unacknowledged order).** A paid order whose
ticket was delivered but not acknowledged on the Expo Screen within 7 minutes
escalates once by SMS to `shops.owner_mobile` (migrations 092/093: the
`owner_escalated_at` column + partial index, and the `issue-detector-escalation`
pg_cron job, every 2 min — a dedicated job, not the 10-min `issue-detector`
sweep, because a 7-min timer on a 10-min cadence would fire 7–17 min late).
The clock falls back to `ticket_emailed_at` when `ticket_delivery_status` is
NULL (item H's Resend webhook registration is still pending on Jason). Sends
go through `outbound-guard`'s default-deny reason enum via a new gated
`owner_escalation` reason — never a bypass. Exactly-once is enforced by a DB
conditional UPDATE claim on `owner_escalated_at`, not by the `issues` table;
Melvin's independent QA drove 6 concurrent sweeps over 3 eligible carts and
got exactly one send per cart. The recipient is structurally the owner only —
the function never loads a diner phone column. Known non-blocking gap: the
function runs `verify_jwt=false`, so an unauthenticated POST triggers a real
sweep (not exploitable for spam — exactly-once is DB-enforced and the
recipient is owner-only — but should be closed with the vault bearer
`issue_detector_bearer` used elsewhere).

### Scheduled jobs

| Function | Schedule | Purpose |
|----------|----------|---------|
| `eval-sweep` | Every 5 min (cron) | Judge completed conversations; write eval scores |
| `issue-detector` | Every 10 min (pg_cron, 047/048) | Detect quality issues from evals + ticket delivery failures; write to issues table; set notified_at on source evals |
| `issue-detector-escalation` | Every 2 min (pg_cron, 093, jobid 80) | Escalate paid+unacknowledged orders to `owner_mobile` by SMS after 7 min |
| `test-runner` | Every 60s (pg_cron, 070) | Autonomous per-shop acceptance suite: drain `test_run_queue`, run Proof/CartOps battery, checkpoint per-case, incremental scoring |
| `campaign-status-reader` | Deployed, **not yet scheduled** — migration 083 unapplied | Poll Telnyx mapping status; advance campaign_assignment_status submitted→approved when both mappings ADDED |
| `daily-reset` | Daily | Clear expired specials, delivery pauses; audit log |

**NOTIFIED_AT contract:** `eval-sweep` DMs flagged evals but does NOT set
`notified_at`. The `issue-detector` is the single actioner — it creates a tracked
issue row, then sets `notified_at`. This ensures zero flagged evals marked
notified without a corresponding issue.

---

## Edge function index

### Customer-facing (live order path)
| Function | Purpose | JWT |
|----------|---------|-----|
| `chat-sms` | Core ordering state machine (SMS + web chat) | No |
| `create-checkout` | Stripe Checkout Session (direct charge) | No |
| `pay-redirect` | Look up `pay_links` short code and 302 to Stripe | No |

### Admin / shop owner
| Function | Purpose | JWT |
|----------|---------|-----|
| `admin-api` | REST API for admin dashboard (CRUD) | Yes |
| `admin-chat` | Conversational AI admin (menu mgmt, delivery) | Yes |
| `onboarding-save` | Wizard step persistence (create shop, save step) | No |
| `go-live` | All-or-nothing go-live gate check (13 gates) | No |
| `merchant-auth` | Server-side PIN auth for sold-out manager | No |
| `set-app-metadata` | Set user roles in app_metadata (service-key only) | No |
| `shop-financials` | Shop financial reporting (KPIs, ledger, payouts, CSV export) | Yes |

#### Go-live gates (13 — all must pass)

| Gate | Check |
|------|-------|
| connect | `isShopLive()` true (charges+payouts enabled) |
| delivery_geo | Coordinates set when delivery_enabled |
| menu | ≥1 active item on confirmed csv/pdf menu |
| menu_approved | Owner attestation (§C) on current menu hash |
| menu_clean | No flagged-awaiting-review menu_items |
| number | `phone_number_e164` set |
| hours | ≥1 day configured in `open_hours` |
| subscription | `subscription_status = "active"` (written ONLY by stripe-webhook; client writes blocked via onboarding-save allowlist) |
| ein | Required for non-test shops |
| proof | 100% proof_pass_pct via QA twin (scorer_version=3, current menu) |
| delivery_test | `first_delivery_test_passed_at` set (is_test skips) |
| ticket_destination | `email_ticket_recipient` non-null, valid email syntax |
| campaign_assignment | `campaign_assignment_status = "approved"` (is_test exempt; migration 081) |

### Payments
| Function | Purpose | JWT |
|----------|---------|-----|
| `create-subscription` | Create Stripe Checkout session for $99/mo subscription (mode:subscription) | No |
| `stripe-webhook` | Stripe billing events → subscription lifecycle + tenant billing | No |
| `refund-order` | Refund order with fee logic | No |
| `connect-create-express` | Create Express connected account + onboarding session | No |
| `connect-oauth` | OAuth for existing Standard accounts | No |

### Onboarding & training
| Function | Purpose | JWT |
|----------|---------|-----|
| `onboard-tenant` | Scrape website, chunk, embed → knowledge base | No |
| `train-tenant` | Text paste / document upload → embed | No |
| `scrape-shop` | Firecrawl + Claude summary → shop_context + structured hours/menu | No |
| `extract-menu-items` | LLM menu-item extraction (async after scrape-shop) | No |
| `google-places-lookup` | Google Places enrichment — authoritative address/hours/rating/coords | No |
| `generate-test-cases` | Generate + enqueue onboarding test run (test_run_queue) | No |
| `import-menu-csv` | CSV menu importer (idempotent, diff-based) | No |
| `parse-menu-pdf` | PDF/photo menu intake — multi-pass, triple-extract consensus, Opus model, 7-column canonical output | No |

### Operations & maintenance
| Function | Purpose | JWT |
|----------|---------|-----|
| `provision-number` | Auto-buy Telnyx number for new shop (v2 API) | No |
| `toast-order` | Toast POS menu fetch + order placement | No |
| `campaign-status-reader` | Poll Telnyx mapping status; advance submitted→approved when both ADDED | No |
| `daily-reset` | Clear expired specials, delivery pauses | No |
| `test-parse-judge` | Judge parser robustness test (script, not deployed) | N/A |

### Quality & monitoring
| Function | Purpose | JWT |
|----------|---------|-----|
| `eval-sweep` | Conversation Judge — automated quality scoring | No |
| `issue-detector` | Issue detection from evals (3 severity tiers) | No |

### Testing & QA
| Script | Purpose |
|--------|---------|
| `test-suite/quick.ts` | 25 fast deterministic cases (no LLM judge, no persist, ~2–4 min) |
| `test-suite/proof.ts` | Deterministic acceptance engine — 100% pass or shop doesn't go live |
| `test-suite/cart-ops.ts` | Adversarial CartOps battery + Proof invariants (shop-aware, real menu) |
| `test-suite/fix.ts` | LLM root-cause + proposed-fix generator for failing cases |
| `test-suite/worker.ts` | launchd worker — drains `test_run_queue` (onboarding QA) |
| `test-runner/` | **Edge function** — pg_cron-driven autonomous runner; polls queue every 60s, checkpoints per-case, scores incrementally. Runs the same test suite as `worker.ts` but server-side, no Mac dependency. |
| `campaign-status-reader/` | Polls Telnyx GET-only; advances campaign_assignment_status submitted→approved when both mappings ADDED. |
| `create-qa-twin.py` | Clone any shop as unprotected/phone-less twin for safe Proof testing |
| `create-vitos-pizza-demo.py` | Create Vito's Pizza demo shop from Jack's Slice CSV |

### Shared libraries (`_shared/`)
| File | Purpose |
|------|---------|
| `outbound-guard.ts` | Structural chokepoint — all customer-facing sends route here |
| `telnyx-error.ts` | Classifies Telnyx outbound rejections (opt-out/blocked) for graceful handling |
| `connect.ts` | Stripe Connect helpers, `isShopLive()` gate, service fee constant |
| `test-mode.ts` | Test-mode Stripe key resolution with allowlist gate |
| `stripe-financials.ts` | Real Stripe fee lookup + payout reconciliation for financials |
| `judge-rubric.ts` | Conversation Judge rubric (single source of truth) |
| `judge-notify.ts` | Judge digest → Telegram notification |
| `judge-autofix.ts` | Auto-fix seam (OFF by default) |
| `telnyx.ts` | Telnyx API helpers, messaging profile creation, number assignment |
| `test-suite/` | Shared test-suite library (generator, runner, judge, scorecard, persist, cart-ops, hours-closed, fix, library) — used by both `test-runner` edge function and `scripts/test-suite/` CLI |

---

## Database

Single Postgres database with tenant isolation enforced by RLS policies.

Key tables: `tenants`, `shops`, `menu_items`, `option_groups`, `option_choices`,
`order_carts`, `cart_items`, `messages`, `conversations`, `conversation_evals`,
`knowledge_base`, `availability_overrides`, `admin_action_log`, `issues`,
`resolution_log`, `sprintai_clients`, `ticket_send_log`, `outbound_queue`,
`number_provision_log`.

Migrations are in `supabase/migrations/` (001–083). Migration `039` added the
delivery flow (order_type, delivery_address, driver_tip). Migration `038` removed
user-metadata-based RLS policies, replaced with `app_metadata`-based policies
via the `set-app-metadata` edge function. Migration `041` locked ops tables
(outbound_queue, number_provision_log) behind service-role-only RLS (PII was
anon-readable). Migrations `042–045` added kitchen-ticket idempotency, order-
number assignment hardening, per-send audit logging, and inbound message_sid
dedup. Migration `046` hardened PII-table RLS — forced RLS on outbound_queue + 
number_provision_log, and gated admin_chat_transcripts INSERT to super_admin only.
Migration `047/048` schedules the issue-detector via pg_cron (every 10 min).
Migration `050` adds the 7-column canonical menu schema (prompt_for, upsell,
row_type, content_hash, open_questions, validation, owner sign-off). Migration
`051` adds protected-shop guard (DB-level trigger blocks menu deletes for
real/demo shops). Migration `052` adds test_runs + test_case_results tables
for the shop conversation test suite. Migration `053` adds read policies
(super_admin full / shop_owner own-tenant SELECT) so the QA suite is visible
in the admin dashboard with tenant isolation preserved. Migrations `054`/`055` add case-fix tracking to the QA suite: `proposed_fix`,
`fix_status` (default `open`), and `root_cause` columns on `test_case_results`.
A `scripts/test-suite/fix.ts` script auto-generates root-cause + proposed-fix via
LLM for every failing case; the admin dashboard shows these inline alongside
transcript + judge findings (two-level drill-down: run → case → detail).
Migration `056` adds `sms_opt_outs` (per-phone/tenant opt-out state).
Migrations `057`–`059` add onboarding fields (owner_name, onboarding_token,
ein, is_test, crawl fields). Migration `060` adds `delivery_hours`; `061`
normalizes `open_hours`/`delivery_hours` to a structured per-day object shape.
Migration `062` adds Google Places fields (google_place_id, formatted_address,
rating, review_count). Migration `063` adds shop `latitude`/`longitude`/
`delivery_radius_mi` for the fail-closed delivery zone. Migration `064` adds
`test_run_queue` for the async onboarding test-run worker. Migration `065` adds
`bot_segments` + `reached_checkout` to `test_case_results` for automatic SMS
segment tracking on every QA run. Migration `066` adds `scorer_version` so the
dashboard can separate runs scored under different scoring rules. Migration `068`
adds `telnyx_number_id`, `telnyx_messaging_profile_id`, and
`telnyx_messaging_phone_number` to `shops` and `number_provision_log` for the
Telnyx provisioning rewrite. Migration `069` adds the `merchant_registration`
state machine (`registration_status`, `registration_deadline`, `submitted_at`)
and `merchant_business_info` table (EIN, business_type, ownership_details) for
Phase 2 merchant identity verification. Migration `078` adds
`first_delivery_test_passed_at` + `recorded_by` for the delivery_test go-live
gate. Migration `079` adds `ticket_send_attempt_at` to `order_carts` for the
send-then-claim ticket delivery pattern. Migration `080` adds `attempt_number`
to `ticket_send_log` for per-attempt audit tracing. Migration `081` adds
`campaign_assignment_status` to `shops` for the campaign assignment go-live
gate (#13). Migration `082` restores shops config columns (prod-applied but
previously untracked). Migration `083` schedules `campaign-status-reader` via
pg_cron (hourly) — **unapplied**, blocked on Jason setting `DAILY_RESET_SECRET`
and `TELNYX_API_KEY` as Supabase function secrets. The deployed function was
also caught running `verify_jwt=true`, which would have rejected 083's
non-JWT shared-secret cron POST at the platform edge (401
`UNAUTHORIZED_INVALID_JWT_FORMAT`) before it ever reached the function's own
secret check — meaning the job would have silently 401'd forever even after
Jason set the secrets. Fixed 2026-09-04 (`config.toml` → `verify_jwt=false`,
redeployed); the function's own shared-secret check is unchanged. Applying
083 and setting the secrets remain the only steps left to close go-live
gate #13's auto-advance path.

### RLS model

- User roles: `super_admin`, `shop_owner` in `auth.users.app_metadata.role`.
  Legacy `is_admin` in `user_metadata` accepted as super_admin fallback.
- `tenant_id` in `app_metadata` scopes shop_owner access to their shop only.
- Policies read `auth.jwt() → app_metadata` — client-cannot-edit.
- Service-role key bypasses RLS for edge functions that need cross-tenant access.

---

## Security invariants

1. **Outbound guard**: ALL customer-facing sends go through `guardedSend()` in
   `_shared/outbound-guard.ts`. Only three reasons allowed: `inbound_reply`,
   `payment_confirmed`, `order_refunded`. Default-deny — anything else is logged
   CRITICAL and dropped.

2. **Tenant isolation**: Every query scopes by `tenant_id`. Cross-tenant data
   leak is a catastrophic failure. RLS enforces this at the DB level.

3. **Test-mode gate**: `_shared/test-mode.ts` allowlists only `sk_test_` /
   `rk_test_` prefixes. A live key in test mode is rejected.

4. **Phantom-link guard**: Payment links can only be sent on a paid cart — the
   guard checks `cart.status === 'paid'` and `cart.stripe_payment_id` exists.

5. **Inbound message dedup**: Inbound SMS/webchat messages carry a `message_sid`
   that is uniqued in Postgres (partial unique index, 045). Duplicate webhook
   deliveries or Twilio retransmits hit a constraint violation and are silently
   skipped — preventing double-orders from replayed messages.

6. **Kitchen ticket idempotency**: `ticket_emailed_at` on `order_carts` is
   claimed via atomic conditional UPDATE (`WHERE ticket_emailed_at IS NULL`)
   before sending. Only one caller wins; duplicate `payment_confirmed` events
   cannot produce duplicate tickets.

7. **Ops-table RLS (041, 046)**: `outbound_queue` and `number_provision_log` are
   service-role-only with RLS forced on. Anon and authenticated roles have no
   privileges. Customer phone numbers and Twilio SIDs are not readable from
   the anon key.

8. **Admin transcript INSERT gate (046)**: `admin_chat_transcripts` INSERT
   requires `is_super_admin()` (user JWT) or service_role key. WITH CHECK(true)
   replaced — any authenticated user could previously inject transcripts.

9. **TCPA / 10DLC**: All messaging respects opt-in, honors STOP immediately and
   permanently, observes quiet hours. The registered campaign (TCR `CSMB9HG`,
   provider Telnyx) is approved by all seven carriers. STOP/HELP/START use the
   **exact registered strings** and are matched **whole-message only** —
   "I want to cancel this order" does NOT opt out. The public homepage CTA and
   footer carry the carrier-required message-frequency disclosure — added to
   clear carrier rejection code 806. Legal pages use the canonical
   `getsprintai.com` mailbox and publish the SprintAI LLC legal identity
   (5620 Cetronia Rd, Allentown, PA 18106); the retired `getsprintai.net`
   mailbox is gone. See `docs/10dlc-compliance-obligations.md` for the full
   binding spec.

   **CANCEL is a registered opt-out keyword enforced by Telnyx at platform
   level — the word is banned from all system prompts and bot replies.**
   The bot offers CHANGE or RESTART at abandon-or-modify points instead.
   Opt-out state is durably persisted in `sms_opt_outs` (migration 056)
   with `upsertOptOut()` called from all STOP/START handlers and the Telnyx
   send-rejection path.

10. **Protected shop guard (051)**: Shops flagged `protected=true` (NJB and
    future demo/live shops) have a DB-level trigger that blocks DELETE on
    menus/menu_items. Legitimate admin re-imports opt in per-transaction:
    `SET LOCAL app.allow_protected_delete = 'on'`. This is the data-layer
    defense against test/QA runs accidentally destroying a real shop's menu.

11. **EIN required — no sole proprietors**: EIN is a hard gate in onboarding.
    No alternate path (no SSN, no skip). Permanent decision by Jason.

12. **First-contact compliance disclosure is code-driven, not prompt-driven.**
    The 10DLC-required footer ("Msg & data rates...") is injected ONLY on the
    lifetime first contact per (consumer phone, shop) pair — keyed on
    `conversations`, not session expiry. On every subsequent reply it is
    stripped by regex before send (~183 chars saved per reply).

13. **Deterministic grounding guards (chat-sms)**: Code-path intercepts
    prevent the LLM from hallucinating in ways that prompt rules alone can't
    stop.
    - Guard 1b: suppress replies inventing off-menu container/portion
      words ("tub", "pint") not in the shop's menu vocabulary.
    - Guard 1c: suppress claims an item is in the cart when the authoritative
      cart row disagrees (including empty-cart assertions).
    - Guard 1d (phantom-add guard): extracted to `chat-sms/phantom-add-guard.ts`
      (unit-testable). Catches "added X for ya" / "to your cart" claims when the
      cart didn't mutate — including colloquial completions (for ya/you/u),
      third-party recipients (him/her/them/mom/dad/grandma/"my wife"/a personal
      name), and bare item-add claims terminated by `(`, end-of-string, or a
      clause boundary. Fixed 2026-09-04 after a production SEV-1: a real order
      said "Added the Chicken Parmesan sandwich for mom (comes with fries)!"
      with no cart mutation and no guard firing — "for mom" wasn't a customer
      pronoun and "(" wasn't a recognized terminator. NON_ITEM_NARRATION
      (fee/tip/service/note/instruction, incl. plurals) is excluded from the
      captured claim object only, not the whole reply, so a message that both
      drops an item and mentions a fee is still caught.
    - Guard 1g (post-turn menu hallucination): `claimsOffMenuItem` helper
      checks if the model invented or offered items not on the shop's actual
      menu; falls back to honest cart summary.
    - Guard 3b: suppress "added X to your cart" claims when the cart
      didn't actually mutate this turn.
    - Guard C: block `phase=checkout` in `saveCart` when no Stripe checkout
      session exists — downgrades to `review`.
    - D1 (checkout-completion driver): when cart is submittable and user
      signals checkout intent, deterministically calls `submit_order` to
      create a real Stripe session — prevents "what else?" / re-ask loops.
    - D2 (kill re-ask): when `order_type` is already set, strip lingering
      pickup/delivery questions from the reply.
    - E1 (cross-turn `clear_cart` guard): suppress `clear_cart` when user
      message has additive intent (also, and a, etc.) and cart has items.
      Also recognizes restart intent anywhere in the message (not just
      anchored ^...$) — e.g. "Actually, cancel my order" clears the cart
      even when the leading word is additive.
    - C2 (name→submit shortcut): when the last assistant message asked for
      pickup name and the customer's next message looks like a short name
      and the cart is submittable, bypass LLM entirely and call
      `submit_order` directly — prevents LLM hallucination (doubling cart
      via spurious `add_item`) on the pickup-name turn.
    - P1 (checkout-writes-order): force `submit_order` when cart is
      submittable and the model signals checkout intent — the server writes
      the `orders` row, server recomputes total, never the model.
    - P2 (cart-persistence): if the cart silently resets mid-conversation
      (model hallucinates a clear), restore `cart_json` from the pre-turn
      snapshot. The guard re-snapshots after correction blocks so the
      restored state is post-correction truth, not stale pre-correction.
    - P3 (no-menu-hallucination): strip LLM-prose mentions of items not
      on the shop's actual menu. Now backed by claim-first detection —
      scans replies for product-claim patterns and validates against
      the effective menu, with distinctive-token fuzzy matching, question-
      word exclusion, and ack-leader filtering to avoid false positives.
    - P3 safety invariants (three deterministic checks run per-case in Proof):
      `verifyNoWrongPriceCharge` (charges quoted in reply match cart-derived
      amounts including $0.99 service fee), `verifyTenantIsolationNoLeak`
      (cross-tenant data never appears in reply), `verifyStopOptOutHonored`
      (STOP word replies correctly refuse service and persist opt-out).
    - False-green kill (`correction_reflected`): harness scoring checkpoint
      gated on fixture flag `expectCorrection`; absent the flag, `correction_reflected`
      is skipped (never scores). `fragmentGuard` tightened to match only when
      the fragment is absent — a model that happens to include correct text nearby
      no longer passes by accident. SCORER_VERSION bumped to 3.
    - Guard F (fake-checkout gate): after `submit_order` returns a real
      checkoutUrl, the reply is deterministically replaced with the real
      payment link — the model can never emit a hallucinated "order placed"
      confirmation. Guard 3 remains as the post-turn backstop.
    - Item disambiguation: `buildMenuItemNames()` detects duplicate canonical
      names and qualifies them by category (e.g. "tuna (salads)" vs "tuna
      (wraps)") so the LLM can distinguish same-named items.
    These are code-path intercepts, not prompt-preference — they fire
    deterministically regardless of what the LLM intended.

    **OrderBrain Phase A — deterministic Ledger render (2026-08-30).**
    Money and status lines (subtotal, fee, total, item count, checkout status)
    are now code-rendered from Ledger state rather than emitted as free-form
    LLM prose. `renderLedgerFooter()` appends the deterministic lines;
    `stripLlmMoneyLines()` removes any model-generated duplicates. The LLM
    handles conversation only — the Ledger owns every number the customer
    sees. Spec: `docs/specs/2026-08-30-orderbrain-deterministic-render.md`.

14. **Guard 4 v2/v3 — under-populated cart asks, never auto-adds (chat-sms).**
    V2: when a closing reply claims the cart has fewer items than the
    conversation history supports, the bot appends one warm upsell/ask line —
    cart is never mutated. V3: catches multi-item silent drops on non-closing
    replies where ordering conjunctions ("and", "also", "plus", "with") in the
    current message suggest multiple items but the cart got only one. MODE B
    scans the current message for menu items and appends an upsell ask line if
    any referenced items are missing from the post-LLM cart. Hard rule (Jason
    2026-09-01): cart NEVER auto-adds; upsell/ask only.

15. **Customer-question precedence (chat-sms)**: The bot answers direct
    customer questions (e.g. "do you have gluten-free bagels?") before
    advancing the order, even when the question is mixed with declines or
    order-completion signals. Category-level declines (e.g. asking for a
    category the shop doesn't carry) get a clean "we don't carry that" without
    pushing the conversation. Repeated questions get a fresh answer — the bot
    never ignores a customer question to shortcut to "what else can I add?".
    This is a prompt-rule in system-prompt CRITICAL tier, enforced alongside
    the deterministic grounding guards above.

16. **order_type defaulted on cart insert (chat-sms).** Cart creation now sets
    `order_type`: 'pickup' for delivery-disabled shops, null for
    delivery-enabled shops. The C2 name-turn deadlock breaker and phantom-link
    guard both default to pickup when `order_type` is still null, ensuring
    `submit_order`'s C1 gate (order_type must be set) can't deadlock a
    pickup-only shop.

17. **Cart-population — required options no longer drop items (chat-sms).**
    Multi-item messages where one item has a required modifier option (e.g.
    "Shrimp Scampi and a Pierogie") no longer silently drop the optioned item.
    `add_item` collects missing required groups into `pending_options[]` on the
    cart item — base price is charged now, surcharge applied on `modify_item`
    when the customer picks. `submit_order` deterministically rejects checkout
    if any item still has pending options, ensuring the customer always resolves
    required choices before paying.

18. **CartOps integrity (chat-sms)**: `cart_json` is the single source of
    truth. A bare tip reply never mutates items (no spurious `add_item`);
    quantity corrections ("just one") write back to `cart_json` and persist
    BEFORE any reply; every quoted total is computed from `cart_json`
    (subtotal + $0.99 fee + delivery + tip). The invariant
    `quoted_total == charged_total == sum(cart_json) + fees` is enforced — the
    bot never states a total that differs from the real cart, and no path lets
    an LLM-supplied number reach Stripe. An adversarial CartOps battery
    (`scripts/test-suite/cart-ops.ts`) asserts these invariants at 100%. The
    battery is shop-aware — `buildCartOpsCases` builds cases from the shop's
    real menu items. Total integrity is deterministic via Invariant 1
    (`quoted_total_matches_cart`, compared against actual `cart_json`), never
    judge arithmetic. The separate `expectedItemCents` stated-total override
    is rescue-only: it force-passes on a match but defers to the judge on a
    mismatch, since fixture-guessed totals can't prove a bot error.

19. **Closed-hours gate is deterministically tested.** `chat-sms` accepts a
    gated `test_hours=open|closed` param (web/test only, never on live keys)
    that forces the closed branch through `effectiveOpen`. The suite's
    `hours-closed` critical case (`scripts/test-suite/hours-closed.ts`)
    verifies the bot refuses with a "kitchen is closed" message, produces no
    cart, and generates no payment link — proving per shop, automatically,
    that the bot never takes an order the kitchen can't fulfill.

20. **Delivery zone is fail-closed (chat-sms + go-live)**: A delivery address
    is accepted only when geocoded as a positively-qualified, in-zone street
    match (`status=OK`, `partial_match !== true`, `location_type` ∈
    {ROOFTOP, RANGE_INTERPOLATED}, distance ≤ `delivery_radius_mi`). Any other
    outcome — out-of-zone, centroid-only (`APPROXIMATE`/`GEOMETRIC_CENTER`),
    `ZERO_RESULTS`, non-OK, or a transient geocode failure (one retry) — does
    NOT write the address; the customer is warmly offered pickup. Shops with no
    coords or null radius are unchanged (no check). A delivery-enabled shop
    without coordinates cannot go live (`delivery_geo` gate); go-live backfills
    coords from the shop's own address so the gate is enforceable, not a dead end.

---

## Monitoring & alerting

- `eval-sweep` generates conversation quality assessments every ~5 minutes.
  The Judge grades only assistant messages — a diner's prompt-injection attempt
  is never flagged as an assistant failure. `wrong_total` fires only on an
  explicit stated total; `invented_item` is narrowly scoped to items truly
  absent from the menu, its descriptions, and modifiers — fewer false flags.
  The ground-truth format now carries `description` and `modifiers` per item
  so the Judge can distinguish off-menu items from real add-ons and ingredients.
- `issue-detector` scans evals for patterns: error spikes, quality decline,
  compliance violations → writes to `issues` table + optional Telegram alerts.
- iMessage bridge logs to `/tmp/sprintai-imsg-bridge.log`.
- Stripe webhook failures surface in Supabase function logs.

---

## Troubleshooting

### "Bridge is down" / iMessage not routing
1. SSH to Mac: `launchctl list | grep sprintai`
2. Check logs: `tail -f /tmp/sprintai-imsg-bridge.log`
3. Restart: `launchctl kickstart gui/$(id -u)/com.sprintai.imsg-bridge`

### Stripe Connect onboarding fails
- Verify `isShopLive()` gate passes — all four fields must be set.
- For Path B (Express), the account must have `charges_enabled=true` and
  `payouts_enabled=true`. Onboarding may be incomplete in Stripe dashboard.
- Check `connect_status` on the shop row.

### Admin dashboard blank page
- Confirm `sprintai-chat-admin` site has the latest deploy.
- Confirm `deploy-root/_redirects` has the `/admin/*` → `/admin/index.html` rewrite.
- Check `admin-dashboard/vite.config.ts` has `base: "/admin/"` and `src/main.tsx` `basename="/admin"`.
- The live URL is `getsprintai.com/admin`; the SPA routes under `/admin/`.

### Edge function deploy fails
- `supabase functions deploy <name>` — check `supabase/config.toml` has the
  function's `verify_jwt` setting.
- For new functions: add the `[functions.<name>]` block to `config.toml` first.


## One shop per real-world restaurant (PERMANENT — 2026-09-06)

There is exactly ONE Vito's Pizza: `vitos-pizza` / `e0000000-0000-0000-0000-000000000001`.
It is `is_test=true`, so the acceptance harness, the public tester, the owner
simulator and the demo pages all point at it and risk nothing real.

`vitos-pizza-qa` was a twin of it and is RETIRED (renamed
`ZZ RETIRED — do not use (was Vito's Pizza QA)`, `is_paused=true`, slug
`retired-vitos-pizza-qa`). It is not deleted yet; hard-delete once the harness
has run green against `vitos-pizza`.

The twin drifted: it kept a menu with zero toppings and zero dressings after the
real shop was fixed, and on 2026-09-06 the founder tested against it by name and
concluded — reasonably — that nothing had been fixed. A twin that can diverge
from the shop it mirrors certifies a menu nobody is selling.

RULE: one shop per real-world restaurant. If a test needs different data it gets
a differently named shop — `harness-scratch`, never a second copy of a real one.
Do not create one speculatively.


## Reading the QA data yourself (no agent in the loop) — 2026-09-06

`qa_ro` is reachable over the session pooler with the read-only role. The
credentials live in `~/.sprintai-readonly-env` on Joe's Mac (mode 600). One
command, from anywhere with ssh to that box:

```
ssh <host> 'set -a; . ~/.sprintai-readonly-env; set +a; \
  psql "$DATABASE_URL" -c "select tester_name, reporter_note, source, created_at \
  from qa_ro.test_transcripts order by created_at desc limit 5;"'
```

Locally on that box it is just:

```
set -a; . ~/.sprintai-readonly-env; set +a
psql "$DATABASE_URL" -c "<your query>"
psql "$DATABASE_URL"            # interactive
```

The role can SELECT only inside schema `qa_ro`. No writes, no DDL, no `public`.
Useful views: `test_transcripts`, `public_tester_sessions` (device +
is_first_session), `test_runs`, `test_case_results`, `test_run_queue`, `issues`,
`menus`, `menu_items`, `option_groups`, `option_choices`, `lexicon`,
`owner_questions`, `menu_item_option_coverage`, `ticket_send_log_ro`,
`order_carts_ro`, `orders_ro`, `shops_config`, `menu_edit_log`.

**Column exposure matters as much as row scoping — a view can hide columns from
a table it otherwise shows fine.** Found 2026-09-07: `qa_ro.menu_items` showed
25 of the real table's 37 columns and silently dropped every Phase-0 compiler
column (`display_name`, `product_key`, `archetype`, `bot_state`,
`bot_state_reason`, `ask_plan`, `name_provenance`, `price_provenance`,
`source_span`) — so a query that looked like it worked (0 rows filtered, no
error) just never showed the thing being asked about. Same shape bug as the
row-scoping issue above, one layer down. Fixed same day: those 9 columns added
to `qa_ro.menu_items`; `qa_ro.option_groups`/`option_choices` extended with
their own missing Phase-0 columns (`kind`, `slot_key`, `kitchen_critical`,
`price_critical`, `default_choice_id`, `ask_mode`, `provenance`,
`source_span` / `display_name`, `is_default`, `provenance`, `source_span`);
`qa_ro.lexicon` and `qa_ro.owner_questions` created from scratch — they had
no `qa_ro` view at all before this, meaning the owner-question list and
lexicon terms were only ever reachable through a report script, never
independently. `confidence_score`/`source`/`source_ref` on `menu_items` are
still not exposed — pre-existing gap, predates this spec, not fixed here.
When adding a new compiler-output column anywhere: add it to the `qa_ro` view
in the SAME migration, not later — this is the second time a real column
existed and was invisible through the one read-only path meant to verify it.

**Shop scoping is NOT consistent across these views — check this table before
trusting a zero-row result.** Found 2026-09-07 the hard way: `qa_ro.option_groups`
returned 0 rows for Zio's Pizzeria while `qa_ro.shops_all`/`qa_ro.menu_items`
showed the shop and its 220 items fine — Zio's option data was real (140
groups, 889 choices, verified via a direct service-role query) but invisible
through `qa_ro` because it wasn't in `visible_shop_ids()`'s allowlist yet
(fixed migration 116; the allowlist is `is_test = true` OR a hardcoded slug
list — currently `not-just-bagels`, `zio-s-pizzeria`). Migration 116 alone
was NOT enough: `option_groups`/`option_choices` had their own independent
copy of the old filter baked directly into the view (not a call to the
function), so updating the function didn't touch them — proven by Jason's
own proof query (`select ... from qa_ro.option_groups where id = '<a real
row>'`) still returning 0 rows after 116 landed. Migration 117 rewrote both
views to actually reference `visible_shop_ids()` instead of duplicating its
logic, closing that gap for real. Verified live: the same proof query now
returns the row.

- **Scoped by an actual call to `visible_shop_ids()`** (single source of
  truth, only test shops + the named real ones above): `option_groups`,
  `option_choices` (fixed migration 117).
- **Scoped by their OWN independent copy of a similar-but-not-identical
  allowlist** (`is_test = true` OR slug IN `not-just-bagels`/
  `njb-test-clone-11353`) — NOT wired to `visible_shop_ids()`, so adding a
  shop to that function does nothing for these two until they're fixed the
  same way 117 fixed option_groups/option_choices: `orders_ro`,
  `ticket_send_log_ro`.
- **NOT scoped at all — every shop visible, real or test**: `shops_all`,
  `shops_config`, `menus`, `menu_items`, `menu_item_option_coverage`,
  `menu_edit_log`, `issues`, `order_carts_ro`, `order_cart_lines`,
  `test_runs`, `test_case_results`, `test_run_queue`, `test_transcripts`,
  `public_tester_sessions`.

When onboarding a new real shop: it will show up immediately in the unscoped
views, but will read as *empty* — not absent, empty, a real difference — in
`option_groups`/`option_choices`/`orders_ro`/`ticket_send_log_ro` until it's
added to the relevant allowlist. Don't conclude "no data" from one of the
scoped views without cross-checking an unscoped one first.

If `DATABASE_URL` is missing from a service environment, the fix is to source
that file — do not ask an agent to run the query.

## Tester attribution (migration 108) — 2026-09-06

`ip_hash` cannot separate testers and never will: every session so far comes
from one household NAT (`71.185.100.243`), so the founder's iPhone, the crew's
curl and a friend's Android all hash identically. Nothing gates on `ip_hash`
(the daily cap counts rows), so no limiter was affected.

What separates them is the User-Agent, which was arriving on every request and
being discarded. `public_tester_sessions.user_agent`,
`public_tester_sessions.client_first_seen_at` and `test_transcripts.user_agent`
now record it; `qa_ro.public_tester_sessions` exposes a derived `device`
(iPhone / Android / Mac / Windows / script / unknown) and `is_first_session`.
Rows written before 2026-09-06 13:51 UTC show `device = unknown` — that is
missing history, not a bug.

## Recurring bug shape: bookkeeping only wired to the failure path — 2026-09-06

Guard 7's original `pending_disambiguation` persist (commit 3e01286) only ran on the
ROLLBACK branch — when `add_item` was actually called and had to be undone. The far
more common case, the model recognizing the same-name collision itself and asking in
free text without ever calling `add_item`, never touched that code, so nothing was
persisted and the next message had no memory of what was offered. Fixed same day by
adding a second guard (GUARD 7b) keyed on the customer's own message plus a
free-text question, independent of whether a tool call happened at all.

This is the fourth confirmed instance of the same shape: a success path silently
skips bookkeeping that only the failure/rollback path performs. The other three:
the menu importer's silent block-drop, the duplicate migration numbers, and the
option-price revert. Common thread — whoever wrote the "sad path" handling correctly
assumed it was the only path that needed it. When adding state that a later turn or
process depends on, ask whether the HAPPY path reaches the same code, not just the
one you're staring at while fixing the bug in front of you.

## Watch-for: unreproduced cart-emptying on "looks good" — 2026-09-06 (NOT a confirmed defect)

Jason, live-testing Vito's Pizza: after ordering a Caesar salad, "looks good" once
returned "Your cart is empty. What would you like to order?" — the cart emptied
itself. Could not reproduce in 3 follow-up attempts; no transcript captured. Not
logged as a defect because it isn't confirmed — logged here because if it resurfaces
in a real tester transcript, it should be recognized immediately as a recurrence,
not treated as new.

Same family as the "no thanks" cart-line deletion fixed earlier today
(commit `50407e2`) and the GUARD 9 cart-doubling P0 (`0398d99`/`7405a13`) — all three
are the cart silently changing shape on an affirmation/closing message the customer
did not intend as a cart edit. If this recurs: get the actual conversation_id and
turn sequence before touching code; three prior incidents in this exact family were
each traced to a different guard (GUARD 4's fuzzy upsell text, GUARD 9's mutated-
array wiring, the "no thanks" deletion path) — don't assume it's the same guard as
last time without checking.

## Migration tracking has drifted from actual schema state — verify before trusting `supabase migration list` — 2026-09-06

`supabase db push --dry-run` reports migrations 105–111 as not applied to remote.
Live-tested that this is not reliable: POSTing to the deployed `public-tester`
function writes successfully to `user_agent`/`client_first_seen_at`, the columns
migration 109 adds — so that schema change is live despite the tracker saying
otherwise. Confirmed independently by the same day's shop-retirement commits
(`dc542dd`, `0a7ddba`): the actual `UPDATE`s that retired the two QA-twin shops
(rename, pause, slug change) exist nowhere in either commit's diff — applied
directly against the database, outside `supabase db push`, same as 109 apparently
was.

**Operating rule**: `supabase_migrations.schema_migrations` cannot be trusted alone
as evidence a change is (or isn't) live on this project — it has been bypassed more
than once. Before relying on a migration's effect, verify directly: query the
table/view/column itself (via `qa_ro` credentials, or a live probe of whatever
function reads/writes it), don't stop at `supabase migration list`. If a change was
applied out-of-band, run `supabase db push --include-all` (or otherwise reconcile the
tracker) so the next person doesn't have to re-derive this.

Migrations 105–108/110–111 (today's other `qa_ro` widening) were NOT independently
verified either way this pass — they only affect `qa_ro` views, reachable solely via
`~/.sprintai-readonly-env` on Jason's Mac. Check `qa_ro.schema_migrations` (added by
111) directly before assuming any of them are missing.

## `.down.sql` files break `supabase db reset`/`db push`'s forward-migration glob — naming convention — 2026-09-07

BLOCKED.txt (item 7, 2026-09-07 ~18:20 UTC entry) found 13 pre-existing
`.down.sql` rollback scripts (015 through 112) living in `supabase/migrations/`
alongside their forward migrations. The CLI's migration scanner (confirmed via
`supabase migration list`'s own "file name must match pattern `<timestamp>_
name.sql`" skip-message for non-conforming files) only checks that a filename
starts with digits and ends in `.sql` — it does **not** special-case `.down.sql`.
So every one of those 13 files gets picked up and replayed as its own forward
migration, in filename sort order, on a from-scratch `supabase start`/`db reset`.
Confirmed live: `supabase migration list` shows duplicate version rows (e.g. two
`118` rows) for exactly this reason before the fix below.

Migration 118 (`shops_compiled_ordering_engine_flag`) would have been the 14th.
Fixed by moving its down-script out of the scanned directory entirely, rather
than renaming within it (an extension trick like `.sql.down` is fragile — easy
for a future migration to typo back into `.down.sql` and reintroduce the bug):

**Convention going forward:** rollback scripts live in `supabase/migrations-down/
<version>_<name>.down.sql` — a sibling directory the CLI never scans (verified:
`supabase migration list` no longer shows a phantom row for 118 after the move,
and no skip-warning either, since the directory isn't touched at all). Do **not**
put a `.down.sql` file back in `supabase/migrations/`, even temporarily.

The 13 pre-existing offenders (015–112) are **not fixed** — this is a repo-wide
migration-history change on a shared branch, not something to do unilaterally
mid-sprint (same call BLOCKED.txt's item-7 entry made). They still break a
from-scratch `db reset` today; the documented workaround is stashing them during
local reset testing and restoring immediately after.

Separately: migration 118's own forward file (`118_shops_compiled_ordering_engine_
flag.sql`) shows the same "applied live, missing from `supabase migration list`"
drift as migrations 105–111 above — its trigger/column is live (confirmed
directly against the DB) but the remote tracking row is blank. Same operating
rule applies: verify against the actual schema, not the tracker.

## Edge function index — missing rows, 2026-09-06

The "Edge function index" table above predates several now-deployed functions:
`public-menu` (public per-shop menu page, `/m/<slug>`, `verify_jwt=false`,
customer-facing), `public-tester` (Test Kitchen), `judge-transcript`, and
`chat-sms-mtest` (an A/B variant, per an uncommitted change to
`scripts/test-suite/run.ts`'s target URL) are all `ACTIVE` per `supabase functions
list` but not in the table. Not fixed here — noted so the index isn't mistaken for
current.

## Batch `.in()` filters over ~150 IDs — 2026-09-07

A single Supabase `.in()` filter call with ~492 UUIDs failed silently at the
transport layer during `compile-menu`'s first real run against Zio's Pizzeria
(`b448444`) — no thrown error, the caller just got back an empty/partial result and
183 real menu items got wrongly written as `bot_state='blocked'`. The same class of
bug independently hit `scripts/item-9-readonly-compile-report.ts` on the same
shop's 490-ID list (`63e7da6`), undercounting orderable items as 21/220 instead of
163/220. Neither call site threw; both silently returned less data than requested.

**Standing rule:** any new script or function issuing `.in()` against
`option_groups`/`option_choices`/`menu_items` for a shop's full ID list must batch
at ~150 IDs per call and must make the fetch helper throw on error rather than
swallow it. Do not assume a large `.in()` call either succeeds or fails loudly —
on this project it has done neither.

## `compile-menu` — deployed version can be stale relative to `main`, check before invoking

`compile-menu` mutates live data (`menu_items.display_name/product_key/bot_state/
bot_state_reason/ask_plan`, `lexicon`, insert-only `owner_questions`) — it is not a
read-only report. Because it's deployed manually (`supabase functions deploy
compile-menu`), the live version can lag behind `main` after a same-day parser or
logic fix, and invoking a stale deploy against a real shop's menu re-runs the old
logic against real data. Before calling the live endpoint for a real compile, check
`supabase functions list`'s `compile-menu` `UPDATED_AT` against the latest commit
touching `supabase/functions/compile-menu/` or `supabase/functions/_shared/
compile-menu.ts`/`normalize.ts`/`archetypes.ts` — if the commit is newer, redeploy
first.

## `shops.compiled_ordering_engine_enabled` (migration 118) — do not flip on for Vito's

Gates the new deterministic ask_plan sequencer/resolver (`ask-plan-engine.ts`) in
`chat-sms`. Defaults `false` for every shop. Vito's Pizza is the canary shop and
must keep running the legacy LLM-guessed option path byte-for-byte — per the
column's own SQL comment, it must never be set `true`. Enabling it for any shop is
a deliberate, explicit data change made after sign-off, never bundled into a schema
migration.
