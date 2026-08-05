# SPEC: Shop Owner Chat PWA — getsprintai.com/chat

## What

A standalone, installable PWA at `getsprintai.com/chat` where a shop owner logs in (Supabase Auth) and chats with the existing AI admin (`admin-chat` edge function). The chat handles 86'ing items, specials, delivery pauses — same as `ConversationalAdminChat.tsx` in the admin dashboard, but as a dedicated mobile-first experience.

## Architecture Decision

**Auth: Supabase Auth (NOT merchant-auth PIN).** Shop owners get Supabase Auth accounts with `user_metadata.tenant_id` and `user_metadata.shop_id`. This is the same auth system `admin-chat` already expects — no token bridging needed.

**No new backend.** The `admin-chat` edge function is reused as-is. The PWA calls it with the Supabase JWT, same as the admin dashboard does.

**No new database tables.** Messages are not persisted in the DB — they live in localStorage on the device, same pattern as `ConversationalAdminChat.tsx`. The admin-chat function is stateless (message + message_history passed each call).

## What to Build

### 1. New Vite app: `shop-chat/`

Create a new directory `shop-chat/` at the repo root (`/Users/joestrazza/sprintai-ordering/shop-chat/`).

```
shop-chat/
  package.json
  vite.config.ts
  index.html
  public/
    manifest.json
    sw.js
    icons/
      icon-192.png
      icon-512.png
  src/
    main.tsx
    App.tsx
    lib/supabase.ts
    components/
      Login.tsx
      Chat.tsx
```

### 2. Vite config

- `base: '/chat/'` (so it works under the `/chat/` proxy path)
- React plugin, same as admin-dashboard
- Port 3020 for dev

### 3. Supabase client (`src/lib/supabase.ts`)

Same pattern as admin-dashboard's supabase.ts:
- Read `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from env
- Export `supabase`, `supabaseUrl`, `supabaseAnonKey`

### 4. Login page (`src/components/Login.tsx`)

Simple email + password login via `supabase.auth.signInWithPassword()`.
Also support magic link (`signInWithOtp`) as a toggle — same pattern as admin dashboard Login.tsx.

After login, check `user_metadata.shop_id`. If missing, show error: "Your account isn't linked to a shop. Contact support."

No signup form — accounts are provisioned by Sprint admin during onboarding.

### 5. Chat component (`src/components/Chat.tsx`)

This is the core. Port `ConversationalAdminChat.tsx` to a mobile-first standalone version:

- **Read shop_id from user_metadata** (not from props). The logged-in user IS the shop owner.
- **Call admin-chat edge function** with the same request format:
  ```json
  {
    "message": "user text",
    "message_history": [{ "role": "user", "content": "..." }, ...],
    "shop_id": "<from user_metadata>"
  }
  ```
  Headers: `Authorization: Bearer <supabase_access_token>`, `Content-Type: application/json`
- **Handle response types** same as ConversationalAdminChat:
  - `confirmation_card` → show summary + Confirm/Cancel buttons
  - `executed` → show result + status header
  - plain text → show as assistant message
- **Quick action chips** at the top (same as ConversationalAdminChat):
  - "86 an item", "Add special", "Pause delivery", "What's 86'd?"
- **Message persistence**: localStorage keyed by `shop_id` (same pattern: `admin-chat-history-${shopId}`)
- **Voice input**: Web Speech API (same as ConversationalAdminChat) — optional, nice to have
- **Auto-scroll** to bottom on new messages

### 6. Mobile-first UI

- Full-height layout (100dvh)
- Messages fill the screen, input pinned to bottom
- Touch-friendly: 48px+ tap targets
- Safe area insets for notched phones (`safe-area-top`, `safe-area-bottom`)
- Clean, friendly design — not generic SaaS. This is a family restaurant owner's tool.
- Use the same color palette as merchant-ui (green/red/orange for status, brand indigo)

### 7. PWA manifest (`public/manifest.json`)

```json
{
  "name": "Sprint Chat",
  "short_name": "Sprint",
  "description": "Chat with your Sprint AI assistant",
  "start_url": "/chat/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#4f46e5",
  "icons": [
    { "src": "/chat/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/chat/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

### 8. Service worker (`public/sw.js`)

Minimal cache-first for assets, stale-while-revalidate for navigation. Cache version starts at `chat-v1` (separate namespace from admin dashboard's cache).

### 9. Netlify deployment

**Option A (preferred): Deploy as part of the root site.**

Add `shop-chat` to the `PUBLIC_DIRS` array in `scripts/build-public-site.sh`, but with a build step first. The build script needs to:
1. `cd shop-chat && npm install && npm run build`
2. Copy `shop-chat/dist/` to `public/chat/`

Then add a redirect in the root `netlify.toml`:
```toml
[[redirects]]
  from = "/chat/*"
  to = "/chat/:splat"
  status = 200
```

**Option B: Separate Netlify site (like admin-dashboard).**

Deploy `shop-chat/dist` to a new Netlify site, proxy `/chat/*` from the root site. More complex, not needed for a static PWA.

Go with Option A unless the build script gets too complex.

### 10. Root netlify.toml changes

Add to the root `netlify.toml`:
```toml
# Shop owner chat PWA
[[redirects]]
  from = "/chat"
  to = "/chat/"
  status = 301
  force = true

[[redirects]]
  from = "/chat/*"
  to = "/chat/:splat"
  status = 200
```

## Auth Account Provisioning

Shop owner accounts need to be created in Supabase Auth with:
- `user_metadata.tenant_id`: the tenant ID
- `user_metadata.shop_id`: the shop ID
- `user_metadata.is_admin`: false (or absent)

For now, accounts are created manually via Supabase dashboard or a script. Auto-provisioning during onboarding is a future task.

## Acceptance Criteria

1. **`getsprintai.com/chat` loads on mobile** (Chrome and Safari) and shows a login screen
2. **Shop owner can log in** with email + password (Supabase Auth)
3. **After login, chat interface appears** — full screen, mobile-first, no dashboard chrome
4. **Shop owner can send a message** (e.g., "86 the everything bagels") and get a confirmation card back
5. **Confirming an action executes it** — the item gets 86'd, visible in admin dashboard
6. **Quick action chips work** — tapping "86 an item" starts that flow
7. **Messages persist** in localStorage — closing and reopening the PWA shows conversation history
8. **PWA is installable** — Chrome and Safari show "Add to Home Screen" and the app opens in standalone mode (no browser chrome)
9. **App icon appears** on home screen after install
10. **Works on iPhone and Android** — test both (or at minimum, Chrome iOS and Chrome Android)

## Pre-mortem

**Why will this fail?**

1. **Build script integration breaks the root site deploy.** Adding a Vite build step to `build-public-site.sh` could fail if npm install fails or the build output isn't where expected. → Mitigation: Build `shop-chat` separately first, test the output, then wire it into the build script. If it breaks, the root site deploy fails — so test on a branch.

2. **Vite base path `/chat/` doesn't match the proxy.** Same issue we just fixed with `/dashboard/`. Assets referenced as `/chat/assets/...` but served from `/assets/`. → Mitigation: Either set Vite `base: '/chat/'` AND add redirect rules for `/chat/assets/*` → `/assets/:splat` in the root netlify.toml, OR deploy as a static subdirectory where the assets are already at the right relative path. Test on phone before declaring done.

3. **Shop owner doesn't have a Supabase Auth account yet.** The PWA is built but no one can log in. → Mitigation: Create a test account manually in Supabase dashboard with the right user_metadata. Document how to create accounts.

4. **admin-chat function breaks when called from the PWA.** The function expects `shop_id` in the body and `tenant_id` in user_metadata. If the shop owner's account doesn't have these, it 403s. → Mitigation: Verify the test account has correct user_metadata before testing.

5. **Service worker caches break the chat.** A cache-first SW could serve stale JS. → Mitigation: Use stale-while-revalidate for navigation, cache-first only for static assets (fonts, icons). Start with a minimal SW. Version it `chat-v1`.

6. **iOS Safari "Add to Home Screen" doesn't work without HTTPS or without the manifest served correctly.** → Mitigation: Manifest must be served at `/chat/manifest.json` with correct `Content-Type: application/manifest+json`. Verify with curl.

## Key Files to Reference

- `/Users/joestrazza/sprintai-ordering/admin-dashboard/src/components/shop/ConversationalAdminChat.tsx` — the chat UI to port (528 lines, has all the response handling, quick actions, voice input)
- `/Users/joestrazza/sprintai-ordering/admin-dashboard/src/lib/supabase.ts` — Supabase client pattern
- `/Users/joestrazza/sprintai-ordering/admin-dashboard/src/pages/Login.tsx` — login UI pattern
- `/Users/joestrazza/sprintai-ordering/admin-dashboard/vite.config.ts` — Vite config pattern (base path, React plugin)
- `/Users/joestrazza/sprintai-ordering/admin-dashboard/netlify.toml` — redirect rules for assets under a base path
- `/Users/joestrazza/sprintai-ordering/supabase/functions/admin-chat/index.ts` — the backend (DO NOT MODIFY, just call it)
- `/Users/joestrazza/sprintai-ordering/scripts/build-public-site.sh` — build script to integrate with
- `/Users/joestrazza/sprintai-ordering/netlify.toml` — root site redirects

## Do NOT

- Do NOT modify the `admin-chat` edge function. It works. Just call it.
- Do NOT create new database tables. No schema changes.
- Do NOT add the full admin dashboard to this PWA. Chat only.
- Do NOT create a signup form. Accounts are provisioned by Sprint.
- Do NOT use the merchant-auth PIN system. Supabase Auth only.
