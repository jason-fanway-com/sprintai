#!/usr/bin/env python3
"""
content_generator.py — SprintAI HVAC Content Generator

Generates a full month of social media posts for a client using Claude,
then saves them as drafts in `sprintai_content_calendar` for QA review.

Usage:
    python content_generator.py --client_id UUID --month 2026-03

Posts are scheduled Mon/Wed/Fri at 10:00 AM (local time based on client
timezone, defaulting to US/Eastern).  12 posts per platform per month.

Content pipeline (two-step):
    1. content_generator.py — generates drafts (status: draft)
    2. content_qa.py        — reviews, scores, rewrites if needed → (status: pending)
    3. post_scheduler.py    — publishes pending posts where scheduled_at <= now()

Required env vars (see .env.example):
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
"""

import argparse
import json
import os
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
PLATFORMS = ["facebook", "instagram", "google_business"]
POSTS_PER_PLATFORM = 12   # ~3/week across a 4-week month


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def get_supabase() -> Client:
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )


def get_client(sb: Client, client_id: str) -> dict:
    result = sb.table("sprintai_clients").select("*").eq("id", client_id).execute()
    if not result.data:
        raise ValueError(f"Client {client_id} not found.")
    return result.data[0]


# ---------------------------------------------------------------------------
# Schedule helpers — Mon/Wed/Fri at 10 AM
# ---------------------------------------------------------------------------

MWF = {0, 2, 4}  # Monday=0, Wednesday=2, Friday=4


def get_posting_slots(year: int, month: int, timezone_str: str = "America/New_York",
                      hour: int = 10) -> list[datetime]:
    """Return Mon/Wed/Fri 10 AM slots for the given month, as UTC datetimes."""
    tz   = ZoneInfo(timezone_str)
    d    = date(year, month, 1)
    slots: list[datetime] = []

    while d.month == month:
        if d.weekday() in MWF:
            local_dt = datetime(d.year, d.month, d.day, hour, 0, 0, tzinfo=tz)
            slots.append(local_dt.astimezone(ZoneInfo("UTC")))
        d += timedelta(days=1)

    return slots


# ---------------------------------------------------------------------------
# Claude content generation
# ---------------------------------------------------------------------------

PLATFORM_GUIDANCE = {
    "facebook": (
        "Facebook — conversational, 1-3 short paragraphs, can include a call to action. "
        "Friendly and informative. Up to 300 words."
    ),
    "instagram": (
        "Instagram — punchy, visually descriptive, 5-10 lines max, ends with 5-8 relevant "
        "hashtags (HVAC, local city hashtags, seasonal). 150 words max."
    ),
    "google_business": (
        "Google Business Profile Local Post — professional, concise (100-150 words), "
        "focuses on a single offer, tip, or update. No hashtags."
    ),
}

HVAC_THEMES = [
    "spring AC tune-up promotion",
    "why regular filter changes save money",
    "signs your AC needs repair before summer",
    "energy-saving tips for summer cooling",
    "indoor air quality and HEPA filters",
    "what an HVAC maintenance plan includes",
    "heating system checkup before winter",
    "emergency HVAC service — we're available 24/7",
    "5-star customer review highlight",
    "furnace efficiency and when to replace",
    "smart thermostat installation benefits",
    "humidity control and comfort",
    "common AC myths debunked",
    "how often to service your HVAC system",
    "duct cleaning benefits",
    "SEER ratings explained — choosing the right unit",
]


def call_claude(prompt: str) -> str:
    """Call Claude claude-3-5-haiku via Messages API and return the text."""
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key":         ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type":      "application/json",
        },
        json={
            "model":      "claude-3-5-haiku-20241022",
            "max_tokens": 600,
            "messages":   [{"role": "user", "content": prompt}],
        },
        timeout=60,
    )
    r.raise_for_status()
    return r.json()["content"][0]["text"].strip()


def generate_posts_for_platform(client: dict, platform: str,
                                 themes: list[str]) -> list[str]:
    """Ask Claude to generate POSTS_PER_PLATFORM posts for one platform."""
    platform_guide = PLATFORM_GUIDANCE[platform]
    themes_str     = "\n".join(f"- {t}" for t in themes)
    company_name   = client["name"]

    prompt = f"""You are a social media copywriter for {company_name}, a local HVAC contractor.

Platform: {platform_guide}

Write exactly {POSTS_PER_PLATFORM} unique social media posts for this HVAC company.
Each post should cover one of these themes (you may choose which and reorder them):
{themes_str}

Rules:
- Sound like a real local HVAC company, not a faceless corporation
- Be helpful and trust-building, not salesy
- Vary the tone: some tips, some offers, some social proof
- DO NOT include image descriptions or stage directions
- Return ONLY a JSON array of {POSTS_PER_PLATFORM} strings, nothing else.
  Example format: ["Post text 1", "Post text 2", ...]

Output the JSON array now:"""

    raw = call_claude(prompt)

    # Parse the JSON array
    # Claude may wrap it in code fences — strip them
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    posts = json.loads(raw.strip())
    if not isinstance(posts, list) or len(posts) < POSTS_PER_PLATFORM:
        raise ValueError(f"Claude returned unexpected format: {raw[:200]}")

    return posts[:POSTS_PER_PLATFORM]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="SprintAI HVAC Content Generator")
    parser.add_argument("--client_id", required=True, help="SprintAI client UUID")
    parser.add_argument("--month",     required=True,
                        help="Month to generate for, YYYY-MM (e.g. 2026-03)")
    parser.add_argument("--timezone",  default="America/New_York",
                        help="Client's local timezone (default: America/New_York)")
    parser.add_argument("--dry-run",   action="store_true",
                        help="Print posts without saving to Supabase")
    args = parser.parse_args()

    # Parse month
    try:
        year, month = (int(x) for x in args.month.split("-"))
    except ValueError:
        print("❌ --month must be in YYYY-MM format")
        raise SystemExit(1)

    sb     = get_supabase()
    client = get_client(sb, args.client_id)
    print(f"Generating content for: {client['name']} ({args.client_id})")
    print(f"Month: {args.month}  |  Timezone: {args.timezone}")

    slots = get_posting_slots(year, month, args.timezone)
    print(f"Available posting slots: {len(slots)}")

    # Rotate themes so platforms get different coverage
    import random
    themes_shuffled = HVAC_THEMES.copy()
    random.shuffle(themes_shuffled)

    all_rows = []

    for i, platform in enumerate(PLATFORMS):
        print(f"\n→ Generating {POSTS_PER_PLATFORM} posts for {platform} …")
        # Rotate themes per platform
        platform_themes = themes_shuffled[i::len(PLATFORMS)] + themes_shuffled[:i]
        platform_themes = (platform_themes * 3)[:POSTS_PER_PLATFORM]

        try:
            posts = generate_posts_for_platform(client, platform, platform_themes)
        except Exception as exc:
            print(f"  ❌ Claude generation failed: {exc}")
            continue

        # Pair each post with a slot
        platform_slots = slots[:POSTS_PER_PLATFORM]

        for j, (text, slot) in enumerate(zip(posts, platform_slots)):
            row = {
                "client_id":    args.client_id,
                "platform":     platform,
                "post_text":    text,
                "image_url":    None,
                "scheduled_at": slot.isoformat(),
                "status":       "draft",   # Promoted to 'pending' by content_qa.py
            }
            all_rows.append(row)

            preview = text[:80].replace("\n", " ")
            print(f"  [{j+1:02d}] {slot.strftime('%b %d %H:%M UTC')} — {preview}…")

    if args.dry_run:
        print(f"\n✅ Dry run — {len(all_rows)} posts generated, NOT saved.")
        return

    if not all_rows:
        print("\n❌ No posts generated.")
        raise SystemExit(1)

    print(f"\n→ Saving {len(all_rows)} posts to Supabase …")
    # Batch insert
    sb.table("sprintai_content_calendar").insert(all_rows).execute()
    print(f"✅ Done! {len(all_rows)} posts scheduled for {args.month}.")


if __name__ == "__main__":
    main()
