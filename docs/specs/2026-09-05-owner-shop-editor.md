# Owner-facing shop editor — spec

**Origin:** Jason, 2026-09-05 10:04. The editing surface is **owner-facing**. It lives in the
shop owner portal beside the Demo Kit page. An owner maintains their own menu; Erin, Jason, and
the product owner act on any shop through the *same* screens by previewing as that owner.

**Why the shape matters.** An admin-only editor means Jason owns every menu change for every
restaurant forever. That fails the North Star outright — it is a human touch per restaurant.
The first build (37142f8) put the editor in the admin dashboard and was reverted (b192d65).

**Reuse:** branch `shop-editor-admin-shape` holds the reverted work in full — option-group
editing, hours editor, validation, price handling. Take the logic; move the surface.

**Already on main and KEPT (do not redo):**
- migration `097_owner_editable_options.sql` — `owner_edited` on `option_groups` /
  `option_choices`, plus the owner INSERT and DELETE RLS policies. **Applied to production.**
- `import-menu-csv` honours `owner_edited`. **Committed, NOT deployed.** Deploying it is out of
  scope here and gated on Melvin — it touches real shops' menus on re-import.

---

## Pre-mortem — why this fails, and what stops each

1. **It invents menu data again.** The first build fabricated a "Wing Flavor" group
   (Buffalo/BBQ) on Vito's bone-in wings and cleared the item's `prompt_for`, leaving the bot
   with no choices *and* no knowledge that a choice was required — a silent downgrade from
   honest ignorance to confident wrongness, on a shop with live testers.
   → **Mitigation (hard AC):** the editor writes only what the owner typed. No seed lists, no
   example choices, no defaults in code or fixtures. `prompt_for` is cleared **only** by an
   owner submission that supplies at least one choice. Zero writes to any real shop during the
   build; use a throwaway shop and name it in the report.
2. **Wrong surface again.** → Page renders under `ShopOwnerRoute`, appears in `shopOwnerNav`,
   self-scopes to the owner's shop the way `ShopOwnerDemoKit` and `ExpoScreen` do. No new
   admin-only screen. Super-admin reaches it through owner preview, not a separate path.
3. **RLS lets the save fail, or lets it reach across tenants.** Owners previously had no INSERT
   or DELETE policy at all. → Prove both directions against the live DB **as an owner JWT, not
   service-role**: an owner can create/rename/delete a group and choice on their own shop, and
   the identical write against another tenant's shop is rejected.
4. **Owner's edit is erased by the next re-import.** → `owner_edited` must be set by every
   create/update path in this page (the old bug: `editMenuItem`/`addMenuItem` never set it).
   The import side is already written but undeployed — state that plainly, do not deploy it.
5. **It never reaches a human.** Admin auto-deploy has been dead since 8/22. → Deploy to the
   `sprintai-chat-admin` site explicitly and verify through the **front door**
   `getsprintai.com/admin`, not a `*.netlify.app` origin. Confirm the served bundle hash is new.
6. **Money bug.** → Prices entered in dollars, converted to cents exactly once, rounded once.
   `$0.00` renders explicitly rather than as blank.

## Acceptance criteria

- AC1 New owner page reachable at `/menu`, labelled in `shopOwnerNav` beside Demo Kit, guarded
  by `ShopOwnerRoute`, self-scoping to the signed-in owner's shop.
- AC2 Items with an unresolved `prompt_for` are surfaced as a fillable question. Answering it
  creates the group + choices, marks them `owner_edited`, and clears `prompt_for`. Submitting
  nothing changes nothing.
- AC3 Full option-group/choice CRUD: add, rename, remove, required flag, min/max select, price.
- AC4 Item edit/add/delete reuses the existing mutations and sets `owner_edited` on every path.
- AC5 Cross-tenant write rejected under an owner JWT; own-shop write succeeds. Both proven live.
- AC6 `tsc` clean, build clean. Deployed to `sprintai-chat-admin`; new bundle hash confirmed
  served at `getsprintai.com/admin`.
- AC7 No real shop's data modified by the build. Vito's and NJB untouched — testers are live.
- AC8 No invented option choices anywhere in code, fixtures, tests, or the DB.

## Out of scope
Deploying the `import-menu-csv` `owner_edited` change (Melvin gate, separate). Off-domain menu
import (backlog 2a794a96 / b0656741). Extraction of modifiers by the crawler (backlog 7f0fc459).
