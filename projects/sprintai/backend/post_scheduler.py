#!/usr/bin/env python3
"""
post_scheduler.py — SprintAI Post Scheduler

Pulls pending posts from `sprintai_content_calendar` where
`scheduled_at <= now()` and `status = 'pending'`, then publishes
them to the appropriate social platforms.

Run via cron every 15 minutes:
    */15 * * * * cd /path/to/backend && python post_scheduler.py >> /var/log/sprintai-scheduler.log 2>&1

Required env vars (see .env.example):
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
"""

import os
import sys
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def get_supabase() -> Client:
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )


def get_pending_posts(sb: Client):
    now_iso = datetime.now(timezone.utc).isoformat()
    result = (
        sb.table("sprintai_content_calendar")
        .select("*")
        .eq("status", "pending")
        .lte("scheduled_at", now_iso)
        .execute()
    )
    return result.data or []


def get_connection(sb: Client, client_id: str, platform: str):
    """Return the social connection record for a client+platform."""
    result = (
        sb.table("sprintai_social_connections")
        .select("*")
        .eq("client_id", client_id)
        .eq("platform", platform)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def mark_posted(sb: Client, calendar_id: str, client_id: str,
                platform: str, external_post_id: str):
    now_iso = datetime.now(timezone.utc).isoformat()
    sb.table("sprintai_content_calendar").update(
        {"status": "posted"}
    ).eq("id", calendar_id).execute()

    sb.table("sprintai_posts").insert({
        "calendar_id":      calendar_id,
        "client_id":        client_id,
        "platform":         platform,
        "external_post_id": external_post_id,
        "posted_at":        now_iso,
    }).execute()


def mark_failed(sb: Client, calendar_id: str, client_id: str,
                platform: str, error: str):
    sb.table("sprintai_content_calendar").update(
        {"status": "failed"}
    ).eq("id", calendar_id).execute()

    sb.table("sprintai_posts").insert({
        "calendar_id":   calendar_id,
        "client_id":     client_id,
        "platform":      platform,
        "error_message": error[:2000],
    }).execute()


# ---------------------------------------------------------------------------
# Platform posting helpers
# ---------------------------------------------------------------------------

def post_facebook(post: dict, connection: dict) -> str:
    """Post to a Facebook page. Returns the created post ID."""
    page_id    = connection["page_id"]
    page_token = connection["access_token"]

    payload = {"message": post["post_text"], "access_token": page_token}
    if post.get("image_url"):
        # Post as a photo
        r = requests.post(
            f"https://graph.facebook.com/v19.0/{page_id}/photos",
            data={
                "url":          post["image_url"],
                "caption":      post["post_text"],
                "access_token": page_token,
            },
            timeout=30,
        )
    else:
        r = requests.post(
            f"https://graph.facebook.com/v19.0/{page_id}/feed",
            data=payload,
            timeout=30,
        )

    r.raise_for_status()
    data = r.json()
    return data.get("post_id") or data.get("id", "unknown")


def post_instagram(post: dict, connection: dict) -> str:
    """
    Post to Instagram via the Content Publishing API.
    Requires an image_url for feed posts (IG does not allow text-only posts via API).
    """
    ig_user_id = connection["page_id"]
    page_token = connection["access_token"]

    image_url = post.get("image_url")
    if not image_url:
        raise ValueError("Instagram posts require an image_url.")

    # Step 1: Create media container
    r = requests.post(
        f"https://graph.facebook.com/v19.0/{ig_user_id}/media",
        data={
            "image_url":    image_url,
            "caption":      post["post_text"],
            "access_token": page_token,
        },
        timeout=30,
    )
    r.raise_for_status()
    creation_id = r.json()["id"]

    # Step 2: Publish the container
    r = requests.post(
        f"https://graph.facebook.com/v19.0/{ig_user_id}/media_publish",
        data={
            "creation_id":  creation_id,
            "access_token": page_token,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("id", creation_id)


def refresh_google_token(refresh_token: str) -> str:
    """Exchange a Google refresh token for a fresh access token."""
    r = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "grant_type":    "refresh_token",
            "refresh_token": refresh_token,
            "client_id":     os.environ["GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
        },
        timeout=15,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def post_google_business(post: dict, connection: dict) -> str:
    """Post a Local Post to Google Business Profile."""
    location_name = connection["page_id"]   # e.g. "accounts/123/locations/456"
    access_token  = refresh_google_token(connection["access_token"])

    body = {
        "languageCode": "en-US",
        "summary":      post["post_text"],
        "topicType":    "STANDARD",
    }
    if post.get("image_url"):
        body["media"] = [{"mediaFormat": "PHOTO", "sourceUrl": post["image_url"]}]

    r = requests.post(
        f"https://mybusiness.googleapis.com/v4/{location_name}/localPosts",
        json=body,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get("name", "unknown")


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

PLATFORM_HANDLERS = {
    "facebook":        post_facebook,
    "instagram":       post_instagram,
    "google_business": post_google_business,
}


def run():
    sb = get_supabase()
    pending = get_pending_posts(sb)

    if not pending:
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] No pending posts.")
        return

    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] "
          f"Found {len(pending)} pending post(s).")

    success = failed = skipped = 0

    for post in pending:
        calendar_id = post["id"]
        client_id   = post["client_id"]
        platform    = post["platform"]

        print(f"  → [{platform}] calendar:{calendar_id[:8]}…", end=" ")

        handler = PLATFORM_HANDLERS.get(platform)
        if not handler:
            print(f"SKIP (unknown platform)")
            skipped += 1
            continue

        connection = get_connection(sb, client_id, platform)
        if not connection:
            err = f"No {platform} connection found for client {client_id}"
            print(f"FAIL — {err}")
            mark_failed(sb, calendar_id, client_id, platform, err)
            failed += 1
            continue

        try:
            post_id = handler(post, connection)
            mark_posted(sb, calendar_id, client_id, platform, post_id)
            print(f"OK (ext_id={post_id})")
            success += 1
        except Exception as exc:
            err = str(exc)
            print(f"FAIL — {err}")
            mark_failed(sb, calendar_id, client_id, platform, err)
            failed += 1

    print(f"Done. ✅ {success} posted  ❌ {failed} failed  ⏭ {skipped} skipped")


if __name__ == "__main__":
    run()
