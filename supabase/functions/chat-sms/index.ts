/**
 * SprintAI chat-sms Edge Function
 * Handles two channels:
 *   1. Twilio SMS webhook (application/x-www-form-urlencoded)
 *   2. Web chat widget (application/json, channel: "web")
 *
 * POST /functions/v1/chat-sms
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TwilioPayload {
  MessageSid: string;
  AccountSid: string;
  From: string;    // customer phone e.g. "+16105551234"
  To: string;      // Twilio number (tenant lookup key) e.g. "+16103792553"
  Body: string;    // SMS message text
  NumSegments: string;
}

interface WebPayload {
  tenant_id: string;
  message: string;
  channel: "web";
  session_id?: string;
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
  phone_number: string;
  status: string;
  config: Record<string, unknown>;
  plan: string;
}

interface Message {
  role: "customer" | "assistant" | "system";
  content: string;
}

interface KnowledgeChunk {
  content: string;
  source: string;
  similarity: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENAI_API_URL = "https://api.openai.com/v1";
const CHAT_MODEL = "gpt-4o-mini";
const EMBEDDING_MODEL = "text-embedding-3-small";
const MAX_RESPONSE_CHARS = 1500; // Keep SMS responses concise
const HISTORY_LIMIT = 10;        // Last N messages for context

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
  }

  const contentType = req.headers.get("content-type") ?? "";

  // Route based on content-type
  if (contentType.includes("application/json")) {
    return handleWebChannel(req);
  } else {
    // Default: Twilio form-encoded webhook
    return handleTwilioChannel(req);
  }
});

// ─── Channel: Web (from chat widget) ─────────────────────────────────────────

async function handleWebChannel(req: Request): Promise<Response> {
  const startTime = Date.now();

  try {
    let payload: WebPayload;
    try {
      payload = await req.json() as WebPayload;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const { tenant_id, message, session_id } = payload;

    if (!tenant_id || !message) {
      return jsonError("Missing required fields: tenant_id, message", 400);
    }

    console.log(`[chat-sms/web] tenant=${tenant_id} session=${session_id ?? "new"} msg="${message.substring(0, 80)}"`);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    // 1. Look up tenant by ID
    const { data: tenant, error: tenantErr } = await supabase
      .from("tenants")
      .select("id, name, slug, phone_number, status, config, plan")
      .eq("id", tenant_id)
      .single();

    if (tenantErr || !tenant) {
      console.error(`[chat-sms/web] Tenant not found: ${tenant_id}`);
      return jsonError("Tenant not found", 404);
    }

    if (tenant.status !== "active") {
      return jsonResponse({
        response: "This chat assistant is not currently available. Please contact us directly.",
        session_id: session_id ?? "",
      });
    }

    // 2. Find or create conversation by session_id
    const conversation = await findOrCreateWebConversation(supabase, tenant.id, session_id ?? null);
    const resolvedSessionId = session_id || conversation.session_id;

    // 3. Save inbound message
    await saveMessage(supabase, conversation.id, tenant.id, "customer", message);

    // 4. Load conversation history
    const history = await loadHistory(supabase, conversation.id);

    // 5. RAG: embed query + search knowledge base
    const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
    const relevantChunks = await ragSearch(openaiKey, message, tenant.id, supabase);

    // 6. Build system prompt (web-friendly: longer responses allowed)
    const systemPrompt = buildWebSystemPrompt(tenant, relevantChunks);

    // 7. Call OpenAI
    const { response: aiResponse, tokensUsed } = await callOpenAI(
      openaiKey,
      systemPrompt,
      history,
      message,
      600 // allow longer web responses vs SMS
    );

    // 8. Save assistant response + update conversation + track usage
    await Promise.all([
      saveMessage(supabase, conversation.id, tenant.id, "assistant", aiResponse, tokensUsed),
      supabase
        .from("conversations")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", conversation.id),
      supabase.from("usage_events").insert([
        { tenant_id: tenant.id, event_type: "web_chat_inbound", metadata: { session_id: resolvedSessionId } },
        { tenant_id: tenant.id, event_type: "web_chat_outbound", metadata: {} },
        { tenant_id: tenant.id, event_type: "ai_completion", tokens_used: tokensUsed, metadata: { model: CHAT_MODEL, channel: "web" } },
      ]),
    ]);

    const elapsed = Date.now() - startTime;
    console.log(`[chat-sms/web] Responded in ${elapsed}ms. Tokens: ${tokensUsed}`);

    return jsonResponse({
      response: aiResponse,
      session_id: resolvedSessionId,
    });

  } catch (err) {
    console.error("[chat-sms/web] Unhandled error:", err);
    return jsonResponse({
      response: "I'm having trouble right now. Please try again in a moment.",
      session_id: "",
    });
  }
}

// ─── Channel: Twilio SMS webhook ──────────────────────────────────────────────

async function handleTwilioChannel(req: Request): Promise<Response> {
  const startTime = Date.now();

  try {
    // Parse Twilio webhook form body
    const body = await req.text();
    const params = new URLSearchParams(body);
    const payload: TwilioPayload = {
      MessageSid: params.get("MessageSid") ?? "",
      AccountSid: params.get("AccountSid") ?? "",
      From: params.get("From") ?? "",
      To: params.get("To") ?? "",
      Body: params.get("Body") ?? "",
      NumSegments: params.get("NumSegments") ?? "1",
    };

    console.log(`[chat-sms/sms] Incoming SMS from ${payload.From} to ${payload.To}: "${payload.Body.substring(0, 100)}"`);

    // Validate Twilio signature (production security)
    const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    // TODO: Re-enable after testing — temporarily bypassed for end-to-end validation
    if (twilioAuthToken && !Deno.env.get("SKIP_TWILIO_SIG_CHECK")) {
      const isValid = await validateTwilioSignature(req, body, twilioAuthToken);
      if (!isValid) {
        console.error("[chat-sms/sms] Invalid Twilio signature");
        return twimlResponse("Invalid request signature.", 403);
      }
    }

    if (!payload.From || !payload.To || !payload.Body) {
      return twimlResponse("Missing required fields.", 400);
    }

    // Initialize Supabase client with service role key (bypasses RLS)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    // 1. Tenant lookup by Twilio "To" number
    const tenant = await lookupTenant(supabase, payload.To);
    if (!tenant) {
      console.error(`[chat-sms/sms] No tenant found for number: ${payload.To}`);
      return twimlResponse("This number is not currently in service.");
    }

    if (tenant.status === "paused") {
      const pausedMsg = (tenant.config as any).paused_message ??
        `${tenant.name} is temporarily unavailable. Please call us directly.`;
      return twimlResponse(pausedMsg);
    }

    if (tenant.status !== "active") {
      return twimlResponse(`This service is currently unavailable.`);
    }

    // 2. Find or create conversation
    const conversation = await findOrCreateSmsConversation(supabase, tenant.id, payload.From);

    // 3. Save inbound message
    await saveMessage(supabase, conversation.id, tenant.id, "customer", payload.Body);

    // 4. Load conversation history
    const history = await loadHistory(supabase, conversation.id);

    // 5. RAG: embed query + search knowledge base
    const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
    const relevantChunks = await ragSearch(openaiKey, payload.Body, tenant.id, supabase);

    // 6. Detect order intent (route to Toast if needed)
    const orderIntent = detectOrderIntent(payload.Body, history);
    let orderContext = "";
    if (orderIntent) {
      orderContext = await handleOrderIntent(supabase, tenant, conversation.id, payload.Body, history, openaiKey);
    }

    // 7. Build system prompt (SMS constraints)
    const systemPrompt = buildSystemPrompt(tenant, relevantChunks, orderContext);

    // 8. Call OpenAI
    const { response: aiResponse, tokensUsed } = await callOpenAI(
      openaiKey,
      systemPrompt,
      history,
      payload.Body,
      400 // SMS max tokens
    );

    const truncatedResponse = aiResponse.length > MAX_RESPONSE_CHARS
      ? aiResponse.substring(0, MAX_RESPONSE_CHARS - 3) + "..."
      : aiResponse;

    // 9. Save assistant response + update conversation + track usage
    await Promise.all([
      saveMessage(supabase, conversation.id, tenant.id, "assistant", truncatedResponse, tokensUsed),
      supabase
        .from("conversations")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", conversation.id),
      supabase.from("usage_events").insert([
        { tenant_id: tenant.id, event_type: "sms_inbound", metadata: { message_sid: payload.MessageSid } },
        { tenant_id: tenant.id, event_type: "sms_outbound", metadata: {} },
        { tenant_id: tenant.id, event_type: "ai_completion", tokens_used: tokensUsed, metadata: { model: CHAT_MODEL } },
      ]),
    ]);

    const elapsed = Date.now() - startTime;
    console.log(`[chat-sms/sms] Responded to ${payload.From} in ${elapsed}ms. Tokens: ${tokensUsed}`);

    return twimlResponse(truncatedResponse);

  } catch (err) {
    console.error("[chat-sms/sms] Unhandled error:", err);
    return twimlResponse("I'm having trouble right now. Please try again in a moment.");
  }
}

// ─── Shared Helper Functions ──────────────────────────────────────────────────

/** Return a TwiML SMS response */
function twimlResponse(message: string, status = 200): Response {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(message)}</Message>
</Response>`;
  return new Response(twiml, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

/** Validate Twilio webhook signature */
async function validateTwilioSignature(
  req: Request,
  body: string,
  authToken: string
): Promise<boolean> {
  const signature = req.headers.get("X-Twilio-Signature");
  if (!signature) return false;

  const url = req.url;
  const params = new URLSearchParams(body);
  const sortedParams = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}${v}`)
    .join("");

  const data = url + sortedParams;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));

  return computed === signature;
}

/** Look up tenant by their assigned Twilio phone number */
async function lookupTenant(
  supabase: ReturnType<typeof createClient>,
  phoneNumber: string
): Promise<Tenant | null> {
  const { data, error } = await supabase
    .from("tenants")
    .select("id, name, slug, phone_number, status, config, plan")
    .eq("phone_number", phoneNumber)
    .single();

  if (error || !data) {
    // Fallback: shared number mode
    const sharedNumber = Deno.env.get("TWILIO_PHONE_NUMBER");
    if (sharedNumber && phoneNumber === sharedNumber) {
      const { data: fallback } = await supabase
        .from("tenants")
        .select("id, name, slug, phone_number, status, config, plan")
        .eq("status", "active")
        .limit(1)
        .single();
      return fallback ?? null;
    }
    return null;
  }
  return data;
}

/** Find or create an SMS conversation for customer phone + tenant */
async function findOrCreateSmsConversation(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  customerPhone: string
): Promise<{ id: string; session_id: string }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: existing } = await supabase
    .from("conversations")
    .select("id, session_id")
    .eq("tenant_id", tenantId)
    .eq("customer_phone", customerPhone)
    .eq("status", "active")
    .gte("last_message_at", cutoff)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .single();

  if (existing) return { id: existing.id, session_id: existing.session_id ?? existing.id };

  const { data: created, error } = await supabase
    .from("conversations")
    .insert({ tenant_id: tenantId, customer_phone: customerPhone, channel: "sms" })
    .select("id, session_id")
    .single();

  if (error || !created) {
    throw new Error(`Failed to create SMS conversation: ${error?.message}`);
  }
  return { id: created.id, session_id: created.session_id ?? created.id };
}

/** Find or create a web conversation by session_id */
async function findOrCreateWebConversation(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
  sessionId: string | null
): Promise<{ id: string; session_id: string }> {
  // Try to find existing conversation by session_id
  if (sessionId) {
    const { data: existing } = await supabase
      .from("conversations")
      .select("id, session_id")
      .eq("tenant_id", tenantId)
      .eq("session_id", sessionId)
      .eq("channel", "web")
      .single();

    if (existing) return { id: existing.id, session_id: existing.session_id };
  }

  // Generate a new session_id if none provided
  const newSessionId = sessionId || ("web_" + crypto.randomUUID());

  const { data: created, error } = await supabase
    .from("conversations")
    .insert({
      tenant_id: tenantId,
      channel: "web",
      session_id: newSessionId,
    })
    .select("id, session_id")
    .single();

  if (error || !created) {
    throw new Error(`Failed to create web conversation: ${error?.message}`);
  }
  return { id: created.id, session_id: created.session_id ?? newSessionId };
}

/** Save a message to the DB */
async function saveMessage(
  supabase: ReturnType<typeof createClient>,
  conversationId: string,
  tenantId: string,
  role: "customer" | "assistant" | "system",
  content: string,
  tokensUsed = 0
): Promise<void> {
  const { error } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    tenant_id: tenantId,
    role,
    content,
    tokens_used: tokensUsed,
  });
  if (error) {
    console.error("[chat-sms] Failed to save message:", error);
  }
}

/** Load recent conversation history */
async function loadHistory(
  supabase: ReturnType<typeof createClient>,
  conversationId: string
): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .in("role", ["customer", "assistant"])
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error || !data) return [];
  // Reverse to chronological order (fetched newest first)
  return data.reverse() as Message[];
}

/** Embed the user query and search knowledge base */
async function ragSearch(
  openaiKey: string,
  query: string,
  tenantId: string,
  supabase: ReturnType<typeof createClient>
): Promise<KnowledgeChunk[]> {
  try {
    const embeddingRes = await fetch(`${OPENAI_API_URL}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: query,
      }),
    });

    if (!embeddingRes.ok) {
      const errText = await embeddingRes.text();
      console.error("[chat-sms] Embedding error:", errText);
      return [];
    }

    const embeddingData = await embeddingRes.json();
    const queryEmbedding = embeddingData.data[0].embedding;

    const { data, error } = await supabase.rpc("match_knowledge_base", {
      query_embedding: queryEmbedding,
      match_tenant_id: tenantId,
      match_count: 10,
      match_threshold: 0.20,
    });

    if (error) {
      console.error("[chat-sms] RAG search error:", error);
      return [];
    }

    return (data ?? []).map((row: any) => ({
      content: row.content,
      source: row.source,
      similarity: row.similarity,
    }));
  } catch (err) {
    console.error("[chat-sms] RAG error:", err);
    return [];
  }
}

/** Simple keyword-based order intent detection */
function detectOrderIntent(message: string, _history: Message[]): boolean {
  const orderKeywords = [
    "order", "i want", "i'd like", "can i get", "give me", "i'll have",
    "pizza", "burger", "sandwich", "wings", "fries", "delivery", "pickup",
    "add to cart", "place order", "menu item",
  ];
  const lower = message.toLowerCase();
  return orderKeywords.some((kw) => lower.includes(kw));
}

/** Handle Toast order intent */
async function handleOrderIntent(
  supabase: ReturnType<typeof createClient>,
  tenant: Tenant,
  _conversationId: string,
  _message: string,
  _history: Message[],
  _openaiKey: string
): Promise<string> {
  const { data: integration } = await supabase
    .from("integrations")
    .select("config")
    .eq("tenant_id", tenant.id)
    .eq("type", "toast")
    .eq("status", "active")
    .single();

  if (!integration) return "";

  return `\n\n[ORDER MODE ACTIVE: This customer wants to place an order.
Guide them through:
1. Clarify what items they want
2. Confirm quantities and modifications
3. Confirm total and ask to proceed
4. Once confirmed, the system will place the order via Toast POS.
Available menu items are in the knowledge base above.]`;
}

/** Build the system prompt for SMS (concise, plain text) */
function buildSystemPrompt(
  tenant: Tenant,
  chunks: KnowledgeChunk[],
  orderContext: string
): string {
  const config = tenant.config as any;
  const businessType = config.business_type ?? "business";
  const address = config.address ?? "";
  const hours = config.hours ?? "Contact us for hours";
  const phone = config.phone ?? "";
  const greeting = config.greeting ?? "";
  const personality = config.personality ?? "friendly and professional";

  const knowledgeContext = chunks.length > 0
    ? chunks.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n")
    : "No specific information available -- answer based on general knowledge for this business type.";

  return `You are a helpful ${personality} assistant for ${tenant.name}, a ${businessType}${address ? ` located at ${address}` : ""}.
Business hours: ${hours}${phone ? `\nPhone: ${phone}` : ""}
${greeting ? `Greeting style: ${greeting}` : ""}

IMPORTANT RULES:
- Keep responses SHORT and conversational (this is SMS -- under 160 chars when possible, never more than 300 chars)
- Be warm, helpful, and direct
- Never make up prices, hours, or services you don't have info about
- If you don't know something, say so and offer to connect them with the business
- For emergencies: always direct to 911 or the business phone number
- Do not use markdown, bullet points, or formatting -- plain text only
- Do not include emojis unless the business tone specifically calls for it

KNOWLEDGE BASE (what you know about this business):
${knowledgeContext}
${orderContext}`;
}

/** Build the system prompt for web chat (more conversational, can be richer) */
function buildWebSystemPrompt(tenant: Tenant, chunks: KnowledgeChunk[]): string {
  const config = tenant.config as any;
  const businessType = config.business_type ?? "business";
  const address = config.address ?? "";
  const hours = config.hours ?? "Contact us for hours";
  const phone = config.phone ?? "";
  const personality = config.personality ?? "friendly and helpful";

  const knowledgeContext = chunks.length > 0
    ? chunks.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n")
    : "No specific information available -- answer based on general knowledge for this business type.";

  // SprintAI's own tenant gets product/pricing context; customer tenants get a clean slate
  const isSprintAI = tenant.slug === "sprintai-test" || tenant.name?.toLowerCase().includes("sprintai");
  const sprintaiBlock = isSprintAI ? `
YOUR PRIMARY PRODUCT: AI chatbot for websites. When customers ask what you do, lead with the chatbot. You train it on a business's info, it answers customer questions 24/7 on their website. SMS texting is an add-on.

PRICING (use this, not scraped site data for pricing questions):
- AI Chat: $99/mo (website chatbot trained on your business, 24/7, unlimited conversations)
- Text/SMS add-on: +$49/mo (business text number, customers text and get AI responses)
- 30-day free trial on all plans. No contracts. Cancel anytime.
` : "";

  return `You are a helpful ${personality} AI assistant for ${tenant.name}, a ${businessType}${address ? ` located at ${address}` : ""}.
${hours !== "Contact us for hours" ? `Business hours: ${hours}` : ""}${phone ? `\nPhone: ${phone}` : ""}
${sprintaiBlock}
RULES:
- Be conversational, warm, and concise (this is a web chat widget)
- Responses should be 1-3 sentences for simple questions, longer for detailed questions about menus, products, or services
- ONLY answer based on the knowledge base below. You represent this business and ONLY this business.
- When customers ask about the menu, products, services, or "what do you have" — be THOROUGH. List everything you know from the knowledge base. Include item names, descriptions, and prices when available. Customers want details, not vague summaries.
- If the knowledge base genuinely has NO information about what the customer asked, say something like "I don't have that info yet, but the team is getting me up to speed! You can contact us directly in the meantime."
- But if you have ANY relevant information in the knowledge base, USE IT. Do not say "I don't have that info" when you do have relevant data — even partial data is better than nothing.
- Never mention SprintAI, AI chatbots as a product, or anything about how you were built. You ARE the business's assistant.
- Keep responses friendly and natural, not robotic or overly formal
- Do not use heavy markdown; keep formatting minimal and readable

KNOWLEDGE BASE (what you know about this business):
${knowledgeContext}`;
}

/** Call OpenAI chat completions */
async function callOpenAI(
  apiKey: string,
  systemPrompt: string,
  history: Message[],
  userMessage: string,
  maxTokens = 400
): Promise<{ response: string; tokensUsed: number }> {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({
      role: m.role === "customer" ? "user" : m.role === "assistant" ? "assistant" : "system",
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];

  const res = await fetch(`${OPENAI_API_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("[chat-sms] OpenAI error:", errText);
    throw new Error(`OpenAI API error: ${res.status}`);
  }

  const data = await res.json();
  const response = data.choices?.[0]?.message?.content ?? "I'm having trouble right now. Please try again.";
  const tokensUsed = data.usage?.total_tokens ?? 0;

  return { response, tokensUsed };
}
