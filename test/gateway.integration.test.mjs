import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const binary = process.env.MAGPIE_TEST_BINARY;
const bun = process.env.MAGPIE_TEST_BUN;
const root = fileURLToPath(new URL("../", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("installed Magpie gateway: native account failover without a plugin-owned account pool", {
  skip: !binary || !bun || process.platform === "win32" ? "Requires explicit installed Magpie/Bun paths and the POSIX-only local test launcher (not a plugin runtime dependency)." : false,
  timeout: 45000
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentrouter-gateway-test-"));
  const config = path.join(directory, ".config", "magpie");
  await mkdir(config, { recursive: true });
  let child, output = "";
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const send = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/v1/models") return send({ data: [{ id: "native-route-test", supported_endpoint_types: ["responses"], context_length: 10000, max_output_tokens: 1000 }] });
    if (req.url !== "/v1/responses") return send({ error: { message: "Unexpected fixture path" } }, 404);
    calls.push({ headers: req.headers, body });
    if (req.headers.authorization === "Bearer revoked-after-discovery") return send({ error: { type: "authentication_error", code: "invalid_api_key", message: "Key rejected" } }, 401);
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
  await writeFile(path.join(config, "plugin-auth.json"), JSON.stringify({
    agentrouter: { type: "api", key: "revoked-after-discovery", metadata: { site: "air", email: "First test account" } },
    "agentrouter#b00001": { type: "api", key: "working-account", metadata: { site: "org", email: "Second test account" } }
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
    body: JSON.stringify({ model: "agentrouter/native-route-test", input: "local fixture only", stream: false }), signal: AbortSignal.timeout(12000)
  });
  const result = await response.text();
  assert.equal(response.status, 200, result + "\n" + output);
  assert.match(result, /native-failover-ok/);
  assert.deepEqual(calls.map(call => call.headers.authorization), ["Bearer revoked-after-discovery", "Bearer working-account"]);
  assert.ok(calls.every(call => JSON.parse(call.body).model === "native-route-test"));
  assert.deepEqual(calls.map(call => call.headers["x-test-upstream-origin"]), ["https://ps.air-outer.com", "https://agentrouter.org"]);
  assert.ok(calls.every(call => !call.headers.cookie && !call.headers["new-api-user"]));
});
