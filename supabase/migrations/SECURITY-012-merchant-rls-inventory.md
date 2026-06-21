# Security 012 — Merchant RLS Lockdown: Dependency Inventory

**Branch:** `sec/merchant-rls-lockdown` (off `wizard-05`)
**Date:** 2026-06-21
**Scope:** Close the open anon read/write hole on `shops`, `availability_overrides`,
and the shop-pause update created by `004_merchant_pin.sql`. Data-layer lockdown
only — no new auth UI, no user accounts, no admin console.

---

## The hole (confirmed)

`004_merchant_pin.sql` created three wide-open `anon` policies:

| Policy (from 004) | Table | Effect |
|---|---|---|
| `Public can read shops` | `shops` | anon `SELECT *` — **exposes `merchant_pin`** |
| `Public can manage availability overrides` | `availability_overrides` | anon `ALL` (insert/update/delete/select) — anyone can 86 any item |
| `Public can update shop pause status` | `shops` | anon `UPDATE` — anyone can pause/unpause any shop |

`merchant-ui/index.html` fetches the full `shops` row (incl. `merchant_pin`) with
the **anon key** and compares the PIN **client-side** (`handlePinSubmit`, ~line 503).
The PIN is therefore readable by anyone holding the public anon key, and the write
policies let anyone with the anon key mutate `availability_overrides` / `is_paused`
regardless of PIN.

---

## Every caller of the three exposed surfaces

Auth legend: **anon** = public anon JWT (subject to RLS); **service-role** = edge
function using `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS entirely); **authenticated**
= logged-in admin JWT (subject to RLS, satisfies the `is_admin` / tenant policies).

### A. `shops` — READS

| Caller | file:lines | R/W | Auth | Notes |
|---|---|---|---|---|
| merchant-ui PIN login | `merchant-ui/index.html:503-506` (`handlePinSubmit` → `sbGet('shops', ...select=id,name,is_paused,merchant_pin)`) | READ | **anon** | **THE HOLE** — reads `merchant_pin`. Must move server-side. |
| merchant-ui menu load | `merchant-ui/index.html:~545` (`loadMenu` → `sbGet('shops', id=eq...&select=is_paused)`) | READ | **anon** | Only needs `is_paused`. Replaced by server path. |
| diner bot | `supabase/functions/chat-sms/index.ts:1212, 1242` (`.from("shops").select("*")`) | READ | **service-role** | Bypasses RLS — **unaffected** by anon policy removal. |
| admin dashboard | `admin-dashboard/src/pages/Shops.tsx:28`, `ShopDetail.tsx:78`, `Dashboard.tsx:41` | READ | **authenticated** (admin JWT) | Satisfied by 003 admin policy — **unaffected**. |
| scrape-shop, parse-menu-pdf, go-live, onboarding-save, connect-*, provision-number, import-menu-csv, stripe-webhook | various edge fns | READ | **service-role** | All bypass RLS — **unaffected**. |

### B. `shops` — WRITES

| Caller | file:lines | R/W | Auth | Notes |
|---|---|---|---|---|
| merchant-ui pause toggle | `merchant-ui/index.html:~700` (`togglePause` → `sbPatch('shops', id=eq..., {is_paused})`) | WRITE (UPDATE) | **anon** | **THE HOLE** — must move server-side. |
| admin dashboard pause / settings / shop edit | `admin-dashboard/src/pages/ShopDetail.tsx:147,154,175,243`; `ShopHeader.tsx:34` | WRITE | **authenticated** (admin JWT) | Satisfied by 003 admin `FOR ALL` policy — **unaffected**. |
| admin dashboard new shop INSERT | `admin-dashboard/src/pages/ShopCreate.tsx:86` | WRITE (INSERT) | **authenticated** | Satisfied by 005 `Authenticated users can insert shops` — **unaffected**. |
| onboarding-save (wizard) | `supabase/functions/onboarding-save/index.ts:93,104,126` | WRITE (INSERT/UPDATE) | **service-role** | Bypasses RLS — **unaffected**. |
| go-live, connect-*, provision-number, scrape-shop, stripe-webhook | various edge fns | WRITE | **service-role** | Bypass RLS — **unaffected**. |

### C. `availability_overrides` — READS & WRITES

| Caller | file:lines | R/W | Auth | Notes |
|---|---|---|---|---|
| merchant-ui sold-out load | `merchant-ui/index.html:~560` (`loadMenu` → `sbGet('availability_overrides', ...)`) | READ | **anon** | Moves to server path. |
| merchant-ui toggle / reset | `merchant-ui/index.html:~640 applyToggle` (`sbPost`/`sbDelete`), `~680 resetAll` (`sbDelete`) | WRITE | **anon** | **THE HOLE** — must move server-side. |
| diner bot | `supabase/functions/chat-sms/index.ts:289` (`.from("availability_overrides")...`) | READ | **service-role** | Bypasses RLS — **unaffected**. |
| admin dashboard sold-out manager | `admin-dashboard/src/pages/ShopDetail.tsx:111,130,132,140` | READ/WRITE | **authenticated** | Satisfied by 003 admin `FOR ALL` policy — **unaffected**. |

### D. `menus` / `menu_items` — anon READ (from 004, NOT in scope but reviewed)

| Caller | file:lines | R/W | Auth | Notes |
|---|---|---|---|---|
| merchant-ui menu render | `merchant-ui/index.html:~550` (`sbGet('menus'...)`, `sbGet('menu_items'...)`) | READ | **anon** | Non-sensitive menu data. **Kept** as anon read (see decision below). |

### E. Legacy / out-of-scope pages (verified NOT dependent)

- `signup/dashboard.html:323,339` — reads `tenants` only (different table). Not affected.
- `projects/sprintai/portal/index.html`, `portal/dashboard.html` — placeholder stubs
  ("Replace SUPABASE_ANON_KEY with your actual key"); do not reference shops/availability/pin.
- `projects/sprintai/admin/index.html` — uses unrelated `sprintai_*` tables. Not affected.

---

## Conclusion

**`merchant-ui/index.html` is the SOLE anon dependent** on the three exposed
surfaces. Every other read/write is either **service-role** (edge functions, RLS-exempt)
or **authenticated admin JWT** (satisfied by the pre-existing 003/005 policies).

Therefore the fix is contained:
1. Revoke the three wide-open anon policies (migration 012).
2. Revoke anon SELECT/UPDATE/INSERT/DELETE grants on `shops` and
   `availability_overrides` so anon cannot reach them even by table privilege.
3. Route merchant-ui PIN verify + availability/pause writes through a new
   `merchant-auth` edge function (service-role, server-side PIN check, short-lived
   signed token). No working flow regresses.

### Decision: keep `menus` / `menu_items` anon read

These two anon READ-only policies expose **non-sensitive menu data** (item names,
prices, categories). The merchant-ui menu render is the consumer. Closing them is
out of this task's scope and would force a larger merchant-ui rewrite for no
security gain (no secret columns). Left as-is and flagged for the future
SprintAdmin spec if menu reads should also move behind auth.
