import { SITES, assertSameUser, beijingDay, siteChoice, withSiteIdentity } from "./accounts.mjs";
import { browserHeaders, customHeaders } from "./headers.mjs";

export class SiteError extends Error {
  constructor(kind, message) { super(message); this.name = "SiteError"; this.kind = kind; }
}

export function quotaNumber(value) {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function mergeCookies(previous = "", responseHeaders) {
  const values = new Map();
  for (const pair of previous.split(";")) {
    const at = pair.indexOf("=");
    if (at > 0) values.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  const separate = responseHeaders?.getSetCookie?.() ?? [];
  const lines = separate.length ? separate : (responseHeaders?.get("set-cookie") ?? "").split(/,(?=\s*[^;,=\s]+=)/);
  for (const line of lines) {
    const pair = /^\s*([^=;,\s]+)=([^;]*)/.exec(line);
    if (!pair) continue;
    if (/;\s*max-age\s*=\s*0\s*(?:;|$)/i.test(line) || !pair[2]) values.delete(pair[1]);
    else values.set(pair[1], pair[2]);
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function parseSessionHandoff(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 65536) throw new SiteError("credentials", "粘贴有边界的 AgentRouter 会话导出，或 Copy as cURL 请求文本。");
  let cookie, userId, siteHeaders = {};
  if (text.startsWith("{")) {
    let data;
    try { data = JSON.parse(text); } catch { throw new SiteError("credentials", "会话导出不是合法的 JSON。"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new SiteError("credentials", "会话导出必须是一个对象。");
    cookie = data.cookie;
    userId = String(data.userId ?? "");
  } else {
    // Parse clipboard text as data, never as a shell command. Only a site's
    // self request and the minimum account headers are accepted.
    const target = /^curl(?:\.exe)?\s+(?:--location\s+)?(['"])(https:\/\/[^'"\s]+)\1/.exec(text);
    let url;
    try { url = new URL(target?.[2]); } catch {}
    if (!url || !Object.values(SITES).includes(url.origin) || url.pathname !== "/api/user/self" || url.username || url.password) {
      throw new SiteError("credentials", "请复制 AgentRouter 的 /api/user/self 请求，而不是 GitHub 或 LinuxDO 的请求。");
    }
    const headers = new Headers();
    for (const match of text.matchAll(/(?:^|\s)(?:-H|--header)\s+(['"])([^'"\r\n]*)\1/g)) {
      const at = match[2].indexOf(":");
      const name = match[2].slice(0, at).trim().toLowerCase();
      if (at > 0 && ["cookie", "new-api-user", "user-agent", "accept-language"].includes(name)) {
        try { headers.set(name, match[2].slice(at + 1).trim()); }
        catch { throw new SiteError("credentials", "导出的站点请求头无效。"); }
      }
    }
    // Chromium may emit cookies with -b instead of a Cookie header.
    const cookies = /(?:^|\s)(?:-b|--cookie)\s+(['"])([^'"\r\n]*)\1/.exec(text);
    cookie = headers.get("cookie") || cookies?.[2];
    userId = headers.get("new-api-user") || "";
    for (const name of ["user-agent", "accept-language"]) if (headers.has(name)) siteHeaders[name] = headers.get(name);
  }
  if (typeof cookie !== "string" || !/(?:^|;\s*)session=[^;\s]+/.test(cookie) || /[\r\n]/.test(cookie) || !/^\d+$/.test(userId)) {
    throw new SiteError("credentials", "导出必须包含 AgentRouter 会话 Cookie 和数字形式的 New-Api-User ID。");
  }
  return { session: cookie, userId, siteHeaders };
}

function siteFailure(response, data, raw, operation) {
  const message = String(data?.message ?? data?.error?.message ?? "");
  if (/captcha|aliyun_waf|turnstile|human verification|\u9a8c\u8bc1\u7801|\u6ed1\u52a8\u9a8c\u8bc1/i.test(message + " " + raw.slice(0, 4000))) {
    return new SiteError("captcha", "站点要求人机验证，请到网站上完成；插件不会代解。");
  }
  if ([401, 403].includes(response.status) || /password|credentials|access token|\u5bc6\u7801|\u767b\u5f55\u5931\u6548|\u672a\u767b\u5f55/i.test(message)) {
    return new SiteError("credentials", `The site refused ${operation}. Reconnect this site's credentials; the model key is unchanged.`);
  }
  if (response.status === 429) return new SiteError("rate-limit", "站点对该操作限流，请稍后再试。");
  return new SiteError("unavailable", `The site could not complete ${operation} (HTTP ${response.status}).`);
}

export async function readBoundedText(response, limit = 2 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new SiteError("unavailable", "站点响应超过了账号 API 的大小上限。");
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export function createSiteClient({ fetchImpl = (...args) => fetch(...args), timeoutMs = 25000, now = Date.now } = {}) {
  async function request(account, path, { body, anonymous = false, cookies = "", signal, operation = "account read" } = {}) {
    // Site APIs are browser surfaces: default to Chrome headers, then let the
    // account's custom headers and an imported browser session override them.
    const headers = browserHeaders();
    headers.set("referer", account.siteURL + "/");
    if (body !== undefined) headers.set("origin", account.siteURL);
    customHeaders(account.headers).forEach((value, name) => headers.set(name, value));
    customHeaders(account.siteHeaders).forEach((value, name) => headers.set(name, value));
    const cookie = anonymous ? cookies : account.session;
    if (cookie) headers.set("cookie", cookie);
    if (!anonymous) {
      if (account.accessToken) headers.set("authorization", account.accessToken);
      if (account.userId) headers.set("new-api-user", account.userId);
    }
    if (body !== undefined) headers.set("content-type", "application/json");
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(account.siteURL + path, {
        method: body === undefined ? "GET" : "POST", headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error", signal: controller.signal
      });
      const raw = await readBoundedText(response);
      let data;
      try { data = JSON.parse(raw); } catch {}
      if (!response.ok || !data || data.success !== true) throw siteFailure(response, data, raw, operation);
      return { data: data.data, cookies: mergeCookies(cookie, response.headers) };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof SiteError) throw error;
      throw new SiteError("unavailable", "站点请求失败或超时，未执行自动重试登录。");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function login(account, signal) {
    if (!account.username || !account.password) throw new SiteError("credentials", "需要提供 AgentRouter 站点用户名和密码。");
    const result = await request(account, "/api/user/login", {
      anonymous: true, body: { username: account.username, password: account.password }, signal, operation: "password login"
    });
    return {
      user: result.data,
      account: withSiteIdentity({ ...account, session: result.cookies }, result.data)
    };
  }

  async function selfResponse(account) {
    if (!account.userId || (!account.session && !account.accessToken)) {
      throw new SiteError("credentials", "读取账号信息需要站点会话或系统访问令牌加用户 ID。");
    }
    const result = await request(account, "/api/user/self");
    assertSameUser(account, result.data);
    return result;
  }

  async function self(account) {
    return (await selfResponse(account)).data;
  }

  async function profile(account) {
    const result = await selfResponse(account);
    return { user: result.data, account: withSiteIdentity({ ...account, session: result.cookies }, result.data), profileVerified: true };
  }

  async function importSession(account, text) {
    const handoff = parseSessionHandoff(text);
    if (account.userId && account.userId !== handoff.userId) throw new SiteError("credentials", "导出的会话属于另一个账号。");
    const candidate = { ...account, ...handoff, accessToken: "", password: "", checkinEnabled: false };
    return profile(candidate);
  }

  async function selectKey(account, selection = "") {
    const selected = String(selection).trim();
    if (selected && !/^\d+$/.test(selected)) throw new SiteError("selection", "请指定一个现有 API key 的数字 ID。");
    const result = await request(account, selected ? `/api/token/${selected}` : "/api/token/?p=1&size=100", { operation: "API key lookup" });
    const items = selected ? [result.data] : Array.isArray(result.data) ? result.data : result.data?.items;
    if (!Array.isArray(items)) throw new SiteError("unavailable", "站点没有返回 API key 列表。");
    const active = items.filter(item => {
      const expires = quotaNumber(item?.expired_time);
      const remaining = quotaNumber(item?.remain_quota);
      return item?.status === 1 && typeof item.key === "string" && item.key.trim() && !/[\s*]/.test(item.key) &&
        (expires === null || expires <= 0 || expires * 1000 > now()) &&
        (item.unlimited_quota === true || remaining === null || remaining > 0);
    });
    if (selected && active[0] && String(active[0].id) !== selected) throw new SiteError("selection", "站点返回了不同的 API key ID。");
    const truncated = !selected && Number(result.data?.total) > items.length;
    if (!active.length) throw new SiteError("selection", "没有可用的 API key。请先在网站上创建或启用一个 key，再重新连接。");
    if (active.length !== 1 || truncated) {
      const ids = active.slice(0, 10).map(item => String(item.id)).filter(id => /^\d+$/.test(id)).join(", ");
      throw new SiteError("selection", `More than one key may be available. Select an existing key ID in advanced login settings${ids ? ` (IDs: ${ids})` : ""}.`);
    }
    return { key: active[0].key.trim(), keyId: String(active[0].id ?? "") };
  }

  async function beginOAuth(provider, account, { callbackPath } = {}) {
    if (!["github", "linuxdo"].includes(provider)) throw new Error("不支持的身份提供方。");
    if (account.siteURL !== SITES[siteChoice(account.site)]) throw new Error("OAuth 登录必须使用两个官方 AgentRouter 端点之一。");
    const status = await request(account, "/api/status", { anonymous: true, operation: "OAuth configuration read" });
    const config = status.data;
    const clientId = config?.[provider + "_client_id"];
    if (!config?.[provider + "_oauth"] || typeof clientId !== "string" || !clientId) throw new SiteError("unavailable", `The site has not enabled ${provider} login.`);
    const state = await request(account, "/api/oauth/state?mode=login", { anonymous: true, cookies: status.cookies, operation: "OAuth state creation" });
    if (typeof state.data !== "string" || !state.data) throw new SiteError("unavailable", "站点没有签发 OAuth state。");
    const path = callbackPath || (provider === "github" ? "/oauth/github/magpie" : "/oauth/linuxdo");
    if (!["/oauth/" + provider, "/oauth/" + provider + "/magpie"].includes(path)) throw new Error("无法识别的 OAuth 回调路径。");
    const url = new URL(provider === "github" ? "https://github.com/login/oauth/authorize" : "https://connect.linux.do/oauth2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("state", state.data);
    if (provider === "github") url.searchParams.set("scope", "user:email");
    else url.searchParams.set("response_type", "code");
    if (path.endsWith("/magpie")) url.searchParams.set("redirect_uri", SITES.org + path);
    return { provider, account: { ...account, session: state.cookies }, state: state.data, path, url: url.href, expires: now() + 8 * 60000, used: false };
  }

  async function completeOAuth(flow, callback) {
    if (flow.used || now() >= flow.expires) throw new SiteError("credentials", "这个 OAuth 流程已被使用或已过期，请重新发起登录。");
    let url;
    try { url = new URL(callback); } catch { throw new SiteError("credentials", "请粘贴完整的回调 URL（含 code 和 state）。"); }
    if (!Object.values(SITES).includes(url.origin) || url.pathname !== flow.path || url.username || url.password || url.hash ||
        url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== flow.state ||
        url.searchParams.getAll("code").length !== 1 || !url.searchParams.get("code")) {
      throw new SiteError("credentials", "回调的来源、路径或 state 与本次登录不匹配。");
    }
    flow.used = true;
    const params = new URLSearchParams({ code: url.searchParams.get("code"), state: flow.state, mode: "login" });
    const result = await request(flow.account, `/api/oauth/${flow.provider}?${params}`, {
      anonymous: true, cookies: flow.account.session, operation: "OAuth login exchange"
    });
    return {
      user: result.data,
      account: withSiteIdentity({ ...flow.account, mode: flow.provider, session: result.cookies, accessToken: "", password: "", checkinEnabled: false }, result.data)
    };
  }

  function dailyResult(user) {
    return {
      lastCheckinDay: beijingDay(now()),
      lastCheckin: { outcome: user.checked_in === true ? "claimed" : "done", message: user.checked_in === true ? "The site's login granted the daily reward." : "Login completed without a new daily reward." }
    };
  }

  return { request, login, self, profile, importSession, selectKey, beginOAuth, completeOAuth, dailyResult };
}
