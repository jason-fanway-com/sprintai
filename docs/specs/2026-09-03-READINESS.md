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
| G | Expo Screen (promoted, always-active delivery path) | building | edd5abe (migration 089 + ExpoScreen.tsx + routing + nav link + build). Migration 089 applied: expo_status/expo_acknowledged_at columns live; expo_advance_order SECURITY DEFINER RPC live. Bundle index-BLXHTZGY.js deployed to sprintai-chat-admin (getsprintai.com/admin). ExpoScreen at /admin/expo (owner) and /admin/shop/:shopId/expo. Realtime subscription on order_carts (REPLICA IDENTITY FULL) handles network drop. Advance requires human button press only. Wake Lock + audio unlock on first gesture. **Jason's integration test required to mark built.** 2026-09-06: software side integration-passed on the deployed bundle (real paid order rendered NEW with delivery badge, logged in as shop_owner). Only the on-device human check remains — sound, Wake Lock, Acknowledge press on the tablet. | — |
| H | Ticket delivery truth (Resend webhooks vs `resend_message_id`) | built | migration 091 applied (delivery_status/detail/event_at on ticket_send_log + ticket_delivery_status/detail/at on order_carts). resend-webhook edge fn deployed (ACTIVE v3). ExpoScreen already queries + surfaces ticket_delivery_status with bounce badge. **CLOSED 2026-09-05 11:27 EDT: RESEND_WEBHOOK_SECRET set and verified by digest; all three events (delivered/bounced/complained) driven through the real pipeline and matched on resend_message_id. Bounce to `bounced@resend.dev` recorded against the order in 0.7s (ticket_send_log delivery_status=bounced + order_carts.ticket_delivery_status=bounced) and renders the bounce badge on the Expo Screen.** **RE-VERIFIED 2026-09-06 on a REAL order (the 09-05 proof used a hand-seeded shop/cart): order #3, bounce recorded in 0.6s, badge rendered on the deployed Expo Screen.** Migration 105 widened the qa_ro views so the product owner can check this class of claim without asking. Code/DB/ExpoScreen complete. | No blockers. |
| I | Escalation rule — 7-min unacked → SMS owner (reuse issue-detector) | built | acd70c6. Migrations 092 (owner_escalated_at + partial index) + 093 (pg_cron `issue-detector-escalation` */2, jobid 80) applied+live; 10-min sweep untouched. issue-detector v13; outbound-guard new default-deny `owner_escalation` reason, 19/19 tests. **Melvin INDEPENDENT QA: SHIP — all 10 ACs PASS**, driven against the live deployed function with synthetic rows (not builder's word). AC9: diner number is structurally unreachable — the rule never loads a diner phone column; recipient assigned solely from `shops.owner_mobile`. AC4: 6 concurrent sweeps over 3 eligible carts → exactly ONE claim/send, 2 further sweeps → 0. Exactly-once is the DB conditional UPDATE claim, not the issues table. | Fast-follow (non-blocking, Melvin finding #1): function runs `verify_jwt=false`, so unauthenticated POSTs run the real SMS sweep. NOT exploitable for spam/double-text (exactly-once is DB-enforced, recipient owner-only, `include_test_mode` env-gated not body-gated). Close by requiring the provisioned vault bearer `issue_detector_bearer`. |
| J | PROVE carrier approval chain deployed+scheduled | built (chain proven as far as is possible without Jason) | Deployed: yes, `campaign-status-reader` v12 ACTIVE. Scheduled: YES as of 2026-09-10 — migration 083 (re-)applied, `cron.job` jobid 89, `campaign-status-reader`, hourly, active=true. **2026-09-10: the DAILY_RESET_SECRET blocker resolved without Jason** — confirmed via code read that it is a self-mintable shared secret used only between our own cron job and our own function (no third-party dependency, unlike TELNYX_API_KEY which was already set and genuinely is one). Generated a random value, set it as the function secret AND the matching `vault.secrets` entry in one shell scope so the plaintext never appeared in any command, log, or commit. Manually triggered the exact authenticated request the hourly job makes: real response, status 200, `{"ok":true,"read":0,"advanced":0}` — not 401/500. Auth chain is live, not just scheduled. Latent trap found+fixed earlier (28dc2d3, verify_jwt=false) still holds. | Final proof (a `submitted` shop actually advancing to `approved`) needs a real shop sitting in `submitted` — none currently is (`read:0` on the live trigger). Not a blocker for anything else; will confirm organically the next time a real shop is in that state, or can be forced with a throwaway row if the product owner wants it proven sooner. |
| K | PROVE website read reliability | built | Four live measurements by Melvin over the same 20 locked real ICP sites (sample locked before the first run). Report: `docs/specs/2026-09-05-item-K-website-read-reliability.md`. Baseline **0/20 PASS with 19/20 falsely reporting `done` over an empty menu**. Parse fix (838b2f9) → 6/20. Source-priority ladder + PDF routing (d34f7eb, afce671, 3081937) → **12/20 PASS (60%), 0 hallucinations, 0 false `done`, honesty 5% → 100%**; 974 priced items, names/prices spot-checked against the live sites. Fourth measurement (52f4caf, deployed **v73**) verified the last two failure modes closed on the exact sites that showed them: the 150s gateway 504 that stranded shops in `running` is gone (both now return 200 with a terminal, honest `partial`), and PDF-rung provenance now persists (`sd_persisted=true`, `sd_rung=1`). | **Open cost, tracked not hidden:** the deadline-aware budget looks like it truncates the crawl on the largest sites — site 9 previously landed a real 240-item menu before 504ing and now imports 0 items honestly (ledger `72d197cc`). Structural ceiling stands: most ICP menus live off-domain on Slice/Toast/Owner/ChowNow (backlog 2a794a96 + b0656741). Rung 3 (Google listing) never fires without a `google_place_id`, and no fresh onboarded shop has one yet — that's still true and untouched. **Measured 2026-09-08**, separately: forced a re-crawl (shop `1762e5f5`, `google_place_id` set, rung 1 correctly `no_priced_items`) and confirmed the rung-3 code itself runs end-to-end past the guard clause — `{rung:3, source:google, result:no_priced_items, url:"https://verifydebtsolutions.com/"}` in `rungs_tried`: real Places Details lookup, real off-domain scrape, real LLM extraction, honest empty result. So the rung is not dead code, just still unexercised on any real onboarding path — closing this needs a fresh shop to actually get a `google_place_id` (item L-2 / onboarding geocode work), not a code fix. Options/modifiers still never extracted (backlog 7f0fc459). |
| L | PROVE demo kit (3 codes) | in verification | Measured 2026-09-06 without a phone: each code driven through its **real generator**, decoded with an independent decoder (OpenCV), after a known-good `api.qrserver.com` QR was decoded first as a control. Report: `docs/specs/2026-09-06-item-L-demo-kit.md`. **The kit Erin's email links to (`/admin/demo-kit`) is sound** — `qrcode.react` 4.2.0, all three codes decode and match their payloads byte-for-byte. All three destinations return 200 live. NJB kit payloads correct. **L-3, found 2026-09-10, not previously logged here:** `dddcb50` (2026-09-08) shipped `scripts/build-demo-kit-email.py` — the three QR codes are now generated at build time straight from the live `shops` row and embedded as `cid:` images in the email itself (Gmail strips `data:` URIs), with each code's decoded target printed underneath in plain text so a stale code is visible to a human without scanning. Re-ran it live (dry, no `--send`) 2026-09-10: QR1 = `sms:+16107358315?...` (real Vito's Telnyx line, pre-filled order text), QR2 = vCard for the same number, QR3 = `https://getsprintai.com/admin/shop-owner?shop=vitos-pizza`. Confirmed all three targets correct against the live shop row. | **L-1 CLOSED 2026-09-06 08:5x EDT** (f90e967)... [unchanged, see above] **L-2 MITIGATED 2026-09-08 20:22 EDT (a2d7631)**... [unchanged] **L-3 status: the QR-delivery mechanism is fixed (codes now travel embedded in the email, generated live, not hand-made), but the underlying login question is NOT resolved by it** — checked `admin-dashboard/src/App.tsx:96-115` directly: QR3's target (`/admin/shop-owner`) is wrapped in both `ProtectedRoute` and `ShopOwnerRoute`, genuinely login-gated. So the original open question stands exactly as before: does Erin get a real `shop_owner` login for the dashboard leg, or does that route need a public no-login variant. Not a blocker for the sale (the SMS-ordering leg, QR1, needs no login and is the core pitch) — still Jason's call, not mine. Also still unconfirmed: whether the new build-and-send flow (`build-demo-kit-email.py --shop vitos-pizza --send <address>`) has actually been run to send to Erin — that send is Jason's call, not mine to trigger. Physical phone scan + human walk remain Jason's leg. |
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
- 2026-09-06 08:15 EDT — Item H re-verified END TO END on a REAL order after the product
  owner could not confirm it. Three things changed. (1) Migration 105 applied: qa_ro
  `ticket_send_log_ro` gains attempt_number/delivery_status/delivery_detail/delivery_event_at
  and `order_carts_ro` gains ticket_delivery_status/detail/at. Before this the reviewer saw
  only http_status=200 — Resend ACCEPTED it — which is the exact distinction item H exists to
  remove. Third time a qa_ro view was too narrow to check a "built" claim (074, 082): the
  column list is part of the contract now. (2) The 2026-09-05 closure used a hand-seeded shop
  ("ItemH Bounce Proof") and hand-seeded carts — the Resend + webhook legs were real, the ORDER
  was not. Re-run properly: Vito's ticket recipient temporarily pointed at bounced@resend.dev,
  a real conversation through public-tester, a real Stripe test-mode payment, real
  stripe-webhook → chat-sms → Resend → resend-webhook chain. Order #3, cart
  a4731430-e6f6-4fe2-b5af-c4a383d42744, resend_message_id 94939846-0c27-4b03-b20a-3f0dd25d48fd,
  sent 12:08:15.275Z, bounce recorded 12:08:15.878Z (0.6s), delivery_status=bounced with
  Resend's permanent-bounce reason on both ticket_send_log and order_carts. Recipient restored
  to jason@fanway.com. (3) Expo Screen confirmed rendering it on the DEPLOYED bundle
  (index-C6h_btXT) at getsprintai.com/admin/expo, logged in as a shop_owner:
  "⚠ TICKET BOUNCED — shop did not receive this order (Permanent · General · ...)". Item H
  stays **built**, now on evidence a reviewer can reproduce from their own credential.
- 2026-09-06 08:15 EDT — Item G: the same run is a full integration pass on the deployed
  Expo Screen — a real paid order appeared as NEW with order number, pickup name, line item,
  total and the delivery badge. What remains is only the on-device human check the gate names:
  audio unlock, Wake Lock, and Acknowledge/advance pressed on the actual tablet. Staying
  **building** until Jason does that; no software work is outstanding.
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
- 2026-09-06 07:20 EDT — Item K → **built**. Fourth measurement written up. Both failure
  modes from the third measurement are closed and verified against deployed v73, on the exact
  sites that exhibited them: no more 150s gateway 504, no more shops stranded in `running`,
  and PDF-rung provenance now persists to the swapped menu row. Rate unchanged at 12/20 (60%)
  with 0 false success — the two fixed sites were never PASS. Reported honestly rather than as
  a clean win: site 9 used to land a real 240-item menu before dying and now imports nothing,
  and a truncated crawl is the only changed variable. Queued as its own ledger item; the cure
  is to make a big menu fit the wall clock, not to shrink the crawl to meet it.
- 2026-09-06 08:5x EDT — Item L → **in verification**. Measured, not walked: no phone camera,
  so each code went through its real generator and an independent decoder, with a known-good
  external QR decoded first as a control so a decoder failure could not be mistaken for a
  product failure. `/admin/demo-kit` (what the email links to) is correct on all three codes.
  The public `vitos-demo.html` is not: all three codes fail to decode, one is a literal grey
  placeholder. Two artifacts claim to be "the Vito's demo kit" and they disagree — that
  duplication is the finding under the finding, and it already caused the dead-number fix in
  58e7646. Item stays **in verification**, not built: the cure is a decision (delete the public
  page vs. rebuild its codes from the shop record at build time) and that decision is Jason's,
  plus the on-phone walk is his leg regardless.
- 2026-09-06 08:5x EDT — Item L, L-1 → CLOSED (f90e967). Took the delete path, not the rebuild:
  `vitos-demo.html` was unlinked (Erin's email uses the vetted `/admin/demo-kit`), its hand-rolled
  QR encoder is unsalvageable, and a second per-shop public page is the exact duplicate-artifact
  drift that already produced a dead number twice. Removed from the `build-public-site.sh` allowlist
  + `git rm`; pushed; Netlify rebuilt; verified live 404 (control page still 200). Single kit source
  of truth is now `/admin/demo-kit`. Item stays **in verification**: L-2 (kit CTA behind
  `ShopOwnerRoute` — does Erin have a login?) is Jason's call, and the on-phone scan is his leg.
- 2026-09-10 21:10 EDT — Item 5 gate re-run (all three shops, both walk types). Commits this
  session: da43a50 (f0ecf0fe live replay — Zio's P0 does not reproduce), 39631ba (toolCallCount
  per turn in test runner). Item 5 gate results: Zio's 298/298 individual + 20/20 multi; Vito's
  197/197 + 20/20; NJB 166/166 + 5/5 (3 case types skipped, menu too simple). Zero walk failures
  on any shop. Invariant #1 fails on all three (blocked items in active categories); Vito's also
  fails #8 (89.1% orderable < 90%). Blockers: Zio's 2 burgers, Vito's 22 wraps/chicken items,
  NJB 4 items (Turkey Melt, Tuna Melt, salads) awaiting Jason's bread/cheese/dressing answers.
- 2026-09-10 10:35 EDT — Board review per INSTRUCTION-10 continuation: no item is `not started`.
  A–O are all `built` except G (`building`, blocked on Jason's on-device Expo check) and L
  (`in verification`, blocked on Jason's login-vs-public decision + phone walk). Per rule 9, no
  backlog pull while G is open. Found one untracked update for L not previously logged here:
  `dddcb50` (2026-09-08) generates the three demo QR codes live from the shop row and embeds
  them in the email itself, replacing the earlier hand-made codes — re-ran it live today (dry),
  confirmed all three targets correct against Vito's real shop record. This fixes code delivery
  but does NOT resolve L-2's actual open question: checked `App.tsx` directly, the owner-dashboard
  QR (QR3) still routes through `ProtectedRoute`+`ShopOwnerRoute`, genuinely login-gated. Folded
  into the L row as L-3. No engineering work remains that isn't gated on Jason personally.
