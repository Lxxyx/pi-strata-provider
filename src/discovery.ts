import type { Config, LocalModel, ModelOverride } from "./config.ts";
import { tuneModel } from "./tuning.ts";

export type JsonObject = Record<string, any>;
export type Fetcher = typeof fetch;
export interface Discovery {
  models: LocalModel[];
  backend: string;
  authenticationRequired?: boolean;
  warnings: string[];
}
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(...values: unknown[]): number | undefined {
  return values.find(value => typeof value === "number" && Number.isSafeInteger(value) && value > 0) as number | undefined;
}

export function templateThinking(template: string): Pick<LocalModel, "reasoning" | "compat" | "thinkingLevelMap"> {
  const toggle = /\benable_thinking\b/.test(template);
  const effort = /\breasoning_effort\b/.test(template);
  if (!toggle && !effort) return { reasoning: false };
  // Inspect explicit template whitelists without executing untrusted template code.
  const match = template.match(/\b(?:resolved_)?reasoning_effort\s+(?:not\s+)?in\s*[\[(]([^\])]+)[\])]/);
  const supported = match ? [...match[1].matchAll(/["']([^"']+)["']/g)].map(m => m[1]) : [];
  const map: NonNullable<LocalModel["thinkingLevelMap"]> = { off: toggle ? "off" : null };
  for (const level of LEVELS) map[level] = supported.includes(level) ? level : null;
  if (!supported.some(value => LEVELS.includes(value as typeof LEVELS[number]))) {
    map.high = "high";
  }
  const kwargs: NonNullable<LocalModel["compat"]>["chatTemplateKwargs"] = {};
  if (toggle) kwargs.enable_thinking = { $var: "thinking.enabled" };
  if (/\bpreserve_thinking\b/.test(template)) kwargs.preserve_thinking = true;
  // Without an explicit whitelist, retain the template's default reasoning effort.
  if (supported.length && effort) kwargs.reasoning_effort = { $var: "thinking.effort", omitWhenOff: true };
  return {
    reasoning: true,
    thinkingLevelMap: map,
    compat: {
      supportsReasoningEffort: false,
      thinkingFormat: "chat-template",
      chatTemplateKwargs: kwargs,
    },
  };
}

export function applyOverrides(model: LocalModel, ...overrides: ModelOverride[]): LocalModel {
  let result = model;
  for (const override of overrides) {
    result = {
      ...result,
      ...override,
      compat: { ...result.compat, ...override.compat },
      ...(override.thinkingLevelMap && { thinkingLevelMap: { ...result.thinkingLevelMap, ...override.thinkingLevelMap } }),
      cost: { ...result.cost, ...override.cost },
      ...(override.samplingParams && { samplingParams: { ...result.samplingParams, ...override.samplingParams } }),
    };
  }
  return { ...result, maxTokens: Math.min(result.maxTokens, result.contextWindow) };
}

export async function discover(
  config: Config,
  options: { signal?: AbortSignal; apiKey?: string; previous?: readonly LocalModel[]; fetcher?: Fetcher } = {},
): Promise<Discovery> {
  const fetcher = options.fetcher ?? fetch;
  const root = config.baseUrl.replace(/\/v1$/, "");
  const warnings: string[] = [];
  const key = options.apiKey ?? process.env[config.apiKeyEnv] ?? config.apiKey ?? "strata-local";
  const request = async (url: string, body?: unknown, optional = false): Promise<JsonObject | undefined> => {
    options.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(key && { Authorization: `Bearer ${key}` }), ...(body !== undefined && { "Content-Type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal,
        redirect: "error",
      });
    } catch {
      options.signal?.throwIfAborted();
      throw new Error("Local server request failed or timed out.");
    }
    if (optional && [404, 405, 501].includes(response.status)) return undefined;
    if (!response.ok) throw new Error(`Local server returned HTTP ${response.status}${response.status === 401 ? ". Configure STRATA_API_KEY or log in to this provider." : response.status === 403 ? ". Check Strata allowed_hosts or configure an API key." : ""}`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("Local server returned invalid JSON."); }
    if (!object(payload)) throw new Error("Local server returned a non-object response.");
    return payload;
  };
  const list = await request(`${config.baseUrl}/models`);
  if (!Array.isArray(list?.data)) throw new Error("Model list must contain a data array.");
  if (list.data.some((entry: unknown) => !object(entry) || typeof entry.id !== "string" || !entry.id.trim())) {
    throw new Error("Model list contains an invalid model ID.");
  }
  const entries: JsonObject[] = [...new Map<string, JsonObject>(list.data.map((entry: JsonObject) => [entry.id, entry])).values()];
  let backend: string = config.backend;
  let health: JsonObject | undefined;
  if (backend === "strata" || backend === "auto") {
    try { health = await request(`${root}/health`, undefined, true); }
    catch { options.signal?.throwIfAborted(); }
    if (backend === "auto" && health?.service === "strata") backend = "strata";
  }
  let globalProps: JsonObject | undefined;
  if (backend === "strata" || backend === "auto" || backend === "llama-cpp") {
    try { globalProps = await request(`${root}/props`, undefined, true); }
    catch { options.signal?.throwIfAborted(); warnings.push("Server properties unavailable; missing metadata uses cached values or conservative defaults."); }
    if (backend === "auto" && globalProps && ("chat_template" in globalProps || "default_generation_settings" in globalProps || "models_autoload" in globalProps)) {
      backend = "llama-cpp";
    }
  }
  if (backend === "auto") {
    try {
      const version = await request(`${root}/api/version`, undefined, true);
      backend = typeof version?.version === "string" ? "ollama" : "openai";
    } catch {
      options.signal?.throwIfAborted();
      backend = "openai";
    }
  }
  const selected = entries.filter(entry => {
    const status = entry.status?.value;
    if (entry.status?.failed || status === "loading" || status === "failed") return false;
    if (status === "unloaded") return backend === "strata" || (globalProps?.models_autoload === true && entry.source === "preset");
    return true;
  });
  const previous = new Map(options.previous?.map(model => [model.id, model]));
  const results: LocalModel[] = new Array(selected.length);
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const index = next++;
      const entry = selected[index];
      let props: JsonObject | undefined;
      let show: JsonObject | undefined;
      if (backend === "strata" || (backend === "llama-cpp" && (!entry.status || entry.status.value === "loaded"))) {
        const query = new URLSearchParams({ model: entry.id, autoload: "false" });
        try { props = await request(`${root}/props?${query}`, undefined, true); }
        catch { options.signal?.throwIfAborted(); warnings.push(`Model properties unavailable: ${entry.id}`); }
        // Strata aliases share the canonical model's template. Other models do not.
        const canonical = entry.alias_of ?? entry.id;
        if (props?.model_alias && props.model_alias !== canonical && props.model_alias !== entry.id) props = undefined;
        if (!props && ((backend === "strata" && globalProps?.model_alias === canonical) ||
          (selected.length === 1 && (!globalProps?.model_alias || globalProps.model_alias === entry.id)))) props = globalProps;
      }
      if (backend === "ollama") {
        try { show = await request(`${root}/api/show`, { model: entry.id }, true); }
        catch { options.signal?.throwIfAborted(); warnings.push(`Model details unavailable: ${entry.id}`); }
      }
      const cached = previous.get(entry.id);
      const contextFromInfo = show?.model_info && positive(...Object.entries(show.model_info).filter(([name]) => name.endsWith(".context_length")).map(([, value]) => value));
      const configuredOllamaContext = typeof show?.parameters === "string" ? Number(show.parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/)?.[1]) : undefined;
      const contextWindow = positive(
        entry.meta?.n_ctx,
        props?.default_generation_settings?.n_ctx,
        configuredOllamaContext,
        entry.context_window, entry.context_length, entry.max_model_len,
        entry.meta?.n_ctx_train,
        contextFromInfo, cached?.contextWindow,
        config.defaultContextWindow,
      )!;
      const modalities = entry.architecture?.input_modalities ?? entry.input_modalities;
      const vision = Array.isArray(modalities) ? modalities.includes("image") :
        typeof props?.modalities?.vision === "boolean" ? props.modalities.vision :
        Array.isArray(show?.capabilities) ? show.capabilities.includes("vision") : cached?.input.includes("image") ?? false;
      const compat: NonNullable<LocalModel["compat"]> = {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        supportsFinishReason: true,
        supportsStrictMode: false,
        supportsThinkingTokenBudget: false,
        supportsMidConvoSystemMessages: false,
        maxTokensField: "max_tokens",
      };
      let thinking: Pick<LocalModel, "reasoning" | "compat" | "thinkingLevelMap"> = {
        reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : cached?.reasoning ?? false,
        ...(cached && { thinkingLevelMap: cached.thinkingLevelMap, compat: cached.compat }),
      };
      if (typeof props?.chat_template === "string") {
        thinking = templateThinking(props.chat_template);
        // Strata frontend.py normalizes high to the template's xhigh and none to disabled.
        if (backend === "strata" && thinking.reasoning) {
          thinking = {
            reasoning: true,
            compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
            thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
          };
        }
      }
      if (Array.isArray(show?.capabilities)) {
        const reasoning = show.capabilities.includes("thinking");
        const gptOss = show.details?.family === "gptoss" || show.details?.family === "gpt-oss";
        thinking = {
          reasoning,
          compat: { supportsReasoningEffort: reasoning, thinkingFormat: "openai" },
          ...(reasoning && { thinkingLevelMap: {
            off: "none", minimal: null, low: gptOss ? "low" : null,
            medium: gptOss ? "medium" : null, high: "high", xhigh: null, max: null,
          } }),
        };
      }
      const maxTokens = positive(entry.max_output_tokens, entry.max_tokens, props?.default_generation_settings?.params?.n_predict, props ? undefined : cached?.maxTokens, config.defaultMaxTokens)!;
      const samplingParams: Record<string, number> = {};
      const params = props?.default_generation_settings?.params;
      const samplingAliases: Record<string, string> = { repeat_penalty: "repetition_penalty", repeat_last_n: "penalty_last_n" };
      const samplingKeys = new Set(["temperature", "top_p", "top_k", "min_p", "seed", "repetition_penalty", "penalty_last_n", "presence_penalty", "frequency_penalty"]);
      if (object(params)) {
        for (const [key, value] of Object.entries(params)) {
          const name = samplingAliases[key] ?? key;
          if (samplingKeys.has(name) && typeof value === "number" && Number.isFinite(value)) samplingParams[name] = value;
        }
      }
      results[index] = applyOverrides(tuneModel({
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : entry.id,
        provider: config.provider,
        api: "openai-completions",
        baseUrl: config.baseUrl,
        input: vision ? ["text", "image"] : ["text"],
        cost: ZERO_COST,
        contextWindow,
        maxTokens,
        ...(Object.keys(samplingParams).length && { samplingParams }),
        ...thinking,
        compat: { ...compat, ...thinking.compat },
      }, { ...config, backend: backend as Config["backend"] }), config.defaults, config.modelOverrides[entry.id] ?? {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.concurrency, selected.length) }, worker));
  options.signal?.throwIfAborted();
  return { models: results, backend, authenticationRequired: typeof health?.api_key === "boolean" ? health.api_key : undefined, warnings };
}
