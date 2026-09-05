#!/usr/bin/env python3
"""publish-build-status.py — derive Command Center build status from real
sources and publish it to build_status_* via service-role RPC.

Invoked by scripts/publish-build-status.sh, which does the cheap shell-first
no-op check (git HEAD + READINESS.md mtime unchanged) before spawning this at
all. Never invokes a model — every value here traces to
docs/specs/2026-09-03-READINESS.md, `git log`, or the Supabase Management API.

Two modes:
  publish-build-status.py <head_sha> <readiness_mtime_iso>
      Full run: parse the board, derive today's commits, fetch deployed
      function versions, write all four build_status_* tables. On ANY
      failure, writes build_status_meta with publisher_ok=false and the
      error, and does NOT touch items/commits/functions (stale data stays
      stale rather than half-overwritten; the dashboard's freshness guard
      hides it either way).

  publish-build-status.py --heartbeat <head_sha> <readiness_mtime_iso>
      Nothing changed since the last successful run. Bumps
      build_status_meta.generated_at only — no parse, no git log, no API
      call. Costs one HTTP request.
"""
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
import zoneinfo

REPO = os.path.expanduser("~/sprintai-ordering")
READINESS = os.path.join(REPO, "docs/specs/2026-09-03-READINESS.md")

JASON_RE = re.compile(r"Jason|BLOCKED ON JASON|Jason's (action|integration test)", re.I)

# A cell that explicitly declares nothing outstanding. Checked FIRST, because the
# same cell often goes on to suggest an integration test Jason *could* run — that
# is a suggestion, not a blocker.
NO_BLOCKER_RE = re.compile(r"^\s*(?:[-—–]|none|no blockers|n/?a|no migration needed)\b", re.I)


def env(name):
    v = os.environ.get(name)
    if not v:
        sys.exit(f"missing env var {name}")
    return v


SUPABASE_URL = env("SPRINTAI_CHAT_SUPABASE_URL").rstrip("/")
SERVICE_ROLE_KEY = env("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")
PROJECT_REF = env("SPRINTAI_CHAT_SUPABASE_PROJECT_REF")
MGMT_TOKEN = env("SUPABASE_ACCESS_TOKEN")


def split_row(line):
    parts = line.strip().split("|")
    if parts and parts[0].strip() == "":
        parts = parts[1:]
    if parts and parts[-1].strip() == "":
        parts = parts[:-1]
    return [p.strip() for p in parts]


def parse_readiness():
    """Parse the real markdown table. Never hardcode item keys — items get added."""
    with open(READINESS) as fh:
        lines = fh.readlines()

    header_idx = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("|") and "Item" in stripped and "Status" in stripped and "What" in stripped:
            header_idx = i
            break
    if header_idx is None:
        raise RuntimeError("READINESS.md: table header row not found")

    header = [h.lower() for h in split_row(lines[header_idx])]
    col = {name: idx for idx, name in enumerate(header)}
    for required in ("item", "what", "status", "blockers"):
        if required not in col:
            raise RuntimeError(f"READINESS.md: table missing required column '{required}'")
    validated_idx = col.get("validated how")

    items = []
    sort_order = 0
    for line in lines[header_idx + 2:]:
        if not line.strip().startswith("|"):
            break
        cells = split_row(line)
        if len(cells) < 2:
            continue
        # A row can be short a trailing cell (seen in practice on the real
        # board) — pad rather than drop the whole item, since dropping a row
        # silently would hide a real board item from the tile.
        cells += [""] * (len(header) - len(cells))
        item = cells[col["item"]]
        if not item:
            continue
        blockers = cells[col["blockers"]]
        validated_how = cells[validated_idx] if validated_idx is not None else ""
        # Derived from the BLOCKERS cell only. Reading "validated how" too flagged
        # items whose blocker cell literally says "No blockers" / "None" — on
        # 2026-09-05 that put 7 of 14 items in front of Jason when 3 were real.
        # A tile that cries wolf is the same failure as one that drifts: he stops
        # trusting it. An item is blocked on Jason only when its blockers cell
        # names him AND does not open by declaring there is nothing outstanding.
        blocked_on_jason = bool(
            blockers
            and not NO_BLOCKER_RE.match(blockers)
            and JASON_RE.search(blockers)
        )
        items.append({
            "item": item,
            "what": cells[col["what"]],
            "status": cells[col["status"]],
            "blockers": None if blockers.strip() in ("", "—", "-") else blockers,
            "blocked_on_jason": blocked_on_jason,
            "sort_order": sort_order,
        })
        sort_order += 1

    if not items:
        raise RuntimeError("READINESS.md: parsed zero item rows")
    return items


def git_log_since_midnight_et():
    """Commits since local midnight America/New_York, regardless of host TZ."""
    tz = zoneinfo.ZoneInfo("America/New_York")
    midnight = datetime.datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    out = subprocess.run(
        ["git", "-C", REPO, "log", f"--since={midnight.isoformat()}",
         "--date=iso-strict", "--pretty=format:%H%x1f%s%x1f%cI%x1f%an"],
        check=True, capture_output=True, text=True,
    ).stdout
    commits = []
    for line in out.splitlines():
        if not line.strip():
            continue
        sha, subject, committed_at, author = line.split("\x1f")
        commits.append({"sha": sha, "subject": subject, "committed_at": committed_at, "author": author})
    return commits


# The Supabase Management API's Cloudflare WAF 403s Python's default
# urllib User-Agent (error code 1010) — curl and browsers pass fine, so send
# a plain, non-default one on every request to both Supabase APIs.
UA = {"User-Agent": "sprintai-build-status-publisher/1.0"}


def fetch_functions():
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT_REF}/functions",
        headers={"Authorization": f"Bearer {MGMT_TOKEN}", **UA},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.load(resp)
    out = []
    for f in data:
        dep_ms = f.get("updated_at")
        deployed_at = (
            datetime.datetime.utcfromtimestamp(dep_ms / 1000).isoformat() + "Z"
            if dep_ms else None
        )
        out.append({"slug": f["slug"], "version": f.get("version", 0), "deployed_at": deployed_at})
    if not out:
        raise RuntimeError("Management API returned zero functions")
    return out


def rpc(fn_name, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/{fn_name}",
        data=body,
        method="POST",
        headers={
            "apikey": SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            **UA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{fn_name} HTTP {e.code}: {e.read().decode(errors='replace')[:500]}")


def publish_meta(head_sha, readiness_mtime_iso, ok, error):
    rpc("publish_build_status_meta", {
        "p_head_sha": head_sha,
        "p_readiness_mtime": readiness_mtime_iso,
        "p_publisher_ok": ok,
        "p_publisher_error": (error[:2000] if error else None),
    })


def main():
    args = sys.argv[1:]
    heartbeat = False
    if args and args[0] == "--heartbeat":
        heartbeat = True
        args = args[1:]
    if len(args) != 2:
        sys.exit("usage: publish-build-status.py [--heartbeat] <head_sha> <readiness_mtime_iso>")
    head_sha, readiness_mtime_iso = args

    if heartbeat:
        publish_meta(head_sha, readiness_mtime_iso, True, None)
        print(f"HEARTBEAT head={head_sha[:8]}")
        return

    try:
        items = parse_readiness()
        commits = git_log_since_midnight_et()
        functions = fetch_functions()

        rpc("publish_build_status_items", {"p_items": items})
        rpc("publish_build_status_commits", {"p_commits": commits})
        rpc("publish_build_status_functions", {"p_functions": functions})
        publish_meta(head_sha, readiness_mtime_iso, True, None)
    except Exception as e:
        try:
            publish_meta(head_sha, readiness_mtime_iso, False, str(e))
        except Exception as meta_e:
            print(f"FATAL: primary failure {e!r}; meta publish ALSO failed: {meta_e!r}", file=sys.stderr)
            sys.exit(1)
        print(f"FAIL: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"OK head={head_sha[:8]} items={len(items)} commits={len(commits)} functions={len(functions)}")


if __name__ == "__main__":
    main()
