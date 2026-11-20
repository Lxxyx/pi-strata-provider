import type { ModelThinkingLevel, SamplingParams } from "@earendil-works/pi-ai";
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
  // Strata caps thinking per request with `reasoning_budget_tokens`. The thinking ceiling must not be derived
  // from the already clamped output ceiling, or a long plan would leave no room for the answer.
  if (config.backend === "strata" && model.reasoning) {
    const supported = model.thinkingLevelMap ?? { off: "none", minimal: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
    // Strata: `reasoning_budget_tokens` 0 means "no budget", and the request's own value wins over the server's config
    // (#123) - so `off` sends an explicit zero to switch off a budget the server was told to apply to every request.
    const budgets: Partial<Record<ModelThinkingLevel, number>> = { off: 0, minimal: 1024, low: 1024, medium: 4096, high: 8192, xhigh: 12288, max: 16384 };
    // Keep room for the answer itself: thinking may not eat more than half of the model's output ceiling.
    const ceiling = Math.max(1, Math.min(model.maxTokens, Math.floor(model.contextWindow / 2)));
    const budgetsByLevel: Partial<Record<ModelThinkingLevel, SamplingParams>> = {};
    for (const level of THINKING_LEVELS) {
      const budget = budgets[level];
      if (budget === undefined || supported[level] === undefined || supported[level] === null) continue;
      budgetsByLevel[level] = { reasoning_budget_tokens: budget === 0 ? 0 : Math.max(1, Math.min(budget, Math.floor(ceiling / 2))) };
    }
    result.samplingParamsByThinkingLevel = budgetsByLevel;
  }
  return result;
}

export function compactionPreset(model: Pick<LocalModel, "contextWindow" | "maxTokens"> & { reasoning?: boolean }) {
  // A compact turn can spend as much on thinking as on the answer, and a compaction turn is one more such turn:
  // reserving only the output ceiling left thinking to push the summary itself out of the window.
  const thinking = model.reasoning === false ? 0 : Math.min(16384, Math.floor(Math.min(model.maxTokens, Math.floor(model.contextWindow / 2)) / 2));
  const reserveTokens = Math.min(Math.floor(model.contextWindow / 2), Math.max(model.maxTokens + thinking + 4096, Math.floor(model.contextWindow / 4)));
  const keepRecentTokens = Math.min(20000, Math.floor(model.contextWindow / 4));
  return { reserveTokens, keepRecentTokens };
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type SupportedLevel = (typeof THINKING_LEVELS)[number];

/**
 * The highest level at or below the request that this model actually supports. Servers differ:
 * Strata answers `xhigh` and `max`, llama.cpp templates often stop at `medium`.
 */
export function supportedThinkingLevel(model: LocalModel, requested?: string): ModelThinkingLevel {
  if (!model.reasoning) return "off";
  if (!model.thinkingLevelMap) return (requested as ModelThinkingLevel) ?? "high";
  const start = requested ? THINKING_LEVELS.indexOf(requested as SupportedLevel) : THINKING_LEVELS.length - 1;
  for (let index = start < 0 ? THINKING_LEVELS.length - 1 : start; index >= 0; index -= 1) {
    const level = THINKING_LEVELS[index];
    if (model.thinkingLevelMap[level as keyof typeof model.thinkingLevelMap] !== null) return level;
  }
  return "off";
}

export function chooseModel(models: readonly LocalModel[], previousId?: string, requiresImage = false): LocalModel {
  const candidates = models.filter(model => !requiresImage || model.input.includes("image"));
  const previous = candidates.find(model => model.id === previousId);
  const model = previous ?? candidates[0];
  if (!model) throw new Error(requiresImage ? "No available Strata model supports image input." : "No Strata model is available. Start the server and run /strata refresh.");
  return model;
}
