import assert from "node:assert/strict";
import test from "node:test";
import { createProvider } from "../lib/provider.mjs";
import { readAccount, saveAccount } from "../lib/accounts.mjs";
import { buildCatalog, protocolOfURL } from "../lib/catalog.mjs";
import { createFilteredFetch } from "../lib/responses-filter.mjs";

const json = data => new Response(JSON.stringify({ success: true, data }), { headers: { "content-type": "application/json" } });
const key = { id: 7, status: 1, key: "model-secret", unlimited_quota: true };
const state = (extra = {}) => ({
  mode: "password", site: "air", siteURL: "https://ps.air-outer.com", key: "model-secret", keyId: "7", userId: "123",
  username: "alice", password: "site-secret", session: "session=original", accessToken: "", headers: "", checkinEnabled: true,
  ...extra
});
const stored = extra => saveAccount(state(extra));
const asAuth = ({ type, ...rest }) => ({ type: "oauth", ...rest });

test("login UI has five modes, masks secrets and makes advanced fields conditional", async () => {
  const hooks = await createProvider();
  const [password, github, linuxdo, token, api] = hooks.auth.methods;
  assert.ok(hooks.auth.icon.startsWith("data:image/png;base64,"));
  assert.deepEqual(hooks.auth.methods.map(method => method.type), ["api", "oauth", "oauth", "api", "api"]);
  assert.equal(password.keyless, true);
  assert.equal(token.keyless, true);
  assert.equal(api.authorize, undefined);
  assert.equal(password.prompts.find(prompt => prompt.key === "password").type, "password");
  assert.equal(token.prompts.find(prompt => prompt.key === "accessToken").type, "password");
  for (const method of [github, linuxdo, token, api]) assert.ok(!method.prompts.some(prompt => prompt.key === "checkinEnabled"));
  for (const method of [github, linuxdo, api]) assert.ok(!method.prompts.some(prompt => ["password", "username", "accessToken", "cookie", "userId"].includes(prompt.key)));
  for (const method of hooks.auth.methods) assert.equal(method.prompts.find(prompt => prompt.key === "headers").when.key, "advanced");
  for (const method of [password, github, linuxdo, token]) assert.ok(!method.prompts.some(prompt => ["email", "label", "alias"].includes(prompt.key)),
    "do not offer a display-alias field when the host SDK cannot set a native alias");
  const email = api.prompts.find(prompt => prompt.key === "email");
  assert.match(email.message, /邮箱/);
  assert.equal(email.validate("alice@example.test"), undefined);
  assert.equal(email.validate(""), undefined);
  assert.ok(email.validate("maodou38"), "an API-key name must not mistake a display remark for an email");
});

test("password login needs no separately entered API key and never stores an unapproved password", async t => {
  for (const enabled of ["no", "yes"]) await t.test(enabled, async () => {
    const calls = [];
    const hooks = await createProvider({}, {}, { fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/api/user/login")) return new Response(JSON.stringify({ success: true, data: { id: 123, username: "alice", checked_in: true } }), { headers: { "set-cookie": "session=signed-in; HttpOnly" } });
      return url.includes("/api/user/self") ? json({ id: 123, username: "alice", email: "alice@example.test", checked_in: false }) : json({ items: [key], total: 1 });
    } });
    const result = await hooks.auth.methods[0].authorize({ site: "air", username: "alice", password: "site-secret", checkinEnabled: enabled });
    assert.equal(result.type, "success");
    const account = readAccount(asAuth(result));
    assert.equal(account.key, "model-secret");
    assert.equal(account.checkinEnabled, enabled === "yes");
    assert.equal(account.password, enabled === "yes" ? "site-secret" : "");
    assert.equal(account.email, "alice@example.test");
    assert.equal(result.accountId, "alice@example.test");
    assert.equal(account.lastCheckin.outcome, "claimed", "a read-only profile must not replace the actual login's check-in result");
    assert.ok(calls.every(call => call.url.startsWith("https://ps.air-outer.com/")));
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ["/api/user/login", "/api/user/self", "/api/token/"]);
    assert.ok(!calls.some(call => call.url.includes("/api/user/token")));
  });
});

test("access-token login is a read-only account flow and cannot opt into check-in", async () => {
  const calls = [];
  const hooks = await createProvider({}, {}, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return url.includes("/api/user/self") ? json({ id: 123, username: "alice" }) : json({ items: [key], total: 1 });
  } });
  const result = await hooks.auth.methods[3].authorize({ site: "org", accessToken: "system-secret", userId: "123", checkinEnabled: "yes", password: "must-not-store" });
  assert.equal(result.type, "success");
  assert.equal(readAccount(asAuth(result)).checkinEnabled, false);
  assert.doesNotMatch(JSON.stringify(result), /must-not-store/);
  assert.ok(calls.every(call => call.init.method === "GET"));
  assert.equal(calls.length, 2);
});

test("LinuxDO defaults to normal website login and an explicit site-session handoff, not a consumed-code race", async () => {
  const calls = [];
  const hooks = await createProvider({}, {}, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return url.endsWith("/api/user/self") ? json({ id: 123, username: "alice" }) : json({ items: [key], total: 1 });
  } });
  const flow = await hooks.auth.methods[2].authorize({ site: "air" });
  assert.equal(flow.url, "https://ps.air-outer.com/login");
  assert.equal(calls.length, 0);
  const result = await flow.callback('{"cookie":"session=site-only","userId":"123"}');
  assert.equal(result.type, "success");
  const account = readAccount(asAuth(result));
  assert.equal(account.mode, "linuxdo");
  assert.equal(account.checkinEnabled, false);
  assert.equal(account.key, "model-secret");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !call.url.includes("/api/oauth/") && call.init.method === "GET"));
  assert.equal((await flow.callback('{"cookie":"session=site-only","userId":"123"}')).type, "failed");
});

test("all site login paths use the verified profile identity, not an old display-alias input", async t => {
  const ways = [[0, "password"], [3, "access-token"], [1, "github-code"], [2, "linuxdo-code"], [1, "github-session"], [2, "linuxdo-session"]];
  for (const [index, way] of ways) for (const email of ["real@example.test", ""]) await t.test(`${way}: ${email ? "email" : "username fallback"}`, async () => {
    const calls = [];
    const hooks = await createProvider({}, {}, { fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, init });
      if (pathname === "/api/status") return json({ github_oauth: true, github_client_id: "github-fixture", linuxdo_oauth: true, linuxdo_client_id: "linuxdo-fixture" });
      if (pathname === "/api/oauth/state") return json("one-use-state");
      if (pathname === "/api/user/login" || /^\/api\/oauth\/(github|linuxdo)$/.test(pathname)) {
        return new Response(JSON.stringify({ success: true, data: { id: 123, username: "from-login" } }), { headers: { "set-cookie": "session=verified; HttpOnly" } });
      }
      if (pathname === "/api/user/self") {
        assert.equal(init.headers.get("new-api-user"), "123");
        if (way === "access-token") assert.equal(init.headers.get("authorization"), "system-secret");
        else assert.equal(init.headers.get("cookie"), "session=verified");
        return json({ id: 123, username: "verified-site-name", email });
      }
      assert.equal(pathname, "/api/token/");
      return json({ items: [key], total: 1 });
    } });
    const inputs = { site: "org", email: "maodou38", username: "login@example.test", password: "site-secret", accessToken: "system-secret", userId: "123", handoff: way.endsWith("session") ? "session" : "code" };
    const method = hooks.auth.methods[index];
    const authorized = await method.authorize(inputs);
    const callback = way.endsWith("session") ? '{"cookie":"session=verified","userId":"123"}'
      : `https://agentrouter.org/oauth/${way.startsWith("github") ? "github/magpie" : "linuxdo"}?code=one-use-code&state=one-use-state`;
    const result = method.type === "oauth" ? await authorized.callback(callback) : authorized;
    assert.equal(result.type, "success", result.error);
    assert.equal(result.accountId, email || "verified-site-name");
    assert.equal(result.uid, "agentrouter:123");
    const account = readAccount(asAuth(result));
    assert.equal(account.email, email);
    assert.equal(account.label, "maodou38", "retain in-flight legacy remarks only as non-identity information");
    assert.equal(account.username, "verified-site-name");
    assert.equal(calls.filter(call => call.pathname === "/api/user/self").length, 1, "session and access-token paths already read the profile");
    assert.equal(calls.filter(call => call.pathname === "/api/token/").length, 1);
  });
});

test("profile verification fails closed before key lookup or persistence", async t => {
  for (const failure of ["wrong-user", "unavailable"]) await t.test(failure, async () => {
    const calls = [];
    const hooks = await createProvider({ client: { auth: { set() { assert.fail("a failed login cannot persist credentials"); } } } }, {}, { fetchImpl: async url => {
      calls.push(new URL(url).pathname);
      if (url.endsWith("/api/user/login")) return new Response(JSON.stringify({ success: true, data: { id: 123, username: "alice" } }), { headers: { "set-cookie": "session=verified" } });
      assert.ok(url.endsWith("/api/user/self"));
      return failure === "wrong-user" ? json({ id: 456, username: "bob", email: "other@example.test" }) : new Response("Unavailable", { status: 503 });
    } });
    const result = await hooks.auth.methods[0].authorize({ username: "alice", password: "site-secret" });
    assert.equal(result.type, "failed");
    assert.equal(result.access, undefined);
    assert.equal(result.refresh, undefined);
    assert.deepEqual(calls, ["/api/user/login", "/api/user/self"]);
    assert.doesNotMatch(result.error, /site-secret|session=verified|other@example/);
  });
});

test("API-key-only accounts never call the site for quota or check-in", async () => {
  const hooks = await createProvider({}, {}, { fetchImpl: () => { throw new Error("No site calls allowed"); } });
  const auth = { type: "api", key: "model-secret", metadata: { site: "org" } };
  const usage = await hooks.auth.usage(async () => auth, {});
  assert.deepEqual(usage.windows, []);
  assert.equal(usage.balance, undefined);
  assert.equal(usage.signIn, "kept");
  assert.equal((await hooks.auth.checkin(async () => auth, {})).outcome, "ineligible");
});

test("wallet usage exposes the site's used and remaining amounts without fake reset windows", async () => {
  const calls = [];
  const hooks = await createProvider({}, {}, { fetchImpl: async (url, init) => {
    calls.push({ url, init }); return json({ id: 123, username: "alice", quota: 1250000, used_quota: 3750000 });
  } });
  const usage = await hooks.auth.usage(async () => stored(), {});
  assert.equal(usage.balance, "$2.50");
  assert.equal(usage.windows[0].used, 75);
  assert.equal(usage.windows[0].amount, 7.5);
  assert.equal(usage.windows[0].limit, 10);
  assert.equal(usage.windows[0].unit, "USD");
  for (const name of ["balance", "span", "resetsAt", "resetSecs"]) assert.equal(usage.windows[0][name], undefined);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ["/api/user/self"]);
});

test("wallet balance remains the routing fallback when cumulative spend is unavailable", async () => {
  const hooks = await createProvider({}, {}, { fetchImpl: async () => json({ id: 123, username: "alice", quota: 1250000 }) });
  const usage = await hooks.auth.usage(async () => stored(), {});
  assert.equal(usage.balance, "$2.50");
  assert.equal(usage.windows[0].balance, 2.5);
  assert.equal(usage.windows[0].used, undefined);
  assert.equal(usage.windows[0].limit, undefined);
});

test("wallet reads leave account names, aliases and duplicate-name suffixes to the host", async t => {
  for (const mode of ["password", "github", "linuxdo", "access-token", "legacy-session"]) await t.test(mode, async () => {
    const accessToken = mode === "access-token" ? "system-token" : "";
    const auths = [
      stored({ mode, accessToken, label: "shared-label", username: "site-alice", session: accessToken ? "" : "session=alice" }),
      stored({ mode, accessToken, label: "shared-label", username: "site-bob", userId: "456", session: accessToken ? "" : "session=bob" })
    ];
    const before = JSON.stringify(auths);
    const calls = [];
    const hooks = await createProvider({}, {}, { fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const id = Number(new Headers(init.headers).get("new-api-user"));
      return json({ id, username: `upstream-name-${id}`, quota: id * 500000 });
    } });
    for (const auth of auths) {
      const usage = await hooks.auth.usage(async () => auth, {});
      assert.equal(Object.hasOwn(usage, "user"), false, "neither the site username nor the bare label may replace the host's canonical account name");
      assert.equal(usage.windows[0].balance, Number(readAccount(auth).userId));
      assert.equal(usage.signIn, "kept");
    }
    assert.equal(JSON.stringify(auths), before, "wallet refresh must not rewrite names, UIDs or credentials");
    assert.ok(calls.every(call => new URL(call.url).pathname === "/api/user/self" && call.init.method === "GET"));
    assert.equal(calls.length, 2);
  });
});

test("missing quota and WAF failures remain unknown, never password-login fallbacks", async t => {
  for (const response of [() => json({ id: 123, used_quota: 100 }), () => new Response("<html>captcha</html>")]) await t.test("unknown balance", async () => {
    const calls = [];
    const hooks = await createProvider({}, {}, { fetchImpl: async url => { calls.push(url); return response(); } });
    const usage = await hooks.auth.usage(async () => stored(), {});
    assert.equal(usage.balance, undefined);
    assert.deepEqual(usage.windows, []);
    assert.equal(usage.signIn, "kept");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith("/api/user/self"));
  });
});

test("daily login is deduplicated, scoped to the account and persisted without invalidating inference", async () => {
  let auth = stored(), calls = 0;
  let now = Date.parse("2026-10-28T08:00:00Z");
  const writes = [];
  const hooks = await createProvider({ client: { auth: { set: async value => { writes.push(value); auth = value.body; } } } }, {}, {
    now: () => now,
    fetchImpl: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 2)); return new Response(JSON.stringify({ success: true, data: { id: 123, checked_in: true } }), { headers: { "set-cookie": "session=fresh; HttpOnly" } }); }
  });
  const results = await Promise.all([hooks.auth.checkin(async () => auth, {}), hooks.auth.checkin(async () => auth, {})]);
  assert.deepEqual(results.map(result => result.outcome), ["claimed", "done"]);
  assert.equal(calls, 1);
  assert.equal(writes[0].path.id, "agentrouter");
  assert.equal(readAccount(auth).session, "session=fresh");
  assert.equal(auth.access, "model-secret");
  assert.equal(results[0].signIn, undefined);
  assert.equal((await hooks.auth.checkin(async () => auth, {})).outcome, "done");
  assert.equal(calls, 1);
  now = Date.parse("2026-10-28T16:00:00Z");
  assert.equal((await hooks.auth.checkin(async () => auth, {})).outcome, "claimed");
  assert.equal(calls, 2);
});

test("wrong-user check-in never replaces the selected account's credentials", async () => {
  let writes = 0;
  const hooks = await createProvider({ client: { auth: { set: () => { writes++; } } } }, {}, { fetchImpl: async () => json({ id: 999, checked_in: true }) });
  const result = await hooks.auth.checkin(async () => stored(), {});
  assert.equal(result.outcome, "failed");
  assert.equal(result.signIn, undefined);
  assert.equal(writes, 0);
});

test("model catalog honors account permissions, per-model protocols and explicit API overrides", () => {
  const explicit = { models: { friendly: { id: "server-model", name: "My model", provider: { npm: "@ai-sdk/openai-compatible", api: "https://custom.example/prefix" }, headers: { "x-selected": "custom" }, limit: { context: 1234 } } } };
  const provider = { models: { friendly: { api: { id: "server-model" }, headers: { "x-existing": "keep" } } } };
  const rows = [
    { id: "server-model", supported_endpoint_types: ["anthropic"] },
    { id: "messages-model", supported_endpoint_types: ["anthropic", "openai"] },
    { id: "google-model", supported_endpoint_types: ["gemini"] }
  ];
  const out = buildCatalog(rows, provider, state(), explicit, [{ model_name: "not-authorized", supported_endpoint_types: ["anthropic"] }]);
  assert.deepEqual(Object.keys(out), ["friendly", "messages-model", "google-model"]);
  assert.equal(out.friendly.api.id, "server-model");
  assert.equal(out.friendly.api.npm, "@ai-sdk/openai-compatible");
  assert.equal(out.friendly.api.url, "https://custom.example/prefix");
  assert.equal(out.friendly.limit.context, 1234);
  assert.equal(out["messages-model"].api.npm, "@ai-sdk/anthropic");
  assert.equal(out["messages-model"].api.url, "https://ps.air-outer.com/v1");
  assert.equal(out["google-model"].api.url, "https://ps.air-outer.com/v1beta");
  assert.equal(out["google-model"].limit.context, 0);
});

test("account custom headers override native defaults and the loader never forces every model to one base URL", async () => {
  let captured;
  const hooks = await createProvider({}, {}, { fetchImpl: async (url, init) => { captured = { url, init }; return json({ ok: true }); } });
  const loaded = await hooks.auth.loader(async () => stored({ headers: "X-Selected: account-default" }), {});
  assert.equal(loaded.baseURL, undefined);
  await loaded.fetch("https://custom.example/v1/messages", { method: "POST", body: '{"model":"unchanged"}', headers: { "x-selected": "current-model", "x-api-key": "old-key", cookie: "session=must-not-leak" } });
  assert.equal(captured.url, "https://custom.example/v1/messages");
  assert.equal(captured.init.headers.get("x-selected"), "account-default");
  assert.equal(captured.init.headers.get("x-api-key"), "model-secret");
  assert.equal(captured.init.headers.get("cookie"), null);
  assert.equal(captured.init.body, '{"model":"unchanged"}');
});

test("a first-seat URL is remapped to the selected account, but explicit model endpoints win", async () => {
  const calls = [];
  const hooks = await createProvider({}, {}, { fetchImpl: async (url, init) => { calls.push({ url, init }); return json({ ok: true }); } });
  const cfg = { provider: { agentrouter: { models: {
    fixed: { id: "fixed-api-id", provider: { api: "https://ps.air-outer.com/explicit/v1", npm: "@ai-sdk/anthropic" } }
  } } } };
  await hooks.config(cfg);
  const loaded = await hooks.auth.loader(async () => stored({ site: "org", siteURL: "https://agentrouter.org" }), {
    models: { default: { api: { id: "wire-id", url: "https://ps.air-outer.com/v1" } }, fixed: { api: { id: "fixed-api-id", url: "https://ps.air-outer.com/explicit/v1" } } }
  });
  await loaded.fetch("https://ps.air-outer.com/v1/responses", { method: "POST", body: '{"model":"wire-id","input":"unchanged"}' });
  await loaded.fetch("https://ps.air-outer.com/v1beta/models/google-id:generateContent?alt=sse", { method: "POST", body: '{"contents":[]}' });
  const headers = {};
  await hooks["chat.headers"]({ model: { id: "fixed", providerID: "agentrouter" } }, { headers });
  await loaded.fetch("https://agentrouter.org/v1/messages", { method: "POST", body: '{"model":"fixed-api-id"}', headers });
  assert.equal(calls[0].url, "https://agentrouter.org/v1/responses");
  assert.equal(calls[0].init.body, '{"model":"wire-id","input":"unchanged"}');
  assert.equal(calls[1].url, "https://agentrouter.org/v1beta/models/google-id:generateContent?alt=sse");
  assert.equal(calls[2].url, "https://ps.air-outer.com/explicit/v1/messages");
  assert.ok(calls.every(call => !call.init.headers.has("x-agentrouter-account-model")));
});

test("changing an account during retry cannot send old request data using the replacement identity", async () => {
  let auth = stored(), calls = 0;
  const hooks = await createProvider({}, {}, { fetchImpl: async () => {
    calls++;
    auth = stored({ userId: "456", username: "bob", key: "other-key" });
    return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_encrypted_content" } }), { status: 400 });
  } });
  const loaded = await hooks.auth.loader(async () => auth, {});
  const send = createFilteredFetch(loaded.fetch, { retryDelay: () => 0 });
  const response = await send("https://ps.air-outer.com/v1/responses", { method: "POST", body: JSON.stringify({ model: "chosen", input: "account-bound prompt" }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "account_changed");
  assert.equal(calls, 1);
});

test("provider config is not overwritten and discovery failure preserves explicit models without default names", async () => {
  const original = { name: "Existing AgentRouter", npm: "@ai-sdk/openai-compatible", api: "https://custom.example/v1", models: { custom: { id: "remote-id" } } };
  const cfg = { provider: { agentrouter: original, other: { name: "Unchanged" } } };
  const hooks = await createProvider({}, {}, { fetchImpl: async () => { throw new Error("offline"); } });
  await hooks.config(cfg);
  assert.equal(cfg.provider.agentrouter, original);
  assert.deepEqual(Object.keys(cfg.provider), ["agentrouter", "other"]);
  const cached = { custom: { name: "Custom" }, retired: { name: "Stale models.dev entry" } };
  const fallback = await hooks.provider.models({ models: cached }, { auth: stored() });
  assert.deepEqual(Object.keys(fallback), ["custom"]);
  assert.equal(fallback[Symbol.for("magpie.fellBack")], true);
});

test("successful model discovery does not erase manually configured models or grant public-only models", () => {
  const explicit = { models: { manual: { id: "manual-api-id", provider: { npm: "@ai-sdk/anthropic", api: "https://custom.example/v1" } } } };
  const out = buildCatalog([{ id: "discovered" }], { models: { manual: { name: "Manual" } } }, state(), explicit, [{ model_name: "public-only" }]);
  assert.deepEqual(Object.keys(out), ["discovered", "manual"]);
  assert.equal(out.manual.api.id, "manual-api-id");
  assert.equal(out.manual.api.url, "https://custom.example/v1");
});

test("all four inference protocol URLs are recognized, not account or mutation endpoints", () => {
  assert.equal(protocolOfURL("https://site/v1/responses"), "responses");
  assert.equal(protocolOfURL("https://site/v1/chat/completions"), "chat");
  assert.equal(protocolOfURL("https://site/v1/messages"), "anthropic");
  assert.equal(protocolOfURL("https://site/v1beta/models/name:streamGenerateContent?alt=sse"), "gemini");
  for (const path of ["/api/user/login", "/v1/files", "/v1/responses/compact"]) assert.equal(protocolOfURL("https://site" + path), null);
});
