import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SITES, saveAccount } from "../lib/accounts.mjs";

const binary = process.env.MAGPIE_TEST_BINARY;
const bun = process.env.MAGPIE_TEST_BUN;
const root = fileURLToPath(new URL("../", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checkSseIdle = process.env.MAGPIE_TEST_SSE_IDLE === "1";
const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

test("installed Magpie gateway: native names, aliases and account failover without a plugin-owned pool", {
  skip: !binary || !bun || process.platform === "win32" ? "Requires explicit installed Magpie/Bun paths and the POSIX-only local test launcher (not a plugin runtime dependency)." : false,
  timeout: checkSseIdle ? 380000 : 45000
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentrouter-gateway-test-"));
  const config = path.join(directory, ".config", "magpie");
  await mkdir(config, { recursive: true });
  const cache = path.join(directory, ".cache", "magpie");
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, "models.json"), await readFile(new URL("./fixtures/models.json", import.meta.url)));
  let child, output = "";
  let finishStream, upstreamFrames = 0, resourceFailed = false, sessionFailed = false;
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const send = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/v1/models") return send({ data: [{ id: "native-route-test", supported_endpoint_types: ["responses"],
      limit: { context: 10000, input: 9000, output: 1000 }, reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "high", "xhigh"] }] }] });
    if (req.url === "/api/user/self") {
      const id = req.headers["new-api-user"];
      if (!["123", "456"].includes(id) || req.headers.cookie !== `session=s${id}`) return send({ success: false }, 401);
      const username = id === "123" ? "alice" : "bob";
      return send({ success: true, data: { id: Number(id), username, email: `${username}@example.test`, quota: 50000000 } });
    }
    if (req.url !== "/v1/responses") return send({ error: { message: "Unexpected fixture path" } }, 404);
    calls.push({ headers: req.headers, body });
    if (req.headers.authorization === "Bearer revoked-after-discovery") return send({ error: { type: "authentication_error", code: "invalid_api_key", message: "Key rejected" } }, 401);
    if (!resourceFailed && JSON.parse(body).input?.some?.(item => item.encrypted_content === "fixture-private-history")) {
      resourceFailed = true;
      return send({ error: {
        type: "invalid_request_error",
        message: "OpenAI Responses bad request: The requested item was created under a different *** OpenAI resource. Use the same resource that created the item to access it. [trace_id=00000000000000000000000000000001]"
      } }, 400);
    }
    if (!sessionFailed && req.headers["x-session-id"] === "fixture-session-base" &&
        JSON.parse(body).input?.some?.(item => item.encrypted_content === "fixture-private-session")) {
      sessionFailed = true;
      return send({ error: {
        type: "invalid_request_error",
        code: "session_binding_invalidated",
        message: "session binding invalidated: the model this session is bound to can no longer serve it; restart the task with a new session id [trace_id=00000000000000000000000000000002 code=30013]"
      } }, 409);
    }
    if (checkSseIdle && JSON.stringify(JSON.parse(body).input).includes("local slow fixture only")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const progress = { type: "response.in_progress", response: { id: "resp_slow_original", status: "in_progress", output: [] } };
      res.write(frame({ ...progress, type: "response.created" }));
      const timer = setInterval(() => { upstreamFrames++; res.write(frame(progress)); }, 1000);
      res.on("close", () => clearInterval(timer));
      finishStream = () => {
        clearInterval(timer);
        res.end(frame({ type: "response.completed", response: { id: "resp_slow_original", status: "completed", output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
      };
      return;
    }
    return send({ id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: "native-route-test",
      output: [{ id: "msg_fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "native-failover-ok", annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  });
  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    }
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const launcher = path.join(directory, "test-bun");
  const hostLog = path.join(directory, "host-stderr.log");
  const quote = text => "'" + text.replaceAll("'", "'\"'\"'") + "'";
  await writeFile(launcher, `#!/bin/sh\nexport MAGPIE_TEST_ORIGIN=${quote(`http://127.0.0.1:${server.address().port}`)}\nif [ "$1" = run ]; then\n  shift\n  exec ${quote(bun)} run --preload ${quote(fileURLToPath(new URL("./fixtures/host-preload.mjs", import.meta.url)))} "$@" 2>>${quote(hostLog)}\nfi\nexec ${quote(bun)} "$@" 2>>${quote(hostLog)}\n`, { mode: 0o700 });
  await writeFile(path.join(config, "plugins.json"), JSON.stringify({ plugins: [] }));
  const fixtureAccount = (userId, username, key, site) => saveAccount({
    mode: "github", userId, username, key, site, siteURL: SITES[site], email: `${username}@example.test`,
    label: "shared-label", session: `session=s${userId}`, checkinEnabled: false
  });
  await writeFile(path.join(config, "plugin-auth.json"), JSON.stringify({
    agentrouter: fixtureAccount("123", "alice", "revoked-after-discovery", "air"),
    "agentrouter#b00001": fixtureAccount("456", "bob", "working-account", "org")
  }), { mode: 0o600 });
  const env = {
    PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: path.join(directory, ".config"),
    MAGPIE_BUN: launcher, MAGPIE_PLUGIN_MARKET: "off", MAGPIE_ADDR: `127.0.0.1:${port}`,
    MAGPIE_API_KEY: "isolated-test-gateway", MAGPIE_GATEWAY_KEY: "isolated-test-gateway",
    MAGPIE_TEST_ORIGIN: `http://127.0.0.1:${server.address().port}`
  };
  // The real gateway consumes the host's persisted provider/model snapshot.
  // Refresh it just as a normal plugin login/list operation does.
  const cli = args => new Promise((resolve, reject) => {
    const list = spawn(binary, args, { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    list.stdout.on("data", chunk => { text += chunk; });
    list.stderr.on("data", chunk => { text += chunk; });
    const timer = setTimeout(() => list.kill("SIGTERM"), 15000);
    list.on("error", error => { clearTimeout(timer); reject(error); });
    list.on("close", async code => {
      clearTimeout(timer);
      if (code === 0) resolve(text);
      else reject(new Error(text + "\nHost: " + await readFile(hostLog, "utf8").catch(() => "")));
    });
  });
  await cli(["plugin", "add", root.replace(/\/+$/, "")]);
  const discovered = await cli(["plugin", "--json"]);
  assert.match(discovered, /native-route-test/);
  assert.doesNotMatch(discovered, /registry-only/);
  const authBeforeRename = await readFile(path.join(config, "plugin-auth.json"), "utf8");
  const accountNames = async () => JSON.parse(await cli(["accounts", "agentrouter", "--json"]))
    .map(account => account.user).sort();
  const canonicalNames = ["alice@example.test", "bob@example.test"];
  assert.deepEqual(await accountNames(), canonicalNames);
  await cli(["accounts", "alias", "agentrouter", "alice@example.test", "maodou38"]);
  await cli(["accounts", "alias", "agentrouter", "bob@example.test", "maodou38"]);
  assert.deepEqual(await accountNames(), canonicalNames, "equal display aliases must not turn into duplicate underlying account names or slot suffixes");
  await cli(["accounts", "alias", "agentrouter", "alice@example.test", "roiding"]);
  assert.deepEqual(await accountNames(), canonicalNames);
  const renamedProviders = JSON.parse(await readFile(path.join(config, "providers.json"), "utf8"));
  assert.deepEqual(renamedProviders.providers.find(provider => provider.id === "agentrouter").accountNames, {
    "alice@example.test": "roiding", "bob@example.test": "maodou38"
  });
  const namedQuotas = JSON.parse(await cli(["quota", "--json"]));
  assert.deepEqual(namedQuotas.filter(quota => quota.provider === "agentrouter")
    .map(quota => ({ user: quota.user, alias: quota.alias })).sort((a, b) => a.user.localeCompare(b.user)), [
    { user: "alice@example.test", alias: "roiding" }, { user: "bob@example.test", alias: "maodou38" }
  ]);
  assert.equal(await readFile(path.join(config, "plugin-auth.json"), "utf8"), authBeforeRename,
    "native renaming changes display aliases, not real email identities, UIDs or account slots");
  child = spawn(binary, ["serve"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false, lastModels;
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Isolated gateway exited: ${output}`);
    try {
      const response = await fetch(base + "/v1/models", { headers: { authorization: "Bearer isolated-test-gateway" }, signal: AbortSignal.timeout(1500) });
      if (response.status === 401 || response.status === 403) throw new Error("Gateway authorization failed in the isolated test.");
      const models = await response.json();
      lastModels = models;
      if (models.data?.some(model => model.id === "agentrouter/native-route-test")) { ready = true; break; }
    } catch {}
    await pause(150);
  }
  assert.equal(ready, true, output + "\nLast model list: " + JSON.stringify(lastModels));
  const response = await fetch(base + "/v1/responses", {
    method: "POST", headers: { authorization: "Bearer isolated-test-gateway", "content-type": "application/json" },
    body: JSON.stringify({ model: "agentrouter/native-route-test", input: "local fixture only", stream: false, reasoning: { effort: "xhigh" } }), signal: AbortSignal.timeout(12000)
  });
  const result = await response.text();
  assert.equal(response.status, 200, result + "\n" + output);
  assert.match(result, /native-failover-ok/);
  assert.deepEqual(calls.map(call => call.headers.authorization), ["Bearer revoked-after-discovery", "Bearer working-account"]);
  assert.ok(calls.every(call => JSON.parse(call.body).model === "native-route-test"));
  assert.ok(calls.every(call => JSON.parse(call.body).reasoning?.effort === "xhigh"));
  assert.deepEqual(calls.map(call => call.headers["x-test-upstream-origin"]), ["https://ps.air-outer.com", "https://agentrouter.org"]);
  assert.ok(calls.every(call => !call.headers.cookie && !call.headers["new-api-user"]));
  const resourceHistory = {
    model: "agentrouter/native-route-test", stream: false, store: true,
    include: ["reasoning.encrypted_content"], reasoning: { effort: "high" },
    input: [
      { type: "reasoning", id: "old-reasoning", encrypted_content: "fixture-private-history" },
      { type: "message", id: "old-message", role: "user", content: "local resource fixture only" },
      { type: "function_call", id: "old-call", call_id: "fixture-pair", name: "lookup", arguments: "{}" },
      { type: "function_call_output", id: "old-result", call_id: "fixture-pair", output: "keep-result" }
    ]
  };
  const beforeResource = calls.length;
  const resourceResponse = await fetch(base + "/v1/responses", {
    method: "POST", headers: { authorization: "Bearer isolated-test-gateway", "content-type": "application/json" },
    body: JSON.stringify(resourceHistory), signal: AbortSignal.timeout(12000)
  });
  const resourceResult = await resourceResponse.text();
  assert.equal(resourceResponse.status, 200, resourceResult + "\n" + output);
  assert.match(resourceResult, /native-failover-ok/);
  const resourceCalls = calls.slice(beforeResource);
  assert.equal(resourceFailed, true);
  assert.equal(resourceCalls.length, 2, "redacted resource failures retry inside the selected account");
  assert.ok(resourceCalls.every(call => call.headers.authorization === "Bearer working-account"));
  const preserved = JSON.parse(resourceCalls[0].body), cleaned = JSON.parse(resourceCalls[1].body);
  assert.deepEqual(preserved.input, resourceHistory.input);
  assert.equal(cleaned.model, "native-route-test");
  assert.equal(cleaned.store, false);
  assert.deepEqual(cleaned.include, []);
  assert.deepEqual(cleaned.input, [
    { type: "message", role: "user", content: "local resource fixture only" },
    { type: "function_call", call_id: "fixture-pair", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "fixture-pair", output: "keep-result" }
  ]);
  const sessionHistory = {
    model: "agentrouter/native-route-test", stream: false, store: true,
    include: ["reasoning.encrypted_content"], reasoning: { effort: "high" },
    input: [
      { type: "reasoning", id: "session-reasoning", encrypted_content: "fixture-private-session" },
      { type: "message", id: "session-message", role: "user", content: "local session fixture only" }
    ]
  };
  const beforeSession = calls.length;
  const sessionResponse = await fetch(base + "/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer isolated-test-gateway", "content-type": "application/json",
      "x-session-id": "fixture-session-base"
    },
    body: JSON.stringify(sessionHistory), signal: AbortSignal.timeout(12000)
  });
  const sessionResult = await sessionResponse.text();
  assert.equal(sessionResponse.status, 200, sessionResult + "\n" + output);
  assert.match(sessionResult, /native-failover-ok/);
  const sessionCalls = calls.slice(beforeSession);
  assert.equal(sessionFailed, true);
  assert.equal(sessionCalls.length, 2, "invalidated bindings retry once inside the selected account");
  assert.ok(sessionCalls.every(call => call.headers.authorization === "Bearer working-account"));
  assert.deepEqual(JSON.parse(sessionCalls[0].body).input, sessionHistory.input);
  assert.equal(sessionCalls[0].headers["x-session-id"], "fixture-session-base");
  const rebound = JSON.parse(sessionCalls[1].body);
  assert.equal(sessionCalls[1].headers["x-session-id"], "fixture-session-base-rebind-1");
  assert.equal(rebound.store, false);
  assert.deepEqual(rebound.include, []);
  assert.deepEqual(rebound.input, [{ type: "message", role: "user", content: "local session fixture only" }]);
  if (checkSseIdle) {
    // The native gateway holds lead events for up to four minutes. Comments
    // do not reset Codex's five-minute EVENT idle clock: test the real path,
    // not just the plugin's byte activity or receipt of HTTP headers.
    const started = Date.now();
    const stream = await fetch(base + "/v1/responses", {
      method: "POST", headers: { authorization: "Bearer isolated-test-gateway", "content-type": "application/json" },
      body: JSON.stringify({ model: "agentrouter/native-route-test", input: "local slow fixture only", stream: true }),
      signal: AbortSignal.timeout(330000)
    });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", text = "", firstDataMs, lastEvent = started;
    try {
      while (true) {
        let timer;
        const part = await Promise.race([reader.read(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("idle timeout waiting for SSE data (comments do not count)")), Math.max(1, 300000 - (Date.now() - lastEvent)));
        })]).finally(() => clearTimeout(timer));
        if (part.done) break;
        const chunk = decoder.decode(part.value, { stream: true });
        text += chunk;
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!/^data:\s*\S/m.test(event)) continue;
          lastEvent = Date.now();
          if (firstDataMs === undefined) {
            firstDataMs = lastEvent - started;
            assert.match(event, /response.in_progress/);
            assert.ok(firstDataMs < 285000, "native gateway must expose a parsed event before Codex's idle deadline");
            assert.ok(upstreamFrames > 0);
            finishStream();
          }
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
    assert.match(text, /response.completed/);
    assert.match(text, /resp_slow_original/);
    t.diagnostic(`Real gateway SSE: first data event ${firstDataMs}ms, ${upstreamFrames} upstream progress frames; completed without an event-idle timeout.`);
  }
});
