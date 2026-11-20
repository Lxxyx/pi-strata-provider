import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig, type LocalModel } from "../src/config.ts";
import { compactionPreset, tuneModel } from "../src/tuning.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const strataModel: LocalModel = {
  id: "iq3_xxs", name: "iq3_xxs", provider: "strata", api: "openai-completions", baseUrl: "http://127.0.0.1:8080/v1",
  input: ["text", "image"], reasoning: true,
  thinkingLevelMap: { off: "none", minimal: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  cost, contextWindow: 262144, maxTokens: 32768,
};
const llamaModel: LocalModel = { ...strataModel, id: "llama", thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: null, xhigh: null, max: null } };

test("thinking budgets grow with the level and leave room for the answer", () => {
  const budgets = tuneModel(strataModel, normalizeConfig({})).samplingParamsByThinkingLevel ?? {};
  const at = (level: "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => Number(budgets[level]?.reasoning_budget_tokens ?? 0);
  // 'off' sends an explicit zero: in Strata a request's own budget wins over the server's config, and zero switches that config off.
  assert.equal(budgets.off?.reasoning_budget_tokens, 0);
  assert.ok(at("low") < at("medium"), "levels must actually differ");
  assert.ok(at("medium") < at("high"));
  assert.ok(at("high") < at("xhigh"));
  assert.ok(at("max") <= Math.floor(strataModel.maxTokens / 2), "thinking may not outbid the answer");
  assert.ok(at("max") >= 4096, "a ceiling this low would make thinking pointless");
});

test("a model without the top levels gets budgets only for the levels it accepts", () => {
  const budgets = tuneModel(llamaModel, normalizeConfig({})).samplingParamsByThinkingLevel ?? {};
  assert.ok(budgets.low?.reasoning_budget_tokens);
  assert.ok(budgets.medium?.reasoning_budget_tokens);
  assert.equal(budgets.high, undefined);
  assert.equal(budgets.max, undefined);
});

test("a model without thinking gets no thinking budgets", () => {
  const tuned = tuneModel({ ...strataModel, reasoning: false, thinkingLevelMap: undefined }, normalizeConfig({}));
  assert.equal(tuned.samplingParamsByThinkingLevel, undefined);
});

test("compaction reserves the whole reply budget: output ceiling plus thinking", () => {
  const preset = compactionPreset(strataModel);
  const thinking = 16384;
  assert.ok(preset.reserveTokens >= strataModel.maxTokens + thinking, "a long thinking block must not push the summary out of the window");
  assert.ok(preset.reserveTokens <= Math.floor(strataModel.contextWindow / 2));
  assert.ok(preset.keepRecentTokens <= 20000);
});

test("tuned models keep images resized and the ceiling bounded by the window", () => {
  const tuned = tuneModel(strataModel, normalizeConfig({}));
  assert.equal(tuned.inputLimits?.images?.resize?.maxWidth, 1568);
  assert.ok((tuned.maxTokens ?? 0) <= Math.floor(strataModel.contextWindow / 4));
});
