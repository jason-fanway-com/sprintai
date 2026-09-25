#!/bin/bash
# smoke.sh — deploy chat-sms if the live stamp differs from HEAD, then the 3-cent smoke: canary x1 + pay-link re-send.
# Run on the Air from the worktree root. Only the PO runs this (CLAUDE.md rule 1).
export PATH=/opt/homebrew/bin:$PATH
set -a; . ~/.openclaw-sprintai/.secrets; set +a
cd "$(dirname "$0")/../.."
echo "HEAD $(git rev-parse --short HEAD)"
D=$(mktemp -d); (cd $D && supabase functions download chat-sms --project-ref rvdqfxtrskxekfkqnegx >/dev/null 2>&1); LIVE=$(grep -m1 -o "DEPLOY_SHA: [0-9a-f]*" $D/supabase/functions/chat-sms/index.ts); rm -rf $D
echo "live before: $LIVE"
if ! echo "$LIVE" | grep -q "$(git rev-parse HEAD)"; then
  touch ~/po-scratch/.po-deploy-token
  ./scripts/deploy-function.sh chat-sms 2>&1 | sed "s/\x1b\[[0-9;]*m//g" | tail -6
fi
echo "--- smoke: canary x1"
python3 scripts/engine/e2e.py --shop e0000000-0000-0000-0000-000000000001 --runs 1 --scenario canary 2>&1 | tail -3
echo "--- smoke: pay link re-send"
python3 scripts/engine/replay.py "pickup|garlic knots|thats it|yes|thanks, on my way"
