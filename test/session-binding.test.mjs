import assert from "node:assert/strict";
import test from "node:test";
import { _internal } from "../lib/responses-filter.mjs";

const { cleanResponsesRequest, createFilteredFetch, historyErrorCode, sessionBindingInvalidated,
  sessionBindingInvalidatedText } = _internal;
const binding = {
  type: "invalid_request_error",
  code: "session_binding_invalidated",
  message: "session binding invalidated: the model this session is bound to can no longer serve it; restart the task with a new session id [trace_id=60b810d945ddd3159bb890af949ce13f code=30013]"
};
const history = {
  model: "request-chosen-model", stream: true, store: true,
  reasoning: { effort: "max" }, include: ["reasoning.encrypted_content"],
  prompt_cache_key: "cache-base", session_id: "body-session",
  input: [
    { type: "reasoning", id: "old-reasoning", encrypted_content: "private-reasoning" },
    { type: "message", id: "old-message", role: "assistant", phase: "commentary", content: "Keep the message." },
    { type: "function_call", id: "old-call", call_id: "pair", name: "lookup", arguments: "{}" },
    { type: "function_call_output", id: "old-result", call_id: "pair", output: "Keep the result." }
  ]
};
const headers = {
  "session-id": "session-base", "thread-id": "thread-base",
  "x-session-id": "plugin-base", "x-client-request-id": "client-base"
};
const frame = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const completed = frame("response.completed", { response: { id: "response-ok", status: "completed", output: [] } });
const json = (value, status = 200) => Response.json(value, { status });
const sse = value => new Response(value, { headers: { "content-type": "text/event-stream" } });

function harness(steps, options = {}) {
  const calls = [], events = [];
  const fetchImpl = async (url, init) => {
    const raw = new TextDecoder().decode(init.body);
    calls.push({ raw, body: JSON.parse(raw), headers: new Headers(init.headers) });
    return steps[Math.min(calls.length - 1, steps.length - 1)]();
  };
  const send = (body = history, extraHeaders = headers) => fetchWithFilter(body, extraHeaders);
  const fetchWithFilter = (body, requestHeaders) => _internal.fetchWithFilter(
    "https://relay.example/v1/responses",
    { method: "POST", body: JSON.stringify(body), headers: requestHeaders },
    { fetchImpl, retryDelay: () => 0, keepaliveMs: 0,
      onEvent: (event, data) => events.push({ event, ...data }), ...options }
  );
  return { calls, events, send };
}

test("session binding errors are recognized by code and exact text without overmatching", () => {
  for (const value of [
    { error: binding },
    { type: "response.failed", response: { error: binding } },
    { type: "error", code: "invalid_request_error", message: binding.message },
    { error: { code: 30013, message: "upstream conflict" } }
  ]) assert.equal(sessionBindingInvalidated(value), true);
  assert.equal(sessionBindingInvalidatedText(JSON.stringify(binding)), true);
  assert.equal(sessionBindingInvalidatedText(`upstream said ${binding.message}`), true);

  for (const value of [
    { error: { code: "invalid_request_error", message: "ordinary bad request" } },
    { error: { code: "invalid_encrypted_content", message: "encrypted content" } },
    { error: { code: "invalid_api_key", message: binding.message } },
    { error: { code: "session_binding_invalidated", message: "Account quota exhausted" } }
  ]) assert.equal(sessionBindingInvalidated(value), false, JSON.stringify(value));
  assert.equal(sessionBindingInvalidatedText("ordinary text"), false);
});

test("409 cleans portable history and rotates every session identity once", async () => {
  const h = harness([() => json({ error: binding }, 409), () => sse(completed)]);
  const response = await h.send();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), completed);
  assert.equal(h.calls.length, 2);

  const [first, retry] = h.calls;
  assert.deepEqual(first.body, history);
  assert.deepEqual(Object.fromEntries(Object.keys(headers).map(name => [name, first.headers.get(name)])), headers);
  assert.equal(first.headers.get("content-length"), null);

  const expected = cleanResponsesRequest(history).body;
  assert.deepEqual(retry.body, {
    ...expected,
    session_id: "body-session-rebind-1",
    prompt_cache_key: "cache-base-rebind-1"
  });
  assert.equal(retry.body.model, history.model);
  assert.deepEqual(retry.body.input, expected.input);
  for (const name of Object.keys(headers)) {
    assert.equal(retry.headers.get(name), `${headers[name]}-rebind-1`, name);
  }

  const cleanup = h.events.filter(row => row.event === "history-cleanup");
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0].errorCode, "session_binding_invalidated");
  assert.equal(cleanup[0].removed, 1);
  assert.equal(cleanup[0].removedItemIds, 3);
  assert.equal(h.events.filter(row => row.event === "session-binding-rotated").length, 1);
  assert.equal(h.events.find(row => row.event === "retry-scheduled").kind, "sessionBinding");
  assert.doesNotMatch(JSON.stringify(h.events), /private-reasoning|Keep the message|trace_id/);
});

test("the 400-wrapped binding variant uses the same cleanup path", async () => {
  const wrapped = { error: {
    ...binding,
    code: "invalid_request_error",
    message: `OpenAI Responses bad request: ${binding.message}`
  } };
  const h = harness([() => json(wrapped, 400), () => sse(completed)]);
  assert.equal((await h.send()).status, 200);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].body, {
    ...cleanResponsesRequest(history).body,
    session_id: "body-session-rebind-1",
    prompt_cache_key: "cache-base-rebind-1"
  });
  assert.equal(h.events.find(row => row.event === "http-error").errorCode, "session_binding_invalidated");
});

test("plain-text and SSE binding failures clean before retry", async t => {
  for (const [name, first] of [
    ["plain text", () => new Response(binding.message, { status: 409 })],
    ["SSE response.failed", () => sse(
      frame("response.output_item.done", { item: { id: "failed-item", arguments: "failed-output" } }) +
      frame("response.failed", { response: { error: binding } })
    )],
    ["SSE error", () => sse(frame("error", { error: binding }))]
  ]) await t.test(name, async () => {
    const h = harness([first, () => sse(completed)]);
    const text = await (await h.send()).text();
    assert.equal(text, completed);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1].body.input, cleanResponsesRequest(history).body.input);
    assert.doesNotMatch(text, /failed-item|failed-output/);
  });
});

test("binding recovery retries once and does not loop on the same failed binding", async () => {
  const h = harness([() => json({ error: binding }, 409)]);
  assert.equal((await h.send()).status, 409);
  assert.equal(h.calls.length, 2);
  assert.equal(h.events.filter(row => row.event === "history-cleanup").length, 1);
  assert.deepEqual(h.calls.map(call => call.headers.get("session-id")),
    ["session-base", "session-base-rebind-1"]);
  assert.equal(h.events.filter(row => row.event === "session-binding-rotated").length, 1);
});

test("SDK-wrapped stream errors recover once, then stop retrying the same binding", async () => {
  const wrapped = Object.assign(
    new Error(`stream disconnected before completion: AgentRouter: ${binding.message}`),
    { cause: new Error("upstream response closed unexpectedly") }
  );
  const calls = [], events = [];
  const fetchImpl = async (url, init) => {
    calls.push({ body: JSON.parse(new TextDecoder().decode(init.body)), headers: new Headers(init.headers) });
    if (calls.length === 1) throw wrapped;
    if (calls.length === 2) return sse(completed);
    throw wrapped;
  };
  const send = body => _internal.fetchWithFilter("https://relay.example/v1/responses", {
    method: "POST", body: JSON.stringify(body), headers
  }, {
    fetchImpl, retryDelay: () => 0, keepaliveMs: 0,
    onEvent: (event, data) => events.push({ event, ...data })
  });
  assert.equal((await send(history)).status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, history);
  assert.deepEqual(calls[1].body, {
    ...cleanResponsesRequest(history).body,
    session_id: "body-session-rebind-1",
    prompt_cache_key: "cache-base-rebind-1"
  });
  assert.equal(calls[1].headers.get("session-id"), "session-base-rebind-1");
  assert.equal(events.filter(row => row.event === "history-cleanup").length, 1);

  const terminalCalls = [];
  const terminal = await _internal.fetchWithFilter("https://relay.example/v1/responses", {
    method: "POST", body: JSON.stringify(history), headers
  }, {
    fetchImpl: async (url, init) => {
      terminalCalls.push(new Headers(init.headers));
      throw wrapped;
    }, retryDelay: () => 0, keepaliveMs: 0
  });
  assert.equal(terminal.status, 409);
  assert.equal((await terminal.json()).error.code, "session_binding_invalidated");
  assert.equal(terminalCalls.length, 2);
  assert.deepEqual(terminalCalls.map(value => value.get("session-id")),
    ["session-base", "session-base-rebind-1"]);
});

test("rotation state is shared by a filtered fetch instance, not across accounts", async () => {
  const calls = [], events = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(new TextDecoder().decode(init.body));
    calls.push({ headers: new Headers(init.headers), body });
    return calls.length === 1 ? json({ error: binding }, 409) : sse(completed);
  };
  const send = createFilteredFetch(fetchImpl, { retryDelay: () => 0, keepaliveMs: 0,
    onEvent: (event, data) => events.push({ event, ...data }) });
  const request = () => send("https://relay.example/v1/responses", {
    method: "POST", body: JSON.stringify(history), headers: { "session-id": "shared-base" }
  });
  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 200);
  assert.deepEqual(calls.map(call => call.headers.get("session-id")),
    ["shared-base", "shared-base-rebind-1", "shared-base-rebind-1"]);
  assert.deepEqual(calls[2].body, {
    ...cleanResponsesRequest(history).body,
    session_id: "body-session-rebind-1",
    prompt_cache_key: "cache-base-rebind-1"
  });
  assert.equal(calls[2].body.session_id, "body-session-rebind-1");
  assert.equal(events.filter(row => row.event === "session-binding-restored").length, 1);
});

test("a request without a session identity never shares an undefined rotation slot", async () => {
  const body = Object.fromEntries(Object.entries(history).filter(([key]) =>
    !["session_id", "prompt_cache_key"].includes(key)));
  const calls = [];
  const send = createFilteredFetch(async (url, init) => {
    calls.push(JSON.parse(new TextDecoder().decode(init.body)));
    return calls.length === 1 ? json({ error: binding }, 409) : sse(completed);
  }, { retryDelay: () => 0, keepaliveMs: 0 });
  const request = () => send("https://relay.example/v1/responses", {
    method: "POST", body: JSON.stringify(body)
  });
  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 200);
  assert.deepEqual(calls, [body, cleanResponsesRequest(body).body, body]);
});

test("binding recovery refuses unrecoverable server references instead of discarding them", async () => {
  const h = harness([() => json({ error: binding }, 409)]);
  const body = { ...history, previous_response_id: "server-history" };
  const response = await h.send(body);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "response_reference_not_portable");
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].body, body);
  assert.equal(h.events.some(row => row.event === "session-binding-rotated"), false);
});

test("other protocols and unfixable identities never receive Responses cleanup", async t => {
  for (const [name, url, requestHeaders] of [
    ["chat protocol", "https://relay.example/v1/chat/completions", headers],
    ["no session identity", "https://relay.example/v1/responses", {}]
  ]) await t.test(name, async () => {
    const requestBody = name === "no session identity"
      ? Object.fromEntries(Object.entries(history).filter(([key]) =>
        !["session_id", "prompt_cache_key"].includes(key))) : history;
    const calls = [];
    const response = await _internal.fetchWithFilter(url, {
      method: "POST", headers: requestHeaders,
      body: JSON.stringify(name === "chat protocol" ? { ...history, messages: [] } : requestBody)
    }, {
      fetchImpl: async (input, init) => {
        calls.push({ body: JSON.parse(new TextDecoder().decode(init.body)), headers: new Headers(init.headers) });
        return json({ error: binding }, 409);
      }, retryDelay: () => 0, keepaliveMs: 0
    });
    assert.equal(response.status, 409);
    assert.equal(calls.length, name === "no session identity" ? 2 : 1);
    assert.deepEqual(calls[0].headers.get("session-id"), requestHeaders["session-id"] ?? null);
    assert.deepEqual(calls[0].body, name === "chat protocol" ? { ...history, messages: [] } : requestBody);
    if (name === "no session identity") {
      assert.deepEqual(calls[1].body, cleanResponsesRequest(requestBody).body);
    }
  });
});

test("historyErrorCode remains a resource-repair classifier", () => {
  assert.equal(historyErrorCode({ error: binding }), null);
});
