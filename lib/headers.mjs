export const MODEL_HINT_HEADER = "x-agentrouter-account-model";

const RESERVED = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "new-api-user",
  "x-api-key", "x-goog-api-key", "host", "content-length", "transfer-encoding", "connection", MODEL_HINT_HEADER
]);

export function customHeaders(value) {
  const result = new Headers();
  if (!value) return result;
  if (typeof value === "string") {
    for (const raw of value.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const at = line.indexOf(":");
      if (at < 1) throw new Error("自定义请求头必须每行一条 Name: value。");
      result.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  } else {
    new Headers(value).forEach((v, k) => result.set(k, v));
  }
  for (const name of result.keys()) {
    if (RESERVED.has(name)) throw new Error(`请求头 ${name} 由所选账号或传输层管理，不能自定义。`);
  }
  return result;
}

export function inferenceHeaders(account, incoming, protocol, compatibility = true) {
  const headers = customHeaders(account.headers);
  if (compatibility && !headers.has("user-agent")) headers.set("user-agent", "codex_cli_rs/0.101.0");
  new Headers(incoming).forEach((value, name) => headers.set(name, value));
  for (const name of ["authorization", "proxy-authorization", "cookie", "set-cookie", "new-api-user", "x-api-key", "x-goog-api-key", MODEL_HINT_HEADER]) {
    headers.delete(name);
  }
  if (protocol === "anthropic") headers.set("x-api-key", account.key);
  else if (protocol === "gemini") headers.set("x-goog-api-key", account.key);
  else headers.set("authorization", `Bearer ${account.key}`);
  return headers;
}
