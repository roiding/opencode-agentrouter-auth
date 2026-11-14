import assert from "node:assert/strict";
import test from "node:test";
import { cleanResponsesRequest, fetchWithFilter, historyErrorCode, retryErrorClass } from "../lib/responses-filter.mjs";

const azureMessage = "The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it.";
const redactedMessage = azureMessage.replace("Azure", "***");
const redactedError = {
  type: "invalid_request_error",
  message: `OpenAI Responses bad request: ${redactedMessage} [trace_id=00000000000000000000000000000001]`
};
const history = {
  model: "request-chosen-model", stream: true, store: true,
  reasoning: { effort: "high" }, include: ["reasoning.encrypted_content"],
  input: [
    { type: "reasoning", id: "old-reasoning", encrypted_content: "old-private-history" },
    { type: "message", id: "old-message", role: "assistant", phase: "commentary", content: "Keep this message." },
    { type: "function_call", id: "old-call", call_id: "tool-pair", name: "lookup", arguments: "{}" },
    { type: "function_call_output", id: "old-result", call_id: "tool-pair", output: "Keep this result." }
  ]
};
const frame = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const completed = frame("response.completed", { response: { id: "winning-response", status: "completed", output: [] } });
const json = (value, status = 200) => Response.json(value, { status });
const sse = value => new Response(value, { headers: { "content-type": "text/event-stream" } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness(first, options = {}) {
  const calls = [], events = [];
  return {
    calls, events,
    send: (body = history) => fetchWithFilter("https://relay.example/v1/responses", {
      method: "POST", body: typeof body === "string" ? body : JSON.stringify(body)
    }, {
      fetchImpl: async (url, init) => {
        const raw = new TextDecoder().decode(init.body);
        calls.push({ raw, body: JSON.parse(raw) });
        return calls.length === 1 ? first() : sse(completed);
      },
      retryDelay: () => 0, keepaliveMs: 0,
      onEvent: (event, data) => events.push({ event, ...data }),
      ...options
    })
  };
}

test("Responses resource classification accepts only the original and AgentRouter-redacted messages", () => {
  for (const error of [
    { type: "invalid_request_error", message: azureMessage },
    { type: "invalid_request_error", message: redactedMessage },
    redactedError,
    { ...redactedError, code: "local_filter_error" }
  ]) {
    for (const value of [{ error }, { type: "response.failed", response: { error } }]) {
      assert.equal(retryErrorClass(value), "resource", error.message);
      assert.equal(historyErrorCode(value), "different_azure", error.message);
    }
  }
  const event = { type: "error", code: "invalid_request_error", message: redactedError.message };
  assert.equal(retryErrorClass(event), "resource");
  assert.equal(historyErrorCode(event), "different_azure");
});

test("redacted resource errors clean once across HTTP, JSON and SSE envelopes", async t => {
  for (const [name, first] of [
    ["HTTP 400", () => json({ error: redactedError }, 400)],
    ["HTTP 200 error JSON", () => json({ error: redactedError })],
    ["HTTP 200 failed response JSON", () => json({ status: "failed", error: redactedError })],
    ["SSE response.failed", () => sse(
      frame("response.output_item.done", { item: { id: "failed-item", type: "function_call", arguments: "failed-tool-output" } }) +
      frame("response.failed", { response: { error: redactedError } })
    )],
    ["SSE error", () => sse(frame("error", { type: "error", code: "invalid_request_error", message: redactedError.message }))],
    ["SSE event-only error", () => sse(frame("error", { error: redactedError }))]
  ]) await t.test(name, async () => {
    const h = harness(first);
    const raw = "\n " + JSON.stringify(history, null, 2) + "\n";
    const response = await h.send(raw);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), completed);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].raw, raw);
    assert.deepEqual(h.calls[1].body, cleanResponsesRequest(history).body);
    assert.equal(h.calls[1].body.model, history.model);
    const cleanup = h.events.filter(row => row.event === "history-cleanup");
    assert.equal(cleanup.length, 1);
    assert.equal(cleanup[0].errorCode, "different_azure");
    assert.equal(cleanup[0].removed, 1);
    assert.equal(cleanup[0].removedItemIds, 3);
    assert.equal(h.events.find(row => row.event === "retry-scheduled").kind, "resource");
    assert.doesNotMatch(JSON.stringify(h.events), /old-private-history|Keep this|trace_id/);
  });
});

test("redacted resource matching does not broaden cleanup to unrelated errors or protocols", () => {
  for (const error of [
    { ...redactedError, type: "authentication_error" },
    { ...redactedError, code: "invalid_api_key" },
    { ...redactedError, type: "permission_error" },
    { ...redactedError, message: redactedError.message + " Account quota exhausted." },
    { ...redactedError, message: redactedMessage.replace("***", "Another") },
    { ...redactedError, message: redactedMessage.replace("***", "****") },
    { ...redactedError, message: "Use the same resource that created the item to access it." },
    { ...redactedError, message: "The requested item was created under a different *** OpenAI resource." }
  ]) {
    const value = { type: "response.failed", response: { error } };
    assert.equal(retryErrorClass(value), null, JSON.stringify(error));
    assert.equal(historyErrorCode(value), null, JSON.stringify(error));
  }
  for (const protocol of ["chat", "anthropic", "gemini"]) {
    assert.equal(retryErrorClass({ error: redactedError }, protocol), null);
    assert.equal(historyErrorCode({ error: redactedError }, protocol), null);
  }
});

test("redacted resource HTTP errors outside status 400 remain terminal", async t => {
  for (const status of [401, 403, 429, 500, 502, 503, 504]) await t.test(String(status), async () => {
    const h = harness(() => json({ error: redactedError }, status));
    const response = await h.send();
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: redactedError });
    assert.equal(h.calls.length, 1);
    assert.equal(h.events.some(row => row.event === "history-cleanup"), false);
  });
});

test("redacted resource cleanup refuses unrecoverable server references", async () => {
  const h = harness(() => json({ error: redactedError }, 400));
  const body = { ...history, previous_response_id: "old-server-response" };
  const response = await h.send(body);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "response_reference_not_portable");
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].body, body);
  assert.equal(h.events.some(row => row.event === "cleanup-refused"), true);
});

test("SDK-wrapped stream errors still trigger resource cleanup exactly once", async () => {
  const calls = [], events = [];
  const wrapped = new Error(`stream disconnected before completion: AgentRouter: ${redactedError.message}`);
  const response = await fetchWithFilter("https://relay.example/v1/responses", {
    method: "POST", body: JSON.stringify(history)
  }, {
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(new TextDecoder().decode(init.body)));
      if (calls.length === 1) throw wrapped;
      return sse(completed);
    },
    retryDelay: () => 0, keepaliveMs: 0,
    onEvent: (event, data) => events.push({ event, ...data })
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), completed);
  assert.deepEqual(calls, [history, cleanResponsesRequest(history).body]);
  assert.equal(events.filter(row => row.event === "history-cleanup").length, 1);
  assert.equal(events.find(row => row.event === "history-cleanup").errorCode, "different_azure");
});

test("late redacted resource SSE errors retry behind non-content keepalive events", async () => {
  const h = harness(async () => {
    await delay(25);
    return sse(frame("response.output_item.done", { item: { id: "failed-item", arguments: "failed-tool-output" } }) +
      frame("response.failed", { response: { error: redactedError } }));
  }, { keepaliveMs: 5 });
  const response = await h.send();
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /response.in_progress/);
  assert.match(text, /winning-response/);
  assert.doesNotMatch(text, /failed-item|failed-tool-output|response.failed|bad request/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.events.filter(row => row.event === "history-cleanup").length, 1);
});
