import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hostPath = process.env.MAGPIE_TEST_HOST;
const bun = process.env.MAGPIE_TEST_BUN;
const root = fileURLToPath(new URL("../", import.meta.url));
const frame = (data, event = "") => (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`;

test("installed Magpie host: keyless login, isolated accounts, real wallet metadata and protected fetch", {
  skip: !hostPath || !bun ? "Set MAGPIE_TEST_HOST and MAGPIE_TEST_BUN to explicitly run the installed host against a loopback fixture." : false,
  timeout: 30000
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentrouter-host-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = path.join(directory, "plugin-auth.json");
  const modelsDevPath = path.join(directory, "models.json");
  await writeFile(modelsDevPath, await readFile(new URL("./fixtures/models.json", import.meta.url)));
  const requests = [], attempts = new Map();
  const users = { alice: "123", bob: "456" };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    requests.push({ path: req.url, headers: req.headers, body: text });
    const send = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const session = /session=s(\d+)/.exec(req.headers.cookie || "")?.[1];
    if (req.url === "/api/user/login") {
      const body = JSON.parse(text);
      const id = users[body.username];
      if (!id || body.password !== "test-password") return send({ success: false, message: "wrong password" });
      res.setHeader("set-cookie", `session=s${id}; Path=/; HttpOnly`);
      return send({ success: true, data: { id: Number(id), username: body.username, checked_in: true } });
    }
    if (req.url === "/api/user/self") {
      if (!session || req.headers["new-api-user"] !== session) return send({ success: false }, 401);
      const name = session === "123" ? "alice" : "bob";
      return send({ success: true, data: {
        id: Number(session), username: name, email: `${name}@example.test`,
        quota: Number(session) * 500000, used_quota: Number(session) * 1500000
      } });
    }
    if (req.url.startsWith("/api/token/")) {
      if (!session || req.headers["new-api-user"] !== session) return send({ success: false }, 401);
      return send({ success: true, data: { items: [{ id: Number(session), status: 1, key: `model-${session}`, unlimited_quota: true }], total: 1 } });
    }
    if (req.url === "/v1/models") return send({ data: [
      { id: "fixture-responses", supported_endpoint_types: ["responses"], context_length: 10000 },
      { id: "fixture-messages", supported_endpoint_types: ["anthropic"], context_length: 10000 },
      { id: "fixture-gemini", supported_endpoint_types: ["gemini"], context_length: 10000 },
      { id: "gpt-fixture-exact", supported_endpoint_types: ["responses"] }
    ] });
    if (req.url === "/v1/responses") {
      const key = req.headers.authorization;
      const count = (attempts.get(key) || 0) + 1;
      attempts.set(key, count);
      if (key === "Bearer model-123" && count === 1) return send({ error: {
        type: "invalid_request_error",
        message: "OpenAI Responses bad request: The requested item was created under a different *** OpenAI resource. Use the same resource that created the item to access it. [trace_id=00000000000000000000000000000001]"
      } }, 400);
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(frame({ response: { status: "completed", output: [{ type: "message", content: [{ text: "safe-result" }] }] } }, "response.completed"));
    }
    if (req.url === "/v1/messages") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(frame({ type: "message_stop" }, "message_stop"));
    }
    send({ error: { message: "Unexpected fixture path" } }, 404);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const child = spawn(bun, ["--preload", fileURLToPath(new URL("./fixtures/host-preload.mjs", import.meta.url)), hostPath], {
    cwd: directory,
    env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: path.join(directory, ".config"), MAGPIE_TEST_ORIGIN: `http://127.0.0.1:${server.address().port}` },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const pending = new Map(), events = [];
  let next = 1;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) { events.push(message); return; }
    if (message.event) { request.events.push(message); return; }
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve({ result: message.result, events: request.events });
  });
  child.on("exit", code => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Host exited ${code}: ${stderr}`)); }
    pending.clear();
  });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
      await exited;
      clearTimeout(timer);
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Host RPC timed out: ${method}: ${stderr}`)); }, 12000);
    pending.set(id, { resolve, reject, timer, events: [] });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const init = await rpc("init", { directory, authPath, modelsDevPath,
    config: { provider: { agentrouter: { models: { "gpt-fixture-exact": { limit: { input: 88000 } } } } } },
    plugins: [{ spec: root, target: root, options: { modelsRegistryPath: modelsDevPath } }] });
  assert.equal(init.result.plugins.length, 1);
  assert.equal(init.result.plugins[0].error, undefined);
  const firstPrompt = await rpc("prompt", { provider: "agentrouter", method: 0 });
  assert.equal(firstPrompt.result.prompt.key, "site");
  const answers = { site: "air", checkinEnabled: "no", username: "alice", password: "test-password", advanced: "no" };
  const filled = {}, asked = [];
  while (true) {
    const { result } = await rpc("prompt", { provider: "agentrouter", method: 0, inputs: filled });
    if (!result.prompt) break;
    asked.push(result.prompt.key);
    if (result.prompt.key === "password") assert.equal(result.prompt.type, "password");
    assert.ok(Object.hasOwn(answers, result.prompt.key), "Unexpected additional credential question");
    filled[result.prompt.key] = answers[result.prompt.key];
  }
  assert.deepEqual(asked, ["site", "checkinEnabled", "username", "password", "advanced"]);
  const login = async (username, site, email = "same-label") => (await rpc("apiKey", { provider: "agentrouter", method: 0, inputs: {
    site, email, username, password: "test-password", checkinEnabled: "no", advanced: "no"
  } })).result;
  const alice = await login("alice", "air");
  const bob = await login("bob", "org");
  assert.equal(alice.ok, true);
  assert.equal(bob.ok, true);
  assert.notEqual(alice.account, bob.account, "same label must not collapse two different site UIDs");
  const again = await login("alice", "air", "changed-remark");
  assert.equal(again.account, alice.account, "a changed in-flight remark must not create another login for the same site identity");
  const saved = await readFile(authPath, "utf8");
  assert.doesNotMatch(saved, /test-password/);
  assert.equal(Object.keys(JSON.parse(saved)).length, 2);
  assert.equal(JSON.parse(saved)[alice.account].uid, "agentrouter:123");
  assert.equal(JSON.parse(saved)[bob.account].uid, "agentrouter:456");
  assert.equal(JSON.parse(saved)[alice.account].accountId, "alice@example.test");
  assert.equal(JSON.parse(saved)[bob.account].accountId, "bob@example.test");
  const providers = await rpc("providers");
  const models = providers.result.find(provider => provider.id === "agentrouter").models;
  assert.equal(models.some(model => model.id === "registry-only"), false);
  const corresponding = models.find(model => model.id === "fixture-responses");
  assert.deepEqual([corresponding.context, corresponding.input, corresponding.output], [10000, 8000, 2000]);
  assert.equal(corresponding.reasoning, true);
  assert.equal(corresponding.image, true);
  assert.deepEqual(corresponding.variants, ["low", "medium", "high", "xhigh"]);
  const original = models.find(model => model.id === "gpt-fixture-exact");
  assert.deepEqual([original.context, original.input, original.output], [100000, 88000, 10000]);
  assert.deepEqual(original.variants, ["none", "high"]);
  const usage = await rpc("usage", { provider: "agentrouter", account: alice.account, proxy: "direct" });
  assert.equal(usage.result.user, "", "wallet results must not replace the real-email identity or its native alias");
  assert.equal(usage.result.windows[0].balance, null);
  assert.equal(usage.result.windows[0].used, 75);
  assert.equal(usage.result.windows[0].amount, 369);
  assert.equal(usage.result.windows[0].limit, 492);
  assert.equal(usage.result.windows[0].unit, "USD");
  assert.equal(usage.result.windows[0].resetsAt, "");
  const bobUsage = await rpc("usage", { provider: "agentrouter", account: bob.account, proxy: "direct" });
  assert.equal(bobUsage.result.user, "");
  assert.equal(bobUsage.result.windows[0].used, 75);
  assert.equal(bobUsage.result.windows[0].amount, 1368);
  assert.equal(bobUsage.result.windows[0].limit, 1824);
  assert.equal(await readFile(authPath, "utf8"), saved, "reading balances must not rewrite account identity or labels");
  const loaded = await rpc("load", { provider: "agentrouter", account: alice.account });
  assert.equal(loaded.result.baseURL, "");
  const body = { model: "fixture-responses", input: [{ type: "reasoning", encrypted_content: "private-history" }, { role: "user", content: "hello" }], stream: true };
  const send = account => rpc("fetch", { provider: "agentrouter", account, model: "fixture-responses", npm: "@ai-sdk/openai", method: "POST",
    url: account === alice.account ? "https://ps.air-outer.com/v1/responses" : "https://agentrouter.org/v1/responses", body: Buffer.from(JSON.stringify(body)).toString("base64"), session: "session-id", proxy: "direct" });
  const results = await Promise.all([send(alice.account), send(bob.account)]);
  for (const response of results) {
    assert.equal(response.events.find(event => event.event === "head").status, 200);
    const text = response.events.filter(event => event.event === "chunk").map(event => Buffer.from(event.data, "base64").toString()).join("");
    assert.match(text, /safe-result/);
  }
  const a = requests.filter(request => request.path === "/v1/responses" && request.headers.authorization === "Bearer model-123");
  const b = requests.filter(request => request.path === "/v1/responses" && request.headers.authorization === "Bearer model-456");
  assert.equal(a.length, 2);
  assert.equal(b.length, 1);
  assert.equal(a[0].body, JSON.stringify(body));
  assert.equal(JSON.parse(a[1].body).input.some(item => item.type === "reasoning"), false);
  assert.equal(b[0].body, JSON.stringify(body));
  assert.equal(a[0].headers["x-test-upstream-origin"], "https://ps.air-outer.com");
  assert.equal(b[0].headers["x-test-upstream-origin"], "https://agentrouter.org");
  assert.ok([...a, ...b].every(request => !request.headers.cookie && !request.headers["new-api-user"]));
  const cleanupPrefix = "[agentrouter-auto-filter] history-cleanup ";
  const cleanupLogs = events.filter(event => event.event === "log" && event.message.startsWith(cleanupPrefix));
  assert.equal(cleanupLogs.length, 1, "Magpie must retain cleanup details even though its log shim drops extra");
  const cleanup = JSON.parse(cleanupLogs[0].message.slice(cleanupPrefix.length));
  assert.equal(cleanup.errorCode, "different_azure");
  assert.equal(cleanup.removed, 1);
  assert.doesNotMatch(JSON.stringify(events.filter(event => event.event === "log")), /test-password|private-history|model-123|session=s123/);
});
