/**
 * stripe-webhook.js
 * POST /.netlify/functions/stripe-webhook
 *
 * Receives and verifies Stripe webhook events.
 *
 * Events handled:
 *   checkout.session.completed     → create client in Supabase + trigger onboarding
 *   customer.subscription.deleted  → mark client cancelled in Supabase
 *
 * Register this endpoint in Stripe Dashboard → Developers → Webhooks:
 *   https://getsprintai.com/.netlify/functions/stripe-webhook
 */

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PLAN_NAMES = {
  [process.env.STRIPE_PRICE_FOUNDER]: "founder",
  [process.env.STRIPE_PRICE_GROWTH]: "growth",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsertClient({ email, name, plan, stripeCustomerId }) {
  const { data: existing } = await supabase
    .from("sprintai_clients")
    .select("id")
    .eq("email", email)
    .single();

  if (existing) {
    await supabase
      .from("sprintai_clients")
      .update({ name, plan, stripe_customer_id: stripeCustomerId, status: "active" })
      .eq("id", existing.id);
    console.log(`Updated client: ${email} (${existing.id})`);
    return existing.id;
  }

  const { data } = await supabase
    .from("sprintai_clients")
    .insert({ email, name, plan, stripe_customer_id: stripeCustomerId, status: "active" })
    .select("id")
    .single();
  console.log(`Created client: ${email} (${data.id})`);
  return data.id;
}

async function getPlanFromSession(session) {
  const meta = session.metadata || {};
  if (meta.plan) return meta.plan;

  const subId = session.subscription;
  if (subId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subId, {
        expand: ["items.data.price"],
      });
      const priceId = sub.items.data[0].price.id;
      return PLAN_NAMES[priceId] || priceId;
    } catch (e) {
      console.warn("Could not retrieve subscription plan:", e.message);
    }
  }
  return "unknown";
}

// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // Stripe needs the raw body for signature verification
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, "base64")
    : event.body;

  const sig = event.headers["stripe-signature"];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log(`Stripe event: ${stripeEvent.type} (${stripeEvent.id})`);

  try {
    // ── checkout.session.completed ────────────────────────────────────────────
    if (stripeEvent.type === "checkout.session.completed") {
      const session = stripeEvent.data.object;
      const details = session.customer_details || {};
      const email = session.customer_email || details.email || "";
      const name = details.name || "";
      const stripeCustomerId = session.customer || "";
      const plan = await getPlanFromSession(session);

      if (!email) {
        console.error("No email in checkout.session.completed — session:", session.id);
        return { statusCode: 200, body: "ok (no email)" };
      }

      const clientId = await upsertClient({ email, name, plan, stripeCustomerId });
      console.log(`Client ready: ${email} | plan: ${plan} | id: ${clientId}`);

      // TODO: trigger onboarding email once SMTP is configured
      // For now: client is in Supabase + redirected to /welcome by Stripe
    }

    // ── customer.subscription.deleted ─────────────────────────────────────────
    else if (stripeEvent.type === "customer.subscription.deleted") {
      const subscription = stripeEvent.data.object;
      const customerId = subscription.customer;

      const { data } = await supabase
        .from("sprintai_clients")
        .update({ status: "cancelled" })
        .eq("stripe_customer_id", customerId)
        .select("email");

      if (data && data.length > 0) {
        console.log(`Cancelled subscription for: ${data[0].email}`);
      } else {
        console.warn(`No client found for Stripe customer: ${customerId}`);
      }
    }
  } catch (err) {
    console.error("Error processing webhook:", err);
    // Return 200 anyway — Stripe will retry if we return non-2xx
  }

  return { statusCode: 200, body: "ok" };
};
