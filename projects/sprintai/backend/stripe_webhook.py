"""
stripe_webhook.py — SprintAI Stripe webhook handler + checkout session creator.

Routes
------
POST /create-checkout-session  →  Creates a Stripe Checkout session and returns the URL.
POST /webhook                  →  Receives Stripe webhook events.

Events handled
--------------
  checkout.session.completed      → create client record in Supabase + send onboarding email
  customer.subscription.deleted  → mark client status = 'cancelled' in Supabase

Run locally
-----------
  pip install flask stripe supabase python-dotenv
  export FLASK_APP=stripe_webhook.py
  flask run --port 4242

  # In another terminal, forward Stripe events:
  stripe listen --forward-to localhost:4242/webhook
"""

import os
import sys
import subprocess
import logging
from flask import Flask, request, jsonify
import stripe
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

# ─── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# ─── Config ─────────────────────────────────────────────────────────────────
STRIPE_SECRET_KEY      = os.environ["STRIPE_SECRET_KEY"]
STRIPE_WEBHOOK_SECRET  = os.environ["STRIPE_WEBHOOK_SECRET"]
STRIPE_PRICE_FOUNDER   = os.environ.get("STRIPE_PRICE_FOUNDER", "PRICE_FOUNDER")
STRIPE_PRICE_GROWTH    = os.environ.get("STRIPE_PRICE_GROWTH",  "PRICE_GROWTH")

SUPABASE_URL           = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY   = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

SUCCESS_URL            = os.environ.get(
    "CHECKOUT_SUCCESS_URL",
    "https://getsprintai.com/welcome?session_id={CHECKOUT_SESSION_ID}"
)
CANCEL_URL             = os.environ.get(
    "CHECKOUT_CANCEL_URL",
    "https://getsprintai.com/checkout"
)

stripe.api_key = STRIPE_SECRET_KEY

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

app = Flask(__name__)


# ─── Helpers ────────────────────────────────────────────────────────────────

PLAN_NAMES = {
    STRIPE_PRICE_FOUNDER: "founder",
    STRIPE_PRICE_GROWTH:  "growth",
}


def _plan_from_session(session: dict) -> str:
    """Derive plan name from session metadata or line-item price ID."""
    # Prefer explicit metadata set at session creation time
    meta = session.get("metadata") or {}
    if meta.get("plan"):
        return meta["plan"]

    # Fall back to the first subscription item's price
    subscription_id = session.get("subscription")
    if subscription_id:
        try:
            sub = stripe.Subscription.retrieve(
                subscription_id,
                expand=["items.data.price"],
            )
            price_id = sub["items"]["data"][0]["price"]["id"]
            return PLAN_NAMES.get(price_id, price_id)
        except stripe.error.StripeError as exc:
            logger.warning("Could not retrieve subscription plan: %s", exc)

    return meta.get("plan", "unknown")


def _upsert_client(
    email: str,
    name: str,
    plan: str,
    stripe_customer_id: str,
    status: str = "active",
) -> str:
    """Insert or update a client in sprintai_clients. Returns the client UUID."""
    existing = (
        supabase.table("sprintai_clients")
        .select("id")
        .eq("email", email)
        .execute()
    )
    if existing.data:
        client_id = existing.data[0]["id"]
        supabase.table("sprintai_clients").update(
            {
                "name": name,
                "plan": plan,
                "stripe_customer_id": stripe_customer_id,
                "status": status,
            }
        ).eq("id", client_id).execute()
        logger.info("Updated existing client %s (%s)", email, client_id)
    else:
        result = (
            supabase.table("sprintai_clients")
            .insert(
                {
                    "email": email,
                    "name": name,
                    "plan": plan,
                    "stripe_customer_id": stripe_customer_id,
                    "status": status,
                }
            )
            .execute()
        )
        client_id = result.data[0]["id"]
        logger.info("Created new client %s (%s)", email, client_id)

    return client_id


def _send_onboarding_email(email: str, name: str, client_id: str) -> None:
    """Fire the onboarding email script as a subprocess."""
    script = os.path.join(os.path.dirname(__file__), "send_onboarding_email.py")
    cmd = [
        sys.executable, script,
        "--client_email", email,
        "--client_name",  name,
        "--client_id",    client_id,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error("Onboarding email failed: %s", result.stderr)
    else:
        logger.info("Onboarding email sent to %s", email)


# ─── Routes ─────────────────────────────────────────────────────────────────

@app.route("/create-checkout-session", methods=["POST"])
def create_checkout_session():
    """
    Create a Stripe Checkout session for the requested plan.

    Request JSON:
        { "plan": "founder" | "growth", "price_id": "<stripe_price_id>" }

    Response JSON:
        { "url": "<stripe_checkout_url>" }
    """
    data = request.get_json(silent=True) or {}
    plan     = data.get("plan", "unknown")
    price_id = data.get("price_id")

    if not price_id:
        return jsonify({"error": "price_id is required"}), 400

    try:
        session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            mode="subscription",
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=SUCCESS_URL,
            cancel_url=CANCEL_URL,
            metadata={"plan": plan},
            # Collect billing name + email so they appear in the webhook event
            billing_address_collection="auto",
            customer_creation="always",
        )
        return jsonify({"url": session.url})

    except stripe.error.StripeError as exc:
        logger.error("Stripe error creating session: %s", exc)
        return jsonify({"error": str(exc)}), 500


@app.route("/webhook", methods=["POST"])
def stripe_webhook():
    """
    Receive and verify Stripe webhook events.

    Verifies the Stripe-Signature header against STRIPE_WEBHOOK_SECRET,
    then dispatches to the appropriate handler.
    """
    payload   = request.get_data()
    sig_header = request.headers.get("Stripe-Signature", "")

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, STRIPE_WEBHOOK_SECRET
        )
    except ValueError:
        logger.warning("Invalid payload from Stripe")
        return jsonify({"error": "Invalid payload"}), 400
    except stripe.error.SignatureVerificationError:
        logger.warning("Invalid Stripe signature")
        return jsonify({"error": "Invalid signature"}), 400

    event_type = event["type"]
    logger.info("Received Stripe event: %s  id=%s", event_type, event["id"])

    # ── checkout.session.completed ─────────────────────────────────────────
    if event_type == "checkout.session.completed":
        session = event["data"]["object"]

        email    = session.get("customer_email") or session.get("customer_details", {}).get("email", "")
        name     = (session.get("customer_details") or {}).get("name", "")
        customer = session.get("customer", "")
        plan     = _plan_from_session(session)

        if not email:
            logger.error("No email in checkout.session.completed — session id=%s", session["id"])
            return jsonify({"error": "Missing customer email"}), 200  # return 200 to ack Stripe

        try:
            client_id = _upsert_client(email, name, plan, customer)
            _send_onboarding_email(email, name or "there", client_id)
        except Exception as exc:
            logger.exception("Error handling checkout.session.completed: %s", exc)
            # Still return 200 so Stripe doesn't retry indefinitely.
            # Alert should be raised via logging/monitoring.

    # ── customer.subscription.deleted ─────────────────────────────────────
    elif event_type == "customer.subscription.deleted":
        subscription = event["data"]["object"]
        customer_id  = subscription.get("customer", "")

        try:
            result = (
                supabase.table("sprintai_clients")
                .update({"status": "cancelled"})
                .eq("stripe_customer_id", customer_id)
                .execute()
            )
            if result.data:
                logger.info("Cancelled subscription for customer %s", customer_id)
            else:
                logger.warning("No client found for customer %s (subscription deleted)", customer_id)
        except Exception as exc:
            logger.exception("Error handling customer.subscription.deleted: %s", exc)

    else:
        logger.debug("Unhandled event type: %s", event_type)

    return jsonify({"status": "ok"}), 200


# ─── Entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 4242))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    logger.info("Starting SprintAI webhook server on port %d", port)
    app.run(host="0.0.0.0", port=port, debug=debug)
