#!/usr/bin/env python3
"""
SprintAI — Monthly Performance Report Generator
------------------------------------------------
Generates and emails a monthly performance report to each active client.

Usage:
    python monthly_report.py --month 2026-02

Requirements:
    pip install supabase python-dotenv

Environment variables (copy .env.example → .env):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    SMTP_HOST          (e.g. smtp.gmail.com or smtp.mail.me.com)
    SMTP_PORT          (e.g. 587)
    SMTP_USER          (sender email address)
    SMTP_PASS          (sender password / app password)
    PORTAL_URL         (e.g. https://getsprintai.com/portal/)
    FROM_NAME          (e.g. Jason @ SprintAI)
"""

import argparse
import os
import smtplib
import sys
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

# ── CONFIG ────────────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://fdxvflryvctvstxdbdtm.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SMTP_HOST    = os.environ.get("SMTP_HOST", "smtp.mail.me.com")
SMTP_PORT    = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER    = os.environ.get("SMTP_USER", "")
SMTP_PASS    = os.environ.get("SMTP_PASS", "")
PORTAL_URL   = os.environ.get("PORTAL_URL", "https://getsprintai.com/portal/")
FROM_NAME    = os.environ.get("FROM_NAME", "Jason @ SprintAI")

PLATFORM_LABELS = {
    "facebook":        "Facebook",
    "instagram":       "Instagram",
    "google_business": "Google Business Profile",
}


# ── HELPERS ──────────────────────────────────────────────────
def month_range(month_str: str):
    """Return (start_iso, end_iso) for a 'YYYY-MM' string."""
    year, month = map(int, month_str.split("-"))
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    if month == 12:
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    return start.isoformat(), end.isoformat()


def month_display_name(month_str: str) -> str:
    """'2026-02' → 'February 2026'"""
    year, month = map(int, month_str.split("-"))
    return datetime(year, month, 1).strftime("%B %Y")


def fmt_date(iso: str) -> str:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%B %d, %Y")


def group_by_platform(posts: list) -> dict:
    groups = {}
    for p in posts:
        plat = p.get("platform", "unknown")
        groups.setdefault(plat, []).append(p)
    return groups


# ── EMAIL TEMPLATE ───────────────────────────────────────────
def build_html_email(client: dict, month_str: str, published: list, upcoming: list) -> str:
    month_name   = month_display_name(month_str)
    company_name = client["name"]
    platform_groups = group_by_platform(published)
    active_platforms = len(platform_groups)
    portal_link = PORTAL_URL

    # Build published posts section
    if published:
        posts_by_platform_html = ""
        for platform, posts in platform_groups.items():
            label = PLATFORM_LABELS.get(platform, platform.title())
            rows = "".join(
                f"""<tr>
                      <td style="padding:6px 0;color:#94a3b8;font-size:13px;width:140px;vertical-align:top">
                        {fmt_date(p.get('posted_at') or p.get('created_at',''))}
                      </td>
                      <td style="padding:6px 0;color:#e2e8f0;font-size:13px;line-height:1.5">
                        {p.get('post_text','')[:160]}{'…' if len(p.get('post_text',''))>160 else ''}
                      </td>
                    </tr>"""
                for p in posts
            )
            posts_by_platform_html += f"""
            <div style="margin-bottom:24px">
              <div style="font-size:14px;font-weight:700;color:#3b82f6;margin-bottom:10px;
                          padding-bottom:6px;border-bottom:1px solid #334155">{label}</div>
              <table style="width:100%;border-collapse:collapse">{rows}</table>
            </div>"""
        published_section = f"""
        <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;margin-bottom:24px">
          <h3 style="margin:0 0 16px;color:#f1f5f9;font-size:16px">Posts Published This Month</h3>
          {posts_by_platform_html}
        </div>"""
    else:
        published_section = """
        <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;margin-bottom:24px;text-align:center">
          <p style="color:#64748b;margin:0">No posts were published this month.</p>
        </div>"""

    # Build upcoming preview section
    if upcoming:
        upcoming_rows = "".join(
            f"""<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:14px;margin-bottom:10px">
                  <div style="font-size:11px;color:#3b82f6;font-weight:700;text-transform:uppercase;
                               letter-spacing:.05em;margin-bottom:6px">
                    {PLATFORM_LABELS.get(p.get('platform',''),'Unknown')} · {fmt_date(p.get('scheduled_at',''))}
                  </div>
                  <div style="color:#cbd5e1;font-size:13px;line-height:1.6">
                    {p.get('post_text','')[:200]}{'…' if len(p.get('post_text',''))>200 else ''}
                  </div>
                </div>"""
            for p in upcoming[:3]
        )
        upcoming_section = f"""
        <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;margin-bottom:24px">
          <h3 style="margin:0 0 16px;color:#f1f5f9;font-size:16px">Next Month Preview</h3>
          <p style="color:#64748b;font-size:13px;margin:0 0 14px">Here's a peek at what's coming up next month:</p>
          {upcoming_rows}
        </div>"""
    else:
        upcoming_section = ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px">

    <!-- Header -->
    <div style="text-align:center;padding:32px 0 24px">
      <div style="display:inline-block;background:#3b82f6;border-radius:12px;
                  padding:10px 18px;font-size:22px;font-weight:900;color:#fff;letter-spacing:-0.5px">
        SprintAI
      </div>
      <div style="color:#475569;font-size:13px;margin-top:8px">Monthly Performance Report</div>
    </div>

    <!-- Greeting -->
    <div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:28px;margin-bottom:24px">
      <h1 style="margin:0 0 8px;color:#f1f5f9;font-size:22px;font-weight:700">
        Your {month_name} Report
      </h1>
      <p style="margin:0;color:#94a3b8;font-size:14px">
        Here's a look at how your SprintAI social media performed this month, {company_name}.
      </p>
    </div>

    <!-- Stats row -->
    <div style="display:flex;gap:12px;margin-bottom:24px">
      <div style="flex:1;background:#1e293b;border:1px solid #334155;border-radius:12px;
                  padding:20px;text-align:center">
        <div style="font-size:36px;font-weight:900;color:#3b82f6">{len(published)}</div>
        <div style="color:#64748b;font-size:12px;margin-top:4px">Posts Published</div>
      </div>
      <div style="flex:1;background:#1e293b;border:1px solid #334155;border-radius:12px;
                  padding:20px;text-align:center">
        <div style="font-size:36px;font-weight:900;color:#3b82f6">{active_platforms}</div>
        <div style="color:#64748b;font-size:12px;margin-top:4px">Platforms Active</div>
      </div>
    </div>

    {published_section}
    {upcoming_section}

    <!-- CTA -->
    <div style="background:#1e3a5f;border:1px solid #1d4ed8;border-radius:12px;
                padding:24px;text-align:center;margin-bottom:24px">
      <h3 style="margin:0 0 8px;color:#f1f5f9;font-size:16px">View your full dashboard</h3>
      <p style="margin:0 0 16px;color:#93c5fd;font-size:13px">
        See all your upcoming posts, social connections, and more — anytime.
      </p>
      <a href="{portal_link}"
         style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;
                font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px">
        Open My Dashboard →
      </a>
    </div>

    <!-- Footer -->
    <div style="text-align:center;padding:16px 0">
      <p style="color:#334155;font-size:12px;margin:0">
        SprintAI · AI-powered social media for HVAC contractors ·
        <a href="mailto:jason@getsprintai.com" style="color:#475569;text-decoration:none">jason@getsprintai.com</a>
      </p>
      <p style="color:#1e293b;font-size:11px;margin:6px 0 0">
        You're receiving this because you're a SprintAI client. Questions? Just reply.
      </p>
    </div>

  </div>
</body>
</html>"""


# ── SEND EMAIL ───────────────────────────────────────────────
def send_email(to_email: str, to_name: str, subject: str, html_body: str, dry_run: bool = False):
    if dry_run:
        print(f"  [DRY RUN] Would send to: {to_name} <{to_email}>")
        print(f"  Subject: {subject}")
        return

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = f"{FROM_NAME} <{SMTP_USER}>"
    msg["To"]      = f"{to_name} <{to_email}>"

    msg.attach(MIMEText(html_body, "html"))

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.ehlo()
        server.starttls()
        server.login(SMTP_USER, SMTP_PASS)
        server.sendmail(SMTP_USER, [to_email], msg.as_string())

    print(f"  ✅ Sent to {to_name} <{to_email}>")


# ── MAIN ─────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="SprintAI Monthly Report Generator")
    parser.add_argument("--month", required=True, help="Month to report on, e.g. 2026-02")
    parser.add_argument("--dry-run", action="store_true", help="Preview without sending emails")
    parser.add_argument("--client-id", help="Only process one client (for testing)")
    args = parser.parse_args()

    if not SUPABASE_KEY:
        print("ERROR: SUPABASE_SERVICE_ROLE_KEY not set in environment.", file=sys.stderr)
        sys.exit(1)

    if not args.dry_run and (not SMTP_USER or not SMTP_PASS):
        print("ERROR: SMTP_USER and SMTP_PASS must be set to send emails.", file=sys.stderr)
        sys.exit(1)

    # Validate month format
    try:
        datetime.strptime(args.month, "%Y-%m")
    except ValueError:
        print("ERROR: --month must be in YYYY-MM format (e.g. 2026-02)", file=sys.stderr)
        sys.exit(1)

    month_start, month_end = month_range(args.month)
    month_name = month_display_name(args.month)
    subject    = f"Your SprintAI Report — {month_name}"

    print(f"\n🚀 SprintAI Monthly Report — {month_name}")
    print(f"   Range: {month_start[:10]} → {month_end[:10]}")
    if args.dry_run:
        print("   Mode: DRY RUN (no emails will be sent)\n")
    else:
        print(f"   Sending from: {SMTP_USER}\n")

    # Connect to Supabase
    db = create_client(SUPABASE_URL, SUPABASE_KEY)

    # Fetch active clients
    query = db.from_("sprintai_clients").select("*").eq("status", "active")
    if args.client_id:
        query = query.eq("id", args.client_id)
    result = query.execute()
    clients = result.data or []

    if not clients:
        print("No active clients found.")
        return

    print(f"Found {len(clients)} active client(s).\n")

    for client in clients:
        print(f"→ Processing: {client['name']} ({client['email']})")

        # Posts published this month (join calendar via posts table)
        pub_result = db.from_("sprintai_posts") \
            .select("*, sprintai_content_calendar(post_text, platform, scheduled_at)") \
            .eq("client_id", client["id"]) \
            .gte("posted_at", month_start) \
            .lt("posted_at", month_end) \
            .execute()
        raw_posts = pub_result.data or []

        # Flatten: pull post_text and platform from the joined calendar row
        published = []
        for p in raw_posts:
            cal = p.get("sprintai_content_calendar") or {}
            published.append({
                "platform":  p.get("platform") or cal.get("platform", "unknown"),
                "post_text": cal.get("post_text", ""),
                "posted_at": p.get("posted_at", ""),
                "scheduled_at": cal.get("scheduled_at", ""),
            })

        # Upcoming posts next month (preview — first 3)
        next_start = month_end  # end of current month = start of next
        up_result = db.from_("sprintai_content_calendar") \
            .select("platform, post_text, scheduled_at") \
            .eq("client_id", client["id"]) \
            .eq("status", "pending") \
            .gte("scheduled_at", next_start) \
            .order("scheduled_at", desc=False) \
            .limit(3) \
            .execute()
        upcoming = up_result.data or []

        html = build_html_email(client, args.month, published, upcoming)
        send_email(client["email"], client["name"], subject, html, dry_run=args.dry_run)

    print(f"\n✅ Done! Processed {len(clients)} client(s).")


if __name__ == "__main__":
    main()
