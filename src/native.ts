import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { agentDir } from "./config.ts";

type JsonObject = Record<string, any>;

/** One running Strata engine: its own OpenAI-compatible port and its own key. */
export interface EngineInstance {
  id: string;
  apiModelId?: string;
  model?: string;
  modelPath?: string;
  aliases?: string[];
  host: string;
  port: number;
  apiKey?: string;
  args: string[];
}

/** The Strata host gateway URL together with the key Strata itself uses. */
export interface HostEndpoint {
  baseUrl: string;
  apiKey?: string;
  source: string;
}

export interface LocalStrataState {
  instances: EngineInstance[];
  endpoints: HostEndpoint[];
  /** Chat templates Strata already shipped with the model pack, keyed by engine arguments. */
  templates?: (args: string[]) => Promise<string | undefined>;
}

const MAX_STATE_BYTES = 4 * 1024 * 1024;

/**
 * Where Strata keeps its own state. `~/.strata` holds the host store (native-instances), while Windows
 * keeps launch profiles under %LOCALAPPDATA%\Strata. STRATA_HOME overrides both.
 */
export function strataStateDirectories(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const dirs = new Set<string>();
  if (env.STRATA_HOME) {
    dirs.add(resolve(env.STRATA_HOME));
    dirs.add(join(resolve(env.STRATA_HOME), "runtime"));
    return [...dirs];
  }
  const home = env.HOME || homedir();
  dirs.add(join(home, ".strata"));
  if (platform === "win32" && env.LOCALAPPDATA) dirs.add(join(env.LOCALAPPDATA, "Strata"));
  else if (platform === "darwin") dirs.add(join(home, "Library", "Application Support", "Strata"));
  else if (env.XDG_DATA_HOME) dirs.add(join(env.XDG_DATA_HOME, "strata"));
  return [...dirs];
}

async function readJson(path: string): Promise<JsonObject | undefined> {
  try {
    const stat = await readFile(path);
    if (stat.byteLength > MAX_STATE_BYTES) return undefined;
    const value = JSON.parse(stat.toString("utf8").replace(/^\uFEFF/, ""));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

async function jsonFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => join(directory, entry.name)).sort();
  } catch {
    return [];
  }
}

function port(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 && number < 65536 ? number : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return items.length ? items : undefined;
}

function instanceFrom(record: JsonObject, source: string): EngineInstance | undefined {
  const portNumber = port(record.port ?? record.api_port);
  if (portNumber === undefined) return undefined;
  const id = text(record.id) ?? text(record.instance_id) ?? source;
  return {
    id,
    apiModelId: text(record.apiModelId) ?? text(record.api_model_id) ?? text(record.model_id),
    model: text(record.model_id) ?? text(record.model),
    modelPath: text(record.native) ?? text(record.model_path) ?? text(record.gguf),
    aliases: stringList(record.aliases),
    host: text(record.host) ?? "127.0.0.1",
    port: portNumber,
    apiKey: text(record.api_key) ?? text(record.apiKey),
    args: stringList(record.args) ?? [],
  };
}

/** Instances Strata launched itself: `~/.strata/data/native-instances/*.json` (draft probes are not engines). */
export async function engineInstances(dirs: readonly string[]): Promise<EngineInstance[]> {
  const found = new Map<string, EngineInstance>();
  for (const directory of dirs) {
    for (const candidate of [join(directory, "data", "native-instances"), join(directory, "native-instances")]) {
      for (const file of await jsonFiles(candidate)) {
        if (/draft|probe|tmp/i.test(file.split(/[\\/]/).pop() ?? "")) continue;
        const record = await readJson(file);
        if (!record) continue;
        const instance = instanceFrom(record, file);
        if (instance && !found.has(instance.id)) found.set(instance.id, instance);
      }
    }
  }
  return [...found.values()];
}

/** Launch profiles (`AppData\Local\Strata\launch\*.json` on Windows) carry the gateway URL and its key. */
export async function hostEndpoints(dirs: readonly string[]): Promise<HostEndpoint[]> {
  const found = new Map<string, HostEndpoint>();
  for (const directory of dirs) {
    for (const file of await jsonFiles(join(directory, "launch"))) {
      const record = await readJson(file);
      if (!record) continue;
      const urlPort = port(record.port);
      const apiKey = text(record.api_key);
      if (urlPort === undefined || !apiKey) continue;
      const host = text(record.host) ?? "127.0.0.1";
      const endpoint: HostEndpoint = { baseUrl: `http://${host}:${urlPort}/v1`, apiKey, source: file };
      if (!found.has(endpoint.baseUrl)) found.set(endpoint.baseUrl, endpoint);
    }
  }
  for (const file of await jsonFiles(join(agentDir(), "launch"))) {
    const record = await readJson(file);
    if (!record) continue;
    const urlPort = port(record.port);
    const apiKey = text(record.api_key);
    if (urlPort === undefined || !apiKey) continue;
    const endpoint: HostEndpoint = { baseUrl: `http://${text(record.host) ?? "127.0.0.1"}:${urlPort}/v1`, apiKey, source: file };
    if (!found.has(endpoint.baseUrl)) found.set(endpoint.baseUrl, endpoint);
  }
  return [...found.values()];
}

/** Value of a `--flag <value>` style engine argument. */
export function argumentValue(args: readonly string[], ...flags: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (flags.includes(args[index])) return args[index + 1];
    for (const flag of flags) {
      if (args[index].startsWith(`${flag}=`)) return args[index].slice(flag.length + 1);
    }
  }
  return undefined;
}

const TEMPLATE_FILES = ["tokenizer/chat_template.jinja", "chat_template.jinja", "tokenizer/chat_template.json", "config.json", "huggingface/config.json"];

/**
 * Strata unpacks a model pack with the tokenizer's chat template next to it, so the thinking contract is
 * readable without contacting a running engine or loading the model.
 */
export async function chatTemplateFromArgs(dirs: readonly string[], args: readonly string[]): Promise<string | undefined> {
  const pack = argumentValue(args, "--pack", "--model-dir", "--dir");
  if (!pack) return undefined;
  const candidates = [pack];
  if (!isAbsolute(pack)) for (const directory of dirs) candidates.push(join(directory, pack));
  for (const root of candidates) {
    for (const relative of TEMPLATE_FILES) {
      const record = await readJson(join(root, relative));
      if (record && typeof record.chat_template === "string") return record.chat_template;
    }
    const plain = await readText(join(root, "tokenizer", "chat_template.jinja"), join(root, "chat_template.jinja"));
    if (plain) return plain;
  }
  return undefined;
}

async function readText(...paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      const value = await readFile(path, "utf8");
      if (value.trim()) return value;
    } catch {
      // Missing or unreadable: the next candidate or the server's own answer decides.
    }
  }
  return undefined;
}

/** Best-effort view of the local Strata installation. Never throws: a missing install is not an error. */
export async function localStrataState(): Promise<LocalStrataState> {
  const dirs = strataStateDirectories();
  const instances = await engineInstances(dirs);
  const endpoints = await hostEndpoints(dirs);
  return { instances, endpoints, templates: args => chatTemplateFromArgs(dirs, args) };
}
