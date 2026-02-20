#!/usr/bin/env python3
"""
content_qa.py — SprintAI Content QA Agent 🍬

Second-pass quality gate that reviews every draft social media post before
it enters the live content calendar. Acts as a "Mercedes-level" QA layer —
generic, robotic, or weak posts are caught and rewritten automatically.

Pipeline position:
  1. content_generator.py  →  generates drafts  (status: draft)
  2. content_qa.py         →  scores & rewrites  (status: draft → pending)
  3. post_scheduler.py     →  publishes pending posts on schedule

Usage:
    python content_qa.py --client_id UUID --month 2026-03

    # Preview scores without saving any changes
    python content_qa.py --client_id UUID --month 2026-03 --dry-run

Required env vars (see .env.example):
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY

Scoring rubric (6 dimensions, 1–10 each):
    Hook Strength    — does the opener stop the scroll?
    Local Specificity — does this feel written for THIS city/company?
    Value Delivery   — is there something useful for the reader?
    CTA Clarity      — is the call to action clear and specific?
    Platform Fit     — does it match the platform's format/norms?
    Authenticity     — does it sound like a real local business owner?

Verdict thresholds:
    average >= 7.0  →  APPROVED  (original kept, status → pending)
    average <  7.0  →  REWRITE   (improved_version saved, status → pending)
"""

import argparse
import json
import os
import re
from datetime import datetime
from pathlib import Path

import requests
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
APPROVAL_THRESHOLD = 7.0

# Path to optional external rubric file
RUBRIC_PATH = Path(__file__).parent.parent / "content" / "qa-scoring-rubric.md"


# ---------------------------------------------------------------------------
# Built-in scoring rubric (used when qa-scoring-rubric.md doesn't exist)
# ---------------------------------------------------------------------------

BUILTIN_RUBRIC = """
## Hook Strength (1-10)
- 9-10: Immediately stops scroll — question, bold claim, surprising stat, or relatable pain point
- 7-8: Clear and relevant, draws reader in
- 4-6: Generic opener ("At [Company], we pride ourselves...")
- 1-3: No hook, starts with company name or boring statement

## Local Specificity (1-10)
- 9-10: Mentions specific city, neighborhood, or local reference; feels written for THIS company
- 7-8: Includes company name and city naturally
- 4-6: Generic but could have a city swapped in
- 1-3: Could be any HVAC company anywhere

## Value Delivery (1-10)
- 9-10: Teaches something useful, solves a problem, or entertains
- 7-8: Has clear value proposition beyond just "hire us"
- 4-6: Mostly promotional but has one useful element
- 1-3: Pure advertisement, zero value to reader

## CTA Clarity (1-10)
- 9-10: Clear, specific action ("Call us at [number]", "Comment your zip code", "Save this for summer")
- 7-8: Implied action that's easy to take
- 4-6: Vague ("Contact us today", "Learn more")
- 1-3: No CTA or confusing CTA

## Platform Fit (1-10)
- Facebook: 150-300 words, conversational, community-focused, 3-5 relevant hashtags
- Instagram: 150 words max, strong first line (truncates at first line), 5-10 focused hashtags
- GBP (Google Business Profile): 150-300 chars, action-oriented, no hashtags, uses CTA button context
- Score based on how well the post matches the specs for its specific platform

## Authenticity (1-10)
- 9-10: Sounds like a real local business owner wrote it; natural, slightly imperfect voice
- 7-8: Sounds human, conversational
- 4-6: Slightly corporate or templated
- 1-3: Obviously AI-generated — overly polished, generic phrases ("In today's fast-paced world"), or reads like a brochure
""".strip()


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def get_supabase() -> Client:
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )


def get_client_record(sb: Client, client_id: str) -> dict:
    result = sb.table("sprintai_clients").select("*").eq("id", client_id).execute()
    if not result.data:
        raise ValueError(f"Client {client_id} not found.")
    return result.data[0]


def get_draft_posts(sb: Client, client_id: str, month: str) -> list[dict]:
    """Pull all draft posts for this client and month."""
    # month is "YYYY-MM"; scheduled_at is a TIMESTAMPTZ
    # Filter: scheduled_at starts with YYYY-MM (i.e. gte first day, lt first day of next month)
    year, mon = month.split("-")
    start = f"{year}-{mon}-01T00:00:00+00:00"

    # Compute end of month
    next_month = int(mon) + 1
    next_year = int(year)
    if next_month > 12:
        next_month = 1
        next_year += 1
    end = f"{next_year}-{next_month:02d}-01T00:00:00+00:00"

    result = (
        sb.table("sprintai_content_calendar")
        .select("*")
        .eq("client_id", client_id)
        .eq("status", "draft")
        .gte("scheduled_at", start)
        .lt("scheduled_at", end)
        .order("scheduled_at")
        .execute()
    )
    return result.data or []


# ---------------------------------------------------------------------------
# Load rubric
# ---------------------------------------------------------------------------

def load_rubric() -> str:
    """Return the scoring rubric — from file if it exists, otherwise built-in."""
    if RUBRIC_PATH.exists():
        rubric_text = RUBRIC_PATH.read_text(encoding="utf-8").strip()
        print(f"📋 Loaded rubric from {RUBRIC_PATH}")
        return rubric_text
    print("📋 Using built-in scoring rubric")
    return BUILTIN_RUBRIC


# ---------------------------------------------------------------------------
# Claude QA call
# ---------------------------------------------------------------------------

PLATFORM_LABELS = {
    "facebook":        "Facebook",
    "instagram":       "Instagram",
    "google_business": "Google Business Profile (GBP)",
}


def build_qa_prompt(post: dict, client: dict, rubric: str) -> tuple[str, str]:
    """Return (system_prompt, user_message) for the QA call."""
    platform_label = PLATFORM_LABELS.get(post["platform"], post["platform"])
    company_name   = client.get("name", "Unknown Company")
    city           = client.get("city", client.get("state", "their local area"))

    system_prompt = f"""You are a senior social media content QA specialist for local HVAC businesses.
You review posts and score them on a strict rubric. You have extremely high standards.
Generic, AI-sounding, or weak content always fails your review.

Your scoring rubric:

{rubric}

You MUST respond with valid JSON only — no markdown, no explanation outside the JSON."""

    user_message = f"""Review this social media post for {company_name}, an HVAC contractor in {city}.

Platform: {platform_label}
Company: {company_name}
City: {city}

--- POST TEXT ---
{post["post_text"]}
--- END POST ---

Score this post on all 6 dimensions. If the average is below 7.0, write an improved version.

Respond with ONLY this JSON structure (no markdown fences):
{{
  "scores": {{
    "hook_strength": <1-10>,
    "local_specificity": <1-10>,
    "value_delivery": <1-10>,
    "cta_clarity": <1-10>,
    "platform_fit": <1-10>,
    "authenticity": <1-10>
  }},
  "average": <decimal>,
  "verdict": "APPROVED" or "REWRITE",
  "issues": ["issue 1", "issue 2"],
  "improved_version": "<rewritten post text, or empty string if APPROVED>"
}}"""

    return system_prompt, user_message


def call_claude_qa(system_prompt: str, user_message: str, retries: int = 2) -> dict:
    """Call Claude for QA scoring. Returns parsed JSON dict."""
    for attempt in range(retries + 1):
        try:
            r = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key":         ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type":      "application/json",
                },
                json={
                    "model":      "claude-3-5-sonnet-20241022",
                    "max_tokens": 1200,
                    "system":     system_prompt,
                    "messages":   [{"role": "user", "content": user_message}],
                },
                timeout=60,
            )
            r.raise_for_status()
            raw = r.json()["content"][0]["text"].strip()

            # Strip markdown code fences if Claude added them
            if raw.startswith("```"):
                raw = re.sub(r"^```(?:json)?\n?", "", raw)
                raw = re.sub(r"\n?```$", "", raw)

            result = json.loads(raw)

            # Validate expected keys
            required = {"scores", "average", "verdict", "issues", "improved_version"}
            if not required.issubset(result.keys()):
                raise ValueError(f"Missing keys in QA response: {result.keys()}")

            # Recalculate average for accuracy
            scores = result["scores"]
            avg = round(sum(scores.values()) / len(scores), 1)
            result["average"] = avg

            # Enforce verdict based on threshold
            result["verdict"] = "APPROVED" if avg >= APPROVAL_THRESHOLD else "REWRITE"

            return result

        except Exception as exc:
            if attempt < retries:
                print(f"    ⚠️  Retry {attempt + 1}/{retries} — {exc}")
            else:
                raise RuntimeError(f"QA call failed after {retries + 1} attempts: {exc}")


# ---------------------------------------------------------------------------
# Apply results to Supabase
# ---------------------------------------------------------------------------

def apply_qa_result(sb: Client, post: dict, qa: dict, dry_run: bool) -> None:
    """Update the calendar row and insert into qa_log."""
    verdict     = qa["verdict"]
    rewritten   = verdict == "REWRITE" and bool(qa.get("improved_version", "").strip())
    new_text    = qa["improved_version"].strip() if rewritten else post["post_text"]
    scores      = qa["scores"]

    if dry_run:
        return

    # Update calendar row
    update_payload = {
        "status":        "pending",
        "status_prev":   "draft",
        "qa_score":      qa["average"],
        "qa_rewritten":  rewritten,
    }
    if rewritten:
        update_payload["post_text"] = new_text

    sb.table("sprintai_content_calendar") \
      .update(update_payload) \
      .eq("id", post["id"]) \
      .execute()

    # Insert QA log row
    log_row = {
        "client_id":        post["client_id"],
        "calendar_id":      post["id"],
        "platform":         post["platform"],
        "score_hook":       scores.get("hook_strength"),
        "score_local":      scores.get("local_specificity"),
        "score_value":      scores.get("value_delivery"),
        "score_cta":        scores.get("cta_clarity"),
        "score_platform":   scores.get("platform_fit"),
        "score_authenticity": scores.get("authenticity"),
        "score_average":    qa["average"],
        "verdict":          verdict,
        "issues":           qa.get("issues", []),
        "was_rewritten":    rewritten,
    }
    sb.table("sprintai_qa_log").insert(log_row).execute()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="SprintAI Content QA Agent — scores and improves draft posts",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--client_id", required=True, help="SprintAI client UUID")
    parser.add_argument("--month",     required=True,
                        help="Month to QA, YYYY-MM (e.g. 2026-03)")
    parser.add_argument("--dry-run",   action="store_true",
                        help="Score posts but do NOT update Supabase")
    args = parser.parse_args()

    # Validate month format
    if not re.match(r"^\d{4}-\d{2}$", args.month):
        print("❌ --month must be in YYYY-MM format")
        raise SystemExit(1)

    sb      = get_supabase()
    client  = get_client_record(sb, args.client_id)
    rubric  = load_rubric()

    print(f"\n🔍 SprintAI Content QA — {client['name']} | {args.month}")
    print(f"   Client ID: {args.client_id}")
    if args.dry_run:
        print("   ⚡ DRY RUN — no Supabase changes will be made")
    print()

    posts = get_draft_posts(sb, args.client_id, args.month)

    if not posts:
        print("⚠️  No draft posts found for this client / month.")
        print("   Make sure content_generator.py has been run first (saves status='draft').")
        raise SystemExit(0)

    print(f"📬 Found {len(posts)} draft posts to review\n")

    # Track stats
    results          = []
    approved_count   = 0
    rewritten_count  = 0
    total_score      = 0.0
    lowest_score     = 11.0
    lowest_preview   = ""

    for i, post in enumerate(posts, 1):
        platform = PLATFORM_LABELS.get(post["platform"], post["platform"])
        preview  = post["post_text"][:60].replace("\n", " ") + "…"
        print(f"  [{i:02d}/{len(posts)}] {platform:<28} {preview}")

        try:
            system_prompt, user_message = build_qa_prompt(post, client, rubric)
            qa = call_claude_qa(system_prompt, user_message)
        except Exception as exc:
            print(f"         ❌ QA failed: {exc}\n")
            # Don't block the pipeline — skip this post
            continue

        avg     = qa["average"]
        verdict = qa["verdict"]
        total_score += avg

        verdict_emoji = "✅" if verdict == "APPROVED" else "✏️ "
        issues_str    = "; ".join(qa.get("issues", [])[:2]) if qa.get("issues") else ""

        print(f"         {verdict_emoji} {verdict}  avg={avg:.1f}  |  {issues_str}")

        if verdict == "APPROVED":
            approved_count += 1
        else:
            rewritten_count += 1
            if qa.get("improved_version"):
                rewrite_preview = qa["improved_version"][:60].replace("\n", " ")
                print(f"         → New: {rewrite_preview}…")

        if avg < lowest_score:
            lowest_score   = avg
            lowest_preview = post["post_text"][:80].replace("\n", " ")

        apply_qa_result(sb, post, qa, dry_run=args.dry_run)
        results.append((post, qa))

    # ---------------------------------------------------------------------------
    # Summary
    # ---------------------------------------------------------------------------
    reviewed     = len(results)
    avg_score    = round(total_score / reviewed, 1) if reviewed else 0.0
    approved_pct = round(approved_count / reviewed * 100) if reviewed else 0
    rewrite_pct  = round(rewritten_count / reviewed * 100) if reviewed else 0

    print()
    print("=" * 55)
    print(f"  QA Complete — {client['name']} | {args.month}")
    print("=" * 55)
    print(f"  Posts reviewed : {reviewed}")
    print(f"  Approved       : {approved_count} ({approved_pct}%)")
    print(f"  Rewritten      : {rewritten_count} ({rewrite_pct}%)")
    print(f"  Average score  : {avg_score}")
    if lowest_preview:
        print(f"  Lowest post    : {lowest_preview}… — {lowest_score:.1f} avg")
    if args.dry_run:
        print()
        print("  ⚡ DRY RUN — Supabase was NOT updated.")
    print("=" * 55)
    print()


if __name__ == "__main__":
    main()
