/**
 * create-checkout-session.js
 * POST /.netlify/functions/create-checkout-session
 *
 * Creates a Stripe Checkout session for the selected plan and returns the
 * hosted checkout URL. Called by checkout/index.html.
 *
 * Body: { plan: "founder" | "growth", price_id: "price_..." }
 * Response: { url: "https://checkout.stripe.com/..." }
 */

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let plan, price_id;
  try {
    ({ plan, price_id } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!price_id) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "price_id is required" }) };
  }

  const SUCCESS_URL =
    process.env.CHECKOUT_SUCCESS_URL ||
    "https://getsprintai.com/projects/sprintai/welcome/?session_id={CHECKOUT_SESSION_ID}";
  const CANCEL_URL =
    process.env.CHECKOUT_CANCEL_URL ||
    "https://getsprintai.com/projects/sprintai/checkout/";

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: price_id, quantity: 1 }],
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      metadata: { plan: plan || "unknown" },
      billing_address_collection: "auto",
      customer_creation: "always",
    });

    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error("Stripe error:", err.message);
    return {
      statusCode: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
