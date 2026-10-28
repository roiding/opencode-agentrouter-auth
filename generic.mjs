import { cleanResponsesRequest, createFilteredFetch, defaultRetryDelay, fetchWithFilter,
  historyErrorCode, retryErrorClass } from "./lib/responses-filter.mjs";

const DEFAULT_PROVIDER_ID = "auto-codex-filter";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
function normalizeBaseURL(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseURL must use http: or https:");
  }
  return url.href.replace(/\/+$/, "");
}

function normalizeModels(models) {
  const source = Array.isArray(models)
    ? Object.fromEntries(models.map(id => [String(id), { id: String(id) }]))
    : models && typeof models === "object" ? models : null;
  if (!source) return {};

  const result = {};
  for (const [key, value] of Object.entries(source)) {
    const model = typeof value === "string" ? { id: value } : { ...value };
    result[key] = {
      ...model,
      id: model.id ?? key,
      name: model.name ?? model.id ?? key,
      limit: model.limit ?? { context: 400000, output: 64000 }
    };
    if (model.reasoning === undefined) result[key].reasoning = true;
    if (model.tool_call === undefined) result[key].tool_call = true;
  }
  return result;
}

async function plugin(input = {}, options = {}) {
  const providerId = options.providerId || DEFAULT_PROVIDER_ID;
  const models = normalizeModels(options.models);
  const configuredBaseURL = options.baseURL ? normalizeBaseURL(options.baseURL) : undefined;
  const prompts = configuredBaseURL ? [] : [{
    type: "text",
    key: "baseURL",
    message: "Responses API base URL",
    placeholder: "https://api.example.com/v1",
    validate(value) {
      try {
        normalizeBaseURL(value);
        return undefined;
      } catch {
        return "Enter an http: or https: URL";
      }
    }
  }];

  return {
    config: async cfg => {
      cfg.provider ??= {};
      cfg.provider[providerId] ??= {
        name: options.providerName || "Auto Codex Filter",
        npm: "@ai-sdk/openai",
        api: configuredBaseURL || DEFAULT_BASE_URL,
        models
      };
    },
    auth: {
      provider: providerId,
      maxConcurrency: options.maxConcurrency ?? 4,
      methods: [{
        type: "api",
        label: "Responses 上游 API key",
        placeholder: "sk-…（无鉴权的本地端点也请填一个非空占位符）",
        prompts
      }],
      async loader(getAuth) {
        const auth = await getAuth();
        const baseURL = normalizeBaseURL(auth?.metadata?.baseURL || configuredBaseURL || DEFAULT_BASE_URL);
        const headers = new Headers();
        if (auth?.key) headers.set("authorization", `Bearer ${auth.key}`);
        const filtered = createFilteredFetch((request, init) => {
          const merged = new Headers(request instanceof Request ? request.headers : undefined);
          new Headers(init?.headers).forEach((value, name) => merged.set(name, value));
          headers.forEach((value, name) => merged.set(name, value));
          return fetch(request, { ...init, headers: merged });
        }, options.filter ?? {});
        return {
          baseURL,
          apiKey: auth?.key,
          fetch: filtered
        };
      }
    },
    provider: {
      id: providerId,
      async models(provider, { auth } = {}) {
        try {
          const baseURL = normalizeBaseURL(auth?.metadata?.baseURL || configuredBaseURL || DEFAULT_BASE_URL);
          const headers = new Headers();
          if (auth?.key) headers.set("authorization", `Bearer ${auth.key}`);
          const response = await fetch(baseURL + "/models", { headers });
          if (!response.ok) return provider.models;
          const catalog = await response.json();
          if (!Array.isArray(catalog?.data)) return provider.models;
          return Object.fromEntries(catalog.data
            .filter(model => typeof model?.id === "string" && model.id)
            .map(model => [model.id, {
              ...provider.models[model.id],
              id: model.id,
              name: model.name ?? model.id
            }]));
        } catch {
          return provider.models;
        }
      }
    }
  };
}

export default {
  id: "auto-codex-filter",
  server: plugin
};

export const _internal = {
  cleanResponsesRequest,
  defaultRetryDelay,
  fetchWithFilter,
  historyErrorCode,
  normalizeModels,
  retryErrorClass
};
