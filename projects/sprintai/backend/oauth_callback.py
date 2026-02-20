#!/usr/bin/env python3
"""
oauth_callback.py — SprintAI OAuth handler

Exchanges an OAuth authorization code for access tokens and saves the
connection to Supabase.

Usage:
    python oauth_callback.py --platform facebook --code CODE --client_id UUID
    python oauth_callback.py --platform google   --code CODE --client_id UUID

Required env vars (see .env.example):
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
    FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
    OAUTH_REDIRECT_BASE_URL
"""

import argparse
import os
import sys
from datetime import datetime, timezone, timedelta

import requests
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_supabase() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def upsert_connection(sb: Client, client_id: str, platform: str,
                      page_id: str, page_name: str,
                      access_token: str, token_expires_at=None):
    """Insert or update a social connection row."""
    record = {
        "client_id":        client_id,
        "platform":         platform,
        "page_id":          page_id,
        "page_name":        page_name,
        "access_token":     access_token,
        "token_expires_at": token_expires_at.isoformat() if token_expires_at else None,
    }
    # Upsert on (client_id, platform, page_id)
    sb.table("sprintai_social_connections").upsert(
        record,
        on_conflict="client_id,platform,page_id"
    ).execute()
    print(f"  ✅ Saved: [{platform}] {page_name or page_id}")


# ---------------------------------------------------------------------------
# Facebook flow
# ---------------------------------------------------------------------------

def handle_facebook(code: str, client_id: str, sb: Client):
    """
    1. Exchange code for short-lived user token
    2. Exchange for long-lived token (60-day)
    3. Fetch all managed pages (each has its own permanent page token)
    4. Store each page in sprintai_social_connections
    """
    app_id     = os.environ["FACEBOOK_APP_ID"]
    app_secret = os.environ["FACEBOOK_APP_SECRET"]
    redirect   = os.environ["OAUTH_REDIRECT_BASE_URL"].rstrip("/") + "/facebook"

    print("→ Exchanging code for short-lived user token …")
    r = requests.get(
        "https://graph.facebook.com/v19.0/oauth/access_token",
        params={
            "client_id":     app_id,
            "redirect_uri":  redirect,
            "client_secret": app_secret,
            "code":          code,
        },
        timeout=15,
    )
    r.raise_for_status()
    short_token = r.json()["access_token"]

    print("→ Exchanging for long-lived token (60 days) …")
    r = requests.get(
        "https://graph.facebook.com/v19.0/oauth/access_token",
        params={
            "grant_type":        "fb_exchange_token",
            "client_id":         app_id,
            "client_secret":     app_secret,
            "fb_exchange_token": short_token,
        },
        timeout=15,
    )
    r.raise_for_status()
    data        = r.json()
    long_token  = data["access_token"]
    expires_in  = data.get("expires_in", 5_184_000)   # default 60 days
    user_token_expires = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

    print("→ Fetching managed pages …")
    r = requests.get(
        "https://graph.facebook.com/v19.0/me/accounts",
        params={
            "access_token": long_token,
            "fields":       "id,name,access_token,instagram_business_account",
        },
        timeout=15,
    )
    r.raise_for_status()
    pages = r.json().get("data", [])

    if not pages:
        print("⚠️  No Facebook pages found for this account.")
        return

    for page in pages:
        page_id          = page["id"]
        page_name        = page["name"]
        page_token       = page["access_token"]   # permanent page access token

        # Store Facebook page
        upsert_connection(
            sb, client_id, "facebook",
            page_id, page_name, page_token,
            token_expires_at=None  # page tokens do not expire if generated from long-lived user token
        )

        # If the page has a linked Instagram Business account, store that too
        ig = page.get("instagram_business_account")
        if ig:
            ig_id = ig["id"]
            # Fetch IG username
            ir = requests.get(
                f"https://graph.facebook.com/v19.0/{ig_id}",
                params={"fields": "username", "access_token": page_token},
                timeout=15,
            )
            ir.raise_for_status()
            ig_name = ir.json().get("username", ig_id)
            upsert_connection(
                sb, client_id, "instagram",
                ig_id, ig_name, page_token,
                token_expires_at=None
            )

    print(f"✅ Facebook OAuth complete. {len(pages)} page(s) connected.")


# ---------------------------------------------------------------------------
# Google Business flow
# ---------------------------------------------------------------------------

def handle_google(code: str, client_id: str, sb: Client):
    """
    1. Exchange code for access + refresh tokens
    2. Fetch account/location info from Google My Business API
    3. Store each location in sprintai_social_connections
    """
    g_client_id     = os.environ["GOOGLE_CLIENT_ID"]
    g_client_secret = os.environ["GOOGLE_CLIENT_SECRET"]
    redirect        = os.environ["OAUTH_REDIRECT_BASE_URL"].rstrip("/") + "/google"

    print("→ Exchanging code for tokens …")
    r = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "code":          code,
            "client_id":     g_client_id,
            "client_secret": g_client_secret,
            "redirect_uri":  redirect,
            "grant_type":    "authorization_code",
        },
        timeout=15,
    )
    r.raise_for_status()
    token_data    = r.json()
    access_token  = token_data["access_token"]
    refresh_token = token_data.get("refresh_token")

    if not refresh_token:
        print("⚠️  No refresh_token returned. User may have already authorized before.")
        print("    Re-connect with prompt=consent to force a new refresh token.")

    # Fetch GBP accounts
    print("→ Fetching Google Business accounts …")
    r = requests.get(
        "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    r.raise_for_status()
    accounts = r.json().get("accounts", [])

    stored = 0
    for account in accounts:
        account_name = account["name"]   # e.g. "accounts/123456"

        # Fetch locations for this account
        r = requests.get(
            f"https://mybusinessbusinessinformation.googleapis.com/v1/{account_name}/locations",
            params={"readMask": "name,title"},
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=15,
        )
        if not r.ok:
            print(f"  ⚠️  Could not fetch locations for {account_name}: {r.text}")
            continue

        locations = r.json().get("locations", [])
        for loc in locations:
            loc_name  = loc["name"]    # e.g. "accounts/123/locations/456"
            loc_title = loc.get("title", loc_name)

            # We store the refresh token against each location.
            # The scheduler will use it to get fresh access tokens at post time.
            upsert_connection(
                sb, client_id, "google_business",
                loc_name, loc_title,
                refresh_token or access_token,
                token_expires_at=None  # refresh token has no expiry
            )
            stored += 1

    print(f"✅ Google OAuth complete. {stored} location(s) connected.")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="SprintAI OAuth callback handler")
    parser.add_argument("--platform",  required=True, choices=["facebook", "google"],
                        help="Platform being connected")
    parser.add_argument("--code",      required=True, help="Authorization code from OAuth redirect")
    parser.add_argument("--client_id", required=True, help="SprintAI client UUID")
    args = parser.parse_args()

    sb = get_supabase()

    # Verify client exists
    result = sb.table("sprintai_clients").select("id, name").eq("id", args.client_id).execute()
    if not result.data:
        print(f"❌ Client {args.client_id} not found in Supabase.")
        sys.exit(1)
    print(f"Client: {result.data[0]['name']} ({args.client_id})")

    if args.platform == "facebook":
        handle_facebook(args.code, args.client_id, sb)
    elif args.platform == "google":
        handle_google(args.code, args.client_id, sb)


if __name__ == "__main__":
    main()
