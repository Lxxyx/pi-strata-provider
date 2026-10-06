import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { agentDir, type Config } from "./config.ts";

type BootstrapRuntime = Pick<ModelRuntime, "registerNativeProvider" | "setRuntimeApiKey" | "refresh">;
type BootstrapDependencies = {
  createRuntime?: (options: Parameters<typeof ModelRuntime.create>[0]) => Promise<BootstrapRuntime>;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
};

function argument(name: string, argv: string[]): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

export async function bootstrapCatalog(provider: Provider, config: Config, dependencies: BootstrapDependencies = {}): Promise<void> {
  // Print mode and initial model selection only restore catalogs in Pi 1.0.4.
  // Seed the native provider before registration, using Pi's own locked store and credentials.
  const dir = agentDir();
  const argv = dependencies.argv ?? process.argv;
  const env = dependencies.env ?? process.env;
  const createRuntime = dependencies.createRuntime ?? ModelRuntime.create;
  const runtime = await createRuntime({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), allowModelNetwork: false });
  runtime.registerNativeProvider(provider);
  const model = argument("--model", argv);
  const providerArgument = argument("--provider", argv);
  const runtimeKey = argument("--api-key", argv);
  if (runtimeKey && (providerArgument === config.provider || model?.startsWith(`${config.provider}/`))) {
    await runtime.setRuntimeApiKey(config.provider, runtimeKey);
  }
  const offline = argv.includes("--offline") || /^(1|true|yes|on)$/i.test(env.PI_OFFLINE?.trim() ?? "");
  await runtime.refresh({ providers: [config.provider], allowNetwork: !offline,
    force: true, signal: AbortSignal.timeout(Math.min(15000, config.timeoutMs * 3)) });
}
