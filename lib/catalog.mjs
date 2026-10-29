import { protocolBase } from "./accounts.mjs";
import { inferenceHeaders } from "./headers.mjs";
import { readBoundedText } from "./site-client.mjs";
import { resolveModelMetadata } from "./model-metadata.mjs";
import { createModelRegistry } from "./model-registry.mjs";
export { protocolOfURL } from "./protocols.mjs";

export const NPMS = Object.freeze({ responses: "@ai-sdk/openai", chat: "@ai-sdk/openai-compatible", anthropic: "@ai-sdk/anthropic", gemini: "@ai-sdk/google" });

function fromNpm(npm) {
  if (/anthropic/.test(npm ?? "")) return "anthropic";
  if (npm === "@ai-sdk/google") return "gemini";
  if (["@ai-sdk/openai", "@ai-sdk/azure"].includes(npm)) return "responses";
  return "chat";
}

function chooseProtocol(row, explicit, defaults) {
  const npm = explicit?.provider?.npm ?? defaults.npm;
  if (npm) return fromNpm(npm);
  const types = Array.isArray(row.supported_endpoint_types) ? row.supported_endpoint_types : [];
  if (types.includes("anthropic")) return "anthropic";
  if (types.includes("gemini") || types.includes("google")) return "gemini";
  if (types.some(value => ["responses", "openai-response", "openai-responses"].includes(value))) return "responses";
  if (types.some(value => ["chat", "chat-completions", "openai-compatible"].includes(value))) return "chat";
  // AgentRouter's OpenAI route defaults to Responses; "openai" metadata alone
  // does not distinguish Chat from Responses. An explicit SDK setting wins.
  return "responses";
}

export function buildCatalog(rows, provider, account, explicit = {}, pricing = [], registry = {}) {
  const meta = new Map(pricing.filter(row => row && typeof row.model_name === "string").map(row => [row.model_name, row]));
  const out = Object.create(null);
  const discovered = new Set(rows.map(row => row?.id));
  const manual = Object.entries(explicit.models ?? {}).filter(([name, model]) => !model.disabled && !discovered.has(model.id || name))
    .map(([name, model]) => ({ id: model.id || name }));
  // A user declaration is an explicit override; a public price-list entry is
  // not. Never silently remove a manually configured model on catalog refresh.
  for (const row of [...rows, ...manual]) {
    if (typeof row?.id !== "string" || !row.id) continue;
    const aliases = Object.entries(explicit.models ?? {}).filter(([name, model]) => (model.id || name) === row.id);
    const names = aliases.length ? aliases : [[row.id, {}]];
    for (const [name, user] of names) {
      if (user.disabled) continue;
      const base = provider.models?.[name] ?? provider.models?.[row.id] ?? {};
      const metadata = { ...meta.get(row.id), ...row };
      const protocol = chooseProtocol(metadata, user, explicit);
      const url = user.provider?.api || account.apiBase || explicit.api || protocolBase(account.siteURL, protocol);
      out[name] = {
        ...base, id: name, name: user.name || row.name || row.display_name || base.name || name,
        api: { id: row.id, url, npm: user.provider?.npm || explicit.npm || NPMS[protocol] },
        ...resolveModelMetadata({ id: row.id, providerId: provider.id || "agentrouter", registry, user, row, pricing: meta.get(row.id), base }),
        headers: { ...base.headers, ...user.headers },
        options: { ...base.options, ...user.options },
        ...(Array.isArray(metadata.supported_endpoint_types) ? { endpoints: metadata.supported_endpoint_types } : {})
      };
    }
  }
  return out;
}

export function createCatalog({ site, explicit, compatibility, fetchImpl = (...args) => fetch(...args), loadRegistry = createModelRegistry({ fetchImpl }) }) {
  const fallback = (provider, failed = false) => {
    const models = Object.fromEntries(Object.keys(explicit().models ?? {}).filter(id => !explicit().models[id].disabled)
      .filter(id => provider.models?.[id]).map(id => {
        const user = explicit().models[id], base = provider.models[id];
        return [id, { ...base, ...resolveModelMetadata({ id: user.id || id, providerId: provider.id || "agentrouter", user, base }) }];
      }));
    if (failed) models[Symbol.for("magpie.fellBack")] = true;
    return models;
  };
  return async (provider, account) => {
    if (!account?.key) return fallback(provider);
    const settings = explicit();
    try {
      const base = account.apiBase || settings.api || protocolBase(account.siteURL);
      const headers = inferenceHeaders(account, settings.headers, "responses", compatibility());
      const response = await fetchImpl(base + "/models", { headers, redirect: "error", signal: AbortSignal.timeout(25000) });
      const text = await readBoundedText(response);
      let value;
      try { value = JSON.parse(text); } catch {}
      if (response.status === 401) {
        const clientRejected = /unauthorized client detected/i.test(value?.error?.message || value?.message || "") && value?.error?.code !== "invalid_api_key";
        throw Object.assign(new Error(clientRejected ? "The gateway rejected the client headers, not necessarily the API key." : "The model API rejected the inference key. Reconnect this account."), { signIn: clientRejected ? "kept" : "expired" });
      }
      if (!response.ok) return fallback(provider, true);
      if (!Array.isArray(value?.data)) return fallback(provider, true);
      const publicMetadata = (async () => {
        if (!value.data.length) return [];
        try {
          const result = await site.request(account, "/api/pricing", { anonymous: true, signal: AbortSignal.timeout(5000), operation: "public model metadata read" });
          if (Array.isArray(result.data)) return result.data;
        } catch {}
        return [];
      })();
      const [pricing, registry] = await Promise.all([publicMetadata, loadRegistry()]);
      return buildCatalog(value.data, provider, account, settings, pricing, registry);
    } catch (error) {
      if (error.signIn) throw error;
      return fallback(provider, true);
    }
  };
}
