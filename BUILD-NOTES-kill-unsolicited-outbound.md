# BUILD NOTES — kill-unsolicited-outbound

**Branch:** `fix/kill-unsolicited-outbound`
**Goal:** Eliminate every path that could send an SMS/iMessage the customer did not just ask for. Two independent mechanisms could fire unsolicited outbound; both are closed.
**Status:** TEST ONLY. Not merged, not pushed to main, not deployed to prod. No real SMS/iMessage sent. Live bridge (PID 18724) untouched. No secrets in diff.

---

## Mechanism B — webhook / chat-sms (already done in prior run)

These TS edge functions were fixed before this run and are good. Summarized here for completeness; **this run did not modify them.**

- `supabase/functions/stripe-webhook/index.ts` (+/- per `git diff --stat origin/main`, ~30 lines)
  Stopped the webhook from triggering outbound customer messaging on Stripe events that aren't a direct customer-initiated action.
- `supabase/functions/chat-sms/index.ts` (~39 lines)
  Tightened the reply path so the function only emits a reply in direct response to an inbound customer message (no proactive/greeting sends off non-inbound triggers).

> `deno check` could not be run on this machine (deno not installed). My bridge work added **zero** TypeScript changes, so it cannot introduce new TS errors relative to origin/main. The TS diffs are unchanged from the prior run.

---

## Mechanism A — iMessage bridge replay bug (completed this run)

File: `scripts/imsg-bridge.sh` (161 insertions / 16 deletions vs origin/main).
This was the load-bearing fix: a stale/replayed inbound could be re-processed and answered, producing an unsolicited send. Four gaps were closed.

### Gap 1 — singleton lock was defined but never called
- `acquire_singleton_lock()` defined at **line 69** (unchanged logic: atomic `mkdir` lock + PID liveness; refuses on live owner, reclaims stale).
- **NEW call site at line 536**, top-level, BEFORE the crash-restart loop and before any processing:
  ```sh
  if ! acquire_singleton_lock; then
    log "Startup aborted: singleton lock not acquired."
    rm -f "$PID_FILE"; exit 1
  fi
  ```
  Acquired once so the same PID keeps the lock across self-restarts. On failure: exit non-zero, process nothing. `cleanup`/trap still calls `release_singleton_lock`. Tests override `SPRINTAI_BRIDGE_LOCK_FILE` to a temp path so they never collide with the live bridge's lock.

### Gap 2 — dedup was in-memory-only (the actual replay bug)
- `is_processed()` (**line 200**) now treats the on-disk `PROCESSED_IDS_FILE` as the **single source of truth**: in-memory `_PROC_*` is a fast-path cache only; on a cache MISS it `grep -qxF`s the file on EVERY call. A stale in-memory snapshot can no longer cause a re-send.
- `mark_processed()` (**line 220**) now **writes through to disk first** (dedup-guarded append), then warms the cache.
- In `process_message()` (**line 294**), `mark_processed` was moved to run **BEFORE** the `send_reply` attempt (**line ~340**), so a crash mid-send cannot double-send (we accept rare "marked-not-sent" over "sent-twice").
- **Bonus correctness fix:** added `_proc_varname()` (**line 166**) to sanitize ids into legal bash identifiers (`tr -c '[:alnum:]' '_'`). Real iMessage GUIDs contain hyphens/colons, which made the old `eval _PROC_<id>=1` fail (`command not found`) and silently broke the cache for those ids. The on-disk file still stores the RAW id; only the cache key is sanitized. Applied in `load_processed_ids` (**line 171**), `is_processed`, and `mark_processed`.

### Gap 3 — age guard failed OPEN
- `msg_is_too_old()` (**line 240**) now **fails CLOSED**. Missing/empty/unparseable/non-numeric `created_at` ⇒ return 0 ("too old → skip"). Only a successfully-parsed timestamp within `MAX_MSG_AGE_SECONDS` (now 900s/15min) returns 1 ("fresh → process"). The loop uses the return-0 path to skip + mark processed.

### Gap 4 — TTL-rollover greeting guard
- Primary defense is the fail-closed age guard (loop, **line 473**): a stale/replayed message is skipped before any session logic, so it can't mint a session or greet.
- Defensive belt-and-suspenders (loop, **line 482**): added `phone_has_session_history()` (**line 149**). If a message is undateable AND the phone already has prior session history, skip rather than re-greet. Documented as secondary; the age guard is primary.

---

## Proof artifacts (`signup-page/_proof/`)

All proofs run the bridge functions in isolation by extracting config+functions into a temp lib (`_extract-bridge-lib.sh`, cuts at the `# -- Test mode` sentinel, disables the real secrets-source and dep-check). They use a TEMP lock + TEMP processed-ids + TEMP session dir via env/HOME overrides. They NEVER touch `~/.sprintai-bridge`, NEVER touch PID 18724, and NEVER send.

- `_extract-bridge-lib.sh` — sourceable-lib extractor.
- `bridge-compliance-proofs.sh` — the 4 proof groups.
- `bridge-compliance-proofs.log` — captured passing run.

**Result: 13 passed, 0 failed.**

- **(a) singleton lock:** live FOREIGN lock (a real backgrounded PID) ⇒ second acquire REFUSES (non-zero) and leaves the foreign lock intact; stale lock (dead PID) ⇒ reclaimed.
- **(b) dedup:** `mark_processed` writes through to disk; after clearing the in-memory `_PROC_*` cache var (simulated stale-snapshot race), `is_processed` still returns TRUE from on-disk authority ⇒ NO re-process.
- **(c) age-guard fail-closed:** empty ⇒ skip; garbage ⇒ skip; 16min-old ⇒ skip; 5min-old ⇒ allow.
- **(d) Erin replay:** an already-processed, 42-min-old inbound re-seen (with the in-memory cache wiped) ⇒ NO send, via BOTH the dedup guard and (independently) the age guard.

Re-run: `bash signup-page/_proof/bridge-compliance-proofs.sh`

---

## DoD confirmations

- [x] `bash -n scripts/imsg-bridge.sh` passes.
- [x] No TS changes in this run; bridge work cannot add new TS errors vs origin/main. (`deno` unavailable on host to run `deno check`.)
- [x] Proofs (a)–(d) all pass (13/13).
- [x] NOT merged, NOT pushed to main, NOT deployed to prod.
- [x] No real SMS/iMessage sent (no `imsg send` invoked by any proof; dep-check disabled in lib).
- [x] Live bridge PID 18724 untouched and still running; live `~/.sprintai-bridge/processed-ids.txt` mtime unchanged.
- [x] No secrets printed or committed (secrets source disabled in proof lib; placeholders used).
