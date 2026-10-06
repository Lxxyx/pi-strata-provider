import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";

export type LocalModel = Model<"openai-completions">;
export type ModelOverride = Partial<Omit<LocalModel, "id" | "provider" | "api" | "baseUrl">>;
export interface Config {
  provider: string;
  baseUrl: string;
  backend: "strata" | "auto" | "llama-cpp" | "ollama" | "openai";
  apiKey?: string;
  apiKeyEnv: string;
  timeoutMs: number;
  concurrency: number;
  defaultContextWindow: number;
  defaultMaxTokens: number;
  defaults: ModelOverride;
  modelOverrides: Record<string, ModelOverride>;
}

export const DEFAULT_CONFIG: Config = {
  provider: "local",
  baseUrl: "http://127.0.0.1:8080/v1",
  backend: "strata",
  apiKeyEnv: "STRATA_API_KEY",
  timeoutMs: 4000,
  concurrency: 4,
  defaultContextWindow: 32768,
  defaultMaxTokens: 16384,
  defaults: {},
  modelOverrides: {},
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeConfig(raw: unknown): Config {
  if (!record(raw)) throw new Error("Strata provider configuration must be an object.");
  const config = { ...DEFAULT_CONFIG, ...raw } as Config;
  const allowed = new Set(Object.keys(DEFAULT_CONFIG).concat("apiKey"));
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`Unknown Strata provider option: ${key}`);
  }
  if (typeof config.provider !== "string" || !/^[a-zA-Z0-9._-]+$/.test(config.provider)) {
    throw new Error("Provider ID may contain only letters, digits, dots, underscores and hyphens.");
  }
  if (typeof config.baseUrl !== "string") throw new Error("Base URL must be a string.");
  const url = new URL(config.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Base URL must use HTTP(S) without credentials, query parameters or fragments.");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
  config.baseUrl = url.toString().replace(/\/+$/, "");
  if (!["strata", "auto", "llama-cpp", "ollama", "openai"].includes(config.backend)) {
    throw new Error("Backend must be strata, auto, llama-cpp, ollama or openai.");
  }
  for (const key of ["timeoutMs", "concurrency", "defaultContextWindow", "defaultMaxTokens"] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Option must be a positive integer: ${key}`);
  }
  if (config.timeoutMs > 60000 || config.concurrency > 16) throw new Error("Timeout must not exceed 60000 ms and concurrency must not exceed 16.");
  if (typeof config.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) {
    throw new Error("Invalid API key environment variable name.");
  }
  if (config.apiKey !== undefined && typeof config.apiKey !== "string") throw new Error("API key must be a string.");
  if (!record(config.defaults) || !record(config.modelOverrides)) throw new Error("Defaults and model overrides must be objects.");
  for (const override of [config.defaults, ...Object.values(config.modelOverrides)]) {
    if (!record(override)) throw new Error("Each model override must be an object.");
    for (const key of ["id", "provider", "api", "baseUrl"]) {
      if (key in override) throw new Error(`Model identity and endpoint cannot be overridden: ${key}`);
    }
    for (const key of ["contextWindow", "maxTokens"] as const) {
      if (key in override && (!Number.isSafeInteger(override[key]) || Number(override[key]) < 1)) {
        throw new Error(`Overridden token limits must be positive integers: ${key}`);
      }
    }
    if ("reasoning" in override && typeof override.reasoning !== "boolean") throw new Error("Reasoning override must be a boolean.");
    if ("input" in override && (!Array.isArray(override.input) || !override.input.length || override.input.some(x => x !== "text" && x !== "image"))) {
      throw new Error("Input must contain text and/or image.");
    }
    for (const key of ["compat", "thinkingLevelMap", "inputLimits", "cost", "samplingParams", "samplingParamsByThinkingLevel"] as const) {
      if (key in override && !record(override[key])) throw new Error(`Model override must be an object: ${key}`);
    }
  }
  return config;
}

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function configPath(): string {
  return process.env.PI_STRATA_CONFIG || join(agentDir(), "strata-provider.json");
}

export async function loadConfig(): Promise<Config> {
  const path = configPath();
  let raw: unknown = {};
  try {
    raw = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read Strata provider configuration. Check its JSON syntax.", { cause: error });
    if (process.env.PI_STRATA_CONFIG) throw new Error("The specified Strata provider configuration file does not exist.");
  }
  const config = normalizeConfig(raw);
  if (process.env.PI_STRATA_BASE_URL) return normalizeConfig({ ...config, baseUrl: process.env.PI_STRATA_BASE_URL });
  return config;
}
