import assert from "node:assert/strict";
import test from "node:test";
import type { ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import { normalizeConfig, type LocalModel } from "../src/config.ts";
import { createStrataProvider } from "../src/provider.ts";
import { chooseModel, compactionPreset } from "../src/tuning.ts";

const model: LocalModel = { id: "test-model", name: "test-model", provider: "local", api: "openai-completions", baseUrl: "http://127.0.0.1:8080/v1", input: ["text"], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 16384 };
function context(extra: Partial<RefreshModelsContext> = {}, publications: ModelsPublication[] = []): RefreshModelsContext {
  return { allowNetwork: false, signal: new AbortController().signal,
    publish: async publication => { publications.push(publication); publication.update?.(); return true; }, ...extra };
}

test("restores cached models without network access", async () => {
  let calls = 0;
  const { provider, status } = createStrataProvider(normalizeConfig({}), { fetcher: async () => { calls++; throw new Error("unexpected"); } });
  await provider.refreshModels!(context({ stored: { models: [model], checkedAt: 1 } }));
  assert.equal(calls, 0);
  assert.equal(provider.getModels()[0].id, model.id);
  assert.equal(status.source, "cache");
});

test("does not restore another server's cached catalog", async () => {
  const { provider } = createStrataProvider(normalizeConfig({ baseUrl: "http://localhost:8081/v1" }));
  await provider.refreshModels!(context({ stored: { models: [model], checkedAt: 1 } }));
  assert.equal(provider.getModels().length, 0);
});

test("keeps the last successful catalog on a failed refresh", async () => {
  const { provider, status } = createStrataProvider(normalizeConfig({}), { fetcher: async () => new Response("{}", { status: 401 }) });
  await provider.refreshModels!(context({ stored: { models: [model], checkedAt: 1 } }));
  await assert.rejects(provider.refreshModels!(context({ allowNetwork: true })), /HTTP 401/);
  assert.equal(provider.getModels()[0].id, model.id);
  assert.match(status.lastError!, /STRATA_API_KEY/);
});

test("publishes a successful empty catalog so removed models disappear", async () => {
  const { provider } = createStrataProvider(normalizeConfig({}), { fetcher: async () => Response.json({ data: [] }) });
  await provider.refreshModels!(context({ stored: { models: [model], checkedAt: 1 } }));
  const publications: ModelsPublication[] = [];
  await provider.refreshModels!(context({ allowNetwork: true }, publications));
  assert.equal(provider.getModels().length, 0);
  assert.deepEqual(publications[0].persist?.models, []);
});

test("rejects superseded publications without swapping live state", async () => {
  const { provider } = createStrataProvider(normalizeConfig({}), { fetcher: async () => Response.json({ data: [] }) });
  await provider.refreshModels!(context({ stored: { models: [model], checkedAt: 1 } }));
  await provider.refreshModels!(context({ allowNetwork: true, publish: async () => false }));
  assert.equal(provider.getModels().length, 1);
});

test("continues with live metadata when the model store is read-only", async () => {
  const { provider, status } = createStrataProvider(normalizeConfig({}), { fetcher: async () => Response.json({ data: [] }) });
  await provider.refreshModels!(context({ stored: { models: [model], checkedAt: 1 } }));
  await provider.refreshModels!(context({ allowNetwork: true, publish: async publication => {
    if (publication.persist) throw new Error("read-only");
    publication.update?.(); return true;
  } }));
  assert.equal(provider.getModels().length, 0);
  assert.equal(status.source, "live");
  assert.equal(status.warnings.length, 1);
});

test("aborted refreshes do not overwrite or persist cached state", async () => {
  const { provider } = createStrataProvider(normalizeConfig({}));
  await provider.refreshModels!(context({ stored: { models: [model], checkedAt: 1 } }));
  const controller = new AbortController(); controller.abort();
  const publications: ModelsPublication[] = [];
  await provider.refreshModels!(context({ allowNetwork: true, signal: controller.signal }, publications));
  assert.equal(provider.getModels().length, 1);
  assert.equal(publications.length, 0);
});

test("keyless servers have usable native authentication with a placeholder", async () => {
  const { provider } = createStrataProvider(normalizeConfig({}));
  const auth = await provider.auth.apiKey!.resolve({ ctx: { env: async () => undefined } as any, signal: new AbortController().signal });
  assert.equal(auth?.auth.apiKey, "strata-local");
});

test("stored credentials take precedence over environment and inline keys", async () => {
  const { provider } = createStrataProvider(normalizeConfig({ apiKey: "inline" }));
  const auth = await provider.auth.apiKey!.resolve({ ctx: { env: async () => "environment" } as any,
    credential: { type: "api_key", key: "stored" }, signal: new AbortController().signal });
  assert.equal(auth?.auth.apiKey, "stored");
});

test("compaction reserves output headroom and retains useful recent history", () => {
  assert.deepEqual(compactionPreset(model), { reserveTokens: 32768, keepRecentTokens: 20000 });
  assert.deepEqual(compactionPreset({ contextWindow: 32768, maxTokens: 8192 }), { reserveTokens: 12288, keepRecentTokens: 8192 });
});

test("automatic routing stays sticky while supporting changed model IDs", () => {
  const other = { ...model, id: "new-model", input: ["text", "image"] as ("text" | "image")[] };
  assert.equal(chooseModel([model, other], other.id).id, other.id);
  assert.equal(chooseModel([other], model.id).id, other.id);
  assert.equal(chooseModel([model, other], undefined, true).id, other.id);
  assert.throws(() => chooseModel([], undefined), /Start the server/);
});
