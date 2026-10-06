import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type LocalModel } from "./src/config.ts";
import { createStrataProvider } from "./src/provider.ts";
import { saveConnection, saveRecommendedSetup } from "./src/storage.ts";
import { AUTO_MODEL_ID, chooseModel, compactionPreset } from "./src/tuning.ts";
import { explainStrataError } from "./src/errors.ts";

export default async function (pi: ExtensionAPI) {
  const config = await loadConfig();
  const { provider, status } = createStrataProvider(config);
  pi.registerProvider(provider);
  pi.registerVirtualModel({
    provider: config.provider,
    id: AUTO_MODEL_ID,
    name: "Strata Auto (tuned)",
    thinkingLevels: ["off", "low", "medium", "high"],
    input: ["text", "image"],
    route(request, ctx) {
      const models = ctx.modelRegistry.getAvailable().filter((model): model is LocalModel =>
        model.provider === config.provider && model.id !== AUTO_MODEL_ID && model.api === "openai-completions");
      if (!models.length && status.lastError) throw new Error(status.lastError);
      const sticky = request.failed ?? request.previous;
      const requiresImage = request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image"));
      const model = chooseModel(models, sticky?.model.id, requiresImage);
      // Direct requests include compaction and branch summaries: use fast, bounded reasoning.
      const thinkingLevel = !model.reasoning ? "off" : request.reason === "direct" ?
        model.thinkingLevelMap?.low === null ? "off" : "low" : request.thinkingLevel;
      return { model, thinkingLevel };
    },
  });

  pi.registerCommand("strata", {
    description: "Manage Strata: status, refresh, connection, or recommended setup",
    handler: async (args, ctx) => {
      try {
        let action = args.trim();
        if (!action && ctx.hasUI) {
          const selected = await ctx.ui.select("Strata", ["Status", "Refresh models", "Configure server URL", "Apply recommended Pi setup", "API key help"]);
          if (!selected) return;
          action = ({ "Status": "status", "Refresh models": "refresh", "Configure server URL": "url", "Apply recommended Pi setup": "setup", "API key help": "key" } as Record<string, string>)[selected];
        }
        action ||= "status";
        if (action === "key") {
          ctx.ui.notify("Keyless local servers work with the default placeholder key. For a protected server, run /login and choose Strata, or set STRATA_API_KEY. Pi stores login credentials in auth.json; never commit that file.", "info");
          return;
        }
        if (action === "url") {
          if (!ctx.hasUI) throw new Error("Configure the server URL through the interactive /strata menu or PI_STRATA_BASE_URL.");
          if (process.env.PI_STRATA_BASE_URL) throw new Error("PI_STRATA_BASE_URL overrides the saved URL. Change or unset it before configuring a different server.");
          const url = await ctx.ui.input("Strata server URL", config.baseUrl);
          if (!url) return;
          await ctx.waitForIdle();
          await saveConnection(config, url.trim());
          ctx.ui.notify("Server URL saved. Reloading the extension; the new server's catalog will be discovered automatically.", "info");
          await ctx.reload();
          return;
        }
        if (action !== "status" && action !== "refresh" && action !== "setup") throw new Error("Usage: /strata [status|refresh|url|setup|key]");
        if (action === "refresh" || action === "setup") {
          await ctx.waitForIdle();
          const result = await ctx.modelRegistry.refresh({ providers: [config.provider], allowNetwork: true, force: true });
          const error = result.errors.get(config.provider);
          if (error) {
            ctx.ui.notify(`Strata refresh failed; keeping the last successful catalog. ${error.message}`, "warning");
            return;
          }
        }
        if (action === "setup") {
          const models = provider.getModels();
          await saveRecommendedSetup(config, models);
          const auto = ctx.modelRegistry.find(config.provider, AUTO_MODEL_ID);
          if (auto) await pi.setModel(auto);
          ctx.ui.notify("Recommended local-only compaction presets saved. Other providers are unchanged. Reloading and selecting Strata Auto.", "info");
          await ctx.reload();
          return;
        }
        const message = [
          `Provider: ${config.provider}`,
          `Endpoint: ${config.baseUrl}`,
          `Backend: ${status.backend}`,
          `Models: ${status.models} (${status.source})`,
          `API key required: ${status.authenticationRequired === undefined ? "unknown" : status.authenticationRequired ? "yes" : "no"}`,
          "API key: /login -> Strata, or STRATA_API_KEY (default: strata-local)",
          ...(status.checkedAt ? [`Last refresh: ${new Date(status.checkedAt).toISOString()}`] : []),
          ...provider.getModels().map(model => `${model.id}: context=${model.contextWindow}, output=${model.maxTokens}, reasoning=${model.reasoning}, input=${model.input.join("+")}, compaction=${JSON.stringify(compactionPreset(model))}`),
          ...status.warnings,
          ...(status.lastError ? [`Last error: ${status.lastError}`] : []),
        ].join("\n");
        ctx.ui.notify(message, status.lastError || status.warnings.length ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Strata command failed.", "error");
      }
    },
  });

  pi.on("message_end", event => {
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== config.provider || message.stopReason !== "error" || !message.errorMessage) return;
    const errorMessage = explainStrataError(message.errorMessage);
    if (errorMessage !== message.errorMessage) return { message: { ...message, errorMessage } };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (status.lastError) ctx.ui.notify(`Strata is unavailable; using the last successful catalog if present. ${status.lastError}`, "warning");
    for (const warning of status.warnings) ctx.ui.notify(warning, "warning");
  });
}
