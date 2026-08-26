/**
 * runner.ts — Run a single test case against the chat-sms bot via the
 * web-chat-test JSON path. NO Twilio, NO outbound SMS.
 *
 * HARD SAFETY GATE: refuses to run against a shop with protected=true OR
 * phone_number_e164 IS NOT NULL. Only synthetic test shops allowed.
 *
 * Supports both scripted TestCase and LLM-driven ConversationalCase.
 * Conversational cases use a customer-simulator LLM playing a persona toward
 * a goal, producing natural multi-turn conversations on one session_id.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import type { TestCase, ConversationalCase, AnyCase, Turn } from "./library.ts";
import { isConversationalCase } from "./library.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TurnResult {
  role: "customer" | "assistant" | "system";
  message: string;
  /** If the turn was a customer message that got a bot reply. */
  reply?: string | null;
  cart?: unknown;
  phase?: string;
}

export interface RunResult {
  caseId: string;
  shopId: string;
  transcript: TurnResult[];
  sessionId: string;
  error?: string;
}

export interface RunnerConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  /** Function URL for the chat-sms edge function. */
  chatFunctionUrl: string;
  /** Optional simulator API key for conversational cases. */
  simulatorApiKey?: string;
  /** Optional simulator model (default deepseek-v4-flash). */
  simulatorModel?: string;
  /** Optional simulator API URL (default OpenRouter). */
  simulatorApiUrl?: string;
}

// ── HARD GATES ─────────────────────────────────────────────────────────────

async function loadShop(
  supabase: any,
  shopId: string,
): Promise<{ id: string; tenant_id: string; name: string; protected: boolean; phone_number_e164: string | null }> {
  const { data, error } = await supabase
    .from("shops")
    .select("id, tenant_id, name, protected, phone_number_e164")
    .eq("id", shopId)
    .single();
  if (error || !data) throw new Error(`Shop ${shopId} not found`);
  return data;
}

function enforceSafetyGate(shop: { id: string; name: string; protected: boolean; phone_number_e164: string | null }): void {
  if (shop.protected === true) {
    throw new Error(
      `SAFETY GATE: Shop "${shop.name}" (${shop.id}) is protected. ` +
      `Refusing to run test suite against a protected shop. ` +
      `Only test/unprotected shops (no phone number) are allowed.`,
    );
  }
  if (shop.phone_number_e164 !== null && shop.phone_number_e164 !== "") {
    throw new Error(
      `SAFETY GATE: Shop "${shop.name}" (${shop.id}) has a phone number ` +
      `(${shop.phone_number_e164}). Refusing to run — this shop could receive ` +
      `real SMS traffic. Only phone-less test shops are allowed.`,
    );
  }
}

// ── Bot Driver ─────────────────────────────────────────────────────────────

/**
 * Send a web-chat message and get the JSON reply. Uses the SAME contract as
 * the admin chat-test: POST {shop_id, message, session_id} → {reply, cart, phase, session_id}.
 */
async function sendMessage(
  chatFunctionUrl: string,
  supabaseKey: string,
  shopId: string,
  message: string,
  sessionId: string,
  hoursMode?: "open" | "closed",
): Promise<{ reply: string | null; cart?: unknown; phase?: string }> {
  // ── Build the request body ───────────────────────────────────────────
  const requestBody: Record<string, unknown> = {
    shop_id: shopId,
    message,
    session_id: sessionId,
    test: true,
  };
  if (hoursMode === "closed") {
    requestBody.test_hours = "closed";
    // Remove `test: true` so the forceClosed branch takes priority.
    delete requestBody.test;
  }

  const res = await fetch(chatFunctionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`chat-sms returned ${res.status}: ${text.slice(0, 500)}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/xml") || ct.includes("application/xml")) {
    // SMS path returned TwiML — this means the function routed to Twilio.
    // This should not happen for a JSON POST, but guard anyway.
    throw new Error("chat-sms returned TwiML (SMS path) — web-chat-test path unexpected");
  }

  const data = await res.json();
  return data;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Run a single test case against the bot. Returns a full transcript.
 *
 * Hard safety gate: throws BEFORE any bot call if the shop is protected or
 * has a phone number.
 *
 * Dispatches to scripted or conversational driver based on case type.
 */
export async function runCase(
  config: RunnerConfig,
  shopId: string,
  testCase: AnyCase,
): Promise<RunResult> {
  if (isConversationalCase(testCase)) {
    return runConversationalCase(config, shopId, testCase, testCase.hoursMode);
  }
  return runScriptedCase(config, shopId, testCase, testCase.hoursMode);
}

/**
 * Run a scripted (turn-by-turn) test case.
 */
async function runScriptedCase(
  config: RunnerConfig,
  shopId: string,
  testCase: TestCase,
  hoursMode?: "open" | "closed",
): Promise<RunResult> {
  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── HARD SAFETY GATE (MUST run before any network call) ────────────────
  const shop = await loadShop(supabase, shopId);
  enforceSafetyGate(shop);

  // ── Run each turn ──────────────────────────────────────────────────────
  const sessionId = `test-suite-${crypto.randomUUID()}`;
  const transcript: TurnResult[] = [];

  for (const turn of testCase.turns) {
    try {
      const result = await sendMessage(
        config.chatFunctionUrl,
        config.serviceRoleKey,
        shopId,
        turn.message,
        sessionId,
        hoursMode,
      );

      transcript.push({
        role: turn.role,
        message: turn.message,
        reply: result.reply ?? null,
        cart: result.cart,
        phase: result.phase,
      });
    } catch (e) {
      transcript.push({
        role: turn.role,
        message: turn.message,
        reply: `[ERROR: ${(e as Error).message}]`,
      });
      return {
        caseId: testCase.id,
        shopId,
        transcript,
        sessionId,
        error: (e as Error).message,
      };
    }
  }

  return {
    caseId: testCase.id,
    shopId,
    transcript,
    sessionId,
  };
}

// ── Conversational (LLM customer-simulator) driver ─────────────────────────

/**
 * Run a conversational case: an LLM plays the customer persona toward a goal,
 * producing natural turns. All turns share ONE session_id so the bot keeps a
 * single conversation + cart across the whole exchange. The simulator stops
 * when the goal is reached, the bot's reply signals closure, or max_turns is
 * hit. The bot's last reply is not sent to the simulator (nothing to say to a
 * final bot message), so the transcript ends on the bot's closing message.
 */
async function runConversationalCase(
  config: RunnerConfig,
  shopId: string,
  testCase: ConversationalCase,
  hoursMode?: "open" | "closed",
): Promise<RunResult> {
  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── HARD SAFETY GATE (MUST run before any network call) ────────────────
  const shop = await loadShop(supabase, shopId);
  enforceSafetyGate(shop);

  if (!config.simulatorApiKey) {
    return {
      caseId: testCase.id,
      shopId,
      transcript: [],
      sessionId: "",
      error: "simulatorApiKey not configured (conversational cases require it)",
    };
  }

  const sessionId = `test-suite-${crypto.randomUUID()}`;
  const transcript: TurnResult[] = [];
  const history: string[] = [];
  let goalReached = false;
  let lastPhase: string | undefined;

  // Opening turn: the customer speaks first (persona's seed message or a
  // generated one from the goal if no explicit seed).
  let message = testCase.seed_message ??
    `(start a conversation as ${testCase.persona}, working toward: ${testCase.goal})`;

  for (let turn = 0; turn < testCase.max_turns; turn++) {
    try {
      const result = await sendMessage(
        config.chatFunctionUrl,
        config.serviceRoleKey,
        shopId,
        message,
        sessionId,
        hoursMode,
      );

      transcript.push({
        role: "customer",
        message,
        reply: result.reply ?? null,
        cart: result.cart,
        phase: result.phase,
      });
      history.push(`Customer: ${message}`);
      lastPhase = result.phase;

      const reply = result.reply ?? "";
      if (reply) history.push(`Assistant: ${reply}`);

      // Decide whether to continue.
      const decision = await simulateNext(
        config,
        testCase,
        history,
        reply,
        lastPhase,
        turn + 1,
        testCase.max_turns,
      );

      if (decision.done) {
        goalReached = decision.goalReached ?? false;
        break;
      }
      if (!decision.nextMessage || !decision.nextMessage.trim()) {
        break;
      }
      message = decision.nextMessage.trim();
    } catch (e) {
      transcript.push({
        role: "customer",
        message,
        reply: `[ERROR: ${(e as Error).message}]`,
      });
      return {
        caseId: testCase.id,
        shopId,
        transcript,
        sessionId,
        error: (e as Error).message,
      };
    }
  }

  // If the simulator ran out of turns without reaching the goal, annotate the
  // last assistant reply so the judge sees the goal was NOT reached.
  if (!goalReached && transcript.length > 0) {
    const last = transcript[transcript.length - 1];
    transcript[transcript.length - 1] = {
      ...last,
      reply: `${last.reply ?? ""}\n\n[SYSTEM: customer goal "${testCase.goal}" was NOT reached within ${testCase.max_turns} turns]`.trim(),
    };
  }

  return {
    caseId: testCase.id,
    shopId,
    transcript,
    sessionId,
  };
}

interface SimulatorDecision {
  done: boolean;
  goalReached?: boolean;
  nextMessage?: string;
}

/**
 * Ask the customer-simulator LLM whether the goal is met and, if not, what the
 * customer says next. One LLM call per turn. On API/parse failure, fall back
 * to a deterministic "stop" so the run still terminates (goalReached=false).
 */
async function simulateNext(
  config: RunnerConfig,
  testCase: ConversationalCase,
  history: string[],
  lastReply: string,
  lastPhase: string | undefined,
  turn: number,
  maxTurns: number,
): Promise<SimulatorDecision> {
  const system = `You are simulating a real restaurant customer for a test of an SMS/web
ordering bot. You are playing this persona:

  PERSONA: ${testCase.persona}

  GOAL: ${testCase.goal}

Stay in character. Speak naturally and concisely, like a real customer typing
a text message. Do NOT reveal you are a test or a bot. Do not use emoji
excessively. If the assistant asks a question, answer it. If the assistant
offers something off-goal, decline or redirect to your goal. You may make a
realistic mess: misspell occasionally, change your mind, ask a clarifying
question, or forget a detail — but only when it serves the goal.

Current conversation phase reported by the bot: ${lastPhase ?? "unknown"}.
Turns used: ${turn} of ${maxTurns}.

Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "done": <true if the customer's goal is fully satisfied OR the conversation
           has naturally ended OR continuing would be repetitive>,
  "goal_reached": <true if the goal was actually satisfied, false if the
           conversation ended without the goal being met>,
  "next_message": "<the customer's next text message, or empty string if done>"
}
If the assistant's last message clearly satisfies the goal, set done=true and
goal_reached=true with an empty next_message. If the assistant is confused,
refuses, or stalls and you cannot make progress, set done=true and
goal_reached=false.`;

  const user = `Conversation so far:
${history.join("\n") || "(empty)"}

Assistant's latest message: ${lastReply || "(no reply)"}

Decide: is the goal reached? If not, what does the customer say next?`;

  const url = config.simulatorApiUrl ?? "https://openrouter.ai/api/v1/chat/completions";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.simulatorApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://getsprintai.com",
        "X-Title": "SprintAI Customer Simulator",
      },
      body: JSON.stringify({
        model: config.simulatorModel ?? "deepseek/deepseek-v4-flash",
        max_tokens: 256,
        reasoning: { enabled: false },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Simulator API ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const text: string = (data.choices?.[0]?.message?.content ?? "").trim();

    // Robust JSON extraction (code fences, prose wrappers).
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const obj = JSON.parse(text.slice(start, end + 1)) as {
        done?: boolean;
        goal_reached?: boolean;
        next_message?: string;
      };
      if (typeof obj.done === "boolean") {
        return {
          done: obj.done,
          goalReached: obj.goal_reached ?? (obj.done && !obj.next_message),
          nextMessage: obj.next_message ?? "",
        };
      }
    }
    // Parse failed — stop rather than loop forever.
    return { done: true, goalReached: false, nextMessage: "" };
  } catch (e) {
    console.error(`  [simulator] error: ${(e as Error).message}`);
    return { done: true, goalReached: false, nextMessage: "" };
  }
}