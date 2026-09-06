# BUILD SPEC — Owner-facing Menu & Settings editor

Lead: OrderFare. Authority: Jason, 2026-09-05 (clarified 10:04 — owner-facing, not admin).
SUPERSEDES the admin-tool version of this spec. Design reported to Jason before building.

## Shape — read this first, it is the thing that changed

This is an **owner-facing** feature in the shop owner portal, alongside the Demo Kit page.
The restaurant owner maintains their own menu and settings. Erin, Jason, and the product
owner act on any shop through the SAME screens with wider scope. There is no separate admin
tool and no second implementation.

Why: if it is admin-only, Jason owns every menu change for every restaurant forever. Fine at
three shops, impossible at fifty. Owner-facing makes it do double duty — we close gaps during
testing, and owners maintain themselves after launch.

## What already exists — verified 2026-09-05, do not rebuild it

The "same screens, wider scope" mechanism is already in the codebase. Use it, do not invent
a parallel one.

- `admin-dashboard/src/lib/useOwnerTenant.ts` returns `{ isOwnerView, effTenant, ... }`:
  the owner's own tenant, or for a super-admin in owner-preview mode, the tenant they picked.
- `Layout.tsx` already renders an admin/owner mode toggle plus a shop picker for super-admins
  (`isSuperAdmin && mode === 'owner'`), and a `shopOwnerNav` sidebar.
- `ShopOwnerDemoKit.tsx` is the reference implementation of an owner page: it reads
  `useOwnerTenant`, scopes its query by `effTenant`, and accepts `?shop=<uuid|slug>` to
  deep-link and set preview. Copy that pattern exactly.
- RLS already scopes `shops`, `menu_items`, `option_groups`, `option_choices` by tenant, with
  super-admin full access. The wider scope is the existing policy, not new code.

Net: this is a new page in an existing frame, not new plumbing.

## Immediacy — PROVEN, build on it

Requirement: changes take effect for the ordering bot immediately, no redeploy, no cache bust.
This already holds. `chat-sms` `loadEffectiveMenu()` reads `menus`, `menu_items`,
`option_groups`, `option_choices` fresh from the database on every single message. There is no
cache layer, no menu snapshot, and no build step between the table and the prompt.

Demonstrated live on Vito's QA on 2026-09-05: a `Wing Flavor` group with four choices was
inserted, and the very next new conversation answered "what wing flavors do you have" with
"Mild, Hot, Honey BBQ, and Garlic Parmesan (that one's a $0.75 add-on)" — while still
correctly saying it did not know the boneless flavors. No deploy, no restart. The test data
was removed afterwards; the shop is back to its real 39 option groups.

Do not add caching to the menu read path. Immediacy is a product requirement now.

## Where it lives

New owner nav item **"Menu & Settings"**, between "At a Glance" and "Demo Kit" in
`shopOwnerNav`. Route `/menu-settings`, wrapped in `ShopOwnerRoute`. Add to
`shopOwnerBottomNav` only if it displaces nothing important — the mobile bar is full.

Two tabs on one page: **Menu** and **Settings**.

## Menu tab — bulk-friendly, one list

An owner correcting 60 prices or filling 12 option lists must not click through 60 screens.

- ONE editable list of every item, grouped by category. Not a form per item, not a modal per
  item, not a wizard.
- Inline edit in place: name, price, description, category, available/sold-out. Click a cell,
  type, move on. Tab and Enter move between cells like a spreadsheet.
- Edits accumulate as pending changes and commit on one explicit **Save**, which first shows
  a plain-language diff: "12 prices changed, 3 items renamed, 1 item hidden — save?" A bulk
  editor without a confirmable diff is how someone wrecks a live menu with one fat finger.
- Search box and category jump. A 220-item menu must stay navigable on a phone.

### The filter strip — one place to fix menu problems, not two

Three counts across the top, each filtering the same list:

- **Needs answers (N)** — items with `prompt_for` set and no options: the importer knew a
  choice was required and could not capture the choices. This is the wing-flavor and salad-
  dressing case we keep hitting. Vito's has 6.
- **Low confidence (N)** — items with `flag_review` set by menu curation. Today these live in
  a separate "We have questions" section in the admin MenuTab. Route them into THIS list.
  One surface for menu problems.
- **All items (N)**

Answering either flag clears it in place, in the list, without navigating away.

### Options editing — inline, expandable

Clicking an item expands its options underneath the row, still in the list:

- add / rename / remove an option group; set required, min_select, max_select
- add / rename / remove a choice; set its extra charge
- For a "Needs answers" item, the group is pre-created from `prompt_for` (name derived from
  the question, `required = true`, `min_select = 1`, `max_select = 1`) so the owner only types
  the flavor names. Filling it clears `prompt_for`.
- Bulk paste: accept a comma or newline separated list into a "add several choices" box.
  Twelve option lists must not be 60 individual clicks.

**Money rules — cart accuracy is zero-tolerance:**
- Prices entered in dollars, stored in cents, rounded exactly once. Never let a float reach
  the database.
- A choice with no charge shows **$0.00** explicitly. Blank is not a price. A silent zero on
  a paid topping under-charges the shop on every order forever.
- Removing an option or item must not retro-change an in-flight cart. Carts hold their own
  `cart_json` with captured prices; confirm a deletion cannot rewrite a cart mid-order, and
  say so in the handback with the evidence.

## Settings tab

Shop-specific config only, clearly labelled as affecting this shop alone:

- **Store hours** — `open_hours`. Existing shape `{"mon":[{"open":"11:00","close":"22:00"}]}`,
  multiple ranges per day. Match it exactly; the ordering engine parses this and a malformed
  value closes the shop. Validate in the form, never write bad shape.
- **Delivery hours** — `delivery_hours`, same shape.
- **Delivery on/off** — `delivery_enabled`. State plainly that off makes the bot refuse delivery.
- **Shop instructions** — `ai_instructions`. Warn inline that the menu overrides instructions
  on item names and prices; that precedence exists in the prompt and owners will otherwise
  write instructions that silently lose.
- **Wing policy** — `wing_flavors_included`, `wing_mix_extra`. The prompt currently says
  "NOT CONFIGURED" and makes the bot refuse to guess. This is where it gets configured.

NEVER expose: `is_test`, `protected`, `tenant_id`, `phone_number_e164`, `telnyx_*`,
`twilio_*`, `stripe_*`, `toast_*`, `merchant_pin`, `subscription_*`, `founding_promo`.
Money, identity, and routing are not shop config and an owner must never see them.

## Chat and form are ONE operations layer — the constraint that matters

Jason, 2026-09-05 10:10: the existing admin chat lives on this same screen, and the chat and
the structured editor must be two views of the SAME operations. Anything the chat can change,
the form can change, and vice versa. If they diverge the owner learns two mental models and
we get two sets of bugs.

Enforce that STRUCTURALLY, not by discipline. There is exactly one implementation of each
operation; chat and form are two parsers that call it.

### What already exists — build on it, do not replace it

`supabase/functions/admin-chat/index.ts` already has the right architecture:
- The LLM NEVER executes. It returns a structured PROPOSAL. (`ADMIN_TOOLS`, 9 intents.)
- The backend validates the proposal, shows a confirmation card, and only then runs
  `executeAction()`.
- `executeAction()` writes, logs to `admin_action_log` with before/after snapshots and an
  undo token, then RE-READS fresh state and returns a `status_header` built from the database.
- `UNDO` is a first-class intent.

`ConversationalAdminChat.tsx` is the client. It already carries the menu-item mutations.

### The change: extract an operations registry

Lift the `switch (proposal.intent)` in `executeAction()` into a named registry. Each operation
declares:
- `id` — e.g. `SET_ITEM_OPTIONS`
- `input_schema` — JSON Schema, used BOTH as the LLM tool schema and as form-submit validation
- `validate(args, ctx)` — resolves names to ids, refuses ambiguity, returns typed errors
- `apply(args, ctx)` — mutates, logs, and returns `{ result_sentence, affected }`

Then:
- **Chat path:** English → LLM proposes an op + args → validate → confirmation card → apply.
- **Form path:** clicks/edits → the SAME op + args, built directly → validate → diff dialog → apply.

The LLM is only a parser that turns English into an op call. The form is a different parser
that turns clicks into the same op call. Divergence becomes impossible because there is one
`apply()`.

Deliberate and permitted difference: **confirmation UX**, not operations. Chat confirms one
action at a time with a card, because its input is ambiguous. The form confirms a batch with
one diff dialog, because per-cell cards for a 60-price edit would be unusable. Both go through
the same validated ops and the same log. Do not let this become a second write path.

### Operations to add to the registry

Existing 9 stay as they are. Add:
- `SET_ITEM_OPTIONS` — add/rename/remove option groups and choices on an item
- `SET_ITEM_FIELDS` — name, price, description, category
- `SET_STORE_HOURS` / `SET_DELIVERY_HOURS`
- `SET_DELIVERY_ENABLED`
- `SET_SHOP_INSTRUCTIONS`

**Do not conflate `delivery_enabled` with `delivery_paused_until`.** The existing
PAUSE_DELIVERY / RESUME_DELIVERY intents set a temporary same-day pause. The editor's
"delivery on/off" is the permanent `delivery_enabled` flag. Two different things with two
different lifetimes; merging them is a real bug. Keep both, label both plainly.

### A chat change appears IMMEDIATELY in the structured list

`apply()` returns `affected` — the table plus row ids it touched. Both callers run through one
client-side wrapper that invalidates the same React Query keys the list renders from. The owner
says "add hot, mild and BBQ to wings" and watches three flavors appear in the list on the same
screen. That is how they verify it landed; no guessing, no refresh.

### Confirm the RESULT, never the intent — and never claim a change not made

`result_sentence` is generated by `apply()` from a **post-write read-back of the entity**, not
from the proposal and never by the LLM. Write, then SELECT, then format the sentence from what
the SELECT returned.

- Right: "Wings (Bone-In) now have three flavors: Hot, Mild, BBQ."
- Wrong: "I've updated the wings."

If the read-back does not show the change, say so plainly and do not report success. This is
the same rule we just enforced on the ordering bot: never invent an action. An honest failure
beats a false confirmation — the owner will trust this screen with their live menu.

### Ambiguity is refused, never guessed

The existing `needs_clarification` / `clarification_options` pattern is MANDATORY for the new
ops. Vito's has both "Wings (Bone-In) - 10 Pieces" and "Wings (Boneless) - 10 Pieces"; "add
flavors to wings" is ambiguous and must ask which, with tappable options. Never guess an item
on a 221-item menu.

### Voice — nothing to build

Jason dictates with Wispr Flow. Dictation is OS-level, so a standard text input gets speech for
free. Do NOT build speech capture, a mic button, or the Web Speech API.
Just do not break it: a plain `<textarea>` / `<input type="text">`, no `contenteditable`, no
custom keydown handling that swallows inserted text, no autocomplete widget that steals focus.
Send is an explicit button plus Cmd/Ctrl+Enter — not bare Enter, because dictation inserts
newlines mid-thought and would fire the message early.

## Backend — unchanged from the earlier dispatch, keep this work

- Migration `097_owner_editable_options.sql`: `owner_edited` on `option_groups` and
  `option_choices`; INSERT and DELETE RLS policies for shop owners on both, mirroring the
  existing tenant predicate exactly. Owners currently have SELECT and UPDATE only, so adding
  a wing flavor fails today.
- `import-menu-csv`: skip deletion/overwrite of option groups and choices with
  `owner_edited = true`, and report the count skipped rather than doing it silently.
- Fix the live bug: the existing menu item mutations never set `owner_edited = true`, so an
  owner's price correction is erased by the next re-import.
- New `menu_edit_log` (shop_id, tenant_id, actor, table, row_id, before, after, at). A bulk
  editor that fifty owners touch needs "who changed this and when" to be answerable. Insert
  on every write. Super-admin readable, plus expose through `qa_ro`.

## Acceptance — Melvin verifies, no self-reports

1. A shop owner logged into their own account sees only their shop and can fill a wing-flavor
   list; the bot enumerates those exact flavors in a real conversation on the next message,
   with no deploy. Drive the real endpoint.
2. A super-admin in owner-preview mode does the same on a different shop through the identical
   screen. No separate admin tool exists.
3. A second tenant's owner can neither see nor modify the first shop's menu or options. Test
   with a real JWT for the other tenant, not by reading the policy.
4. Editing 20 prices takes one save and produces an accurate diff summary before committing.
5. A hand-added wing flavor SURVIVES a menu re-import. Actually re-run the import.
6. Malformed store hours are rejected by the form and never written; valid hours change the
   bot's open/closed behaviour in a live conversation.
7. A $0.00 choice displays as $0.00 and adds exactly $0.00 to a real cart total.
8. `flag_review` and `prompt_for` items both appear in the one list and clear in place.
9. No denied column from the list above is writable or visible anywhere in the page.
10. Every operation is reachable from BOTH chat and form, and both produce an identical
    database result and an identical `admin_action_log` entry. Prove it op by op — this is
    the constraint Jason named, so it gets tested op by op, not spot-checked.
11. "Add hot, mild and BBQ to wings" in the chat makes three flavors appear in the structured
    list on the same screen with no refresh, and the chat's reply names the resulting three
    flavors rather than describing an intent.
12. An operation that silently fails to write must report failure. Force one (e.g. revoke the
    RLS grant mid-flight) and confirm the chat does NOT claim success.
13. "Add flavors to wings" with both a bone-in and a boneless item asks which, and does not
    guess.
14. Dictating a multi-sentence instruction into the chat input does not submit early and does
    not lose text.

## Out of scope
No global config, no prompt editing, no code, no cross-shop bulk actions. Those are the GLOBAL
category and stay with the builder and Melvin.
