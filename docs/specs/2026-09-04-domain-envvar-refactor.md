# Domain env-var refactor (INSTRUCTION-11 Phase 4 — env prep ONLY)

**Date:** 2026-09-04 · From: Jason → OrderFare
**Parent spec:** `docs/specs/2026-09-04-INSTRUCTION-11.md` (Phase 4). Its rules bind here.

## Goal
Make the future domain switch **one value change, not 59 edits.**
BRAND-NEUTRAL: the value stays `getsprintai.com` and **nothing visible changes**.
Do NOT touch visible brand copy, SMS copy, the email sender identity, or legal text.

## Scope
- **Live edge functions:** `supabase/functions/*` (except `chat-sms/`).
- **Served static:** the files/dirs in `scripts/build-public-site.sh` allowlist only
  (root `*.html` allowlisted, `signup/`, `signup-page/`, `checkout/`, `welcome/`, `demo/`).
- **OUT OF SCOPE (do not edit):** `projects/sprintai/**`, `docs/**`, `tests/**`,
  `*.md`, demo/report emails, `netlify/functions/**` legacy, admin-dashboard build
  artifacts. Report their remaining `getsprintai.com` count; do not change them.

## HARD EXCLUSIONS — never touch
1. Any string containing **`@getsprintai.com`** (email addresses / `from:` sender /
   `mailto:` / test allowlist `e.endsWith("@getsprintai.com")`). Sender identity is
   DNS-gated (Phase 4 blocked) and SMS-adjacent.
2. **`supabase/functions/chat-sms/`** — 10DLC compliance copy. Do not open it.
3. Legal body text in `terms.html` / `privacy.html` (Phase 2, blocked). You MAY convert a
   same-origin nav/footer `<a href>` on those pages to root-relative, but do not alter
   legal sentences or the `SprintAI LLC` entity string.
4. `<link rel="canonical">`, `og:*`, `twitter:*` meta URLs, and any URL inside email HTML
   bodies → keep **absolute** `https://getsprintai.com/...` (crawlers/mail clients need
   absolute). These stay hardcoded for now; count them in the report.

## A. Edge functions — one env var
1. Add `supabase/functions/_shared/site-url.ts`:
   ```ts
   // Single source of truth for the public site base URL.
   // Backward-compatible: honors existing `URL` env, falls back to current domain.
   export const SITE_URL: string =
     Deno.env.get("PUBLIC_SITE_URL") ?? Deno.env.get("URL") ?? "https://getsprintai.com";
   ```
2. Replace hardcoded `https://getsprintai.com` **site URLs** (NOT `@` addresses) in live
   functions with `SITE_URL` via `import { SITE_URL } from "../_shared/site-url.ts";`:
   - `create-subscription/index.ts:72` — replace the `Deno.env.get("URL") ?? "..."` with `SITE_URL`.
   - `create-checkout/index.ts:349,350` — success/cancel fallbacks.
   - `onboarding-save/index.ts:129,164` (setup links), `:532` (privacy href in email body —
     this one is a link, allowed; leave the `from:` and any `@` address untouched).
   - `stripe-webhook/index.ts:620,1303` (site href links in email body). Leave `:372,:633,:1323`
     (`from:` sender) and `:1290` (`mailto:`/address) untouched.
   Fallback resolves to `getsprintai.com` → zero behavior change until `PUBLIC_SITE_URL` secret set.

## B. Static HTML/JS — one shared config
1. Add root **`config.js`** and add it to the `PUBLIC_FILES` allowlist in
   `scripts/build-public-site.sh`:
   ```js
   // Single source of truth for the public base URL on static pages.
   window.SITE_BASE_URL = 'https://getsprintai.com';
   ```
2. For each served static page (allowlist only): where **JavaScript** constructs a
   `getsprintai.com` URL, include `<script src="/config.js"></script>` (before the script
   that uses it) and read `window.SITE_BASE_URL`. Provide inline fallback:
   `const BASE = window.SITE_BASE_URL || 'https://getsprintai.com';`
3. For **same-origin `<a href="https://getsprintai.com/...">`** markup links in served
   pages → convert to **root-relative** (`href="/..."`, `href="/#pricing"`, `href="/"`),
   which removes the domain entirely and renders identically on getsprintai.com. Do NOT
   touch canonical/OG/twitter meta or email-body links (keep absolute).

## Acceptance criteria (Melvin verifies — deterministic)
1. `getsprintai.com` count in served static + live edge fns **drops materially**; report the
   before/after count and the remaining-by-category breakdown (excluded email/SMS/legal/meta,
   plus out-of-scope docs/tests/projects).
2. **Zero** change to: any `@getsprintai.com` string, `chat-sms/**`, email `from:` senders,
   legal body text, `SprintAI LLC` entity string, canonical/OG meta. Prove with a diff/grep
   showing these lines are byte-identical.
3. The resolved base URL is still `https://getsprintai.com` everywhere (env fallback +
   config default). Nothing visible changes.
4. Edge-fn TypeScript type-checks / `deno check` passes on every file touched (or documented
   why not runnable); no syntax errors in static JS.
5. `bash scripts/build-public-site.sh` still succeeds and `config.js` lands in `public/`.
6. Single commit, message scoped, `[skip pakka]` not required. Do not bundle other work.
