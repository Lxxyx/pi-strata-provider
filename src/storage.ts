import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { agentDir, configPath, normalizeConfig, type Config, type LocalModel } from "./config.ts";
import { AUTO_MODEL_ID, compactionPreset } from "./tuning.ts";

async function mutateJson(path: string, mutation: (value: Record<string, any>) => void): Promise<void> {
  await withFileMutationQueue(path, async () => {
    let original = "";
    let value: Record<string, any> = {};
    try {
      original = await readFile(path, "utf8");
      try { value = JSON.parse(original.replace(/^\uFEFF/, "")); }
      catch { throw new Error("Cannot update configuration: invalid JSON. The original file was left untouched."); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    mutation(value);
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
    const indent = original.match(/\n([ \t]+)"/)?.[1] ?? "  ";
    const content = bom + (JSON.stringify(value, null, indent) + "\n").replace(/\n/g, newline);
    await mkdir(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.strata-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
      await rename(temp, path);
    } finally { await rm(temp, { force: true }); }
  });
}

export async function saveConnection(config: Config, baseUrl: string): Promise<void> {
  const normalized = normalizeConfig({ ...config, baseUrl });
  await mutateJson(configPath(), value => {
    value.baseUrl = normalized.baseUrl;
    value.provider ??= config.provider;
  });
}

export async function saveRecommendedSetup(config: Config, models: readonly LocalModel[]): Promise<void> {
  if (!models.length) throw new Error("Start Strata and refresh its catalog before applying the recommended setup.");
  await mutateJson(join(agentDir(), "settings.json"), settings => {
    settings.compaction ??= {};
    settings.compaction.modelOverrides ??= {};
    for (const model of models) {
      settings.compaction.modelOverrides[`${config.provider}/${model.id}`] = compactionPreset(model);
    }
    settings.compaction.modelOverrides[`${config.provider}/${AUTO_MODEL_ID}`] = compactionPreset(models[0]);
    settings.modelThinkingLevels ??= {};
    settings.modelThinkingLevels[`${config.provider}/${AUTO_MODEL_ID}`] ??= "low";
    settings.defaultProvider = config.provider;
    settings.defaultModel = AUTO_MODEL_ID;
  });
}
