import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeConfig } from "../src/config.ts";
import { discover, type Fetcher, type JsonObject } from "../src/discovery.ts";
import { chatTemplateFromArgs, engineInstances, hostEndpoints, strataStateDirectories } from "../src/native.ts";

// Fixtures below are transcripts of a live Strata 0.1.63 host (Windows, CUDA engine).
// The gateway (port 8080) answers /v1/models but 404s /props; the engine (port 18500) still answers /props.
const TEMPLATE = "{% if reasoning_effort %}{% set effort = resolved_";
const CHAT_TEMPLATE = `{%- set effort = reasoning_effort | default('xhigh') %}{% if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}error{% endif %}`;
const GATEWAY_MODEL: JsonObject = {
  id: "iq3_xxs", object: "model", owned_by: "strata", status: { value: "loaded" },
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  context_length: 131072,
  meta: { instanceId: "97dcad2d", label: "Qwen3.8-Flash-Next IQ3_XXS", aliases: ["iq3_xxs"], n_ctx: 131072 },
};
const API_NATIVE: JsonObject = {
  available: true, engineInfo: { version: "0.1.63", source: null },
  instances: [{
    id: "97dcad2d", apiModelId: "iq3_xxs", model: "iq3_xxs", label: "Qwen3.8-Flash-Next IQ3_XXS",
    context: 131072, aliases: ["iq3_xxs"], vision: true, port: 18500, status: "ready", phase: "idle",
    metrics: { engine: { max_context: 131072, version: "0.1.63", images: true } },
  }],
};
const ENGINE_PROPS: JsonObject = {
  model_alias: "qwen3.8-flash-next-iq3_xxs", build_info: "Strata 0.1.63", models_autoload: true, total_slots: 1,
  default_generation_settings: { n_ctx: 131072, params: { temperature: 1, top_p: 0.95, top_k: 20, n_predict: -1 } },
  chat_template: CHAT_TEMPLATE, modalities: { vision: true },
  chat_template_caps: { supports_tools: true, supports_preserve_reasoning: true },
};

/** Fetcher keyed by absolute URL: the 0.1.63 layout has two servers on two ports. */
function urlFetch(routes: Record<string, JsonObject | number | ((init?: RequestInit) => JsonObject)>): Fetcher {
  return (async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    const key = `${url.origin}${url.pathname}${url.search}`;
    const value = routes[key] ?? routes[`${url.origin}${url.pathname}`] ?? routes[url.pathname + url.search] ?? routes[url.pathname] ?? 404;
    if (typeof value === "number") return new Response(JSON.stringify({ error: `HTTP ${value}` }), { status: value });
    return Response.json(typeof value === "function" ? value(init) : value);
  }) as Fetcher;
}

const live0163 = (extra: JsonObject = {}) => urlFetch({
  "http://127.0.0.1:8080/v1/models": { object: "list", data: [GATEWAY_MODEL] },
  "http://127.0.0.1:8080/api/native": API_NATIVE,
  "http://127.0.0.1:18500/props": ENGINE_PROPS,
  ...extra,
});

test("reads capabilities from the engine when the 0.1.63 gateway has no /props", async () => {
  const seen: string[] = [];
  const base = live0163();
  const fetcher: Fetcher = (input, init) => { seen.push(String(input)); return base(input, init); };
  const result = await discover(normalizeConfig({}), {
    fetcher,
    localState: { instances: [{ id: "97dcad2d", apiModelId: "iq3_xxs", aliases: ["iq3_xxs"], port: 18500, host: "127.0.0.1", apiKey: "engine-key", args: ["--pack", "F:\\strata\\packs\\iq3_xxs"] }], endpoints: [] },
  });
  const model = result.models[0];
  assert.equal(result.backend, "strata");
  assert.equal(result.warnings.length, 0, result.warnings.join("\n"));
  assert.equal(model.contextWindow, 131072);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.reasoning, true);
  assert.equal(model.compat?.supportsReasoningEffort, true);
  assert.equal(model.compat?.thinkingFormat, "openai");
  assert.deepEqual(model.thinkingLevelMap, { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
  assert.equal(model.maxTokens, 32768);
  assert.ok(seen.some(url => url.startsWith("http://127.0.0.1:18500/props")), "the engine port must be queried");
});

test("uses the engine API key of the instance that serves the model", async () => {
  const seen: (string | null)[] = [];
  const base = live0163();
  const fetcher: Fetcher = (input, init) => {
    if (String(input).includes(":18500")) seen.push(new Headers(init?.headers).get("authorization"));
    return base(input, init);
  };
  await discover(normalizeConfig({}), {
    fetcher,
    localState: { instances: [{ id: "97dcad2d", apiModelId: "iq3_xxs", port: 18500, host: "127.0.0.1", apiKey: "engine-key", args: [] }], endpoints: [] },
  });
  assert.deepEqual(seen, ["Bearer engine-key"]);
});

test("falls back to the chat template on disk when neither server exposes properties", async () => {
  const routes = urlFetch({
    "http://127.0.0.1:8080/v1/models": { object: "list", data: [GATEWAY_MODEL] },
    "http://127.0.0.1:8080/api/native": { available: true, engineInfo: { version: "0.1.63" }, instances: [{ id: "97dcad2d", apiModelId: "iq3_xxs", port: 18500, status: "ready", metrics: { engine: { max_context: 131072 } } }] },
  });
  const result = await discover(normalizeConfig({ capabilityProbe: false }), {
    fetcher: routes,
    localState: {
      instances: [{ id: "97dcad2d", apiModelId: "iq3_xxs", port: 18500, host: "127.0.0.1", args: ["--pack", "F:\\strata\\packs\\iq3_xxs", "--max-context", "131072"] }],
      endpoints: [],
      templates: async () => CHAT_TEMPLATE,
    },
  });
  assert.equal(result.models[0].reasoning, true);
  assert.equal(result.models[0].compat?.supportsReasoningEffort, true);
  assert.equal(result.models[0].thinkingLevelMap?.xhigh, "xhigh");
});

test("probes a tiny reasoning request when properties and templates are unavailable", async () => {
  const bodies: JsonObject[] = [];
  const routes: Record<string, JsonObject | number | ((init?: RequestInit) => JsonObject)> = {
    "http://127.0.0.1:8080/v1/models": { object: "list", data: [GATEWAY_MODEL] },
    "http://127.0.0.1:8080/api/native": 404,
    "http://127.0.0.1:8080/v1/chat/completions": (init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { choices: [{ message: { role: "assistant", content: "17", reasoning_content: "thinking…" } }] };
    },
  };
  const result = await discover(normalizeConfig({}), { fetcher: urlFetch(routes as Record<string, JsonObject | number | ((init?: RequestInit) => JsonObject)>), apiKey: "k" });
  assert.equal(result.models[0].reasoning, true);
  assert.equal(result.models[0].compat?.supportsReasoningEffort, true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].reasoning_effort, "high");
  assert.ok((bodies[0].max_tokens as number) <= 256, "the capability probe must stay tiny");
  assert.ok(result.warnings.some(w => /probe/i.test(w)), result.warnings.join("\n"));
});

test("never invents reasoning when the probe is disabled or answers nothing", async () => {
  const silent = urlFetch({
    "http://127.0.0.1:8080/v1/models": { object: "list", data: [GATEWAY_MODEL] },
    "http://127.0.0.1:8080/v1/chat/completions": { choices: [{ message: { role: "assistant", content: "17" } }] },
  });
  const probed = await discover(normalizeConfig({}), { fetcher: silent });
  assert.equal(probed.models[0].reasoning, false);

  const disabled = await discover(normalizeConfig({ capabilityProbe: false }), {
    fetcher: urlFetch({ "http://127.0.0.1:8080/v1/models": { object: "list", data: [GATEWAY_MODEL] } }),
  });
  assert.equal(disabled.models[0].reasoning, false);
});

test("reads the model context from gateway fields when meta is absent", async () => {
  const model = { id: "m", status: { value: "loaded" }, context_length: 65536 };
  const result = await discover(normalizeConfig({ capabilityProbe: false }), {
    fetcher: urlFetch({ "http://127.0.0.1:8080/v1/models": { object: "list", data: [model] } }),
  });
  assert.equal(result.models[0].contextWindow, 65536);
  assert.equal(result.models[0].maxTokens, 16384, "a 64K model must not reserve a 32K answer");
});

test("reads engine instance ports and keys from ~/.strata state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "strata-state-"));
  try {
    await mkdir(join(dir, "data", "native-instances"), { recursive: true });
    await writeFile(join(dir, "data", "native-instances", "97dcad2d.json"), JSON.stringify({
      id: "97dcad2d", api_key: "engine-key", port: 18500, host: "127.0.0.1", model_id: "iq3_xxs",
      apiModelId: "iq3_xxs", aliases: ["iq3_xxs"], args: ["--pack", "F:/strata/packs/iq3_xxs", "--max-context", "131072"],
    }));
    await writeFile(join(dir, "data", "native-instances", "drafting-1.json"), JSON.stringify({ port: 19999, args: [] }));
    const instances = await engineInstances([dir]);
    assert.equal(instances.length, 1);
    assert.deepEqual(instances[0], { id: "97dcad2d", apiModelId: "iq3_xxs", model: "iq3_xxs", modelPath: undefined, aliases: ["iq3_xxs"], port: 18500, host: "127.0.0.1", apiKey: "engine-key", args: ["--pack", "F:/strata/packs/iq3_xxs", "--max-context", "131072"] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reads the gateway URL and its key from Strata launch state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "strata-launch-"));
  try {
    await mkdir(join(dir, "launch"), { recursive: true });
    await writeFile(join(dir, "launch", "iq3_xxs-128k.json"), JSON.stringify({ api_key: "sk-strata-1", port: 8080, host: "127.0.0.1", model_name: "qwen3.8-flash-next-iq3_xxs" }));
    assert.deepEqual(await hostEndpoints([dir]), [{ baseUrl: "http://127.0.0.1:8080/v1", apiKey: "sk-strata-1", source: join(dir, "launch", "iq3_xxs-128k.json") }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("finds the chat template shipped with the model pack", async () => {
  const dir = await mkdtemp(join(tmpdir(), "strata-pack-"));
  try {
    await mkdir(join(dir, "tokenizer"), { recursive: true });
    await writeFile(join(dir, "tokenizer", "chat_template.jinja"), CHAT_TEMPLATE);
    assert.equal(await chatTemplateFromArgs([dir], ["--pack", dir.replace(/\//g, "\\"), "--max-context", "131072"]), CHAT_TEMPLATE);
    assert.equal(await chatTemplateFromArgs([dir], ["--native", "F:/strata/models/x.gguf"]), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("registers under the Strata provider id so an existing Strata selection keeps working", () => {
  assert.equal(normalizeConfig({}).provider, "strata");
  assert.equal(normalizeConfig({ provider: "local" }).provider, "local");
});

test("local state directories honor STRATA_HOME and stay bounded", () => {
  const dirs = strataStateDirectories({ STRATA_HOME: "F:/strata-home", HOME: "/home/user", LOCALAPPDATA: "C:/Users/x/AppData/Local" }, "linux");
  assert.ok(dirs.includes(resolve("F:/strata-home")), dirs.join(", "));
  assert.ok(dirs.length <= 4);
});

test("a protected gateway reports authentication as required without leaking the key", async () => {
  const result = await discover(normalizeConfig({ capabilityProbe: false }), {
    fetcher: urlFetch({ "http://127.0.0.1:8080/v1/models": { object: "list", data: [GATEWAY_MODEL] }, "http://127.0.0.1:8080/props": 401 }),
    apiKey: "secret-value",
  });
  assert.equal(result.authenticationRequired, true);
  assert.ok(!JSON.stringify(result.warnings).includes("secret-value"));
});

test("keeps the probe and property requests off remote hosts unless they are the configured endpoint", async () => {
  const result = await discover(normalizeConfig({ baseUrl: "https://strata.example.com/v1", capabilityProbe: false, readLocalState: false }), {
    fetcher: urlFetch({ "https://strata.example.com/v1/models": { object: "list", data: [GATEWAY_MODEL] } }),
  });
  assert.equal(result.models[0].reasoning, false);
  assert.equal(await readFile(join(tmpdir(), "definitely-not-a-strata-state"), "utf8").catch(() => ""), "");
  assert.ok(strataStateDirectories({}).length >= 1);
});
