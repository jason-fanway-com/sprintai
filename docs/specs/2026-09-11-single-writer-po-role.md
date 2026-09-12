# Single-writer PO role — spec

**Written 2026-09-11 after two PO sessions drove the crew simultaneously for ~2 hours.**
Status: proposed, not built.

## The incident

Two Claude sessions in the same desktop app both invoked the `orderfare` skill and
both became "the outside PO". Neither could see the other.

| time (ET) | session | dispatch |
|---|---|---|
| 13:29 | A | `00-A-COST-LEVERS-narrow-unhalt` |
| 13:31 | A | `00-A-HALT-CHAT-DEVELOPMENT` — go idle, no testing, no deploys |
| 13:50 | A | `00-A-I-REVERTED-AND-DEPLOYED` |
| ~15:13 | B | `00-A-unhalt-full-scope` — **crew back to work, full scope** |
| 15:18 | B | `00-A-CORRECTION-flash-and-test-go` |
| 15:19 | B | `00-A-v2-go` |
| 15:27 | B | `00-A-owner-answers` |

The crew received a halt and an un-halt, both signed PO, ~100 minutes apart, and
followed the newer one. Session B had to reconstruct session A's three production
commits from `git log` because it could not ask; it issued a model instruction on
that basis and then corrected itself. Session A found out by accident while
listing the outbox for an unrelated reason.

Cost: contradictory instructions to the crew, one wasted correction cycle, and two
sessions independently mutating production — A set `CHAT_MODEL` four times and
deployed `chat-sms` three times while B was directing a menu compile.

## Root cause

The PO role is defined by a skill, not by a claim. `orderfare` instructs any
session to read the brief, dispatch by `scp` into `~/.openclaw-sprintai/po-outbox/`,
and set a recurring watch. Nothing checks for an incumbent. Consequently any
session with ssh access has:

- write access to the shared `po-outbox`
- use of the `00-` queue-jumping prefix
- the service-role key, the Supabase access token, and deploy rights
- **no visibility of any other PO** unless it happens to `ls` the outbox

Two POs is a state the design permits rather than prevents.

## Fix

### 1. An owner claim

`~/.openclaw-sprintai/po-outbox/.po-owner`, JSON:

```json
{
  "session_id":   "local_76559d3a-cdd7-499e-89c3-290570b8703e",
  "label":        "Cart ownership inversion",
  "claimed_at":   "2026-09-11T19:13:02Z",
  "heartbeat_at": "2026-09-11T19:38:22Z"
}
```

### 2. Claim protocol, run by the skill before anything else

Read `.po-owner`, then:

- **absent** → write the claim, proceed as PO.
- **held by this session** → refresh `heartbeat_at`, proceed.
- **held by another session, heartbeat < 30 min old** → **do not become PO.** Report
  the incumbent's id, label and heartbeat age to the user and offer two choices:
  take over explicitly, or stand down read-only. Never take over silently.
- **held by another session, heartbeat >= 30 min** → take over, record
  `superseded_stale` and the previous id in the courier log.

A stale claim must expire. A PO session that dies must not lock the crew out —
the same hazard as the test-run lockfile, where a killed process left a stale lock
that became the next false blocker.

### 3. Heartbeat with no new timer

Refresh `heartbeat_at` on each dispatch and each watch tick. Do not add a separate
scheduler; piggyback on work the PO already does. Inventing timers is how this
project ends up with things running that nobody remembers starting.

### 4. Courier enforcement — the half that actually binds

A claim file is advisory: a session that has not read the updated skill will ignore
it. The courier must reject, not deliver.

- Every `.msg` carries a first line `PO-Session: <session_id>`. The courier strips
  it before handing the body to the agent.
- On pickup the courier compares that id to `.po-owner`.
  - match → dispatch as now
  - mismatch or header missing → **do not dispatch.** Move the file to
    `po-outbox/rejected/` and log `REJECTED <file> sender=<id> owner=<id>`.
- Rejection is loud and recoverable: the message survives, and the sending session
  sees it never left the outbox, which is already the rule it is taught to check
  ("an scp is not a delivery").

### 5. Read-only mode for a standing-down session

A non-owner PO is still useful and should be told exactly what it may do.

**Allowed:** read the brief, DB, logs, transcripts and meters; run the canary and
live read-only probes; report findings to Jason.

**Forbidden:** `scp` into `po-outbox`; `supabase secrets set`; `functions deploy`;
commits to the repo; DB writes. Anything production-mutating goes through the
owner.

This boundary is the one that failed today, and it failed in both directions: the
non-owner was editing and deploying production, and the owner could not see it.

### 6. Surface the incumbent in the skill's opening state check

Add `.po-owner` to the one-pass state command the skill already runs, so the first
thing any session learns is whether someone else holds the role.

## What this does not fix

The lock covers the dispatch channel only. Two sessions can still both hold the
service-role key, the access token and deploy rights, and act on production
directly. Section 5 addresses that as a rule, not a mechanism. A real fix would
scope those credentials to the claim holder — worth considering, out of scope here.

## Acceptance

1. Two sessions invoke the skill; the second reports the incumbent and does not
   become PO.
2. A `.msg` with a foreign or missing `PO-Session` header lands in `rejected/`,
   is logged with both ids, and never reaches the crew.
3. Killing the owner session and waiting 30 min lets the next session take over,
   with the takeover logged as stale.
4. A non-owner session can still run the canary and read the meters.
