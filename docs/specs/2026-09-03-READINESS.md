# Readiness Board — INSTRUCTION-10

Governing spec: `2026-09-03-INSTRUCTION-10.md` (supersedes 07/08/09 sequencing).
Standard: each item built and **validated on its own** — no end-to-end walk. Jason runs
the integration test himself. Update this board whenever a status changes.

Status vocabulary: `not started` · `building` · `in verification` · `built`.

| Item | What | Status | Validated how | Blockers |
|---|---|---|---|---|
| A | Subscription code path — build step in **setup.html** (wizard.js dead) | built | 0e9cadf (build) + 486cd15 (security: removed subscription_status/pm_set/sub_id from onboarding-save back door) + 69f9018 (fix: removed broken server-side promo_code branch — allow_promotion_codes/discounts conflict + promo-code-as-coupon-id) + a51d6df (pin verify_jwt=false). Deployed **v4 ACTIVE**. All 7 deterministic checks pass: no client status write; single $99/mo price (verified live); mode:subscription + client_reference_id; webhook sole writer; payment_method_collection:'always'; go-live 13 gates intact; no pro/enterprise creation. Promo FOUNDING → coupon FOUNDING-BETA-6MO-SUB, 100%/6mo, max 15, expires 2027-01-01 (verified live). Stale coupon FOUNDING-BETA-6MO deleted. | **Remaining = live test-card walk (Jason's integration test): shop reaches active only after checkout, sub+customer ids persisted, promo redemption yields $0 first invoice WITH card attached.** Code/config support it; not provable without the walk. |
| B | Onboarding/go-live split + `onboarding_complete` completion screen | built | 539c6d6 (migration 085 founding_promo — applied), e429031 (item B — go-live phase split, migration 086 applied, setup.html completion screen). go-live unit suite 21/21 pass; gate count exactly 13 (9+4); deno check clean; deployed evaluate mode verified live: phase_a/phase_b/onboarding_complete returned correctly. save handler re-checks completion immediately. Migration 078 (first_delivery_test columns) also applied (was missing from prod, would have broken go-live for every shop). | No blockers. Jason's integration test: owner with all 9 Phase A gates passes → terminal screen appears, not blocked gates. |
| C | Resume email failure visible + resendable | built | migration 084 (welcome_email_status/error/last_attempt_at on shops). onboarding-save v48: sendWelcomeEmail() helper persists true outcome, returns email_sent/email_status/email_error on `create`, new `resend_welcome` action. signup/index.html shows warning + Resend button when email_sent=false. Deployed + columns live. | Validated by: deno check clean; columns confirmed in DB; manual test with RESEND_API_KEY unset needed to observe failure path (Jason's integration test). |
| D | Owner mobile at signup (5th field) | built | f7c9d15 — migration 087 owner_mobile (applied); collected at signup, persisted distinct from `phone_number_e164`. | No blockers. |
| E | Ticket-destination question + persistence (no API build) | built | migration 088 (ticket_destination_type default 'expo' + _detail; applied+verified prod). onboarding-save allowlist + setup.html question (Expo default / dedicated mailbox / own system / free text); mailbox mirrors to email_ticket_recipient. admin-chat SET_TICKET_DESTINATION intent (confirm-card + undo) edits email_ticket_recipient. deno check clean; both functions deployed. **AC8 proven live**: free-text answer persisted through deployed onboarding-save on a real test shop; existing rows default to 'expo'. | AC7 (owner edit via admin chat) needs an authenticated owner session to walk end-to-end — code built+deployed. API integration for own_system intentionally not built. |
| F | Menu curation by confidence | built | 2819738 — extract-menu-items prompt elicits confidence (0-100) + flag_reason per item; items with confidence < 75 inserted with flag_review=true + specific owner question in flag_reason. MenuTab splits into amber "We have questions" (flagged) and normal "Your menu" (confident); "Looks right" button clears flag via clearFlag mutation. deno check clean; tsc clean; edge fn deployed; admin-dashboard deployed to sprintai-chat-admin. Validation: next real-shop crawl will produce the split; owner surface renders both sets differently. | No migration needed (flag_review + flag_reason already existed). Jason's integration test: trigger a crawl → verify items split; click "Looks right" → item moves to confident set. |
| G | Expo Screen (promoted, always-active delivery path) | building | edd5abe (migration 089 + ExpoScreen.tsx + routing + nav link + build). Migration 089 applied: expo_status/expo_acknowledged_at columns live; expo_advance_order SECURITY DEFINER RPC live. Bundle index-BLXHTZGY.js deployed to sprintai-chat-admin (getsprintai.com/admin). ExpoScreen at /admin/expo (owner) and /admin/shop/:shopId/expo. Realtime subscription on order_carts (REPLICA IDENTITY FULL) handles network drop. Advance requires human button press only. Wake Lock + audio unlock on first gesture. **Jason's integration test required to mark built.** | — |
| H | Ticket delivery truth (Resend webhooks vs `resend_message_id`) | built | migration 091 applied (delivery_status/detail/event_at on ticket_send_log + ticket_delivery_status/detail/at on order_carts). resend-webhook edge fn deployed (ACTIVE v3). ExpoScreen already queries + surfaces ticket_delivery_status with bounce badge. **CLOSED 2026-09-05 11:27 EDT: RESEND_WEBHOOK_SECRET set and verified by digest; all three events (delivered/bounced/complained) driven through the real pipeline and matched on resend_message_id. Bounce to `bounced@resend.dev` recorded against the order in 0.7s (ticket_send_log delivery_status=bounced + order_carts.ticket_delivery_status=bounced) and renders the bounce badge on the Expo Screen.** Code/DB/ExpoScreen complete; only registration + secret remain. | No blockers. |
| I | Escalation rule — 7-min unacked → SMS owner (reuse issue-detector) | built | acd70c6. Migrations 092 (owner_escalated_at + partial index) + 093 (pg_cron `issue-detector-escalation` */2, jobid 80) applied+live; 10-min sweep untouched. issue-detector v13; outbound-guard new default-deny `owner_escalation` reason, 19/19 tests. **Melvin INDEPENDENT QA: SHIP — all 10 ACs PASS**, driven against the live deployed function with synthetic rows (not builder's word). AC9: diner number is structurally unreachable — the rule never loads a diner phone column; recipient assigned solely from `shops.owner_mobile`. AC4: 6 concurrent sweeps over 3 eligible carts → exactly ONE claim/send, 2 further sweeps → 0. Exactly-once is the DB conditional UPDATE claim, not the issues table. | Fast-follow (non-blocking, Melvin finding #1): function runs `verify_jwt=false`, so unauthenticated POSTs run the real SMS sweep. NOT exploitable for spam/double-text (exactly-once is DB-enforced, recipient owner-only, `include_test_mode` env-gated not body-gated). Close by requiring the provisioned vault bearer `issue_detector_bearer`. |
| J | PROVE carrier approval chain deployed+scheduled | built (chain proven as far as is possible without Jason) | Deployed: yes, `campaign-status-reader` v12 ACTIVE. Scheduled: NO — migration 083 unapplied (blocked on Jason's secrets, ledger 40b37071); `cron.job` = test-runner-tick, judge-eval-sweep, issue-detector, issue-detector-escalation only. **Latent trap found AND fixed:** deployed verify_jwt=True contradicted 083's shared-secret cron design — a non-JWT bearer was rejected at the platform edge (401 UNAUTHORIZED_INVALID_JWT_FORMAT) and never reached the function, so once Jason set the secrets the hourly job would have 401'd forever, silently, leaving go-live gate #13 permanently unsatisfiable. Fixed in 28dc2d3 (config.toml only, index.ts untouched), redeployed v12 with verify_jwt=false. OrderFare verified INDEPENDENTLY of the builder, live: verify_jwt=False; non-JWT bearer now returns the function's own `500 Not configured` instead of INVALID_JWT_FORMAT; 083 still unapplied, still no cron row. | Final proof (a `submitted` shop advancing to `approved` on its own) is BLOCKED ON JASON: needs DAILY_RESET_SECRET + TELNYX_API_KEY function secrets + a matching vault `daily_reset_secret`, then apply 083. The wrong-secret rejection branch is code-inspected only (fails closed, 401) — unexercisable until the secret exists. |
| K | PROVE website read reliability | in verification | Melvin drove the deployed `scrape-shop` over 20 real ICP sites (sample locked before running). **First measurement: 0/20 PASS — zero items, zero hours, while reporting `crawl_status=done` on 19 of 20.** Report: `docs/specs/2026-09-05-item-K-website-read-reliability.md`. Parse bug fixed (838b2f9); re-measured by Melvin: **6/20 PASS (30%), 14 honest PARTIAL, 0 FAIL, 0 hallucinations, honesty 5% -> 100%** (no shop claims `done` over an empty menu). Item names/prices spot-checked against the live sites — real, not invented. Follow-ons committed but NOT yet re-measured: d34f7eb (route PDF menus to `parse-menu-pdf` + Firecrawl 429 backoff) and afce671 (discover PDF anchors from homepage HTML). | Closes when the PDF-routing commits are re-measured on the PDF bucket (ledger 660a79c1 + baba3bf9, due 09-06 18:00). Structural ceiling stands: most ICP menus now live off-domain on Slice/Toast/Owner/ChowNow — backlog 2a794a96 + b0656741. Options/modifiers still never extracted — backlog 7f0fc459. |
| L | PROVE demo kit (3 codes) | not started | walk all three on a phone in order; report breakage | — |
| M | Delete/mark `signup-page/wizard.js` dead | built | 1c77afa — deleted `signup-page/wizard.js` + `wizard.css`. Confirmed dead before removal: no HTML in signup-page/, signup/, or repo root loads either file; the live wizard is setup.html (item A). Only surviving references are in `signup-page/_proof/`, which build-public-site.sh prunes from the published output, so no shipped page is affected. | Closed 2026-09-05 07:10 EDT: 1c77afa is on origin/main, public site rebuilt. Verified live — `getsprintai.com/signup-page/wizard.js` and `wizard.css` both return **404**. The exposed client-side `subscription_status` back door is no longer downloadable. |
| O | Owner-facing Menu & Settings editor | built | 4a28993 + 5520eec + migration 104 (applied). Owner page at **/menu-settings**, in `shopOwnerNav`, under `ShopOwnerRoute`; writes go through admin-chat's propose->validate->execute registry under the OWNER's JWT (RLS first, code guard behind it), never service-role. Deployed: admin-chat v29; admin bundle `index-C6h_btXT.js` — OrderFare verified independently that the bundle actually served at the front door `getsprintai.com/admin` contains the `menu-settings` route and the ADD_ITEM/REMOVE_ITEM ops, rather than trusting the deploy. **Two independent live attack probes, both PASS with cleanup proven:** AC5 tenant isolation (every cross-tenant write REJECTED, every own-shop write succeeded, zero cross-tenant reads, `menu_edit_log` for the victim tenant empty) and migration 104's new INSERT surface (direct PostgREST and both admin-chat flows, plus a non-shop_owner JWT — all rejected). | **GAP (narrower than first reported): owner-edited OPTION GROUPS and CHOICES were not durable.** My original claim that the deployed importer had zero `owner_edited` handling was WRONG — the check grepped a download tree that never contained `index.ts`, so it measured nothing and `|| echo 0` hid the failure. Melvin drove the deployed function instead and measured the real behaviour: v37 already skipped owner-edited *items*, but reverted an owner's $3.00 addon price to $2.50 on re-import. Groups/choices were the unprotected surface. Melvin verdict SHIP; deployed v38; a confirmation probe against the deployed function is running. Ledger 05de5bc0. Also open: admin-chat REMOVE_ITEM's chat-confirm path reports a false success on a no-op (backlog 37b8f9dd). |
| N | Resolve uncommitted `chat-sms` change | built | 292a838 committed + deployed chat-sms v203 (2026-09-04 00:25). Deployed body: modify_item=10 refs, reduce_qty=0. Correct. |

## Log
- 2026-09-03 22:33 EDT — board created. Rehearsal stood down (leg 1 cancelled, leg 2 not
  started, `p2-rehearsal-diner` left in place). Starting item A.
- 2026-09-04 05:28 EDT — Item A → **built**. Two promo-path bugs fixed (69f9018),
  verify_jwt pinned (a51d6df), redeployed v4, stale coupon confirmed gone. All 7
  deterministic checks pass. Only live test-card walk remains (Jason's integration test).
  Starting item C.
- 2026-09-04 05:38 EDT — Item C → **built**. Commit 9885751. Migration 084 applied
  (3 columns live). onboarding-save v48 deployed. Signup surfaces email failure + resend.
- 2026-09-04 08:14 EDT — Regression: 86ec9dd deployed stripe-webhook with founding_promo
  write. Migration 085 never applied (column missing). Write guarded by unset
  STRIPE_FOUNDING_COUPON_ID so no checkout was breaking, but trap was live. Applied 085.
- 2026-09-04 ~08:30 EDT — Item B → **built**. Commits 539c6d6 + e429031. Phase A/B split
  live in go-live edge fn. Migration 086 applied. Completion screen wired in setup.html.
  Migration 078 (first_delivery_test columns) also applied — was missing, would have broken
  go-live lookups for every shop. 21/21 unit tests pass.
- 2026-09-04 10:35 EDT — CI fix committed + pushed (abe26e6). netlify-plugin-cache added to
  package.json — every git-triggered build was failing (exit 2) since 3f9031b.
- 2026-09-04 10:45 EDT — Item F → **built**. Commit 2819738. extract-menu-items confidence
  scoring live; MenuTab split display deployed to sprintai-chat-admin.
- 2026-09-04 13:50 EDT — Item G → **building**. ExpoScreen committed edd5abe (alongside F
  fix). Migration 089 applied. Bundle BLXHTZGY deployed. Screen live at getsprintai.com/admin/expo.
  Awaiting Jason's integration test to close.
- 2026-09-04 ~15:15 EDT — Item H → **building**. Migration 091 applied (delivery columns on
  ticket_send_log + order_carts). resend-webhook deployed (ACTIVE v3). ExpoScreen already
  surfaces ticket_delivery_status (bounce badge). Blocked on webhook registration: RESEND_API_KEY
  is send-only restricted; Jason must create the webhook in Resend dashboard + set
  RESEND_WEBHOOK_SECRET in Supabase secrets.
- 2026-09-04 17:45 EDT — Item I → **building**. Spec written with pre-mortem
  (`docs/specs/2026-09-04-item-I-escalation.md`), dispatched to builder. Three findings that
  shaped the design: (1) `issue-detector` cron is every 10 min, so a 7-min timer would fire
  7–17 min late → dedicated 2-min `mode:"escalation"` job; (2) outbound sends are default-deny
  through `_shared/outbound-guard.ts` with a closed reason enum — owner escalation needs a new
  gated `owner_escalation` reason, not a bypass; (3) item H is blocked on Jason, so
  `ticket_delivery_status` is NULL in prod → clock falls back to `ticket_emailed_at` rather
  than depending on H. DRIFT NOTED: `stripe-webhook` still sends merchant SMS via hardcoded
  Twilio while `chat-sms` resolves Telnyx-first — not in scope for I, needs its own item.
- 2026-09-04 20:50 EDT — Item I → **built**. Melvin independent QA verdict SHIP; all 10 ACs
  pass against the live function. Note on process: the builder's own "independent QA" ran as a
  child of the builder process and died with it, and a 4-agent self-review is not independence —
  Melvin was re-dispatched separately. Fast-follow logged: `verify_jwt=false` now fronts a real
  SMS-sending path; require the existing vault bearer.
- 2026-09-04 20:58 EDT — Item J → **in verification**. Deployed yes, scheduled no. Found a
  latent trap that would have survived Jason's secret-setting: deployed `verify_jwt=True`
  contradicts migration 083's shared-secret cron design, so the hourly POST would be rejected
  at the platform edge (401 INVALID_JWT_FORMAT) before reaching the function — a silent
  permanent failure of the carrier-approval chain. Auth fix dispatched to builder; 083 stays
  unapplied until Jason's secrets land.
- 2026-09-04 22:30 EDT — Item J → **built** as far as is provable without Jason. Auth trap
  fixed (28dc2d3, v12) and independently re-verified by OrderFare against the live endpoint,
  not taken on the builder's word. Scheduling + end-to-end submitted→approved remain blocked
  on Jason's secrets (ledger 40b37071).
- 2026-09-04 22:40 EDT — Item M → **in verification**. wizard.js/wizard.css deleted (1c77afa)
  after proving nothing loads them. Still served live (200) because the commit is unpushed —
  closes only when main is pushed and the public site rebuilds.
- 2026-09-04 22:35 EDT — Item K dispatched (measurement only): 20 real restaurant sites through
  the deployed read path, distribution specified up front (PDF menus, image-only menus, JS-heavy,
  multi-menu, old HTML) so the success rate cannot be inflated by cherry-picking easy sites.
- 2026-09-05 07:10 EDT — Item M → **built**. Board said LOCAL-ONLY; it was stale. 1c77afa is
  on origin/main and the public site rebuilt. Verified live: both wizard.js and wizard.css
  return 404. The publicly downloadable `subscription_status` back door is gone.
- 2026-09-05 07:10 EDT — Item K dispatch from 09-04 22:35 produced no artifact and no surviving
  subagent — it died with the parent session. Re-dispatched.
- 2026-09-05 09:50 EDT — Item K → **in verification**. Honest red first: 0/20, and worse than
  zero — 19 of 20 shops were marked `done` over an empty menu, so an owner would have been told
  their site was read when nothing was. Parse bug fixed and independently re-measured: 6/20 PASS,
  0 hallucinations, false-success eliminated. PDF routing + PDF-anchor discovery committed after
  the re-measure and are therefore unproven; they get their own measurement.
- 2026-09-05 10:34 EDT — Shop editor reverted off main (b192d65). Jason redefined the feature at
  10:04 as OWNER-FACING — it belongs in the owner portal beside the Demo Kit page so an owner
  maintains their own menu. The build in 37142f8 put it in the admin dashboard, the shape he
  ruled out, and reached main by a careless push rather than a decision. Work preserved on branch
  `shop-editor-admin-shape`. Migration 097 (owner_edited + the missing owner INSERT/DELETE
  policies) is applied and KEPT — an owner cannot add a wing flavor without it. Also reverted on
  the live QA shop: the build had invented a "Wing Flavor" group (Buffalo/BBQ) on Vito's wings
  and cleared the item's prompt_for, leaving the bot with no choices AND no knowledge one was
  required. Group removed, flag restored, bot confirmed honest again.
- 2026-09-05 15:35 EDT — chat-sms v226 shipped. Melvin verdict SHIP on both fixes, verified
  against the deployed body, not the commit: the clause-scoped phantom-add guard (proven a
  strictly finer partition of the old splitter, so suppressions can only decrease — no dropped
  item is possible) and the radius-aware delivery gate. Live re-derivation over 45 shops: only
  Zio's has coords AND a radius, and only the two throwaway D-Verify shops flip to pickup-only.
  No shop that can actually deliver lost delivery.
- 2026-09-05 15:50 EDT — Item O (owner-facing Menu & Settings editor) → **built**, with one gap.
  Two independent live attack probes passed and cleaned up after themselves. The gap is the one
  my own pre-mortem named: the editor marks owner edits, but the deployed importer does not yet
  respect the mark, so a re-import erases them. The editor is safe to use; the durability is not
  there yet. Tracked as ledger 05de5bc0 rather than called done.
- 2026-09-05 19:20 EDT — import-menu-csv v38 deployed; owner-edit durability closed. Melvin
  verdict SHIP on a live throwaway shop: owner-set item price, an option-choice price, an addon
  price and a hand-added option group all survived both a no-op re-import and a changed-CSV
  re-import, byte-for-byte. Normal import behaviour measured identical to the prior deployed
  version for non-owner rows (update / insert / deactivate), and two identical re-imports are a
  hash no-op. Verified against the deployed body (v38 ACTIVE), not the commit.
  **Correction to the 15:50 entry above:** the previously deployed v37 was NOT zero-handling —
  it already skipped owner-edited ITEMS. What it lacked, and what v38 adds, is protection for
  owner-edited option GROUPS and CHOICES. Measured: an owner-set addon price of $3.00 reverted to
  $2.50 on re-import under v37 and survives under v38. So the live risk that existed today was
  erased option/choice edits, not erased items — narrower than I reported.
  **Deliberate behaviour, not a defect:** an owner-edited item that is inactive stays inactive
  even if the CSV re-adds it (the owner-edited skip short-circuits before the reactivation line).
  QA flagged this as an optional fix; I am keeping it. `owner_edited=true` + `active=false` is
  indistinguishable from an owner's explicit REMOVE_ITEM, and resurrecting an item the owner took
  off the menu is a worse failure than leaving one hidden. Owner intent wins over the CSV.
- 2026-09-05 21:05 EDT — Correction on the importer gap. I told Jason the deployed
  `import-menu-csv` had zero `owner_edited` handling, on the strength of a grep that returned 0.
  It returned 0 because the function's `index.ts` was never in the extracted download and the
  command masked the miss — I measured an absent file and reported it as evidence. Melvin drove
  the deployed function and found v37 did protect owner-edited items; the unprotected surface was
  option groups and choices. Method note for next time: `supabase functions download` does not
  reliably extract the entrypoint, so a grep over its output is not proof of what is deployed —
  drive the function.
- 2026-09-05 22:42 EDT — Item O gap CLOSED, confirmed against the deployed function rather than
  the CLI's word. `import-menu-csv` v38: an owner-set add-on price (250 -> 300) survived a
  re-import that wanted 250, while a machine-owned control add-on in the same run moved 300 -> 350
  — so the import demonstrably ran and would have overwritten the owner's price if unprotected.
  An owner-renamed group survived too, and the deployed response emitted
  `skipped_owner_edited_option_groups/_choices`, which v37 could not. `owner_edited` was set
  through the real owner JWT path, not a service-role column write. Throwaway rows deleted and
  proven gone. Owner edits are now durable; the editor is safe for real use.
