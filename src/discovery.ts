import type { Config, LocalModel, ModelOverride } from "./config.ts";
import { tuneModel } from "./tuning.ts";
import type { EngineInstance, LocalStrataState } from "./native.ts";

export type JsonObject = Record<string, any>;
export type Fetcher = typeof fetch;

export interface Discovery {
  models: LocalModel[];
  backend: string;
  authenticationRequired?: boolean;
  warnings: string[];
}

export interface DiscoverOptions {
  signal?: AbortSignal;
  apiKey?: string;
  previous?: readonly LocalModel[];
  fetcher?: Fetcher;
  /** Local Strata installation state (engine ports, keys, pack templates). Injected, never read from disk here. */
  localState?: LocalStrataState;
  /** One tiny request per model to learn whether the server can think, when properties are unavailable. */
  capabilityProbe?: boolean;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/**
 * Strata's own effort table (serve/frontend.py): `none|off|minimal` disable thinking, `low`/`medium` are
 * their own levels and `high|xhigh|max` all mean the template's `xhigh`. Unknown words are a 400.
 */
const STRATA_EFFORTS = { off: "none", minimal: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } as const;
/** The effort a Strata level finally reaches the chat template with. */
const TEMPLATE_EFFORTS = { off: "none", minimal: "none", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh" } as const;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function modelStatus(entry: JsonObject): string | undefined {
  const status = typeof entry.status === "string" ? entry.status : entry.status?.value ?? entry.state;
  return typeof status === "string" ? status.toLowerCase() : undefined;
}

/** Effort words a template accepts, read from `reasoning_effort in (...)` whitelists without executing it. */
export function effortWhitelist(template: string): Set<string> | undefined {
  const match = template.match(/(?:resolved_)?reasoning_effort\s+(?:not\s+)?in\s*[\[(]([^\])]*?)[\])]/);
  if (!match) return undefined;
  const words = [...match[1].matchAll(/["']([^"']+)["']/g)].map(value => value[1].toLowerCase());
  return new Set(words);
}

function thinkingWords(template: string): { effort: boolean; toggle: boolean } {
  return { effort: /\breasoning_effort\b/.test(template), toggle: /\benable_thinking\b/.test(template) };
}

/** llama.cpp and friends: thinking is a chat-template keyword argument, so only whitelisted efforts are offered. */
export function templateThinking(template: string): Pick<LocalModel, "reasoning" | "compat" | "thinkingLevelMap"> {
  const { effort, toggle } = thinkingWords(template);
  if (!effort && !toggle) return { reasoning: false };
  const whitelist = effortWhitelist(template);
  // Without an explicit whitelist the template keeps its own default effort: only `high` is claimed.
  const offered = (word: string) => whitelist ? whitelist.has(word) : word === "high";
  const map: NonNullable<LocalModel["thinkingLevelMap"]> = {
    off: toggle ? "off" : null,
    minimal: offered("low") ? "low" : null,
    low: offered("low") ? "low" : null,
    medium: offered("medium") ? "medium" : null,
    high: offered("high") ? "high" : null,
    xhigh: offered("xhigh") ? "xhigh" : null,
    max: offered("max") ? "max" : null,
  };
  const kwargs: JsonObject = {};
  if (toggle) kwargs.enable_thinking = true;
  if (effort) kwargs.reasoning_effort = { $var: "thinking.effort", omitWhenOff: true };
  if (/\bpreserve_thinking\b/.test(template)) kwargs.preserve_thinking = true;
  return { reasoning: true, compat: { thinkingFormat: "chat-template", chatTemplateKwargs: kwargs }, thinkingLevelMap: map };
}

/**
 * Strata answers `reasoning_effort` at the API itself, so levels are requested directly instead of through
 * the chat template. Levels the model's template does not know are dropped rather than guessed.
 */
export function strataThinking(template?: string): Pick<LocalModel, "reasoning" | "compat" | "thinkingLevelMap"> {
  const whitelist = template ? effortWhitelist(template) : undefined;
  const known = (level: keyof typeof TEMPLATE_EFFORTS) =>
    !whitelist || whitelist.has(TEMPLATE_EFFORTS[level]) || whitelist.has(level);
  const map: NonNullable<LocalModel["thinkingLevelMap"]> = {
    off: STRATA_EFFORTS.off,
    minimal: known("minimal") ? STRATA_EFFORTS.minimal : null,
    low: known("low") ? STRATA_EFFORTS.low : null,
    medium: known("medium") ? STRATA_EFFORTS.medium : null,
    high: known("high") ? STRATA_EFFORTS.high : null,
    xhigh: known("xhigh") ? STRATA_EFFORTS.xhigh : null,
    max: known("max") ? STRATA_EFFORTS.max : null,
  };
  return { reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "openai" }, thinkingLevelMap: map };
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

function isLoopback(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function engineHost(instance: EngineInstance): string {
  const host = instance.host.includes(":") ? `[${instance.host}]` : instance.host;
  return `http://${host}:${instance.port}`;
}

/** Match a served model to the engine instance that answers for it. */
function instanceFor(entry: JsonObject, instances: readonly EngineInstance[]): EngineInstance | undefined {
  const names = new Set([entry.id, entry.alias_of, entry.meta?.instanceId, ...(Array.isArray(entry.meta?.aliases) ? entry.meta.aliases : [])]
    .filter((value): value is string => typeof value === "string" && value !== ""));
  return instances.find(instance =>
    [instance.apiModelId, instance.model, instance.id, ...(instance.aliases ?? [])].some(name => name !== undefined && names.has(name)));
}

export async function discover(config: Config, options: DiscoverOptions = {}): Promise<Discovery> {
  const fetcher = options.fetcher ?? fetch;
  const root = config.baseUrl.replace(/\/v1$/, "");
  const warnings: string[] = [];
  const key = options.apiKey ?? process.env[config.apiKeyEnv] ?? config.apiKey;
  let authenticationRequired: boolean | undefined;
  const request = async (url: string, body?: unknown, optional = false, override?: string): Promise<JsonObject | undefined> => {
    options.signal?.throwIfAborted();
    const bearer = override ?? key;
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(bearer && { Authorization: `Bearer ${bearer}` }), ...(body !== undefined && { "Content-Type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal,
        redirect: "error",
      });
    } catch {
      options.signal?.throwIfAborted();
      throw new Error("Local server request failed or timed out.");
    }
    if (optional && [401, 403].includes(response.status)) {
      authenticationRequired = true;
      return undefined;
    }
    if (optional && [404, 405, 501].includes(response.status)) return undefined;
    if (!response.ok) throw new Error(`Local server returned HTTP ${response.status}${response.status === 401 ? ". Configure STRATA_API_KEY or log in to this provider." : response.status === 403 ? ". Check Strata allowed_hosts or configure an API key." : ""}`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("Local server returned invalid JSON."); }
    if (!object(payload)) throw new Error("Local server returned a non-object response.");
    return payload;
  };

  const list = await request(`${config.baseUrl}/models`);
  if (!object(list) || !Array.isArray(list.data)) throw new Error("Model list must contain a data array.");
  if (list.data.some((entry: unknown) => !object(entry) || typeof entry.id !== "string" || !entry.id.trim())) {
    throw new Error("Model list contains an invalid model ID.");
  }
  const entries: JsonObject[] = [...new Map<string, JsonObject>(list.data.map((entry: JsonObject) => [entry.id, entry])).values()];

  let backend: Config["backend"] = config.backend;
  let health: JsonObject | undefined;
  if (backend === "strata" || backend === "auto") {
    try { health = await request(`${root}/health`, undefined, true); } catch { options.signal?.throwIfAborted(); }
    if (typeof health?.api_key === "boolean") authenticationRequired = health.api_key;
    if (backend === "auto" && health?.service === "strata") backend = "strata";
  }

  // Strata < 0.1.63 served model properties on the gateway; 0.1.63 answers those only on the engine's own port.
  let globalProps: JsonObject | undefined;
  try { globalProps = await request(`${root}/props`, undefined, true); } catch { options.signal?.throwIfAborted(); }
  if (backend === "auto" && globalProps && ("chat_template" in globalProps || "default_generation_settings" in globalProps || "models_autoload" in globalProps)) backend = "llama-cpp";

  const localState = options.localState;
  const instances: EngineInstance[] = [...(localState?.instances ?? [])];
  if (!globalProps && (backend === "strata" || backend === "auto")) {
    const control = await request(`${root}/api/native`, undefined, true).catch(() => { options.signal?.throwIfAborted(); return undefined; });
    for (const record of Array.isArray(control?.instances) ? control.instances : []) {
      if (!object(record)) continue;
      const port = typeof record.port === "number" ? record.port : undefined;
      if (port === undefined) continue;
      const known = instances.find(instance => instance.id === record.id || instance.port === port);
      if (known) { if (known.apiModelId === undefined) known.apiModelId = typeof record.apiModelId === "string" ? record.apiModelId : known.apiModelId; continue; }
      instances.push({
        id: typeof record.id === "string" ? record.id : `port-${port}`,
        apiModelId: typeof record.apiModelId === "string" ? record.apiModelId : typeof record.model === "string" ? record.model : undefined,
        model: typeof record.model === "string" ? record.model : undefined,
        modelPath: typeof record.model_path === "string" ? record.model_path : undefined,
        aliases: Array.isArray(record.aliases) ? record.aliases.filter((value: unknown): value is string => typeof value === "string") : undefined,
        host: typeof record.host === "string" ? record.host : "127.0.0.1",
        port,
        apiKey: instances.find(instance => instance.port === port)?.apiKey ?? (localState?.endpoints ?? []).find(endpoint => endpoint.baseUrl === config.baseUrl)?.apiKey,
        args: Array.isArray(record.args) ? record.args.filter((value: unknown): value is string => typeof value === "string") : [],
      });
    }
    if (backend === "auto" && (control || instances.length)) backend = "strata";
  }

  const previous = new Map(options.previous?.map(model => [model.id, model]));
  const keep = (entry: JsonObject): boolean => {
    const status = modelStatus(entry);
    if (status === "failed" || status === "error") return false;
    if (backend === "strata") return true;
    if (status === "unloaded") return globalProps?.models_autoload === true && entry.source === "preset";
    return true;
  };
  const selected = entries.filter(keep);

  const probe = options.capabilityProbe ?? config.capabilityProbe;
  const canProbe = probe !== false && isLoopback(config.baseUrl) && (backend === "strata" || backend === "openai");
  let probed = false;

  const results: LocalModel[] = new Array(selected.length);
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const index = next++;
      const entry = selected[index];
      const instance = instanceFor(entry, instances);
      let props: JsonObject | undefined;
      const status = modelStatus(entry);
      const loadable = backend === "strata" || status === undefined || status === "loaded" || status === "ready";
      const query = new URLSearchParams({ model: entry.id, autoload: "false" });
      if (instance && loadable) {
        try { props = await request(`${engineHost(instance)}/props?${query}`, undefined, true, instance.apiKey ?? ""); }
        catch { options.signal?.throwIfAborted(); }
      }
      if (!props && !instance && loadable) {
        try { props = await request(`${root}/props?${query}`, undefined, true); }
        catch { options.signal?.throwIfAborted(); warnings.push(`Model properties unavailable: ${entry.id}`); }
      }
      // A per-model query answers for that model. Only an unqualified answer may describe another one.
      const canonical = typeof entry.alias_of === "string" ? entry.alias_of : entry.id;
      if (!props && globalProps && (globalProps.model_alias === canonical || globalProps.model_alias === entry.id ||
        selected.length === 1 || (!globalProps.model_alias && status === "loaded"))) props = globalProps;

      let template = typeof props?.chat_template === "string" ? props.chat_template : undefined;
      if (!template && instance && props === undefined && localState?.templates) {
        try { template = await localState.templates(instance.args); } catch { options.signal?.throwIfAborted(); }
        if (template) warnings.push(`Chat template read from the model pack: ${entry.id}`);
      }
      const show = backend === "ollama"
        ? await request(`${root}/api/show`, { model: entry.id }, true).catch(() => { options.signal?.throwIfAborted(); return undefined; })
        : undefined;

      const cached = previous.get(entry.id);
      const contextWindow = positive(
        entry.meta?.n_ctx, entry.context_length, entry.contextWindow, entry.max_model_len,
        props?.default_generation_settings?.n_ctx, show?.parameters ? Number(show.parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/)?.[1]) : undefined,
        instance?.args.includes("--max-context") ? Number(instance.args[instance.args.indexOf("--max-context") + 1]) : undefined,
        cached?.contextWindow, config.defaultContextWindow,
      )!;
      const modalities = entry.architecture?.input_modalities ?? entry.input_modalities;
      const vision = Array.isArray(modalities) ? modalities.includes("image")
        : typeof props?.modalities?.vision === "boolean" ? props.modalities.vision
        : Array.isArray(show?.capabilities) ? show.capabilities.includes("vision")
        : cached?.input.includes("image") ?? false;

      const compat: NonNullable<LocalModel["compat"]> = {
        supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
        maxTokensField: "max_tokens", thinkingFormat: "chat-template",
      };
      let thinking: Pick<LocalModel, "reasoning" | "compat" | "thinkingLevelMap"> = {
        reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : cached?.reasoning ?? false,
        ...(cached && { thinkingLevelMap: cached.thinkingLevelMap, compat: cached.compat }),
      };
      if (template && (backend === "strata" || instances.length)) {
        const { effort, toggle } = thinkingWords(template);
        if (effort || toggle) {
          thinking = backend === "strata" ? strataThinking(template)
            : { ...templateThinking(template), compat: { ...templateThinking(template).compat, thinkingFormat: "chat-template" } };
        }
      } else if (template) {
        thinking = templateThinking(template);
      }
      if (Array.isArray(show?.capabilities)) {
        const reasoning = show.capabilities.includes("thinking");
        const gptOss = show.details?.family === "gptoss" || show.details?.family === "gpt-oss";
        thinking = {
          reasoning,
          compat: { supportsReasoningEffort: reasoning, thinkingFormat: "openai" },
          ...(reasoning && { thinkingLevelMap: {
            off: "none", minimal: gptOss ? "low" : null, low: gptOss ? "low" : null,
            medium: gptOss ? "medium" : null, high: "high", xhigh: null, max: null,
          } }),
        };
      }
      // Nothing said how this model thinks: ask it once, with a request too small to matter.
      if (canProbe && !template && !Array.isArray(show?.capabilities) && !options.previous?.some(model => model.id === entry.id && model.reasoning)) {
        const answer = await request(`${config.baseUrl}/chat/completions`, {
          model: entry.id, stream: false, max_tokens: 128, reasoning_effort: "high",
          messages: [{ role: "user", content: "Reply with only the number 17." }],
        }, true).catch(() => { options.signal?.throwIfAborted(); return undefined; });
        const message = Array.isArray(answer?.choices) ? object(answer.choices[0]) ? answer.choices[0]?.message : undefined : undefined;
        if (object(message)) {
          const reasoned = ["reasoning", "reasoning_content", "reasoning_text"].some(field =>
            typeof message[field] === "string" && message[field].trim() !== "");
          thinking = reasoned ? strataThinking() : { reasoning: false };
          probed = true;
          warnings.push(reasoned
            ? `Capabilities probed with a tiny request for ${entry.id}: the server thinks but published no properties.`
            : `Capabilities probed with a tiny request for ${entry.id}: the server did not think.`);
        } else {
          warnings.push(`Capabilities unknown for ${entry.id}: no model properties and no answer to a probe request.`);
        }
      }

      const maxTokens = positive(
        entry.max_generated, entry.max_output_tokens, entry.max_tokens,
        props?.default_generation_settings?.params?.n_predict,
        props ? undefined : cached?.maxTokens, config.defaultMaxTokens,
      )!;
      const samplingParams: Record<string, number> = {};
      const params = props?.default_generation_settings?.params;
      const aliases: Record<string, string> = { repeat_penalty: "repetition_penalty", repeat_last_n: "penalty_last_n" };
      const allowed = new Set(["temperature", "top_p", "top_k", "min_p", "seed", "repetition_penalty", "penalty_last_n", "presence_penalty", "frequency_penalty"]);
      if (object(params)) {
        for (const [name, value] of Object.entries(params)) {
          const field = aliases[name] ?? name;
          if (allowed.has(field) && typeof value === "number" && Number.isFinite(value)) samplingParams[field] = value;
        }
      }
      if (props === undefined && !globalProps && !instance && !cached) warnings.push(`Model metadata incomplete for ${entry.id}: context and output limits use configured defaults.`);
      results[index] = applyOverrides(tuneModel({
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : typeof entry.meta?.label === "string" ? entry.meta.label : entry.id,
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
      }, { ...config, backend }), config.defaults, config.modelOverrides[entry.id] ?? {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.concurrency, selected.length) }, worker));
  options.signal?.throwIfAborted();
  if (probed) warnings.push("Some capabilities came from a probe request. Run the Strata app or enable its properties to avoid the probe.");
  return { models: results, backend: backend === "auto" ? "openai" : backend, authenticationRequired, warnings };
}
