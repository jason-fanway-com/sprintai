# Netlify Build-Credit Reduction — 2026-08-31

## The problem

The ProofPros Netlify team hit 75% of its 3,000-credit allowance on day 13 of the Aug 19 – Sep 18 cycle. That's ~173 credits/day, projecting ~5,400 for the full cycle — 1.8× the allowance. Overage credits aren't free.

### Root causes

1. **67 commits since Aug 19, each triggering a full build.** Netlify builds every push by default.
2. **Cold shop-chat install on every build.** `build-public-site.sh` line ~60 does `cd shop-chat && npm install && npm run build`. Netlify auto-caches `node_modules` only at the base directory, so that nested React + Vite + Tailwind install starts from zero every time.
3. **~49% of commits touch only paths that never reach the root origin** (see table below) — yet still consume a full build.

| Path pattern | Commits Aug 19–31 | Served on origin? |
|---|---|---|
| `supabase/functions/*` | 22 | No — deploys separately |
| `admin-dashboard/*`, `RUNBOOK.md`, `HANDOFF.md` | 19 | No |
| Everything else | 34 | Yes |

## What we did

### 1. Build-ignore script (`scripts/netlify-ignore-build.sh`)

Declared as `ignore = "bash scripts/netlify-ignore-build.sh"` in `[build]`. Netlify runs this before the build command; exit 0 skips the build, exit 1 runs it.

The script diffs `$CACHED_COMMIT_REF..$COMMIT_REF` and checks every changed file against a regex list of paths that provably never reach the origin. If all changed files match, the build is skipped.

**Fail-open contract (non-negotiable):** the script builds on ANY uncertainty — missing `CACHED_COMMIT_REF`, git error, unrecognized path, anything. Skipping a real change is far worse than a wasted build. It ONLY skips when every changed path is provably off-origin.

### 2. Cache plugin for shop-chat

```toml
[[plugins]]
  package = "netlify-plugin-cache"
  [plugins.inputs]
    paths = ["shop-chat/node_modules"]
```

Netlify auto-installs plugins declared in `netlify.toml` (no `package.json` change needed). This caches the nested `shop-chat/node_modules` between builds, so the Vite install isn't cold every time. Cold builds still happen on cache-miss or cache-clear, but the normal case is now warm.

Note: we intentionally use `npm install` (not `npm ci`). `npm ci` wipes `node_modules` before installing, which would defeat the restored cache.

### Off-origin path list — KEEP IN SYNC

The ignore script's `NOT_ON_ORIGIN` regex must stay in sync with the allowlist in `scripts/build-public-site.sh`. If a path is not copied by `build-public-site.sh`, it belongs in the ignore regex. If someone adds a new directory to the allowlist, the corresponding pattern MUST be removed from the ignore regex. Drift between these two lists = either wasted builds (safe) or silently skipped real changes (catastrophic).

Current list:

| Regex | Rationale |
|---|---|
| `^[^/]*\.md$` | README, RUNBOOK, BUILD-NOTES, etc. — never published |
| `docs/.*` | Design docs and specs — not published |
| `_proof/.*` | QA artifacts — not published |
| `admin-dashboard/.*` | Deploys to sprintai-chat-admin, not the root origin |
| `supabase/.*` | Edge functions deploy via Supabase CLI, not Netlify |
| `[^/]*\.htmltext$` | Prompt templates — internal, never published |

## Follow-up (not done here)

1. **sprintai-chat-admin needs its own ignore rule.** It's a separate Netlify site that rebuilds on every root-repo push. It should skip builds when only non-admin paths change. The ignore script's logic can be reused with a different path list.

2. **Convert shop-chat to an npm workspace.** If shop-chat's deps hoist to the root `node_modules`, Netlify's native caching covers them and the cache plugin becomes unnecessary. This is a structural change with broader implications (version conflicts, workspace config) and was deferred.