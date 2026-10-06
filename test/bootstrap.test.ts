import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapCatalog } from "../src/bootstrap.ts";
import { normalizeConfig } from "../src/config.ts";
import { createStrataProvider } from "../src/provider.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

async function bootstrap(argv: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const config = normalizeConfig({});
  const { provider } = createStrataProvider(config);
  const calls: Array<[string, unknown]> = [];
  await bootstrapCatalog(provider, config, {
    argv, env,
    createRuntime: async options => {
      calls.push(["create", options]);
      return {
        registerNativeProvider: registered => { assert.equal(registered, provider); calls.push(["register", registered.id]); },
        setRuntimeApiKey: async (id, key) => { calls.push(["key", { id, key }]); },
        refresh: async options => { calls.push(["refresh", options]); return { aborted: false, errors: new Map() }; },
      } satisfies Pick<ModelRuntime, "registerNativeProvider" | "setRuntimeApiKey" | "refresh">;
    },
  });
  return calls;
}

test("bootstraps the native catalog before registration without cloud network access", async () => {
  const calls = await bootstrap();
  assert.deepEqual(calls.map(([name]) => name), ["create", "register", "refresh"]);
  const create = calls[0][1] as Record<string, unknown>;
  assert.equal(create.allowModelNetwork, false);
  assert.match(String(create.authPath), /auth\.json$/);
  assert.match(String(create.modelsPath), /models\.json$/);
  const refresh = calls.at(-1)![1] as Record<string, unknown>;
  assert.deepEqual(refresh.providers, ["local"]);
  assert.equal(refresh.allowNetwork, true);
  assert.equal(refresh.force, true);
  assert.ok(refresh.signal instanceof AbortSignal);
});

test("offline startup restores caches without discovery network access", async () => {
  for (const [argv, env] of [[ ["--offline"], {} ], [ [], { PI_OFFLINE: "1" } ], [ [], { PI_OFFLINE: "true" } ]] as const) {
    const calls = await bootstrap([...argv], env);
    assert.equal((calls.at(-1)![1] as Record<string, unknown>).allowNetwork, false);
  }
  const calls = await bootstrap([], { PI_OFFLINE: "false" });
  assert.equal((calls.at(-1)![1] as Record<string, unknown>).allowNetwork, true);
});

test("an explicitly local CLI runtime key also authenticates startup discovery", async () => {
  for (const argv of [["--model", "local/strata-auto", "--api-key", "runtime-test-key"], ["--provider=local", "--api-key=runtime-test-key"]]) {
    const calls = await bootstrap(argv);
    assert.deepEqual(calls.find(([name]) => name === "key")?.[1], { id: "local", key: "runtime-test-key" });
  }
});

test("never forwards another provider's CLI runtime key to the Strata endpoint", async () => {
  const calls = await bootstrap(["--model", "openai/test-model", "--api-key", "other-provider-test-key"]);
  assert.ok(!calls.some(([name]) => name === "key"));
});
