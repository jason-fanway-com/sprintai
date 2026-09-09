#!/usr/bin/env python3
"""
build-demo-kit-email.py — build (and optionally send) a shop's demo-kit email.

WHY THIS EXISTS
---------------
The demo kit is what a salesperson holds in front of a restaurant owner. Every
number and every QR code in it must match the shop's live record, or a code
fails silently in the worst possible moment.

An earlier kit shipped hand-made SVG QR codes that outlived the shop record and
encoded a number the shop no longer had. The reaction was to remove the codes
and link to a login-gated page instead — which fixed staleness by making the kit
useless without a Sprint login.

This script is the actual fix: the codes ARE in the email, and they are drawn at
build time from the database, alongside the text that describes them. One build,
one source, one rendering. Every code also prints its decoded target underneath,
so a wrong code is visible to a human instead of failing silently.

Nothing here is shop-specific. Point it at a slug.

USAGE
-----
  python3 scripts/build-demo-kit-email.py --shop vitos-pizza
  python3 scripts/build-demo-kit-email.py --shop vitos-pizza --send jason@fanway.com

Requires SPRINTAI_CHAT_SUPABASE_URL and SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY
in the environment (never in this file).
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from email.message import EmailMessage
from email.utils import make_msgid

import qrcode

REPO = pathlib.Path(__file__).resolve().parent.parent
PUBLIC_SITE_URL = os.environ.get("PUBLIC_SITE_URL", "https://getsprintai.com")

# Payload builders below mirror admin-dashboard/src/lib/demoKit.ts. If you change
# one, change the other -- they must encode byte-identical payloads.


def fetch_shop(slug: str) -> dict:
    url = os.environ.get("SPRINTAI_CHAT_SUPABASE_URL")
    key = os.environ.get("SPRINTAI_CHAT_SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("missing SPRINTAI_CHAT_SUPABASE_URL / _SERVICE_ROLE_KEY in env")
    q = f"{url}/rest/v1/shops?slug=eq.{urllib.parse.quote(slug)}&select=id,name,slug,phone_number_e164"
    req = urllib.request.Request(q, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    rows = json.loads(urllib.request.urlopen(req, timeout=20).read())
    if not rows:
        sys.exit(f"no shop with slug {slug!r}")
    shop = rows[0]
    if not shop.get("phone_number_e164"):
        sys.exit(f"shop {slug!r} has no phone_number_e164 -- refusing to build a kit with no line")
    return shop


def derive_order_message(name: str) -> str:
    low = name.lower()
    for key, msg in (
        ("bagel", "some bagels"), ("pizza", "some pizza"), ("burger", "a burger"),
        ("sushi", "some sushi"), ("taco", "some tacos"), ("chicken", "some chicken"),
    ):
        if key in low:
            return f"I'd like to order {msg} from {name}!"
    return f"I'd like to place an order from {name}!"


def phone_spoken(e164: str) -> str:
    m = re.match(r"^\+1(\d{3})(\d{3})(\d{4})$", e164)
    return f"({m[1]}) {m[2]}-{m[3]}" if m else e164


def phone_display(e164: str) -> str:
    m = re.match(r"^\+1(\d{3})(\d{3})(\d{4})$", e164)
    return f"+1 ({m[1]}) {m[2]}-{m[3]}" if m else e164


def build_sms_uri(phone: str, body: str) -> str:
    return f"sms:{phone}?&body={urllib.parse.quote(body, safe='')}"


def build_vcard(shop: dict) -> str:
    phone = shop["phone_number_e164"]
    return "\n".join([
        "BEGIN:VCARD", "VERSION:3.0", f"FN:{shop['name']}",
        f"TEL;TYPE=WORK,MSG:{phone_display(phone)}",
        f"TEL;TYPE=WORK,MSG:{phone}",
        f"ORG:{shop['name']}", "END:VCARD",
    ])


def build_dashboard_url(shop: dict) -> str:
    return f"{PUBLIC_SITE_URL}/admin/shop-owner?shop={urllib.parse.quote(shop['slug'])}"


def qr_png(payload: str) -> bytes:
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=2)
    qr.add_data(payload)
    qr.make(fit=True)
    buf = io.BytesIO()
    qr.make_image(fill_color="#17212E", back_color="white").save(buf, format="PNG")
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shop", required=True, help="shop slug, e.g. vitos-pizza")
    ap.add_argument("--send", help="email address to send to (omit to only write files)")
    ap.add_argument("--account", default="fanway", help="msmtp account")
    ap.add_argument("--outdir", default="/tmp", help="where to write the preview html + pngs")
    args = ap.parse_args()

    shop = fetch_shop(args.shop)
    tpl_path = REPO / "docs" / "demo" / f"{args.shop.split('-')[0]}-demo-kit.template.html"
    if not tpl_path.exists():
        tpl_path = REPO / "docs" / "demo" / f"{args.shop}-demo-kit.template.html"
    if not tpl_path.exists():
        sys.exit(f"no template for {args.shop} (looked for {tpl_path})")

    phone = shop["phone_number_e164"]
    payloads = {
        "QR1": build_sms_uri(phone, derive_order_message(shop["name"])),
        "QR2": build_vcard(shop),
        "QR3": build_dashboard_url(shop),
    }
    pngs = {k: qr_png(v) for k, v in payloads.items()}

    build_date = dt.date.today().isoformat()
    subs = {
        "SHOP_NAME": shop["name"],
        "SHOP_SLUG": shop["slug"],
        "PHONE_SPOKEN": phone_spoken(phone),
        "SMS_URI": payloads["QR1"].replace("&", "&amp;"),
        "DASHBOARD_URL": payloads["QR3"],
        "BUILD_DATE": build_date,
    }
    tpl = tpl_path.read_text()

    outdir = pathlib.Path(args.outdir)
    stem = f"{shop['slug']}-demo-kit-{build_date.replace('-', '')}"
    for k, png in pngs.items():
        (outdir / f"{stem}-{k.lower()}.png").write_bytes(png)

    def render(src_map: dict[str, str]) -> str:
        out = tpl
        for k, v in {**subs, **src_map}.items():
            out = out.replace("{{" + k + "}}", v)
        leftover = re.findall(r"\{\{[A-Z0-9_]+\}\}", out)
        if leftover:
            sys.exit(f"unresolved template tokens: {sorted(set(leftover))}")
        return out

    # Standalone preview: data: URIs so the file works on its own on disk.
    preview = render({f"{k}_SRC": "data:image/png;base64," + base64.b64encode(v).decode() for k, v in pngs.items()})
    preview_path = outdir / f"{stem}.html"
    preview_path.write_text(preview)

    print(f"shop:      {shop['name']} ({shop['slug']})")
    print(f"line:      {phone_display(phone)}")
    for k, v in payloads.items():
        print(f"{k} encodes: {v[:78].replace(chr(10), ' | ')}")
    print(f"preview:   {preview_path}")

    if not args.send:
        return

    # Email: cid: images in multipart/related so they render in Gmail (which
    # strips data: URIs) and travel with the message when Erin forwards it.
    cids = {k: make_msgid(domain="getsprintai.com") for k in pngs}
    html = render({f"{k}_SRC": f"cid:{cids[k][1:-1]}" for k in pngs})

    msg = EmailMessage()
    msg["Subject"] = f"Sprint demo kit — {shop['name']} ({phone_spoken(phone)})"
    msg["To"] = args.send
    msg.set_content(
        f"{shop['name']} demo kit. Ordering line: {phone_display(phone)}. "
        "Open in an HTML mail client to see the QR codes."
    )
    msg.add_alternative(html, subtype="html")
    html_part = msg.get_payload()[-1]
    html_part.make_related()
    for k, png in pngs.items():
        html_part.add_related(png, maintype="image", subtype="png", cid=cids[k],
                              filename=f"{stem}-{k.lower()}.png")

    subprocess.run(["msmtp", "-a", args.account, args.send], input=msg.as_bytes(), check=True)
    print(f"sent:      {args.send} (account {args.account})")


if __name__ == "__main__":
    main()
