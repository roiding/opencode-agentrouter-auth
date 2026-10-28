import assert from "node:assert/strict";
import test from "node:test";
import { createSiteClient, mergeCookies, parseSessionHandoff, quotaNumber } from "../lib/site-client.mjs";
import { customHeaders, inferenceHeaders } from "../lib/headers.mjs";

const json = (data, headers = {}) => new Response(JSON.stringify({ success: true, data }), { headers: { "content-type": "application/json", ...headers } });
const account = extra => ({
  mode: "password", site: "air", siteURL: "https://ps.air-outer.com", userId: "", username: "alice",
  password: "private-password", key: "private-model-key", session: "", accessToken: "", headers: "", ...extra
});
const config = { github_oauth: true, github_client_id: "github-app", linuxdo_oauth: true, linuxdo_client_id: "linuxdo-app", server_address: "https://agentrouter.org" };
const key = { id: 7, status: 1, key: "existing-model-key", expired_time: -1, unlimited_quota: true };

function harness(steps, options = {}) {
  const calls = [];
  const client = createSiteClient({ ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    const next = steps.shift();
    assert.ok(next, "Unexpected additional site request: " + new URL(url).pathname);
    return typeof next === "function" ? next(url, init) : next;
  } });
  return { client, calls };
}

test("password login uses the selected site, no model authorization and no hidden retry", async () => {
  const h = harness([json({ id: 123, username: "alice", checked_in: true }, { "set-cookie": "session=site-session; HttpOnly; Path=/" })]);
  const result = await h.client.login(account());
  assert.equal(result.account.userId, "123");
  assert.equal(result.account.session, "session=site-session");
  const { url, init } = h.calls[0];
  assert.equal(url, "https://ps.air-outer.com/api/user/login");
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.has("authorization"), false);
  assert.deepEqual(JSON.parse(init.body), { username: "alice", password: "private-password" });
  assert.equal(h.client.dailyResult(result.user).lastCheckin.outcome, "claimed");
});

test("account reads are read-only and reject another user's data", async () => {
  const h = harness([json({ id: 123, quota: 0, used_quota: 500000 }), json({ id: 124, quota: 5 })]);
  const state = account({ userId: "123", accessToken: "system-token" });
  assert.equal((await h.client.self(state)).quota, 0);
  await assert.rejects(h.client.self(state), /不一致/);
  assert.ok(h.calls.every(call => call.url.endsWith("/api/user/self") && call.init.method === "GET"));
  assert.equal(h.calls[0].init.headers.get("authorization"), "system-token");
  assert.equal(h.calls[0].init.headers.get("new-api-user"), "123");
  assert.doesNotMatch(JSON.stringify(h.calls.map(call => call.init.body)), /private-password/);
});

test("wrong-user login is not a session update", async () => {
  const h = harness([json({ id: 124, username: "bob" }, { "set-cookie": "session=wrong-user" })]);
  const state = account({ userId: "123", session: "session=original" });
  await assert.rejects(h.client.login(state), /不一致/);
  assert.equal(state.session, "session=original");
});

test("site errors are classified without exposing supplied credentials", async t => {
  const cases = [
    ["captcha", () => new Response('<html><meta name="aliyun_waf_aa">captcha</html>')],
    ["credentials", () => new Response(JSON.stringify({ success: false, message: "wrong password private-password" }))],
    ["unavailable", () => new Response("<html>Bad gateway</html>", { status: 502 })],
    ["rate-limit", () => new Response(JSON.stringify({ success: false }), { status: 429 })]
  ];
  for (const [kind, response] of cases) await t.test(kind, async () => {
    const h = harness([response()]);
    await assert.rejects(h.client.login(account()), error => {
      assert.equal(error.kind, kind);
      assert.doesNotMatch(error.message, /private-password|private-model-key/);
      return true;
    });
    assert.equal(h.calls.length, 1);
  });
});

test("API key selection reads existing active keys without creating or rotating credentials", async () => {
  const h = harness([json({ items: [key], total: 1 }), json(key)]);
  const state = account({ userId: "123", session: "session=site-session" });
  assert.deepEqual(await h.client.selectKey(state), { key: key.key, keyId: "7" });
  assert.deepEqual(await h.client.selectKey(state, "7"), { key: key.key, keyId: "7" });
  assert.ok(h.calls.every(call => call.init.method === "GET"));
  assert.ok(h.calls.every(call => !call.url.includes("/api/user/token")));
  assert.equal(h.calls[1].url, "https://ps.air-outer.com/api/token/7");
});

test("ambiguous, truncated, expired, exhausted and masked keys cannot silently win selection", async t => {
  for (const [name, data] of [
    ["ambiguous", { items: [key, { ...key, id: 8 }], total: 2 }],
    ["truncated", { items: [key], total: 20 }],
    ["expired", { items: [{ ...key, expired_time: 1 }] }],
    ["exhausted", { items: [{ ...key, unlimited_quota: false, remain_quota: 0 }] }],
    ["masked", { items: [{ ...key, key: "sk-****" }] }]
  ]) await t.test(name, async () => {
    const h = harness([json(data)]);
    await assert.rejects(h.client.selectKey(account({ userId: "123", session: "session=x" })), { kind: "selection" });
    assert.equal(h.calls.length, 1);
  });
});

test("OAuth keeps the registered callback origin but exchanges on the selected endpoint with flow cookies", async t => {
  for (const provider of ["github", "linuxdo"]) await t.test(provider, async () => {
    const h = harness([
      json(config), json("site-issued-state", { "set-cookie": "session=anonymous; Path=/; HttpOnly" }),
      json({ id: 123, username: "alice", checked_in: true }, { "set-cookie": "session=signed-in; Path=/; HttpOnly" })
    ]);
    const flow = await h.client.beginOAuth(provider, account());
    const authorize = new URL(flow.url);
    assert.equal(authorize.hostname, provider === "github" ? "github.com" : "connect.linux.do");
    assert.equal(authorize.searchParams.get("state"), "site-issued-state");
    assert.ok(!authorize.searchParams.has("redirect_uri") || new URL(authorize.searchParams.get("redirect_uri")).origin === "https://agentrouter.org");
    const callback = `https://agentrouter.org${flow.path}?code=one-use-code&state=site-issued-state`;
    const result = await h.client.completeOAuth(flow, callback);
    assert.equal(result.account.session, "session=signed-in");
    assert.equal(result.account.userId, "123");
    assert.equal(result.account.password, "");
    assert.equal(result.account.accessToken, "");
    assert.equal(result.account.checkinEnabled, false);
    assert.ok(h.calls.every(call => call.url.startsWith("https://ps.air-outer.com/")));
    assert.equal(h.calls[2].init.headers.get("cookie"), "session=anonymous");
    assert.equal(h.calls[2].init.headers.has("authorization"), false);
    await assert.rejects(h.client.completeOAuth(flow, callback), /已被使用或已过期/);
    assert.equal(h.calls.length, 3);
  });
});

test("invalid OAuth state, origin, duplicate parameters and callback paths are rejected before exchange", async () => {
  const h = harness([json(config), json("state-a")]);
  const flow = await h.client.beginOAuth("github", account());
  for (const url of [
    "one-use-code",
    `https://evil.example${flow.path}?code=c&state=state-a`,
    `https://agentrouter.org${flow.path}?code=c&state=state-b`,
    `https://agentrouter.org${flow.path}?code=c&state=state-a&state=state-a`,
    "https://agentrouter.org/oauth/linuxdo?code=c&state=state-a",
    `https://user:password@agentrouter.org${flow.path}?code=c&state=state-a`
  ]) await assert.rejects(h.client.completeOAuth(flow, url));
  assert.equal(h.calls.length, 2);
  assert.equal(flow.used, false);
});

test("separate concurrent OAuth flows cannot mix state, cookies or identities", async () => {
  let state = 0;
  const client = createSiteClient({ fetchImpl: async (url, init) => {
    if (url.endsWith("/api/status")) return json(config);
    if (url.includes("/api/oauth/state")) { const id = ++state; return json(`state-${id}`, { "set-cookie": `session=anonymous-${id}; Path=/` }); }
    const expected = new URL(url).searchParams.get("state").split("-")[1];
    assert.equal(init.headers.get("cookie"), `session=anonymous-${expected}`);
    return json({ id: expected, username: `user-${expected}` }, { "set-cookie": `session=account-${expected}; Path=/` });
  } });
  const flows = await Promise.all([client.beginOAuth("github", account()), client.beginOAuth("linuxdo", account())]);
  const results = await Promise.all(flows.map(flow => client.completeOAuth(flow, `https://ps.air-outer.com${flow.path}?code=c&state=${flow.state}`)));
  assert.equal(results[0].account.session, "session=account-1");
  assert.equal(results[1].account.session, "session=account-2");
});

test("OAuth expiration does not dispatch an exchange and retry failures consume a flow", async () => {
  let now = 0;
  const h = harness([json(config), json("state"), json(config), json("state-2"), new Response("Bad gateway", { status: 502 })], { now: () => now });
  const first = await h.client.beginOAuth("github", account());
  now = 9 * 60000;
  await assert.rejects(h.client.completeOAuth(first, `https://agentrouter.org${first.path}?code=c&state=state`), /已被使用或已过期/);
  const second = await h.client.beginOAuth("github", account());
  await assert.rejects(h.client.completeOAuth(second, `https://agentrouter.org${second.path}?code=c&state=state-2`));
  assert.equal(second.used, true);
});

test("cookie merging handles Expires commas, rotation and deletion", () => {
  const headers = new Headers();
  headers.append("set-cookie", "session=new; Expires=Wed, 28 Oct 2026 20:00:00 GMT; HttpOnly");
  headers.append("set-cookie", "waf=pass; Path=/");
  headers.append("set-cookie", "old=gone; Max-Age=0");
  assert.equal(mergeCookies("session=old; old=old", headers), "session=new; waf=pass");
});

test("missing or malformed quota values are not zero", () => {
  for (const value of [null, undefined, "", " ", false, true, "not-a-number", Infinity, {}]) assert.equal(quotaNumber(value), null);
  assert.equal(quotaNumber("0"), 0);
  assert.equal(quotaNumber(0), 0);
  assert.equal(quotaNumber("123.5"), 123.5);
});

test("custom headers honor incoming native overrides but cannot leak account credentials", () => {
  for (const header of ["Authorization: token", "Cookie: session=x", "New-Api-User: 123", "X-Api-Key: key"]) assert.throws(() => customHeaders(header), /由所选账号或传输层管理/);
  const state = account({ headers: "X-Account: alice\nX-Selected-Model: default\nUser-Agent: custom-client" });
  for (const [protocol, expected] of [["responses", "authorization"], ["chat", "authorization"], ["anthropic", "x-api-key"], ["gemini", "x-goog-api-key"]]) {
    const headers = inferenceHeaders(state, { "x-selected-model": "native-model", cookie: "session=never-forward", authorization: "gateway-key", "new-api-user": "123" }, protocol);
    assert.equal(headers.get("x-selected-model"), "native-model");
    assert.equal(headers.get("x-account"), "alice");
    assert.equal(headers.get("user-agent"), "custom-client");
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("new-api-user"), null);
    assert.equal(headers.get(expected), expected === "authorization" ? "Bearer private-model-key" : "private-model-key");
    assert.equal(["authorization", "x-api-key", "x-goog-api-key"].filter(name => headers.has(name)).length, 1);
  }
});

test("completed-site handoff imports only AgentRouter credentials and keeps browser headers site-only", async () => {
  const pasted = "curl 'https://agentrouter.org/api/user/self' -H 'New-Api-User: 123' -b 'session=site-secret; waf=valid' -H 'User-Agent: browser-client' -H 'Authorization: must-not-import' --compressed";
  const handoff = parseSessionHandoff(pasted);
  assert.equal(handoff.userId, "123");
  assert.equal(handoff.session, "session=site-secret; waf=valid");
  assert.deepEqual(handoff.siteHeaders, { "user-agent": "browser-client" });
  const h = harness([json({ id: 123, username: "alice" })]);
  const result = await h.client.importSession(account({ mode: "linuxdo" }), pasted);
  assert.equal(result.account.mode, "linuxdo");
  assert.equal(result.account.checkinEnabled, false);
  assert.equal(result.account.password, "");
  assert.equal(result.account.accessToken, "");
  assert.equal(h.calls[0].url, "https://ps.air-outer.com/api/user/self");
  assert.equal(h.calls[0].init.headers.get("user-agent"), "browser-client");
  assert.equal(h.calls[0].init.headers.get("authorization"), null);
  assert.notEqual(inferenceHeaders(result.account, {}, "responses").get("user-agent"), "browser-client");
});

test("session handoffs reject third-party requests, missing credentials and wrong-user site responses", async () => {
  for (const text of [
    "curl 'https://github.com/api/user/self' -H 'cookie: session=github' -H 'new-api-user: 123'",
    "curl 'https://connect.linux.do/api/user/self' -H 'cookie: session=linuxdo' -H 'new-api-user: 123'",
    "curl 'https://agentrouter.org/api/token/' -H 'cookie: session=site' -H 'new-api-user: 123'",
    '{"cookie":"session=site"}', '{"cookie":"session=site\\r\\nX-Secret: x","userId":"123"}', "{}"
  ]) assert.throws(() => parseSessionHandoff(text));
  const h = harness([json({ id: 456, username: "other" })]);
  await assert.rejects(h.client.importSession(account(), '{"cookie":"session=site","userId":"123"}'), /不一致/);
});
