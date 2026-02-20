"""
send_onboarding_email.py — Send the SprintAI welcome + connect email to a new client.

Usage
-----
    python send_onboarding_email.py \\
        --client_email EMAIL \\
        --client_name  NAME \\
        --client_id    UUID

Environment variables required
-------------------------------
    SMTP_USER   Gmail address to send from  (e.g. jason@getsprintai.com)
    SMTP_PASS   Gmail App Password          (not your account password — see note below)

Gmail App Password note
-----------------------
    Go to myaccount.google.com → Security → App passwords.
    Generate a password for "Mail" on "Other device".
    This is the value for SMTP_PASS.

Can be imported and called programmatically:
    from send_onboarding_email import send_onboarding_email
    send_onboarding_email(
        client_email="owner@acmeair.com",
        client_name="Bob Smith",
        client_id="abc123-...",
    )
"""

import argparse
import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# ─── Config ─────────────────────────────────────────────────────────────────
SMTP_HOST  = "smtp.gmail.com"
SMTP_PORT  = 587
SMTP_USER  = os.environ.get("SMTP_USER", "jason@getsprintai.com")
SMTP_PASS  = os.environ.get("SMTP_PASS", "")          # Gmail App Password

FROM_NAME  = "Jason @ SprintAI"
FROM_ADDR  = SMTP_USER

CONNECT_BASE_URL = "https://getsprintai.com/connect"


# ─── Email Templates ────────────────────────────────────────────────────────

def _build_html(client_name: str, client_id: str) -> str:
    connect_url = f"{CONNECT_BASE_URL}?client_id={client_id}"
    first_name  = client_name.split()[0] if client_name else "there"

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body        {{ margin: 0; padding: 0; background: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }}
    .wrapper    {{ max-width: 560px; margin: 0 auto; padding: 40px 24px; }}
    .logo       {{ color: #3b82f6; font-size: 22px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 32px; }}
    .card       {{ background: #1e293b; border-radius: 16px; padding: 36px; margin-bottom: 24px; }}
    h1          {{ color: #f8fafc; font-size: 24px; font-weight: 700; margin: 0 0 12px; }}
    p           {{ color: #94a3b8; font-size: 15px; line-height: 1.65; margin: 0 0 16px; }}
    .highlight  {{ color: #e2e8f0; }}
    .cta-btn    {{ display: inline-block; background: #3b82f6; color: #ffffff !important;
                   text-decoration: none; font-weight: 700; font-size: 16px;
                   padding: 14px 32px; border-radius: 10px; margin: 8px 0 20px; }}
    .steps      {{ list-style: none; margin: 0; padding: 0; }}
    .steps li   {{ display: flex; gap: 14px; align-items: flex-start; margin-bottom: 16px; }}
    .step-num   {{ flex-shrink: 0; width: 28px; height: 28px; background: #3b82f6;
                   border-radius: 50%; display: flex; align-items: center; justify-content: center;
                   color: #fff; font-size: 13px; font-weight: 700; }}
    .step-text  {{ color: #94a3b8; font-size: 14px; line-height: 1.5; }}
    .step-text strong {{ color: #e2e8f0; }}
    .footer     {{ text-align: center; color: #475569; font-size: 13px; margin-top: 32px; }}
    .footer a   {{ color: #3b82f6; text-decoration: none; }}
  </style>
</head>
<body>
  <div class="wrapper">

    <!-- Logo -->
    <div class="logo">⚡ SprintAI</div>

    <!-- Welcome card -->
    <div class="card">
      <h1>Welcome to SprintAI, {first_name}!</h1>
      <p>
        You're officially part of SprintAI. We're going to handle your social media
        from here on out — <span class="highlight">Facebook, Instagram, and Google Business</span>
        — so you can stay focused on running your HVAC business.
      </p>
      <p>
        Before your first posts go out, there's
        <span class="highlight"><strong>one quick step</strong></span>:
      </p>

      <!-- CTA -->
      <div style="text-align: center; padding: 8px 0 4px;">
        <a href="{connect_url}" class="cta-btn">
          Connect My Accounts →
        </a>
        <p style="font-size: 13px; color: #64748b; margin: 0;">
          Takes about 2 minutes. You only need to do this once.
        </p>
      </div>
    </div>

    <!-- What happens next -->
    <div class="card">
      <p style="color: #64748b; font-size: 12px; font-weight: 600;
                 text-transform: uppercase; letter-spacing: 1px; margin-bottom: 20px;">
        What happens next
      </p>
      <ul class="steps">
        <li>
          <div class="step-num">1</div>
          <div class="step-text">
            <strong>Connect your accounts</strong> — click the button above to authorize
            Facebook, Instagram, and Google Business Profile.
          </div>
        </li>
        <li>
          <div class="step-num">2</div>
          <div class="step-text">
            <strong>We generate your content</strong> — our AI writes a full month of
            HVAC-specific posts tailored to your business.
            Done within <strong>24 hours</strong>.
          </div>
        </li>
        <li>
          <div class="step-num">3</div>
          <div class="step-text">
            <strong>Posts go live automatically</strong> — every
            <strong>Monday, Wednesday, and Friday</strong> at 10 AM.
            No work required on your end.
          </div>
        </li>
      </ul>
    </div>

    <!-- Footer -->
    <div class="footer">
      <p>
        Questions? Just reply to this email — we read everything and typically respond
        within a few hours.
      </p>
      <p style="margin-top: 16px;">
        SprintAI &nbsp;·&nbsp;
        <a href="https://getsprintai.com">getsprintai.com</a> &nbsp;·&nbsp;
        <a href="mailto:jason@getsprintai.com">jason@getsprintai.com</a>
      </p>
    </div>

  </div>
</body>
</html>"""


def _build_text(client_name: str, client_id: str) -> str:
    connect_url = f"{CONNECT_BASE_URL}?client_id={client_id}"
    first_name  = client_name.split()[0] if client_name else "there"

    return f"""Hi {first_name},

Welcome to SprintAI! Your subscription is confirmed and we're ready to handle
your social media — Facebook, Instagram, and Google Business — automatically.

NEXT STEP: Connect your accounts
─────────────────────────────────
Before your first posts go out, we need access to your social platforms.
It takes about 2 minutes and you only do it once:

  {connect_url}

We never see your password — we use the same secure OAuth standard as
Hootsuite and Buffer.

WHAT HAPPENS NEXT
─────────────────
1. Connect your accounts (right now, via link above)
2. We generate your content — a full month of HVAC posts, within 24 hours.
3. Posts go live every Monday, Wednesday, and Friday at 10 AM. Automatic.

Questions? Just reply to this email — we read everything.

— Jason
SprintAI
https://getsprintai.com
"""


# ─── Core function ──────────────────────────────────────────────────────────

def send_onboarding_email(
    client_email: str,
    client_name: str,
    client_id: str,
) -> None:
    """
    Send the SprintAI welcome + connect email.

    Raises
    ------
    ValueError   If SMTP_PASS is not set.
    smtplib.SMTPException  On delivery failure.
    """
    if not SMTP_PASS:
        raise ValueError(
            "SMTP_PASS environment variable is not set. "
            "Set it to a Gmail App Password for the sending account."
        )

    subject  = "Welcome to SprintAI — one step to get started"
    html_body = _build_html(client_name, client_id)
    text_body = _build_text(client_name, client_id)

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = f"{FROM_NAME} <{FROM_ADDR}>"
    msg["To"]      = client_email
    msg["Reply-To"] = FROM_ADDR

    # Plain text first, then HTML (email clients prefer the last alternative)
    msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html",  "utf-8"))

    logger.info(
        "Sending onboarding email to %s (client_id=%s)", client_email, client_id
    )

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.ehlo()
        server.starttls()
        server.ehlo()
        server.login(SMTP_USER, SMTP_PASS)
        server.sendmail(FROM_ADDR, [client_email], msg.as_string())

    logger.info("Onboarding email delivered to %s", client_email)


# ─── CLI ────────────────────────────────────────────────────────────────────

def _parse_args():
    parser = argparse.ArgumentParser(
        description="Send SprintAI onboarding email to a new client."
    )
    parser.add_argument(
        "--client_email", required=True,
        help="Recipient email address"
    )
    parser.add_argument(
        "--client_name", required=True,
        help="Client's full name (or first name)"
    )
    parser.add_argument(
        "--client_id", required=True,
        help="Client UUID from sprintai_clients"
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    try:
        send_onboarding_email(
            client_email=args.client_email,
            client_name=args.client_name,
            client_id=args.client_id,
        )
        print(f"✅  Onboarding email sent to {args.client_email}")
    except Exception as exc:
        logger.exception("Failed to send onboarding email: %s", exc)
        raise SystemExit(1) from exc
