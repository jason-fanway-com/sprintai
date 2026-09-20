#!/bin/bash
# engine-test.sh — sync the local working tree's engine dir to the Air's detached
# worktree and run its tests there (deno lives on the Air, not on this Mac).
# usage: scripts/engine-test.sh [extra deno test args]
set -euo pipefail
LOCAL="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_WT='~/sprintai-engine'
rsync -az --delete "$LOCAL/supabase/functions/chat-sms/engine/" openclaw-air:"$REMOTE_WT/supabase/functions/chat-sms/engine/"
ssh openclaw-air "export PATH=/opt/homebrew/bin:\$PATH; cd $REMOTE_WT && deno check supabase/functions/chat-sms/engine/*.ts && deno test --allow-read --allow-env supabase/functions/chat-sms/engine/ $*"
