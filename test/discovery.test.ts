import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig, type LocalModel } from "../src/config.ts";
import { discover, templateThinking, type Fetcher, type JsonObject } from "../src/discovery.ts";

const TEMPLATE = `{% if enable_thinking %}{% set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}{% if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}error{% endif %}{% endif %}{% if preserve_thinking %}<think>{% endif %}`;
const MODEL = { id: "example-model", status: { value: "loaded" }, meta: { n_ctx: 131072 }, architecture: { input_modalities: ["text", "image"] } };
const PROPS = { model_alias: "example-model", default_generation_settings: { n_ctx: 131072, params: { n_predict: -1 } }, chat_template: TEMPLATE, modalities: { vision: true }, models_autoload: true };

export function fakeFetch(routes: Record<string, JsonObject | number | ((init?: RequestInit) => JsonObject)>): Fetcher {
  return (async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    const value = routes[url.pathname + url.search] ?? routes[url.pathname] ?? 404;
    if (typeof value === "number") return new Response("{}", { status: value });
    return Response.json(typeof value === "function" ? value(init) : value);
  }) as Fetcher;
}
function strata(extra: Record<string, unknown> = {}) {
  return normalizeConfig({ ...extra });
}
function routes(models = [MODEL], props: JsonObject = PROPS) {
  return fakeFetch({ "/v1/models": { data: models }, "/props": props, "/health": { service: "strata", api_key: false } });
}

export async function fixtureModel(): Promise<LocalModel> {
  return (await discover(strata(), { fetcher: routes() })).models[0];
}

test("normalizes server roots and reverse proxy prefixes", () => {
  assert.equal(strata({ baseUrl: "http://localhost:8081/" }).baseUrl, "http://localhost:8081/v1");
  assert.equal(strata({ baseUrl: "https://example.com/strata/v1/" }).baseUrl, "https://example.com/strata/v1");
  assert.equal(strata({ baseUrl: "https://example.com/strata" }).baseUrl, "https://example.com/strata/v1");
});

test("rejects invalid configuration and endpoint credentials", () => {
  for (const config of [null, [], { typo: true }, { baseUrl: "ftp://localhost" }, { baseUrl: "http://user:secret@localhost" },
    { timeoutMs: 0 }, { concurrency: 17 }, { provider: "bad/provider" }, { apiKeyEnv: "INVALID KEY" },
    { modelOverrides: { x: { provider: "other" } } }, { defaults: { maxTokens: -1 } }, { defaults: { input: ["audio"] } },
    { defaults: { reasoning: "yes" } }, { defaults: { compat: null } }]) {
    assert.throws(() => normalizeConfig(config));
  }
});

test("discovers actual Strata runtime limits, vision and normalized effort", async () => {
  const result = await discover(strata(), { fetcher: routes() });
  const model = result.models[0];
  assert.equal(model.contextWindow, 131072);
  assert.equal(model.maxTokens, 16384);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.compat?.supportsReasoningEffort, true);
  assert.equal(model.compat?.thinkingFormat, "openai");
  assert.equal(model.compat?.supportsDeveloperRole, false);
  assert.deepEqual(model.thinkingLevelMap, { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null });
  assert.equal(result.authenticationRequired, false);
});

test("passes API keys to both model listing and property requests", async () => {
  let calls = 0;
  const fetcher = (async (input, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-secret");
    assert.equal(init?.redirect, "error");
    calls++;
    return routes()(input, init);
  }) as Fetcher;
  await discover(strata(), { apiKey: "test-secret", fetcher });
  assert.equal(calls, 4);
});

test("surfaces actionable authentication errors without exposing secrets", async () => {
  await assert.rejects(discover(strata(), { apiKey: "test-secret", fetcher: fakeFetch({ "/v1/models": 401 }) }),
    error => error instanceof Error && error.message.includes("STRATA_API_KEY") && !error.message.includes("test-secret"));
});

test("preserves Strata aliases without mixing unrelated templates", async () => {
  const alias = { ...MODEL, id: "alias", alias_of: MODEL.id };
  const result = await discover(strata(), { fetcher: routes([MODEL, alias]) });
  assert.deepEqual(result.models.map(m => m.id), [MODEL.id, "alias"]);
  assert.equal(result.models[1].reasoning, true);
});

test("keeps Strata idle-unloaded models available without loading them", async () => {
  const fetcher = routes([{ ...MODEL, status: { value: "unloaded" } }]);
  const result = await discover(strata(), { fetcher });
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].reasoning, true);
});

test("does not query properties of sleeping llama.cpp models", async () => {
  let perModelCalls = 0;
  const fetcher = (async (input, init) => {
    if (String(input).includes("?model=")) perModelCalls++;
    return routes([{ ...MODEL, status: { value: "sleeping" } }])(input, init);
  }) as Fetcher;
  await discover(strata({ backend: "llama-cpp" }), { fetcher });
  assert.equal(perModelCalls, 0);
});

test("filters failed and non-autoloadable llama.cpp models", async () => {
  const result = await discover(strata({ backend: "llama-cpp" }), {
    fetcher: routes([{ ...MODEL, status: { value: "unloaded" } }, { ...MODEL, id: "failed", status: { value: "failed" } }]),
  });
  assert.deepEqual(result.models, []);
});

test("extracts explicit template effort whitelists for llama.cpp", () => {
  const thinking = templateThinking(TEMPLATE);
  assert.equal(thinking.compat?.thinkingFormat, "chat-template");
  assert.equal(thinking.thinkingLevelMap?.low, "low");
  assert.equal(thinking.thinkingLevelMap?.high, null);
  assert.equal(thinking.thinkingLevelMap?.xhigh, "xhigh");
  assert.deepEqual(thinking.compat?.chatTemplateKwargs?.reasoning_effort, { $var: "thinking.effort", omitWhenOff: true });
});

test("does not invent reasoning capabilities from model names", async () => {
  const result = await discover(strata({ backend: "openai" }), { fetcher: fakeFetch({ "/v1/models": { data: [{ id: "qwen-thinking-vision" }] } }) });
  assert.equal(result.models[0].reasoning, false);
  assert.deepEqual(result.models[0].input, ["text"]);
  assert.equal(result.models[0].contextWindow, 32768);
});

test("boolean-only templates expose a toggle without invented effort parameters", () => {
  const thinking = templateThinking("{% if enable_thinking %}<think>{% endif %}");
  assert.equal(thinking.thinkingLevelMap?.high, "high");
  assert.equal(thinking.thinkingLevelMap?.low, null);
  assert.equal(thinking.compat?.chatTemplateKwargs?.reasoning_effort, undefined);
});

test("refreshes server sampling defaults with API field names", async () => {
  const props = { ...PROPS, default_generation_settings: { n_ctx: 131072, params: { n_predict: 2048, temperature: 0.7, top_p: 0.9, repeat_penalty: 1.1, repeat_last_n: 64 } } };
  const model = (await discover(strata(), { fetcher: routes([MODEL], props) })).models[0];
  assert.equal(model.maxTokens, 2048);
  assert.deepEqual(model.samplingParams, { temperature: 0.7, top_p: 0.9, repetition_penalty: 1.1, penalty_last_n: 64 });
});

test("unlimited server output removes a previously cached fixed cap", async () => {
  const previous = { ...await fixtureModel(), maxTokens: 512 };
  const model = (await discover(strata(), { previous: [previous], fetcher: routes() })).models[0];
  assert.equal(model.maxTokens, 16384);
});

test("model overrides merge compatibility and sampling without replacing server metadata", async () => {
  const props = { ...PROPS, default_generation_settings: { n_ctx: 131072, params: { temperature: 0.7, top_p: 0.9 } } };
  const config = strata({ defaults: { compat: { supportsUsageInStreaming: false }, samplingParams: { top_k: 20 } },
    modelOverrides: { [MODEL.id]: { maxTokens: 999999, samplingParams: { temperature: 1 } } } });
  const model = (await discover(config, { fetcher: routes([MODEL], props) })).models[0];
  assert.equal(model.maxTokens, model.contextWindow);
  assert.equal(model.compat?.supportsReasoningEffort, true);
  assert.equal(model.compat?.supportsUsageInStreaming, false);
  assert.deepEqual(model.samplingParams, { temperature: 1, top_p: 0.9, top_k: 20 });
});

test("deduplicates IDs and accepts successful empty catalogs", async () => {
  assert.equal((await discover(strata(), { fetcher: routes([MODEL, MODEL]) })).models.length, 1);
  assert.deepEqual((await discover(strata(), { fetcher: routes([]) })).models, []);
});

test("rejects malformed catalogs instead of treating errors as empty results", async () => {
  for (const data of [{}, { data: null }, { data: [null] }, { data: [{ id: "" }] }, { data: [{ id: 1 }] }]) {
    await assert.rejects(discover(strata(), { fetcher: fakeFetch({ "/v1/models": data }) }));
  }
});

test("retains cached capabilities when optional properties are unavailable", async () => {
  const previous = await fixtureModel();
  const result = await discover(strata(), { previous: [previous], fetcher: fakeFetch({ "/v1/models": { data: [MODEL] }, "/props": 503 }) });
  assert.equal(result.models[0].reasoning, true);
  assert.equal(result.models[0].compat?.supportsReasoningEffort, true);
  assert.ok(result.warnings.length);
});

test("honors cancellation before network access", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json({}); }) as Fetcher;
  await assert.rejects(discover(strata(), { fetcher, signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("auto detection recognizes Strata health metadata", async () => {
  const result = await discover(strata({ backend: "auto" }), { fetcher: routes() });
  assert.equal(result.backend, "strata");
  assert.equal(result.models[0].compat?.supportsReasoningEffort, true);
});

test("Ollama discovery uses configured context before training context", async () => {
  const fetcher = fakeFetch({ "/v1/models": { data: [{ id: "test-model" }] }, "/api/show": {
    capabilities: ["tools", "thinking", "vision"], parameters: "num_ctx 8192\n",
    model_info: { "test.context_length": 131072 }, details: { family: "gptoss" },
  } });
  const model = (await discover(strata({ backend: "ollama" }), { fetcher })).models[0];
  assert.equal(model.contextWindow, 8192);
  assert.equal(model.maxTokens, 2048);
  assert.equal(model.thinkingLevelMap?.low, "low");
  assert.deepEqual(model.input, ["text", "image"]);
});
