import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../index.ts";
import { explainStrataError } from "../src/errors.ts";

async function harness(fn: (state: any) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "strata-command-test-"));
  const before = { agent: process.env.PI_CODING_AGENT_DIR, config: process.env.PI_STRATA_CONFIG, base: process.env.PI_STRATA_BASE_URL };
  process.env.PI_CODING_AGENT_DIR = dir; delete process.env.PI_STRATA_CONFIG; delete process.env.PI_STRATA_BASE_URL;
  await writeFile(join(dir, "strata-provider.json"), JSON.stringify({ apiKey: "do-not-display-this-secret" }));
  const state: any = { dir, notices: [], handlers: {}, reloads: 0, selected: "Status", input: "http://localhost:8081" };
  const api: any = {
    registerProvider: (provider: any) => { state.provider = provider; },
    registerVirtualModel: (definition: any) => { state.virtual = definition; },
    registerCommand: (_name: string, command: any) => { state.command = command; },
    on: (name: string, handler: any) => { state.handlers[name] = handler; },
    setModel: async (model: any) => { state.selection = model; return true; },
  };
  await extension(api);
  state.context = {
    hasUI: true,
    ui: { notify: (message: string, kind: string) => state.notices.push({ message, kind }), select: async () => state.selected, input: async () => state.input },
    waitForIdle: async () => {}, reload: async () => { state.reloads++; },
    modelRegistry: { refresh: async () => ({ errors: new Map(), aborted: false }), find: () => ({ provider: "local", id: "strata-auto" }) },
  };
  try { await fn(state); }
  finally {
    for (const [name, value] of [["PI_CODING_AGENT_DIR", before.agent], ["PI_STRATA_CONFIG", before.config], ["PI_STRATA_BASE_URL", before.base]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("the menu opens and key help never displays configured secrets", async () => {
  await harness(async state => {
    state.selected = "API key help";
    await state.command.handler("", state.context);
    assert.match(state.notices[0].message, /\/login/);
    assert.ok(!state.notices[0].message.includes("do-not-display-this-secret"));
    await state.command.handler("status", state.context);
    assert.ok(!state.notices[1].message.includes("do-not-display-this-secret"));
  });
});

test("connection setup preserves encoding markers and other configuration", async () => {
  await harness(async state => {
    const path = join(state.dir, "strata-provider.json");
    await writeFile(path, '\uFEFF{\r\n  "apiKeyEnv": "CUSTOM_KEY"\r\n}\r\n');
    await state.command.handler("url", state.context);
    const output = await readFile(path, "utf8");
    assert.ok(output.startsWith("\uFEFF"));
    assert.ok(output.includes("\r\n"));
    const config = JSON.parse(output.slice(1));
    assert.equal(config.apiKeyEnv, "CUSTOM_KEY");
    assert.equal(config.baseUrl, "http://localhost:8081/v1");
    assert.equal(state.reloads, 1);
  });
});

test("recommended setup changes only local model presets and startup selection", async () => {
  await harness(async state => {
    const settingsPath = join(state.dir, "settings.json");
    const cloud = { reserveTokens: 12345 };
    await writeFile(settingsPath, JSON.stringify({ packages: ["existing-package"], theme: "dark", compaction: { modelOverrides: { "cloud/model": cloud } } }));
    const cached = { provider: "local", api: "openai-completions", baseUrl: "http://127.0.0.1:8080/v1", id: "example-model", name: "example-model", input: ["text"], contextWindow: 131072, maxTokens: 16384, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    await state.provider.refreshModels({ allowNetwork: false, signal: new AbortController().signal, stored: { models: [cached], checkedAt: 1 }, publish: async (publication: any) => { publication.update?.(); return true; } });
    await state.command.handler("setup", state.context);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.defaultProvider, "local");
    assert.equal(settings.defaultModel, "strata-auto");
    assert.deepEqual(settings.compaction.modelOverrides["cloud/model"], cloud);
    assert.deepEqual(settings.compaction.modelOverrides["local/example-model"], { reserveTokens: 32768, keepRecentTokens: 20000 });
    assert.deepEqual(settings.packages, ["existing-package"]);
    assert.equal(settings.theme, "dark");
    assert.equal(state.selection.id, "strata-auto");
    assert.equal(state.reloads, 1);
  });
});

test("failed catalog refresh gives actionable guidance without discarding state", async () => {
  await harness(async state => {
    state.context.modelRegistry.refresh = async () => ({ errors: new Map([["local", new Error("HTTP 401. Configure STRATA_API_KEY.")]]) });
    await state.command.handler("refresh", state.context);
    assert.equal(state.notices[0].kind, "warning");
    assert.match(state.notices[0].message, /last successful catalog/);
    assert.match(state.notices[0].message, /STRATA_API_KEY/);
  });
});

test("malformed configuration is not rewritten or quoted in an error", async () => {
  await harness(async state => {
    const path = join(state.dir, "strata-provider.json");
    const broken = '{"apiKey":"secret",broken';
    await writeFile(path, broken);
    await state.command.handler("url", state.context);
    assert.equal(await readFile(path, "utf8"), broken);
    assert.equal(state.notices[0].kind, "error");
    assert.ok(!state.notices[0].message.includes("secret"));
  });
});

test("provider errors are normalized without rewriting unrelated failures", () => {
  assert.match(explainStrataError("401 missing or wrong API key"), /\/login/);
  assert.match(explainStrataError("403 untrusted host"), /allowed_hosts/);
  assert.match(explainStrataError("prompt + max tokens exceeds the context"), /context_length_exceeded/);
  assert.match(explainStrataError("503 engine is starting"), /finish loading/);
  assert.match(explainStrataError("ECONNREFUSED"), /URL and port/);
  assert.equal(explainStrataError("unrelated failure"), "unrelated failure");
});
