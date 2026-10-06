import type { Config, LocalModel } from "./config.ts";

export const AUTO_MODEL_ID = "strata-auto";

export function tuneModel(model: LocalModel, config: Config): LocalModel {
  const maxTokens = Math.min(model.maxTokens, config.defaultMaxTokens, Math.max(1, Math.floor(model.contextWindow / 4)));
  const result: LocalModel = {
    ...model,
    maxTokens,
    ...(model.input.includes("image") && {
      inputLimits: { images: { resize: { maxWidth: 1568, maxHeight: 1568, maxBytes: 524288, jpegQuality: 80 } } },
    }),
  };
  // Strata's soft reasoning cap closes thinking before it consumes the entire output budget.
  if (config.backend === "strata" && model.reasoning) {
    const cap = (tokens: number) => Math.max(1, Math.min(tokens, Math.floor(maxTokens * 0.75)));
    result.samplingParamsByThinkingLevel = {
      off: { reasoning_budget_tokens: 0 },
      low: { reasoning_budget_tokens: cap(1024) },
      medium: { reasoning_budget_tokens: cap(4096) },
      high: { reasoning_budget_tokens: cap(8192) },
    };
  }
  return result;
}

export function compactionPreset(model: Pick<LocalModel, "contextWindow" | "maxTokens">) {
  const reserveTokens = Math.min(Math.floor(model.contextWindow / 2), Math.max(model.maxTokens + 4096, Math.floor(model.contextWindow / 4)));
  const keepRecentTokens = Math.min(20000, Math.floor(model.contextWindow / 4));
  return { reserveTokens, keepRecentTokens };
}

export function chooseModel(models: readonly LocalModel[], previousId?: string, requiresImage = false): LocalModel {
  const candidates = models.filter(model => !requiresImage || model.input.includes("image"));
  const previous = candidates.find(model => model.id === previousId);
  const model = previous ?? candidates[0];
  if (!model) throw new Error(requiresImage ? "No available Strata model supports image input." : "No Strata model is available. Start the server and run /strata refresh.");
  return model;
}
