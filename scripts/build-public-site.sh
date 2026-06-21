#!/usr/bin/env bash
#
# build-public-site.sh — assemble ONLY the public getsprintai.com marketing/app
# surface into ./public, which is the Netlify `publish` dir for the ROOT site.
#
# WHY: The root site historically had no `publish` dir, so Netlify served the
# entire repo root. That made internal source (admin-dashboard/, supabase/,
# *.md build notes, *.htmltext, _proof/ QA artifacts, etc.) fetchable as raw
# text from the origin, guarded only by a deploy-time .netlifyignore. This
# script makes the origin serve an EXPLICIT allowlist and nothing else, so
# internal files are simply never on the origin to begin with.
#
# DESIGN: allowlist, not denylist. We copy ONLY what is explicitly public.
# Anything new or internal is excluded by default — safe at scale.
#
# This script is deterministic and dependency-free (POSIX cp/find/rsync-free).
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public"

cd "$ROOT"

echo "[build-public-site] root = $ROOT"
echo "[build-public-site] out  = $OUT"

# Clean slate so removed files never linger.
rm -rf "$OUT"
mkdir -p "$OUT"

# ── Public top-level HTML pages (marketing + funnel) ────────────────────────
# Verified public via index.html links, inter-page links, netlify.toml
# redirects, and Stripe success/cancel targets in netlify/functions.
PUBLIC_FILES=(
  "index.html"          # real marketing homepage
  "contact.html"        # contact form (action=/thanks)
  "privacy.html"        # legal
  "terms.html"          # legal
  "thanks.html"         # contact form redirect target (/thanks)
  "order-success.html"       # order confirmation page (real orders)
  "order-success-test.html"  # order confirmation page (test-mode orders; diner-bot success_url target)
)

for f in "${PUBLIC_FILES[@]}"; do
  if [[ -f "$f" ]]; then
    cp "$f" "$OUT/"
    echo "  + file  $f"
  else
    echo "  ! MISSING public file: $f" >&2
  fi
done

# ── Public app directories (live customer flow) ─────────────────────────────
# signup/      — onboarding wizard (older)
# signup-page/ — onboarding wizard (actively developed); EXCLUDES _proof/
# checkout/    — Stripe checkout cancel target (verified in functions)
# welcome/     — Stripe checkout success target (verified in functions)
# chat/        — chat ordering frontend
PUBLIC_DIRS=(
  "signup"
  "signup-page"
  "checkout"
  "welcome"
  "chat"
)

for d in "${PUBLIC_DIRS[@]}"; do
  if [[ -d "$d" ]]; then
    # Copy the directory, then prune any internal-only nested artifacts.
    cp -R "$d" "$OUT/"
    echo "  + dir   $d/"
  else
    echo "  ! MISSING public dir: $d" >&2
  fi
done

# ── Prune internal artifacts that live INSIDE an otherwise-public dir ───────
# signup-page/_proof/ is internal QA (test logs, screenshots, sample CSV; one
# file contains "Melvin"). It is only ever loaded by the wizard's ?proof=menu
# screenshot mode, which never runs in normal use, so removing it does not
# break the live wizard.
rm -rf "$OUT/signup-page/_proof"
echo "  - prune signup-page/_proof/ (internal QA artifacts)"

# Belt-and-suspenders: never let any *.htmltext, *.md, *.sql, or a nested
# _proof/ survive in the published tree even if a future public dir gains one.
find "$OUT" -type f \( -name '*.htmltext' -o -name '*.md' -o -name '*.sql' \) -print -delete | sed 's/^/  - prune /' || true
find "$OUT" -type d -name '_proof' -print -exec rm -rf {} + 2>/dev/null | sed 's/^/  - prune /' || true

echo "[build-public-site] done. published file count: $(find "$OUT" -type f | wc -l | tr -d ' ')"
