# BUILD SPEC — Public tester link (implementation)

Lead: OrderFare. Source spec: `docs/specs/2026-09-05-public-tester.md` (authority: Jason).
This file is the implementation contract. Read the source spec first; where they differ,
this file wins on mechanics, the source spec wins on intent.

## Measured cost (already reported to Jason — do not re-measure)

Real spend against production, Vito's Pizza (QA), deepseek/deepseek-v4-pro:
3 turns = $0.018 · 9 turns = $0.082 · 16 turns = $0.226. Cost is QUADRATIC in turns
(the full ~17k-token system prompt is re-sent every turn). The turn cap is the cost
control; the rate limit is the abuse control. Do not weaken either.

## Architecture — read this before writing code

The public page MUST NOT call `chat-sms` directly with the anon key. Two reasons:
1. `test_transcripts` has `REVOKE ALL ... FROM anon` and an RLS INSERT policy requiring
   an authenticated tenant JWT. A public browser cannot write a transcript. It needs a
   service-role server hop.
2. Every guard rail (turn cap, rate limit, kill switch, test-shop-only) must be enforced
   server-side. Anything in the browser is bypassed in thirty seconds, and this endpoint
   is public.

Therefore: **one new edge function `public-tester`** is the only thing the page talks to.
It proxies to `chat-sms` internally using the service role.

Do NOT add an unauthenticated route to the admin SPA. That app is login-gated and lives on
a separate Netlify site; putting a public route in it widens a surface we deliberately closed.

## Deliverable 1 — migration `096_public_tester.sql`

- `ALTER TABLE test_transcripts ADD COLUMN IF NOT EXISTS tester_name text;`
- Drop and recreate `test_transcripts_source_check` to allow
  `('simulator', 'field', 'public-tester')`.
- Rebuild `qa_ro.test_transcripts` to include `tester_name`. Keep the existing grant to
  `qa_readonly`. Do not narrow any column that view already exposes.
- New table `public_tester_sessions`:
  `id uuid pk`, `session_id text not null`, `ip_hash text not null`, `shop_id uuid`,
  `turns int not null default 0`, `submitted boolean not null default false`,
  `created_at timestamptz not null default now()`.
  Indexes on `(session_id)`, `(ip_hash, created_at desc)`, `(created_at desc)`.
  RLS enabled, FORCE, `REVOKE ALL FROM anon` and from `authenticated`. Only the service
  role touches it. Add a SELECT policy for super-admins so Jason can see the volume.
- New table `app_config`: `key text primary key`, `value jsonb not null`,
  `updated_at timestamptz not null default now()`. RLS on, FORCE, revoked from anon;
  super-admin full access. Seed two rows:
  - `public_tester_enabled` → `false`  ← ships OFF. Jason turns it on.
  - `public_tester_shop_id` → the Vito's Pizza (QA) id `22ed2761-a3f2-5bde-9012-916a93c521cd`
  The kill switch is a DB row, not an env var, specifically so it can be flipped without a
  deploy. "Instantly" is the requirement.

`REVOKE ALL ON test_transcripts FROM anon` must remain in force. Do not relax it.

## Deliverable 2 — edge function `supabase/functions/public-tester/index.ts`

`verify_jwt = false` in `supabase/config.toml`, with a comment saying why.
Service-role client. JSON POST, three actions.

Shared preconditions, checked on EVERY action before anything else:
1. `app_config.public_tester_enabled` is true. If not → 503 with
   `{ ok:false, reason:'disabled' }`. The page renders a plain "testing is paused" message.
2. Resolve the target shop from `app_config.public_tester_shop_id`, then HARD-GUARD it:
   the shop row must have `is_test = true` AND `phone_number_e164 IS NULL`.
   If either fails, refuse the request and log loudly. This is the "never point at a live
   shop" rule and it is checked per request, not at deploy time, because the config row is
   editable. A misconfigured shop id must fail closed.
3. Derive `ip_hash` = sha256(client ip + a server-side salt from env `PUBLIC_TESTER_SALT`).
   Store the hash only, never the raw IP. Minimum PII is a hard rule.

### `action: "start"`
Rate-limit checks, in this order, each returning a distinct machine-readable reason:
- global: conversations created today < 150 → else `reason:'global_cap'`
- per ip_hash: conversations in the last hour < 5 → else `reason:'ip_limit'`
- per session_id: conversations in the last hour < 3 → else `reason:'session_limit'`
Then insert a `public_tester_sessions` row and return `{ ok:true, session_id, shop_name }`.
Server generates the session_id. Do not trust a client-supplied one.

### `action: "send"`
- Look up the session row. Unknown session → 400.
- If `turns >= 20` → return `{ ok:true, capped:true, reply:<the cap message> }` and do NOT
  call the model. Cap message: friendly, tells them to hit Send for review and start a fresh
  one. 20 is the cap because at 20 turns a conversation costs ~$0.33 and the curve is
  quadratic — raising it is expensive, not linear.
- Otherwise increment `turns`, then POST to `chat-sms` with
  `{ shop_id, message, session_id, test: true }` and the service role key.
  Return `{ ok:true, reply, cart, model, turns_left }`.
- `test: true` is mandatory on every call. Never omit it.

### `action: "submit"`
Body: `{ session_id, tester_name?, reporter_note?, messages, final_cart }`.
- Insert into `test_transcripts` with `source = 'public-tester'`, `tester_name` trimmed to
  60 chars or null, the shop's `shop_id`/`shop_name`/`tenant_id`, and the model string
  returned by chat-sms. Messages stored VERBATIM — no summarising, truncating, or
  reformatting, including cart footer lines. That rule is from the capture spec and it is
  the reason the corpus is worth anything.
- Mark the session `submitted = true`. Return `{ ok:true }`.
- If the insert fails, return `ok:false` with a message the page can show, so the tester
  knows their feedback did not land rather than being told it did.

## Deliverable 3 — public page `try.html`

Repo root, added to the allowlist array in `scripts/build-public-site.sh` with a comment.
Served at `getsprintai.com/try`. Plain HTML/CSS/JS in the style of the existing root pages —
no build step, no framework, no admin bundle.

- Phone-first layout. Test it narrow.
- Two lines of framing at the top, warm and plain: this is a test of a text-message ordering
  system; order like you would from a real pizzeria; nothing is charged and no food comes.
- Chat transcript + input. Show the cart footer exactly as the bot sends it.
- **Send for review** button: one-line "What felt wrong?" free text (optional, with Skip)
  plus an optional first-name field. On success: thank them, offer "Start a fresh order",
  which calls `start` again.
- Turn counter is not shown to the tester. When capped, the bot's cap message says it.
- Every rate-limit reason gets its own friendly sentence. Never show a raw error code.
- Checkout stays live: it is test mode, it routes to `order-success-test.html`, and the
  checkout step is the most defect-dense part of the flow. Do not disable it.

## Acceptance — Melvin verifies each, no self-reports

1. With `public_tester_enabled = false`, `/try` renders the paused message and no model call
   is made. Prove the second half, do not assume it.
2. With it true, a full order completes and a transcript row lands with
   `source = 'public-tester'`, verbatim messages, and the tester name.
3. Skipping both the note and the name still persists a row.
4. The 21st customer message returns the cap message and costs nothing — confirm no
   OpenRouter spend on that call.
5. Point `public_tester_shop_id` at a shop with a real `phone_number_e164` — every action
   must refuse. This is the live-shop guard; test it explicitly.
6. Exceed each of the three rate limits and get the three distinct reasons.
7. `qa_readonly` can read `qa_ro.test_transcripts` including `tester_name`, and is still
   denied on `public.test_transcripts`.
8. Anon key cannot insert into `test_transcripts` directly.

## Out of scope
No scoring, no LLM judging, no auto-fixing from tester input. Capture and store only.
