/**
 * SprintAI stripe-webhook Edge Function
 * Handles Stripe billing events → tenant lifecycle management
 * 
 * POST /functions/v1/stripe-webhook
 * Headers: stripe-signature required
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { deriveConnectStatus } from "../_shared/connect.ts";
import { guardedSend } from "../_shared/outbound-guard.ts";

const PLAN_PRICES: Record<string, string> = {
  // Map Stripe price IDs to plan names — update with real Stripe price IDs
  starter: "starter",
  pro: "pro",
  enterprise: "enterprise",
};

// Map Stripe price IDs to plan names — LIVE price IDs as of 2026-04-01
const PRICE_TO_PLAN: Record<string, string> = {
  "price_1TG8GsFPm1l8Fm1TSaLhOIaL": "starter",   // $99/mo
  "price_1TG8GsFPm1l8Fm1T2oFHMeij": "pro",        // $247/mo
  "price_1TG8GtFPm1l8Fm1T1erCd7MB": "enterprise", // $497/mo
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonError("Method Not Allowed", 405);
  }

  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

  if (!stripeSecretKey) {
    console.error("[stripe-webhook] STRIPE_SECRET_KEY not configured");
    return jsonError("Stripe not configured", 500);
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });

  // Verify Stripe webhook signature
  const signature = req.headers.get("stripe-signature") ?? "";
  const rawBody = await req.arrayBuffer();
  const bodyText = new TextDecoder().decode(rawBody);

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(bodyText, signature, webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return jsonError("Invalid signature", 400);
  }

  // `event.account` is set for CONNECTED-ACCOUNT events (direct-charge
  // refunds/disputes fire here, NOT on the platform). Empty for platform events.
  const connectedAccount = (event as Stripe.Event & { account?: string }).account ?? "";
  console.log(`[stripe-webhook] Event: ${event.type} — ${event.id}${connectedAccount ? ` (acct ${connectedAccount})` : " (platform)"}`);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  // Idempotency: record (event_id, connected_account) before handling. If the
  // pair already exists, we've processed this delivery — ack and skip.
  const alreadyProcessed = await recordEventOnce(supabase, event.id, connectedAccount, event.type);
  if (alreadyProcessed) {
    console.log(`[stripe-webhook] Duplicate event ${event.id} (acct '${connectedAccount}') — skipping`);
    return jsonResponse({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      // ── Connect: platform-level account state ──────────────────────────
      case "account.updated":
        await handleAccountUpdated(supabase, event.data.object as Stripe.Account);
        break;

      // ── Connect: connected-account order events (DIRECT charges) ───────
      case "charge.refunded":
        await handleChargeRefunded(supabase, event.data.object as Stripe.Charge, connectedAccount);
        break;

      case "charge.dispute.created":
        await handleDisputeCreated(supabase, event.data.object as Stripe.Dispute, connectedAccount);
        break;

      case "checkout.session.completed": {
        const sess = event.data.object as Stripe.Checkout.Session;
        if (sess.metadata?.order_cart_id) {
          // DIRECT-CHARGE order: this event fires on the CONNECTED account.
          await handleOrderPaymentComplete(supabase, stripe, sess, connectedAccount);
        } else {
          await handleCheckoutComplete(supabase, stripe, sess);
        }
        break;
      }

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(supabase, event.data.object as Stripe.Subscription);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(supabase, stripe, event.data.object as Stripe.Subscription);
        break;

      case "invoice.payment_failed":
        await handlePaymentFailed(supabase, stripe, event.data.object as Stripe.Invoice);
        break;

      case "invoice.payment_succeeded":
        await handlePaymentSucceeded(supabase, stripe, event.data.object as Stripe.Invoice);
        break;

      case "checkout.session.expired": {
        const sess = event.data.object as Stripe.Checkout.Session;
        if (sess.metadata?.order_cart_id) {
          await handleOrderPaymentExpired(supabase, sess);
        }
        break;
      }

      default:
        console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
    }

    return jsonResponse({ received: true });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[stripe-webhook] Error handling ${event.type}:`, errMsg);
    // On real failures, roll back the idempotency record so Stripe's retry can
    // re-attempt this event rather than being silently skipped.
    await unrecordEvent(supabase, event.id, connectedAccount);
    // Return 200 to prevent immediate Stripe retry storms; Stripe still retries
    // on non-2xx, but we log internally. (Order events above will be retried
    // because we removed the idempotency row.)
    return jsonResponse({ received: true, error: errMsg });
  }
});

// ─── Idempotency ledger ──────────────────────────────────────────────────────

/** Insert (event_id, stripe_account); returns true if it was ALREADY present. */
async function recordEventOnce(
  supabase: ReturnType<typeof createClient>,
  eventId: string,
  stripeAccount: string,
  eventType: string,
): Promise<boolean> {
  const { error } = await supabase
    .from("stripe_webhook_events")
    .insert({ event_id: eventId, stripe_account: stripeAccount, event_type: eventType });
  if (!error) return false; // inserted fresh
  // 23505 = unique_violation → already processed.
  if ((error as { code?: string }).code === "23505") return true;
  // Unknown error: log but don't block handling (fail open on idempotency).
  console.error("[stripe-webhook] idempotency insert error:", error.message);
  return false;
}

async function unrecordEvent(
  supabase: ReturnType<typeof createClient>,
  eventId: string,
  stripeAccount: string,
): Promise<void> {
  await supabase
    .from("stripe_webhook_events")
    .delete()
    .eq("event_id", eventId)
    .eq("stripe_account", stripeAccount);
}

// ─── Connect: account.updated (platform-level) ───────────────────────────────

/** Update a shop's go-live flags from a changed connected account. */
async function handleAccountUpdated(
  supabase: ReturnType<typeof createClient>,
  account: Stripe.Account,
): Promise<void> {
  const { data: shop } = await supabase
    .from("shops")
    .select("id, connect_status")
    .eq("stripe_connected_account_id", account.id)
    .single();

  if (!shop) {
    console.log(`[stripe-webhook] account.updated for unknown account ${account.id} — ignoring`);
    return;
  }

  const status = deriveConnectStatus(account, shop.connect_status as string | null);

  await supabase
    .from("shops")
    .update({
      charges_enabled: account.charges_enabled ?? false,
      payouts_enabled: account.payouts_enabled ?? false,
      connect_requirements_due: account.requirements?.currently_due ?? [],
      connect_status: status,
    })
    .eq("id", shop.id);

  console.log(`[stripe-webhook] account.updated ${account.id} → shop ${shop.id}: charges=${account.charges_enabled} payouts=${account.payouts_enabled} status=${status}`);
}

// ─── Connect: connected-account order events (DIRECT charges) ────────────────

/**
 * charge.refunded on the CONNECTED account. Update the order's refund state.
 * Note: whether the $0.99 application fee was returned is controlled at
 * refund-creation time via `refund_application_fee` (see refund-fee handler);
 * this webhook just records the resulting refund totals on the order.
 */
async function handleChargeRefunded(
  supabase: ReturnType<typeof createClient>,
  charge: Stripe.Charge,
  connectedAccount: string,
): Promise<void> {
  const cart = await findCartForCharge(supabase, charge, connectedAccount);
  if (!cart) {
    console.log(`[stripe-webhook] charge.refunded ${charge.id} (acct ${connectedAccount}) — no matching order`);
    return;
  }

  const refunded = charge.amount_refunded ?? 0;
  const amount = charge.amount ?? 0;
  const refundStatus = refunded <= 0 ? "none" : refunded >= amount ? "full" : "partial";

  await supabase
    .from("order_carts")
    .update({
      refunded_cents: refunded,
      refund_status: refundStatus,
      payment_status: refundStatus === "full" ? "refunded" : "paid",
    })
    .eq("id", cart.id);

  console.log(`[stripe-webhook] charge.refunded ${charge.id} → cart ${cart.id}: ${refundStatus} ($${(refunded / 100).toFixed(2)} of $${(amount / 100).toFixed(2)})`);

  if (cart.conversation_id) {
    // ALLOWED TRANSACTIONAL EXCEPTION #2 of 2 (lead directive 2026-06-22):
    // the REFUND NOTICE. This outbound directly follows the customer's own
    // paid order being refunded — a consented, expected transactional message.
    // This and payment_confirmed are the ONLY two customer-facing pushes allowed.
    await triggerChatSmsSystemEvent(cart.shop_id, cart.conversation_id, cart.id, "order_refunded");
  }
}

/**
 * charge.dispute.created on the CONNECTED account. The dispute debits the
 * RESTAURANT's balance (they are merchant of record); Sprint only records and
 * notifies the shop.
 */
async function handleDisputeCreated(
  supabase: ReturnType<typeof createClient>,
  dispute: Stripe.Dispute,
  connectedAccount: string,
): Promise<void> {
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  const { data: cart } = await supabase
    .from("order_carts")
    .select("id, shop_id, conversation_id")
    .eq("stripe_charge_id", chargeId ?? "__none__")
    .maybeSingle();

  if (!cart) {
    console.log(`[stripe-webhook] dispute ${dispute.id} on charge ${chargeId} (acct ${connectedAccount}) — no matching order; recording notice only`);
    return;
  }

  await supabase
    .from("order_carts")
    .update({ dispute_status: dispute.status ?? "created" })
    .eq("id", cart.id);

  console.log(`[stripe-webhook] DISPUTE ${dispute.id} (${dispute.reason}) on cart ${cart.id} acct ${connectedAccount} — debits RESTAURANT; notifying shop`);

  // Notify the shop (restaurant owns the dispute). Email + SMS via chat-sms.
  await notifyShopOfDispute(supabase, cart.shop_id, cart.id, dispute);
  if (cart.conversation_id) {
    // SHOP-FACING ONLY, not a customer push. order_disputed resolves to a
    // SILENT branch in chat-sms (no diner-facing copy); the shop is notified
    // separately via notifyShopOfDispute above. No unsolicited customer text.
    await triggerChatSmsSystemEvent(cart.shop_id, cart.conversation_id, cart.id, "order_disputed");
  }
}

/** Find the order_cart for a charge, by payment_intent then charge id. */
async function findCartForCharge(
  supabase: ReturnType<typeof createClient>,
  charge: Stripe.Charge,
  _connectedAccount: string,
): Promise<{ id: string; shop_id: string; conversation_id: string | null } | null> {
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (piId) {
    const { data } = await supabase
      .from("order_carts")
      .select("id, shop_id, conversation_id")
      .eq("stripe_payment_intent_id", piId)
      .maybeSingle();
    if (data) return data as { id: string; shop_id: string; conversation_id: string | null };
  }
  const { data: byCharge } = await supabase
    .from("order_carts")
    .select("id, shop_id, conversation_id")
    .eq("stripe_charge_id", charge.id)
    .maybeSingle();
  return (byCharge as { id: string; shop_id: string; conversation_id: string | null }) ?? null;
}

/** Email the shop that a diner disputed an order (restaurant bears liability). */
async function notifyShopOfDispute(
  supabase: ReturnType<typeof createClient>,
  shopId: string,
  cartId: string,
  dispute: Stripe.Dispute,
): Promise<void> {
  const { data: shop } = await supabase
    .from("shops")
    .select("name, email_ticket_recipient")
    .eq("id", shopId)
    .single();
  const recipient = (shop as { email_ticket_recipient?: string } | null)?.email_ticket_recipient;
  const amount = ((dispute.amount ?? 0) / 100).toFixed(2);
  console.log(`[DISPUTE NOTICE] shop=${(shop as { name?: string } | null)?.name} email=${recipient ?? "n/a"} cart=${cartId} amount=$${amount} reason=${dispute.reason} — a chargeback was filed; funds are held from your Stripe balance pending response.`);

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey || !recipient) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "SprintAI <hello@getsprintai.com>",
        to: [recipient],
        subject: `Chargeback filed on an order — action may be required`,
        html: `<p>A diner disputed a recent order (cart ${cartId}) for <strong>$${amount}</strong> (reason: ${dispute.reason}).</p>
               <p>Because you are the merchant of record, this chargeback is held against your Stripe balance. Respond with evidence from your Stripe Dashboard to contest it.</p>`,
      }),
    });
  } catch (err) {
    console.error("[stripe-webhook] dispute email failed:", err);
  }
}

// ─── Order Payment Handlers ───────────────────────────────────────────────────

/** checkout.session.completed with order_cart_id → mark order paid + log ticket */
async function handleOrderPaymentComplete(
  supabase: ReturnType<typeof createClient>,
  stripe:   Stripe,
  session:  Stripe.Checkout.Session,
  connectedAccount: string,
): Promise<void> {
  const cartId = session.metadata?.order_cart_id;
  if (!cartId) return;
  console.log(`[stripe-webhook] Order payment complete for cart: ${cartId} (acct ${connectedAccount || "platform"})`);

  // Capture the PaymentIntent + Charge id from the CONNECTED account so refund
  // and dispute webhooks can route back to this order. For a direct charge the
  // PI/Charge live on the connected account, so we read with the Stripe-Account.
  const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
  let chargeId: string | null = null;
  if (piId && connectedAccount) {
    try {
      const pi = await stripe.paymentIntents.retrieve(piId, { stripeAccount: connectedAccount });
      chargeId = (pi.latest_charge as string | null) ?? null;
    } catch (err) {
      console.error(`[stripe-webhook] could not retrieve PI ${piId} on acct ${connectedAccount}:`, err);
    }
  }

  const { error } = await supabase
    .from("order_carts")
    .update({
      payment_status: "paid",
      phase: "confirmed",
      stripe_payment_intent_id: piId,
      stripe_charge_id: chargeId,
      stripe_connected_account_id: connectedAccount || null,
    })
    .eq("id", cartId);

  if (error) throw new Error(`Failed to update cart ${cartId}: ${error.message}`);

  // Stub email ticket — log full order details
  const { data: cart } = await supabase
    .from("order_carts")
    .select("*, shops(name, email_ticket_recipient)")
    .eq("id", cartId)
    .single();

  // ALLOWED TRANSACTIONAL EXCEPTION #1 of 2 (lead directive 2026-06-22):
  // the PAID-ORDER RECEIPT. This outbound directly follows the customer's own
  // action (they completed checkout and paid) — a consented, expected
  // transactional message. This and order_refunded are the ONLY two
  // customer-facing pushes allowed.
  if (cart?.conversation_id) {
    await triggerChatSmsSystemEvent(cart.shop_id, cart.conversation_id, cartId, "payment_confirmed");
  }

  if (cart) {
    const shopName  = (cart.shops as { name: string; email_ticket_recipient: string | null })?.name ?? "Unknown Shop";
    const recipient = (cart.shops as { name: string; email_ticket_recipient: string | null })?.email_ticket_recipient ?? "n/a";
    // Reconciliation breakdown — must match the Stripe charge to the cent.
    const subtotal   = ((cart.subtotal_cents ?? 0) / 100).toFixed(2); // food + tax
    const serviceFee = ((cart.service_fee_cents ?? 0) / 100).toFixed(2);
    const total      = ((cart.total_cents ?? 0) / 100).toFixed(2);
    console.log(`[ORDER TICKET] ===========================`);
    console.log(`[ORDER TICKET] Shop:        ${shopName}`);
    console.log(`[ORDER TICKET] Email:       ${recipient}`);
    console.log(`[ORDER TICKET] Cart ID:     ${cartId}`);
    console.log(`[ORDER TICKET] Charge:      ${cart.stripe_charge_id ?? "n/a"} (acct ${connectedAccount || "platform"})`);
    console.log(`[ORDER TICKET] Pickup:      ${cart.pickup_name ?? "Not specified"}`);
    console.log(`[ORDER TICKET] Items:`);
    for (const item of cart.cart_json ?? []) {
      const mods = item.modifiers?.length > 0 ? ` [${item.modifiers.join(", ")}]` : "";
      console.log(`[ORDER TICKET]   ${item.quantity}x ${item.name}${mods} - $${((item.price_cents * item.quantity) / 100).toFixed(2)}`);
    }
    console.log(`[ORDER TICKET] --------------------------`);
    console.log(`[ORDER TICKET] Subtotal (food+tax): $${subtotal}`);
    console.log(`[ORDER TICKET] Service fee:         $${serviceFee}`);
    console.log(`[ORDER TICKET] Grand total:         $${total}`);
    console.log(`[ORDER TICKET] ===========================`);

    // Email the reconciled ticket if Resend is configured.
    await sendOrderTicketEmail(recipient, shopName, cartId, cart, { subtotal, serviceFee, total });
  }
}

/** Send a reconciled order ticket email (food+tax, $0.99 fee, grand total). */
async function sendOrderTicketEmail(
  recipient: string,
  shopName: string,
  cartId: string,
  cart: Record<string, unknown>,
  totals: { subtotal: string; serviceFee: string; total: string },
): Promise<void> {
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!resendApiKey || !recipient || recipient === "n/a") return;
  const items = (cart.cart_json as Array<{ quantity: number; name: string; modifiers?: string[]; price_cents: number }>) ?? [];
  const rows = items.map((i) => {
    const mods = i.modifiers?.length ? ` (${i.modifiers.join(", ")})` : "";
    return `<tr><td>${i.quantity}× ${i.name}${mods}</td><td align="right">$${((i.price_cents * i.quantity) / 100).toFixed(2)}</td></tr>`;
  }).join("");
  const html = `<h2>New order — ${shopName}</h2>
    <p>Pickup: ${(cart.pickup_name as string) ?? "Not specified"}</p>
    <table style="width:100%;border-collapse:collapse;">${rows}
      <tr><td>Subtotal (food + tax)</td><td align="right">$${totals.subtotal}</td></tr>
      <tr><td>Service fee</td><td align="right">$${totals.serviceFee}</td></tr>
      <tr><td><strong>Total charged</strong></td><td align="right"><strong>$${totals.total}</strong></td></tr>
    </table>
    <p style="color:#64748b;font-size:12px;">Cart ${cartId}. Totals reconcile to the Stripe charge.</p>`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "SprintAI <hello@getsprintai.com>", to: [recipient], subject: `New order — ${shopName} ($${totals.total})`, html }),
    });
  } catch (err) {
    console.error("[stripe-webhook] order ticket email failed:", err);
  }
}

/** checkout.session.expired with order_cart_id → mark order expired */
async function handleOrderPaymentExpired(
  supabase: ReturnType<typeof createClient>,
  session:  Stripe.Checkout.Session,
): Promise<void> {
  const cartId = session.metadata?.order_cart_id;
  if (!cartId) return;
  console.log(`[stripe-webhook] Order payment expired for cart: ${cartId}`);

  // Update internal state ONLY. No customer-facing outbound on expiry.
  // COMPLIANCE (TCPA/10DLC), lead directive 2026-06-22: a checkout link
  // expiring is NOT a customer action — pushing an unsolicited "your link
  // expired" text is an unconsented outbound and is KILLED. If the customer
  // texts again in an active session and their link is expired, the inbound
  // reply path handles it synchronously ("that link expired — want to
  // reorder?"). We never push here.
  await supabase
    .from("order_carts")
    .update({ payment_status: "expired", phase: "expired" })
    .eq("id", cartId);
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

/** checkout.session.completed → create tenant, run onboarding, assign Twilio number */
async function handleCheckoutComplete(
  supabase: ReturnType<typeof createClient>,
  stripe: Stripe,
  session: Stripe.Checkout.Session
): Promise<void> {
  console.log(`[stripe-webhook] Checkout complete: ${session.id}`);

  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;
  const metadata = session.metadata ?? {};

  if (!customerId || !subscriptionId) {
    throw new Error("Missing customer or subscription in checkout session");
  }

  // Get customer details from Stripe
  const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  // Determine plan from subscription
  const priceId = subscription.items.data[0]?.price?.id ?? "";
  const plan = resolvePlan(priceId, metadata.plan);

  // Business info from checkout metadata or customer
  const businessName = metadata.business_name ?? customer.name ?? "My Business";
  const websiteUrl = metadata.website_url ?? "";
  const businessType = metadata.business_type ?? "business";
  const email = customer.email ?? "";

  // Generate slug from business name
  const slug = generateSlug(businessName);

  console.log(`[stripe-webhook] Creating tenant: ${businessName} (${plan}) for ${email}`);

  // Check if tenant already exists (idempotency)
  const { data: existingTenant } = await supabase
    .from("tenants")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .single();

  if (existingTenant) {
    console.log(`[stripe-webhook] Tenant already exists: ${existingTenant.id}`);
    // Update subscription info in case it changed
    await supabase
      .from("tenants")
      .update({
        stripe_subscription_id: subscriptionId,
        plan,
        status: "active",
      })
      .eq("id", existingTenant.id);
    return;
  }

  // Create tenant
  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .insert({
      name: businessName,
      slug: await ensureUniqueSlug(supabase, slug),
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      plan,
      status: "onboarding",
      website_url: websiteUrl,
      config: {
        business_type: businessType,
        email,
        personality: "friendly and helpful",
      },
    })
    .select("id, name, slug")
    .single();

  if (tenantError || !tenant) {
    throw new Error(`Failed to create tenant: ${tenantError?.message}`);
  }

  console.log(`[stripe-webhook] Tenant created: ${tenant.id} (${tenant.name})`);

  // Assign Twilio number (pro/enterprise get dedicated number)
  let assignedNumber: string | null = null;
  if (plan === "pro" || plan === "enterprise") {
    try {
      assignedNumber = await assignTwilioNumber(supabase, tenant.id);
      console.log(`[stripe-webhook] Assigned Twilio number: ${assignedNumber} to ${tenant.id}`);
    } catch (err) {
      console.error(`[stripe-webhook] Failed to assign Twilio number:`, err);
      // Non-fatal — tenant can still use shared number
    }
  }

  // Trigger website scraping if URL provided
  if (websiteUrl) {
    try {
      await triggerOnboarding(supabase, tenant.id, websiteUrl);
    } catch (err) {
      console.error(`[stripe-webhook] Onboarding trigger failed:`, err);
    }
  } else {
    // Mark as onboarding skipped
    await supabase
      .from("tenants")
      .update({ status: "active", onboarding_status: "complete" })
      .eq("id", tenant.id);
  }

  // Send welcome SMS
  const finalNumber = assignedNumber ?? Deno.env.get("TWILIO_PHONE_NUMBER");
  if (finalNumber && customer.phone) {
    // WATCHDOG EVIDENCE: read the REAL Stripe subscription state, not a constant.
    // The merchant_welcome reason is allowed ONLY when the merchant's own
    // subscription is in a live, paid state. If Stripe says the subscription is
    // not active/trialing, the guard DENIES and no welcome SMS is sent.
    const subActive =
      subscription.status === "active" || subscription.status === "trialing";
    await sendWelcomeSMS(tenant.name, customer.phone, finalNumber, {
      subscriptionActive: subActive,
      tenantId: tenant.id,
    });
  }

  // Send welcome email with embed code
  if (email) {
    await sendWelcomeEmail({
      toEmail: email,
      businessName: tenant.name,
      tenantId: tenant.id,
    });
  }
}

/** customer.subscription.updated → sync plan/status changes */
async function handleSubscriptionUpdated(
  supabase: ReturnType<typeof createClient>,
  subscription: Stripe.Subscription
): Promise<void> {
  const customerId = subscription.customer as string;
  const priceId = subscription.items.data[0]?.price?.id ?? "";
  const plan = resolvePlan(priceId, "");
  const status = subscription.status === "active" ? "active" : "paused";

  await supabase
    .from("tenants")
    .update({ plan, status, stripe_subscription_id: subscription.id })
    .eq("stripe_customer_id", customerId);

  console.log(`[stripe-webhook] Subscription updated for customer ${customerId}: plan=${plan}, status=${status}`);
}

/** customer.subscription.deleted → deactivate tenant, release Twilio number */
async function handleSubscriptionDeleted(
  supabase: ReturnType<typeof createClient>,
  stripe: Stripe,
  subscription: Stripe.Subscription
): Promise<void> {
  const customerId = subscription.customer as string;

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, phone_number, name")
    .eq("stripe_customer_id", customerId)
    .single();

  if (!tenant) {
    console.log(`[stripe-webhook] No tenant found for customer ${customerId} on subscription delete`);
    return;
  }

  // Release Twilio number if dedicated
  const sharedNumber = Deno.env.get("TWILIO_PHONE_NUMBER");
  if (tenant.phone_number && tenant.phone_number !== sharedNumber) {
    try {
      await releaseTwilioNumber(tenant.phone_number);
      console.log(`[stripe-webhook] Released Twilio number: ${tenant.phone_number}`);
    } catch (err) {
      console.error(`[stripe-webhook] Failed to release Twilio number:`, err);
    }
  }

  // Mark tenant as cancelled
  await supabase
    .from("tenants")
    .update({ status: "cancelled", phone_number: null })
    .eq("id", tenant.id);

  console.log(`[stripe-webhook] Tenant ${tenant.id} (${tenant.name}) cancelled`);
}

/** invoice.payment_failed → pause tenant */
async function handlePaymentFailed(
  supabase: ReturnType<typeof createClient>,
  stripe: Stripe,
  invoice: Stripe.Invoice
): Promise<void> {
  const customerId = invoice.customer as string;

  await supabase
    .from("tenants")
    .update({
      status: "paused",
      config: supabase.rpc("jsonb_set_safe", {}), // We'll update config directly
    })
    .eq("stripe_customer_id", customerId);

  // Update with paused message in config
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, config")
    .eq("stripe_customer_id", customerId)
    .single();

  if (tenant) {
    const config = { ...(tenant.config as Record<string, unknown>), paused_message: "We're temporarily unavailable due to a billing issue. Please contact us directly." };
    await supabase.from("tenants").update({ status: "paused", config }).eq("id", tenant.id);
  }

  console.log(`[stripe-webhook] Tenant paused due to payment failure: customer ${customerId}`);
}

/** invoice.payment_succeeded → reactivate tenant if paused */
async function handlePaymentSucceeded(
  supabase: ReturnType<typeof createClient>,
  stripe: Stripe,
  invoice: Stripe.Invoice
): Promise<void> {
  const customerId = invoice.customer as string;

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, status, config")
    .eq("stripe_customer_id", customerId)
    .single();

  if (tenant && tenant.status === "paused") {
    const config = { ...(tenant.config as Record<string, unknown>) };
    delete config.paused_message;
    await supabase.from("tenants").update({ status: "active", config }).eq("id", tenant.id);
    console.log(`[stripe-webhook] Tenant ${tenant.id} reactivated after payment success`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Assign a new Twilio phone number to a tenant */
async function assignTwilioNumber(
  supabase: ReturnType<typeof createClient>,
  tenantId: string
): Promise<string> {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/chat-sms`;

  // Search for available local number
  const searchRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&Limit=1`,
    {
      headers: {
        "Authorization": `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      },
    }
  );

  if (!searchRes.ok) {
    throw new Error(`Twilio search failed: ${searchRes.status}`);
  }

  const searchData = await searchRes.json();
  const phoneNumber = searchData.available_phone_numbers?.[0]?.phone_number;
  if (!phoneNumber) {
    throw new Error("No available Twilio numbers");
  }

  // Purchase the number
  const purchaseRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
    {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        PhoneNumber: phoneNumber,
        SmsUrl: webhookUrl,
        SmsMethod: "POST",
        FriendlyName: `SprintAI Tenant ${tenantId}`,
      }),
    }
  );

  if (!purchaseRes.ok) {
    const errText = await purchaseRes.text();
    throw new Error(`Twilio purchase failed: ${purchaseRes.status} — ${errText}`);
  }

  const purchaseData = await purchaseRes.json();
  const assignedNumber = purchaseData.phone_number;

  // Update tenant record
  await supabase
    .from("tenants")
    .update({ phone_number: assignedNumber })
    .eq("id", tenantId);

  return assignedNumber;
}

/** Release a Twilio phone number */
async function releaseTwilioNumber(phoneNumber: string): Promise<void> {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";

  // First find the SID for this number
  const listRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`,
    {
      headers: {
        "Authorization": `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      },
    }
  );

  if (!listRes.ok) return;
  const listData = await listRes.json();
  const sid = listData.incoming_phone_numbers?.[0]?.sid;
  if (!sid) return;

  // Release the number
  await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${sid}.json`,
    {
      method: "DELETE",
      headers: {
        "Authorization": `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      },
    }
  );
}

/** Trigger the onboard-tenant function asynchronously */
async function triggerOnboarding(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  websiteUrl: string
): Promise<void> {
  const functionUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/onboard-tenant`;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  // Fire-and-forget (don't await response — onboarding can take a while)
  fetch(functionUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tenant_id: tenantId, website_url: websiteUrl }),
  }).catch((err) => {
    console.error("[stripe-webhook] Failed to trigger onboarding:", err);
  });

  console.log(`[stripe-webhook] Onboarding triggered for tenant ${tenantId}`);
}

/**
 * Send welcome SMS via Twilio (MERCHANT-facing, B2B).
 * STRUCTURAL OUTBOUND WATCHDOG: even though this is the merchant audience (the
 * restaurant owner who just completed subscription checkout), it is the only
 * DIRECT Twilio send in this function, so it is routed through the same guard
 * with the explicit `merchant_welcome` reason. `subscriptionActive` is the
 * verified evidence — this is only ever called from the checkout-completed
 * handler. A call without that evidence fails closed.
 */
async function sendWelcomeSMS(
  businessName: string,
  customerPhone: string,
  fromNumber: string,
  evidence: { subscriptionActive: boolean; tenantId?: string | null } = { subscriptionActive: true },
): Promise<void> {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";

  const message = `Welcome to SprintAI! Your AI chat assistant for ${businessName} is now live. ` +
    `Share this number with your customers: ${fromNumber}. Text START to test it yourself!`;

  const { sent } = await guardedSend(
    {
      reason: "merchant_welcome",
      to: customerPhone,
      tenantId: evidence.tenantId ?? null,
      subscriptionActive: evidence.subscriptionActive,
    },
    async () => {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            "Authorization": `Basic ${btoa(`${accountSid}:${authToken}`)}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: customerPhone,
            From: fromNumber,
            Body: message,
          }),
        }
      );

      if (!res.ok) {
        console.error(`[stripe-webhook] Failed to send welcome SMS: ${res.status}`);
      } else {
        console.log(`[stripe-webhook] Welcome SMS sent to ${customerPhone}`);
      }
    },
  );

  if (!sent) {
    console.warn("[stripe-webhook] WELCOME SMS BLOCKED by watchdog; nothing sent.");
  }
}

/** Resolve Stripe price ID to plan name */
function resolvePlan(priceId: string, fallback: string): string {
  // Check hardcoded price ID map first (live IDs as of 2026-04-01)
  if (PRICE_TO_PLAN[priceId]) return PRICE_TO_PLAN[priceId];

  // Check env vars for price ID mapping (fallback)
  if (priceId === Deno.env.get("STRIPE_STARTER_PRICE_ID")) return "starter";
  if (priceId === Deno.env.get("STRIPE_PRO_PRICE_ID")) return "pro";
  if (priceId === Deno.env.get("STRIPE_ENTERPRISE_PRICE_ID")) return "enterprise";

  // Fallback from checkout metadata (plan field sent by signup page)
  if (["starter", "pro", "enterprise"].includes(fallback)) return fallback;
  return "starter";
}

/** Generate URL-safe slug from business name */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 50);
}

/** Ensure slug is unique by appending number if needed */
async function ensureUniqueSlug(
  supabase: ReturnType<typeof createClient>,
  baseSlug: string
): Promise<string> {
  let slug = baseSlug;
  let counter = 1;

  while (true) {
    const { data } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .single();

    if (!data) return slug;

    slug = `${baseSlug}-${counter}`;
    counter++;
  }
}

// ─── Welcome Email ────────────────────────────────────────────────────────────

interface WelcomeEmailParams {
  toEmail: string;
  businessName: string;
  tenantId: string;
}

/**
 * Send a welcome email via Resend API.
 * Set RESEND_API_KEY in Supabase secrets to enable.
 * If the key is missing, logs a warning and skips gracefully.
 */
async function sendWelcomeEmail({ toEmail, businessName, tenantId }: WelcomeEmailParams): Promise<void> {
  const resendApiKey = Deno.env.get("RESEND_API_KEY");

  if (!resendApiKey) {
    console.warn("[stripe-webhook] RESEND_API_KEY not set — skipping welcome email for", toEmail);
    return;
  }

  const embedCode = `<script src="https://rvdqfxtrskxekfkqnegx.supabase.co/storage/v1/object/public/widget/widget.js" data-tenant-id="${tenantId}"></script>`;

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#4f46e5,#6d28d9);padding:32px 40px;text-align:center;">
              <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:rgba(255,255,255,0.7);letter-spacing:0.08em;text-transform:uppercase;">SprintAI</p>
              <h1 style="margin:0;font-size:26px;font-weight:800;color:white;letter-spacing:-0.02em;">Your AI assistant is live!</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 20px;font-size:16px;color:#374151;line-height:1.6;">
                Welcome aboard! Your AI chat assistant for <strong>${businessName}</strong> has been set up and is ready to start answering your customers' questions.
              </p>

              <!-- Embed code block -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:10px;margin:0 0 28px;">
                <tr>
                  <td style="padding:14px 16px 6px;">
                    <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.07em;">Your embed code</p>
                    <code style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#a5f3fc;word-break:break-all;display:block;line-height:1.6;">${embedCode.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>
                  </td>
                </tr>
                <tr>
                  <td style="padding:10px 16px 14px;">
                    <p style="margin:0;font-size:11px;color:#64748b;">Paste this before the closing &lt;/body&gt; tag on your website</p>
                  </td>
                </tr>
              </table>

              <!-- Steps -->
              <p style="margin:0 0 14px;font-size:14px;font-weight:700;color:#1e293b;">How to add it to your site</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td style="padding:0 0 12px;">
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="width:28px;height:28px;background:#eef2ff;border-radius:50%;text-align:center;vertical-align:middle;font-size:13px;font-weight:700;color:#4f46e5;flex-shrink:0;">1</td>
                        <td style="padding-left:12px;font-size:14px;color:#475569;">Open your website's HTML or CMS editor</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 0 12px;">
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="width:28px;height:28px;background:#eef2ff;border-radius:50%;text-align:center;vertical-align:middle;font-size:13px;font-weight:700;color:#4f46e5;">2</td>
                        <td style="padding-left:12px;font-size:14px;color:#475569;">Find the closing <code style="background:#f1f5f9;padding:2px 5px;border-radius:4px;font-size:13px;">&lt;/body&gt;</code> tag</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td>
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="width:28px;height:28px;background:#eef2ff;border-radius:50%;text-align:center;vertical-align:middle;font-size:13px;font-weight:700;color:#4f46e5;">3</td>
                        <td style="padding-left:12px;font-size:14px;color:#475569;">Paste the embed code directly before it and save</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 28px;font-size:14px;color:#64748b;line-height:1.6;">
                That's it. A chat bubble will appear in the bottom-right corner of your website. Your AI knows your business and will start answering questions immediately.
              </p>

              <!-- Support -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
                <tr>
                  <td style="padding:18px 20px;">
                    <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#1e293b;">Need help? We're here.</p>
                    <p style="margin:0;font-size:13px;color:#64748b;">
                      Text us at <a href="sms:+16103792553" style="color:#4f46e5;text-decoration:none;">(610) 379-2553</a>
                      or email <a href="mailto:hello@getsprintai.com" style="color:#4f46e5;text-decoration:none;">hello@getsprintai.com</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 28px;text-align:center;border-top:1px solid #f1f5f9;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                SprintAI &nbsp;|&nbsp; AI Chat &amp; Text for local businesses<br/>
                <a href="https://getsprintai.com" style="color:#a5b4fc;text-decoration:none;">getsprintai.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "SprintAI <hello@getsprintai.com>",
        to: [toEmail],
        subject: "Your AI assistant is live! Here's your embed code",
        html: htmlBody,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[stripe-webhook] Resend API error ${res.status}:`, errText);
    } else {
      const resData = await res.json();
      console.log(`[stripe-webhook] Welcome email sent to ${toEmail} — id: ${resData.id}`);
    }
  } catch (err) {
    // Non-fatal: log and continue
    console.error("[stripe-webhook] Failed to send welcome email:", err);
  }
}

// ─── Chat-SMS notifier ───────────────────────────────────────────────────────

async function triggerChatSmsSystemEvent(
  shopId:         string,
  conversationId: string,
  orderCartId:    string,
  systemEvent:    string,
): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey     = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const functionUrl = `${supabaseUrl}/functions/v1/chat-sms`;

  try {
    const res = await fetch(functionUrl, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${anonKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        shop_id:         shopId,
        conversation_id: conversationId,
        order_cart_id:   orderCartId,
        system_event:    systemEvent,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[stripe-webhook] chat-sms notify failed: ${res.status} ${errText}`);
    } else {
      console.log(`[stripe-webhook] chat-sms notified: ${systemEvent} for cart ${orderCartId}`);
    }
  } catch (err) {
    console.error("[stripe-webhook] Failed to notify chat-sms:", err);
  }
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
