#!/bin/bash
# engine-test.sh — sync the local working tree's engine files to the Air's detached
# worktree and run checks + tests there (deno lives on the Air, not on this Mac).
# usage: scripts/engine-test.sh [--full] [extra deno test args]
set -euo pipefail
LOCAL="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_WT='~/sprintai-engine'
FULL=0; if [ "${1:-}" = "--full" ]; then FULL=1; shift; fi
rsync -az --delete "$LOCAL/supabase/functions/chat-sms/engine/" openclaw-air:"$REMOTE_WT/supabase/functions/chat-sms/engine/"
rsync -az "$LOCAL/supabase/functions/chat-sms/index.ts" "$LOCAL/supabase/functions/chat-sms/checkout-session.ts" openclaw-air:"$REMOTE_WT/supabase/functions/chat-sms/"
rsync -az "$LOCAL/supabase/functions/engine-eval/" openclaw-air:"$REMOTE_WT/supabase/functions/engine-eval/"
rsync -az "$LOCAL/scripts/deploy-function.sh" openclaw-air:"$REMOTE_WT/scripts/deploy-function.sh"
rsync -az "$LOCAL/supabase/migrations/" openclaw-air:"$REMOTE_WT/supabase/migrations/"
if [ "$FULL" = 1 ]; then
  ssh openclaw-air "export PATH=/opt/homebrew/bin:\$PATH; cd $REMOTE_WT && deno check supabase/functions/chat-sms/index.ts supabase/functions/engine-eval/index.ts supabase/functions/chat-sms/engine/*.ts && deno test --allow-read --allow-env supabase/functions/chat-sms/engine/ supabase/functions/chat-sms/checkout-session.test.ts $*"
else
  ssh openclaw-air "export PATH=/opt/homebrew/bin:\$PATH; cd $REMOTE_WT && deno check supabase/functions/chat-sms/engine/*.ts && deno test --allow-read --allow-env supabase/functions/chat-sms/engine/ $*"
fi
