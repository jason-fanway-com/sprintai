# SprintAI iMessage Ordering — System Runbook
**Last updated:** 2026-06-10
**Status:** Live / Production

---

## What Is This

SprintAI is an AI-powered SMS/iMessage food ordering system. Customers text a dedicated number, the AI takes their order conversationally, and the order is processed via a Supabase edge function.

**First merchant:** Not Just Bagels (Allentown, PA)
**Ordering number:** +1 (484) 201-8054

---

## Architecture

```
Customer texts +14842018054 (iPhone on Jason's Mac)
        ↓
imsg-bridge.sh (launchd agent on Mac)
  - reads ~/Library/Messages/chat.db every 2s
  - filters: only inbound messages to +14842018054
  - skips: outbound, empty, already processed
        ↓
Supabase Edge Function (call_sprint)
  - AI conversation engine
  - manages session state
  - returns { reply, phase }
        ↓
imsg send --service imessage
  - delivers reply back to customer
```

---

## Mac Setup Requirements

### 1. imsg binary
- Install: `brew install nicholasgasior/gaspkg/imsg` (or equivalent)
- Location after install: `/opt/homebrew/bin/imsg`
- Also at: `/opt/homebrew/Cellar/imsg/0.5.0/libexec/imsg`

### 2. Full Disk Access (CRITICAL — bridge hangs without this)
macOS blocks chat.db access for background processes without FDA.

**Grant FDA to the imsg binary:**
1. System Settings → Privacy & Security → Full Disk Access
2. Click `+`
3. Navigate to `/opt/homebrew/Cellar/imsg/0.5.0/libexec/imsg`
4. Add it — toggle ON
5. Also add `/bin/bash` if bridge still hangs

> **Why:** launchd agents run without a GUI session context. macOS TCC blocks
> chat.db reads and the binary hangs indefinitely waiting for a TCC prompt
> that never appears. FDA bypasses this.

### 3. Messages app configured
- iPhone number (+14842018054) must be paired to this Mac via iMessage/SMS relay
- Mac must be signed into the same Apple ID as the iPhone
- Messages app must be open and connected

### 4. Dependencies
```bash
brew install jq
brew install curl  # usually pre-installed
```

### 5. Environment variables
Required in the launchd plist `EnvironmentVariables`:
- `ORDERING_NUMBER=+14842018054` — only process messages destined for this number
- `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`

---

## Bridge Script

**Location:** `~/sprintai-ordering/scripts/imsg-bridge.sh`

### Key behaviors
- Polls `imsg chats --limit 50 --json` every 2 seconds
- Skips chats where `identifier` doesn't start with `+` (filters Apple ID chats)
- Skips messages where `destination_caller_id != ORDERING_NUMBER`
- Skips outbound messages (`is_from_me == true`)
- Tracks processed message IDs in `~/.sprintai-bridge/processed/`
- Session IDs stored in `~/.sprintai-bridge/sessions/` (24h TTL)
- On first run: seeds all existing messages as processed (prevents responding to old messages)
- Crash restart: max 3 crashes in 60s before exiting to launchd

### Send service
**MUST use `--service imessage`** (not `sms`). The `sms` flag reports "sent" but messages are not delivered on this Mac setup. iMessage is the actual transport.

```bash
imsg send --to "$to" --text "$text" --service imessage
```

### Log file
`/tmp/sprintai-imsg-bridge.log`

Log entry types:
- `[SCAN] chat=+1XXXXXXXXXX` — evaluating a chat
- `[MSG] id=N from_me=... dst=... processed=...` — evaluating a message
- `[SKIP] id=N: reason` — skipped (is_from_me / empty text / already processed / wrong dst)
- `━━━ INCOMING ━━━` — message passed all filters, processing
- `✓ Sent` — reply delivered successfully
- `ERROR: ...` — something failed

---

## launchd Agent

**Installed plist:** `~/Library/LaunchAgents/com.sprintai.imsg-bridge.plist`
**Source plist:** `~/sprintai-ordering/scripts/com.sprintai.imsg-bridge.plist`

Key settings:
- `KeepAlive: true` — launchd restarts it if it crashes
- `RunAtLoad: true` — starts on login
- `StandardOutPath`: `/tmp/sprintai-imsg-bridge.log`
- `StandardErrorPath`: `/tmp/sprintai-imsg-bridge-error.log`

### Install / reinstall
```bash
bash ~/sprintai-ordering/scripts/install-bridge.sh
```

### Manual control
```bash
# Status
launchctl list | grep sprintai

# Restart
launchctl unload ~/Library/LaunchAgents/com.sprintai.imsg-bridge.plist
launchctl load ~/Library/LaunchAgents/com.sprintai.imsg-bridge.plist

# View logs live
tail -f /tmp/sprintai-imsg-bridge.log
```

---

## Supabase Edge Function

Called by bridge at: `call_sprint` (URL in bridge script env vars / .env)

Request:
```json
{ "message": "...", "session_id": "imsg-p16102565023-1781013620" }
```

Response:
```json
{ "reply": "Hi there! Welcome to Not Just Bagels...", "phase": "greeting" }
```

Session ID format: `imsg-p{phone_digits}-{timestamp_epoch}`

---

## Debugging Guide

### Bridge not starting
```bash
launchctl list | grep sprintai   # check exit code (column 2)
cat /tmp/sprintai-imsg-bridge-error.log
```
Exit code 1 = crash at startup (deps check, missing env var, etc.)

### Bridge running but not picking up messages
1. Check `ORDERING_NUMBER` env var is set: `grep ORDERING_NUMBER ~/Library/LaunchAgents/com.sprintai.imsg-bridge.plist`
2. Check `--limit` on `imsg chats` — default is 30, may miss older chats. Bridge uses 50.
3. Confirm `destination_caller_id` on inbound messages matches `ORDERING_NUMBER` exactly

### Bridge picks up message but no reply delivered
1. Check for `ERROR: imsg send failed` in log
2. Test manually: `imsg send --to "+16102565023" --text "test" --service imessage`
3. If "sent" but not received: try `--service sms` (shouldn't be needed on this setup)
4. If hangs: FDA not granted — see Mac Setup Requirements above

### chat.db permission errors / hangs
FDA not granted. See Mac Setup Requirements → Full Disk Access.

### Messages going to wrong people
Check `ORDERING_NUMBER` filter in plist. Without it, bridge processes ALL inbound messages on the Mac (Jennifer's texts, spam, etc.).

### "Already processed" on fresh messages
Bridge seeded them on startup. Clear processed files and restart:
```bash
launchctl unload ~/Library/LaunchAgents/com.sprintai.imsg-bridge.plist
rm -rf ~/.sprintai-bridge/processed/
rm ~/.sprintai-bridge/.seeded  # if exists
launchctl load ~/Library/LaunchAgents/com.sprintai.imsg-bridge.plist
```
⚠️ This will re-process ALL messages — bridge will respond to old messages. Only do this on a clean/test number.

---

## Scaling Limitations

**Current architecture is 1:1 — one iPhone = one Mac = one merchant.**

No clean multi-tenancy without significant rework. Options if scaling to multiple merchants:
- **Twilio A2P** — recommended backbone for scale. Each merchant gets a Twilio number. No Mac dependency.
- **Multiple Mac Minis** — one per merchant. Simple but expensive.
- **iMessage as white-glove upsell only** — keep iMessage for premium tier, Twilio for everyone else.

---

## Files

| File | Purpose |
|------|---------|
| `scripts/imsg-bridge.sh` | Main bridge polling script |
| `scripts/com.sprintai.imsg-bridge.plist` | launchd plist (source) |
| `scripts/install-bridge.sh` | Installs plist to LaunchAgents and loads it |
| `~/.sprintai-bridge/processed/` | Processed message ID tracking |
| `~/.sprintai-bridge/sessions/` | Customer session ID cache |
| `/tmp/sprintai-imsg-bridge.log` | Live log (stdout) |
| `/tmp/sprintai-imsg-bridge-error.log` | Error log (stderr) |

---

## Known Issues / History

| Date | Issue | Fix |
|------|-------|-----|
| 2026-06-09 | `set -euo pipefail` caused crashes on single bad messages | Removed; per-message error handling added |
| 2026-06-09 | Processed/session files in /tmp lost on reboot | Moved to `~/.sprintai-bridge/` |
| 2026-06-09 | Bridge responding to ALL messages on Mac | Added `ORDERING_NUMBER` filter on `destination_caller_id` |
| 2026-06-09 | launchd couldn't find imsg binary | Added `/opt/homebrew/bin` to PATH in plist |
| 2026-06-10 | imsg hung when run from launchd (TCC/FDA) | Granted Full Disk Access to imsg binary in System Settings |
| 2026-06-10 | `--service sms` reports "sent" but messages not delivered | Changed to `--service imessage` |
