// The safety property of the interpreter is that the model CANNOT invent an
// answer: it is offered a closed list and anything else is discarded. These
// use a stub transport, so they assert the contract, not the model.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { interpretAnswer } from "./answer-interpreter.ts";

const OPTIONS = [
  { id: "closure", describes: "the customer is finished ordering" },
  { id: "new_order", describes: "the customer is asking for another item" },
  { id: "read_back", describes: "the customer wants the order read back to them" },
];

function stub(answerId: unknown, ok = true): typeof fetch {
  return (() => Promise.resolve({
    ok,
    json: () => Promise.resolve({ content: [{ type: "tool_use", name: "report_answer", input: { answer_id: answerId } }] }),
  })) as unknown as typeof fetch;
}

Deno.test("returns the id when the model picks one that was offered", async () => {
  assertEquals(
    await interpretAnswer({ question: "Anything else?", message: "nah i'm good", options: OPTIONS }, { apiKey: "k", fetchImpl: stub("closure") }),
    "closure",
  );
});

Deno.test("DISCARDS an id the model was never offered - it cannot invent", async () => {
  for (const invented of ["checkout", "cancel_everything", "", "CLOSURE"]) {
    assertEquals(
      await interpretAnswer({ question: "Anything else?", message: "x", options: OPTIONS }, { apiKey: "k", fetchImpl: stub(invented) }),
      null,
      `must discard: ${JSON.stringify(invented)}`,
    );
  }
});

Deno.test("'none' resolves to null", async () => {
  assertEquals(
    await interpretAnswer({ question: "Anything else?", message: "what time do you close", options: OPTIONS }, { apiKey: "k", fetchImpl: stub("none") }),
    null,
  );
});

Deno.test("every failure mode falls back to null, never throws", async () => {
  const cases: Array<[string, typeof fetch]> = [
    ["non-200", stub("closure", false)],
    ["non-string id", stub(42)],
    ["network throw", (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch],
    ["malformed body", (() => Promise.resolve({ ok: true, json: () => Promise.reject(new Error("bad json")) })) as unknown as typeof fetch],
  ];
  for (const [label, f] of cases) {
    assertEquals(await interpretAnswer({ question: "q", message: "m", options: OPTIONS }, { apiKey: "k", fetchImpl: f }), null, label);
  }
});

Deno.test("no model call when the answer is knowable without one", async () => {
  let called = 0;
  const counting = (() => { called++; return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); }) as unknown as typeof fetch;
  await interpretAnswer({ question: "q", message: "   ", options: OPTIONS }, { apiKey: "k", fetchImpl: counting });
  await interpretAnswer({ question: "q", message: "m", options: [] }, { apiKey: "k", fetchImpl: counting });
  await interpretAnswer({ question: "q", message: "m", options: OPTIONS }, { apiKey: "", fetchImpl: counting });
  assertEquals(called, 0, "must not spend a token when the answer is knowable without one");
});
