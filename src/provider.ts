import type { Provider, ProviderStreams, RefreshModelsContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { Config, LocalModel } from "./config.ts";
import { applyOverrides, discover, type Fetcher } from "./discovery.ts";

export interface ProviderStatus {
  backend: string;
  models: number;
  source: "empty" | "cache" | "live";
  checkedAt?: number;
  authenticationRequired?: boolean;
  warnings: string[];
  lastError?: string;
}

export function createStrataProvider(config: Config, dependencies: { fetcher?: Fetcher; streams?: ProviderStreams } = {}) {
  const streams = dependencies.streams ?? openAICompletionsApi();
  let models: readonly LocalModel[] = [];
  const status: ProviderStatus = { backend: config.backend, models: 0, source: "empty", warnings: [] };
  const provider: Provider<"openai-completions"> = {
    id: config.provider,
    name: "Strata",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "Strata API key (optional)",
        login: async interaction => ({
          type: "api_key",
          key: (await interaction.prompt({ type: "secret", message: "Strata API key (leave blank for a keyless local server)" })).trim() || undefined,
        }),
        resolve: async ({ ctx, credential }) => {
          const key = credential?.key ?? await ctx.env(config.apiKeyEnv) ?? config.apiKey ?? "strata-local";
          return {
            auth: { apiKey: key, baseUrl: config.baseUrl },
            source: credential?.key ? "stored API key" : key === "strata-local" ? "keyless local server" : "configured API key",
          };
        },
      },
    },
    getModels: () => models,
    refreshModels: async (context: RefreshModelsContext) => {
      // A cache from a different server must never be used at this endpoint.
      if (!context.allowNetwork && context.stored) {
        const restored = context.stored.models.filter((model): model is LocalModel =>
          (model.type === undefined || model.type === "chat") &&
          model.provider === config.provider && model.api === "openai-completions" && model.baseUrl === config.baseUrl &&
          typeof model.id === "string" && typeof model.contextWindow === "number" && model.contextWindow > 0 &&
          typeof model.maxTokens === "number" && model.maxTokens > 0 && Array.isArray(model.input)
        ).map(model => applyOverrides(model, config.defaults, config.modelOverrides[model.id] ?? {}));
        if (!(await context.publish({ update: () => {
          models = restored;
          Object.assign(status, { source: "cache", models: models.length, checkedAt: context.stored?.checkedAt });
        } }))) return;
      }
      if (!context.allowNetwork || context.signal.aborted) return;
      try {
        const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
        const result = await discover(config, { apiKey, signal: context.signal, previous: models, fetcher: dependencies.fetcher });
        if (context.signal.aborted) return;
        const checkedAt = Date.now();
        const update = () => {
          models = result.models;
          Object.assign(status, {
            backend: result.backend, models: models.length, source: "live", checkedAt,
            authenticationRequired: result.authenticationRequired, warnings: result.warnings, lastError: undefined,
          });
        };
        try {
          await context.publish({ persist: { models: result.models, checkedAt }, update });
        } catch {
          // A read-only model store must not prevent using a successful live refresh.
          result.warnings.push("Could not persist the catalog; the live catalog remains available for this session.");
          await context.publish({ update });
        }
      } catch (error) {
        if (context.signal.aborted) return;
        status.lastError = error instanceof Error ? error.message : "Strata catalog refresh failed.";
        throw error;
      }
    },
    stream: (model, context, options) => streams.stream(model, context, options),
    streamSimple: (model, context, options) => streams.streamSimple(model, context, options),
  };
  return { provider, status };
}
