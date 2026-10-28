import { readFileSync } from "node:fs";

import { PROVIDER, SITES, accountCapabilities, beijingDay, protocolBase, readAccount, saveAccount, siteChoice } from "./accounts.mjs";
import { createSiteClient, quotaNumber } from "./site-client.mjs";
import { MODEL_HINT_HEADER, customHeaders, inferenceHeaders } from "./headers.mjs";
import { createCatalog, protocolOfURL } from "./catalog.mjs";

const required = value => typeof value === "string" && value.length ? undefined : "This field is required.";
const advanced = { key: "advanced", op: "eq", value: "yes" };
const PLUGIN_ICON = `data:image/png;base64,${readFileSync(new URL("../icon.png", import.meta.url)).toString("base64")}`;

function prompts(mode) {
  const out = [
    { type: "select", key: "site", message: "AgentRouter endpoint", options: [
      { label: "agentrouter.org", value: "org" }, { label: "ps.air-outer.com", value: "air" }
    ] },
    { type: "text", key: "email", message: "账号备注（可选）", placeholder: "用于区分不同账号的名字" }
  ];
  if (mode === "password") out.push(
    { type: "select", key: "checkinEnabled", message: "开启每日自动签到？这会把 AgentRouter 站点密码保存在本地。", options: [
      { label: "否 - 只用这次，不保存密码", value: "no" }, { label: "是 - 保存密码用于每日签到", value: "yes" }
    ] },
    { type: "text", key: "username", message: "AgentRouter 站点用户名", validate: required },
    { type: "password", key: "password", message: "AgentRouter 站点密码（不是 GitHub 或 LinuxDO 密码）", validate: required }
  );
  if (mode === "access-token") out.push(
    { type: "password", key: "accessToken", message: "AgentRouter 系统访问令牌（不是模型 API key）", validate: required },
    { type: "text", key: "userId", message: "AgentRouter user ID (New-Api-User)", validate: value => /^\d+$/.test(value) ? undefined : "请输入数字形式的站点用户 ID。" }
  );
  if (["github", "linuxdo"].includes(mode)) {
    const code = { label: "未使用的 OAuth 回调链接", value: "code", hint: "回调里的 code 必须还没有被网站兑换过。" };
    const session = { label: "已完成网站登录（粘贴会话请求）", value: "session", hint: "正常浏览器登录后粘贴站点请求；不导入第三方浏览器会话。" };
    out.push({ type: "select", key: "handoff", message: "登录完成后，用哪种方式把结果交给 Magpie？", options: mode === "linuxdo" ? [session, code] : [code, session] });
  }
  out.push({ type: "select", key: "advanced", message: "展开高级账号设置？供应商/模型原生请求头始终可用。", options: [
    { label: "否", value: "no" }, { label: "是", value: "yes" }
  ] });
  if (mode !== "api-key") out.push({ type: "text", key: "keyId", message: "使用指定的 API key ID（只有一个可用 key 时可留空）", when: advanced,
    validate: value => !value || /^\d+$/.test(value) ? undefined : "请输入数字形式的 API key ID。" });
  out.push({ type: "text", key: "headers", message: "自定义请求头（可选，每行一条 Name: value）", when: advanced,
    validate: value => { try { customHeaders(value); } catch (error) { return error.message; } } });
  return out;
}

function accountFromInputs(mode, inputs = {}) {
  const site = siteChoice(inputs.site || "org");
  const checkinEnabled = mode === "password" && inputs.checkinEnabled === "yes";
  const account = {
    mode, site, siteURL: SITES[site], apiBase: "", key: "", keyId: inputs.keyId || "",
    label: String(inputs.email || "").trim(), email: "", username: mode === "password" ? String(inputs.username || "").trim() : "",
    password: mode === "password" ? inputs.password || "" : "", session: "",
    accessToken: mode === "access-token" ? String(inputs.accessToken || "").trim() : "",
    userId: mode === "access-token" ? String(inputs.userId || "").trim() : "", headers: inputs.headers || "", checkinEnabled
  };
  customHeaders(account.headers);
  return account;
}

const failed = error => ({ type: "failed", error: error.message || "站点未能完成登录。" });

function requestURL(request, init, headers, account, provider, explicit) {
  const original = new URL(request instanceof Request ? request.url : String(request));
  const protocol = protocolOfURL(original.href);
  if (!protocol) return original.href;
  let id = headers.get(MODEL_HINT_HEADER);
  if (!id && init.body) {
    try {
      const body = typeof init.body === "string" ? init.body : ArrayBuffer.isView(init.body) ? new TextDecoder().decode(init.body) : "";
      const model = JSON.parse(body).model;
      if (typeof model === "string") id = model;
    } catch {}
  }
  if (!id && protocol === "gemini") id = decodeURIComponent(original.pathname.match(/\/models\/([^/]+):[^/]+$/)?.[1] || "");
  const [name, model] = Object.entries(provider.models ?? {}).find(([name, model]) => name === id || model.api?.id === id) ?? [id, null];
  const user = explicit.models?.[name] || Object.entries(explicit.models ?? {}).find(([name, model]) => (model.id || name) === id)?.[1];
  const isOfficial = value => Object.values(SITES).includes(new URL(value).origin);
  const modelBase = user?.provider?.api || (model?.api?.url && !isOfficial(model.api.url) ? model.api.url : "");
  const override = modelBase || account.apiBase || explicit.api;
  if (!override && !isOfficial(original.href)) return original.href;
  const base = (override || protocolBase(account.siteURL, protocol)).replace(/\/+$/, "");
  if (original.href.startsWith(base + "/")) return original.href;
  const suffix = original.pathname.match(/\/(?:responses|chat\/completions|messages)\/?$|\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/)?.[0];
  return base + suffix + original.search;
}

export async function createProvider(input = {}, options = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || ((...args) => fetch(...args));
  const now = dependencies.now || Date.now;
  const site = createSiteClient({ fetchImpl, now });
  let explicit = {};
  const compatibility = () => input.magpie?.option?.(PROVIDER, "send-codex-headers") !== false;
  const catalog = createCatalog({ site, explicit: () => explicit, compatibility, fetchImpl });
  const pending = new Map(), completed = new Map();
  const quotaPerUnit = options.quotaPerUnit ?? 500000;
  if (typeof quotaPerUnit !== "number" || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) throw new Error("quotaPerUnit must be a positive number.");

  async function finishLogin(result, selection) {
    const key = await site.selectKey(result.account, selection);
    const state = { ...result.account, ...key };
    if (typeof result.user?.checked_in === "boolean") Object.assign(state, site.dailyResult(result.user));
    const { type, ...record } = saveAccount(state);
    return { type: "success", ...record };
  }

  const methods = [
    { type: "api", keyless: true, label: "AgentRouter 账号密码（可选每日签到）", prompts: prompts("password"),
      async authorize(inputs) {
        try { return await finishLogin(await site.login(accountFromInputs("password", inputs)), inputs?.keyId); }
        catch (error) { return failed(error); }
      } },
    ...["github", "linuxdo"].map(provider => ({
      type: "oauth", label: provider === "github" ? "使用 GitHub 登录 AgentRouter" : "使用 LinuxDO 登录 AgentRouter",
      prompts: prompts(provider),
      async authorize(inputs) {
        const account = accountFromInputs(provider, inputs);
        const handoff = inputs?.handoff || (provider === "linuxdo" ? "session" : "code");
        if (handoff === "session") {
          let used = false;
          return {
            url: account.siteURL + "/login", method: "code",
            instructions: `在网站上选择 ${provider === "github" ? "GitHub" : "LinuxDO"} 并完成正常登录。如有需要，把回调地址里的 agentrouter.org 换成 ${new URL(account.siteURL).host}。登录后打开浏览器 DevTools > Network，刷新账号页，把 /api/user/self 请求复制为 cURL 粘贴到这里。只导入 AgentRouter 会话和用户 ID，不会执行命令；也接受包含 cookie 和 userId 的 JSON 导出。`,
            async callback(value) {
              if (used) return failed(new Error("这份回传已被使用，请重新发起登录。"));
              used = true;
              try { return await finishLogin(await site.importSession(account, value), inputs?.keyId); }
              catch (error) { return failed(error); }
            }
          };
        }
        if (handoff !== "code") throw new Error("请选择支持的 OAuth 回传方式。");
        const flow = await site.beginOAuth(provider, account);
        return {
          url: flow.url, method: "code",
          instructions: provider === "github"
            ? "在浏览器完成授权，然后把完整的 agentrouter.org 回调 URL（含 code 和 state）粘贴到这里。子回调页面可能显示 Not Found，属正常现象；不要先访问普通回调页。兑换使用你选择的端点。"
            : "完成 LinuxDO 授权。需要一条还没被使用的回调 URL（含 code 和 state）。如果网站已经消费了 code，请改用「已完成网站登录」的回传方式；不要重放 code。",
          async callback(value) {
            try { return await finishLogin(await site.completeOAuth(flow, value), inputs?.keyId); }
            catch (error) { return failed(error); }
          }
        };
      }
    })),
    { type: "api", keyless: true, label: "AgentRouter 系统访问令牌（无每日签到）", prompts: prompts("access-token"),
      async authorize(inputs) {
        try {
          const account = accountFromInputs("access-token", inputs);
          const user = await site.self(account);
          return await finishLogin({ account: { ...account, username: user.username || "", email: user.email || "" }, user }, inputs?.keyId);
        } catch (error) { return failed(error); }
      } },
    { type: "api", label: "AgentRouter 模型 API key（仅推理）", placeholder: "模型 API key", prompts: prompts("api-key") }
  ];

  return {
    async config(cfg) {
      cfg.provider ??= {};
      explicit = structuredClone(cfg.provider[PROVIDER] ?? {});
      cfg.provider[PROVIDER] ??= { name: "AgentRouter", npm: "@ai-sdk/openai", api: SITES.org + "/v1", models: {} };
    },
    auth: {
      provider: PROVIDER, methods,
      icon: PLUGIN_ICON,
      options: [{ key: "send-codex-headers", label: "默认兼容客户端请求头", description: "账号和原生请求都没带客户端身份时，自动补一个兼容的客户端请求头。", default: true }],
      async loader(getAuth, provider) {
        const state = readAccount(await getAuth(), provider);
        if (!state) return {};
        return {
          apiKey: state.key,
          async fetch(request, init = {}) {
            const account = readAccount(await getAuth(), provider);
            if (!account?.key) throw new Error("This account has no model API key. Reconnect it before sending requests.");
            if ((state.userId && account.userId && state.userId !== account.userId) ||
                ((!state.userId || !account.userId) && state.key !== account.key)) {
              throw Object.assign(new Error("The selected account changed during this request. Start a new request; no data was sent with the replacement account."), {
                code: "account_changed", status: 409, retryable: false
              });
            }
            const incoming = new Headers(request instanceof Request ? request.headers : undefined);
            new Headers(init.headers).forEach((value, name) => incoming.set(name, value));
            // The Go router can reuse the first seat's URL on failover. Resolve
            // this seat's endpoint without forcing a baseURL over model overrides.
            const url = requestURL(request, init, incoming, account, provider, explicit);
            const headers = inferenceHeaders(account, incoming, protocolOfURL(request), compatibility());
            const target = request instanceof Request ? new Request(url, request) : url;
            return fetchImpl(target, { ...init, headers });
          }
        };
      },
      async usage(getAuth, provider) {
        const account = readAccount(await getAuth(), provider);
        if (!account) return { error: "未连接账号。", windows: [], signIn: "kept" };
        if (account.mode === "api-key") return { plan: "API key - 仅推理", windows: [], signIn: "kept" };
        try {
          const user = await site.self(account);
          const quota = quotaNumber(user.quota);
          if (quota === null) return { error: "站点没有返回剩余余额。", windows: [], signIn: "kept" };
          const balance = quota / quotaPerUnit;
          const display = "$" + balance.toFixed(Math.abs(balance) < 0.01 && balance !== 0 ? 6 : 2);
          return {
            user: user.username || account.username, balance: display, signIn: "kept",
            windows: [{ name: "AgentRouter 钱包", balance: Math.max(0, balance), unit: "USD", display }]
          };
        } catch (error) { return { error: error.message, windows: [], signIn: "kept" }; }
      },
      async checkin(getAuth, provider) {
        const auth = await getAuth();
        const account = readAccount(auth, provider);
        if (!accountCapabilities(account).checkin) return { outcome: "ineligible", message: "每日签到需要显式开启，并使用 AgentRouter 站点账号密码。" };
        const day = beijingDay(now());
        for (const [key, value] of completed) if (value.day !== day) completed.delete(key);
        const key = `${Object.values(SITES).includes(account.siteURL) ? PROVIDER : account.siteURL}:${account.userId}`;
        if (account.lastCheckinDay === day || completed.get(key)?.day === day) return { outcome: "done", message: "该账号今日签到已完成。" };
        if (pending.has(key)) {
          const result = await pending.get(key);
          return result.outcome === "claimed" ? { outcome: "done", message: "并发的每日签到已完成。" } : result;
        }
        const operation = (async () => {
          try {
            const result = await site.login(account);
            const daily = site.dailyResult(result.user);
            completed.set(key, { day: daily.lastCheckinDay });
            const latestAuth = await getAuth();
            const latest = readAccount(latestAuth, provider);
            if (latest?.userId !== account.userId || latest.siteURL !== account.siteURL) {
              return { ...daily.lastCheckin, message: "签到已完成，但所选账号已变更，未覆盖其凭据。" };
            }
            try {
              await input.client?.auth?.set?.({ path: { id: PROVIDER }, body: saveAccount({ ...latest, session: result.account.session, ...daily }, latestAuth) });
            } catch {
              return { ...daily.lastCheckin, message: "签到已完成，但刷新后的站点会话未能保存。" };
            }
            return daily.lastCheckin;
          } catch (error) {
            return { outcome: error.kind === "captcha" ? "captcha" : error.kind === "credentials" ? "ineligible" : "failed", message: error.message };
          }
        })();
        pending.set(key, operation);
        try { return await operation; } finally { pending.delete(key); }
      }
    },
    provider: { id: PROVIDER, models: (provider, { auth } = {}) => catalog(provider, readAccount(auth, provider)) },
    "chat.headers": async (context, output) => {
      if (context.model?.providerID !== PROVIDER && context.provider?.info?.id !== PROVIDER) return;
      const supplied = new Headers(context.model?.headers);
      const modelId = context.model?.id || context.model?.api?.id;
      if (modelId) output.headers[MODEL_HINT_HEADER] = modelId;
      if (context.sessionID && !supplied.has("x-session-id") && !output.headers["x-session-id"]) output.headers["x-session-id"] = context.sessionID;
    }
  };
}
