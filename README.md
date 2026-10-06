# pi-strata-provider

A tuned [Strata](https://github.com/Niko1221/Strata) provider for [Pi](https://pi.dev).
Discover local models automatically instead of maintaining a handwritten provider catalog.

[简体中文文档](README.zh-CN.md) · [MIT license](LICENSE)

> Package and repository name: `pi-strata-provider`. The stable release line starts at **1.0.0**.
>
> [npm package](https://www.npmjs.com/package/pi-strata-provider) · [GitHub releases](https://github.com/Lxxyx/pi-strata-provider/releases)

## Quick start

1. Start Strata. Its usual local endpoint is `http://127.0.0.1:8080/v1`.
2. Install:
   ```sh
   pi install npm:pi-strata-provider
   ```
3. Start Pi, run `/strata`, and choose **Apply recommended Pi setup**.
   This selects **Strata Auto (tuned)** and applies local-model compaction presets.
4. Use Pi normally. Model metadata refreshes at startup, on opening `/model`, and through `pi update --models`.

Startup discovery completes before initial model selection, including a first-ever CLI run with no cache. `--offline` / `PI_OFFLINE=1` restore the catalog without discovery network access. A fresh `local/strata-auto` default stays local when the server is unavailable; it reports a local error instead of silently using a logged-in cloud model. Explicit model choices and resumed conversations are preserved.

A keyless local server works without configuration: the extension supplies `strata-local` as a placeholder.
For a protected server, run `/login` and choose **Strata**, or use `/login local`.

You can also install the pinned GitHub release:

```sh
pi install git:github.com/Lxxyx/pi-strata-provider@v1.0.0
```

If your npm registry mirror has not synced this new package yet, use the official registry:

```sh
npm_config_registry=https://registry.npmjs.org/ pi install npm:pi-strata-provider
```

Requires Pi / Pi AI **1.0.4 or newer** and Node **22.18 or newer**.
Verified with Pi 1.0.4, Strata 0.1.39, and a live Swift Qwen3.8 model with vision enabled.

## What it does

- Discovers model IDs and aliases from `GET /v1/models`.
- Reads **actual runtime context**, input modalities and loaded state.
- Reads the chat template, generation defaults and output cap from `GET /props?model=...`.
- Detects whether Strata requires an API key from `GET /health`.
- Maps Pi thinking levels to Strata's accepted values, including a real **off** setting.
- Keeps model catalogs in Pi's own `models-store.json` for offline startup.
- Retains the last successful catalog on authentication errors, network failures or malformed responses.
- Accepts successful empty catalogs, so removed models do not remain forever.
- Adds a stable `local/strata-auto` virtual model, so changing the physical model ID does not require changing the default model.
- Preserves native Pi streaming, tools, images, usage accounting, cancellation, retries and compaction.
- Never downloads GGUF weights, changes Strata's run configuration, or starts/stops the server.

The default provider ID is **`local`**, not the package name.

## One command menu, native authentication

| Command | Purpose |
| --- | --- |
| `/strata` | Open the management menu |
| `/strata status` | Show endpoint, auth requirement, models, limits and refresh state |
| `/strata refresh` | Force a live catalog refresh |
| `/strata url` | Save a server URL, then reload the extension |
| `/strata setup` | Apply the recommended local Pi setup, then reload |
| `/strata key` | Show API key guidance without displaying credentials |
| `/login local` | Store the Strata key using Pi's native authentication flow |

The URL menu accepts a server root or a URL ending in `/v1`. Reverse-proxy prefixes are supported.
You do **not** need a separate custom command to manage keys. Pi already owns authentication.

**Recommended setup changes**:
- Startup selection becomes `local/strata-auto`.
- The automatic model gets a `low` startup thinking level if it has no existing override.
- Compaction token presets are written for discovered local models and `local/strata-auto`.
- Other providers' presets, global thinking level, tools, theme and package list are left unchanged.
- Explicitly disabled global compaction is respected, not silently re-enabled.

Selecting the automatic model manually also works without applying this setup.
If you significantly change the server's context size, re-run the one-click recommended setup so saved compaction thresholds match it. Metadata refresh alone never silently rewrites Pi settings.

## API keys and server configuration

Strata 0.1.39 supports an optional key through:
- the server's `--api-key` startup argument;
- the server process's `STRATA_API_KEY` environment variable;
- `"api_key"` in the server run configuration.

Strata accepts `Authorization: Bearer ...` and `x-api-key`; this extension uses Bearer authentication for both discovery and inference.
When a key is configured, model lists and properties require it too.

Client-side key precedence:
1. Pi runtime key / stored provider credential in `auth.json`;
2. the configured key environment variable, default `STRATA_API_KEY`;
3. optional literal `apiKey` in the extension configuration;
4. the `strata-local` placeholder.

Prefer `/login local` or an environment variable. A literal key is supported for compatibility but is not recommended.

Example for Git Bash:
```sh
export STRATA_API_KEY='your-real-server-key'
pi
```

The placeholder does **not** disable or bypass authentication.
A 401 error explains how to supply the real key; it never displays the supplied credential.
The extension does not repeatedly prompt for a key when the server is down.

Strata normally binds to `127.0.0.1`. If you bind it to `0.0.0.0` or expose it through a tunnel, configure a real key and appropriate firewall/TLS protection.
For a custom hostname without a key, Strata's `allowed_hosts` setting may be required. Browser `cors_origins` settings are not needed by Pi.

The launch scripts normally use port **8080**, while directly invoking Strata's Python server without a port argument may default to **8095**. Use the address printed by your actual launch script.

## Automatic tuning and model mapping

Capabilities come from server metadata and templates, **not guesses based on a model name**.

### Strata thinking

Strata's frontend accepts `none`, `low`, `medium`, and `high`, translating `high` into the template's `xhigh`.
The provider uses `thinkingFormat: "openai"` and `supportsReasoningEffort: true`.

| Pi level | Request `reasoning_effort` | Default soft reasoning budget |
| --- | --- | --- |
| off | none | 0, with thinking disabled by the effort value |
| low | low | 1,024 tokens |
| medium | medium | 4,096 tokens |
| high | high | 8,192 tokens |

Unsupported or redundant `minimal`, `xhigh` and `max` picker levels are hidden.
Budgets use Strata's verified `reasoning_budget_tokens` field, not an unrelated generic thinking-budget flag.
Each positive budget is capped at 75% of the selected output limit, leaving answer/tool-call headroom.
This is a **soft** budget: Strata inserts its wrap-up marker rather than providing a strict wall-clock or token guarantee.

For ordinary automatic routing, Pi's selected thinking level is used and clamped to the physical model's capabilities.
For direct requests such as compaction and branch summaries, **Strata Auto** selects bounded `low` reasoning, or `off` if low is unsupported.
Tool continuations stay on the previous physical model while it remains available.
Image-bearing conversations require an image-capable model instead of silently sending images to a text-only backend.

### Token and image defaults

- Context: actual `meta.n_ctx` / server context, not the model's advertised training maximum.
- Output: the lower of the server's positive cap, **16,384**, and **one quarter of the context**.
- Server `n_predict: -1` means no advertised fixed cap; the client still uses a safe finite output budget.
- Sampling: preserve the server's explicit defaults. Translate `repeat_penalty` and `repeat_last_n` back to Strata's request field names.
- Images: at most 1,568 × 1,568, 512 KiB encoded, JPEG quality 80.
- System role: `system`, not `developer`.
- Strict tool mode, server-side store, mid-conversation system messages and generic thinking-token budgets are not assumed.
- Prompt-cache lifetime is not invented; the extension does not enable unnecessary cache-warming calls.

These are safety-oriented defaults, not a claim that one temperature or token budget is optimal for every model or GPU.
Existing server sampling choices take precedence over arbitrary model-family presets.

### Compaction presets

The one-click setup computes each model's budgets:

```text
reserveTokens = min(context / 2, max(output + 4096, context / 4))
keepRecentTokens = min(20000, context / 4)
```

For a 131,072-token server with a 16,384-token output cap, this means:
- reserve **32,768**;
- retain roughly **20,000** recent tokens;
- trigger ordinary threshold compaction above **98,304** estimated context tokens.

Pi's default reserve is 16,384, so blindly advertising a 32,000-token output limit is not a coherent local setup.
The extension limits output by default; its recommended setup adds further margin for tools and estimation differences.

Strata's optional server-side `fit_max_tokens: true` can clamp output to the remaining real context rather than returning 400.
It is an additional safeguard, not a substitute for correct Pi compaction settings.
The extension does not modify this server setting automatically.

## Configuration

Normally no file is needed.
Optional user configuration:

```text
~/.pi/agent/strata-provider.json
```

This follows `PI_CODING_AGENT_DIR`.
Use `PI_STRATA_CONFIG` for another file, and `PI_STRATA_BASE_URL` to override the endpoint.

See [strata-provider.example.json](strata-provider.example.json).

| Option | Default | Purpose |
| --- | --- | --- |
| provider | local | Provider ID; changing it also changes the native login target |
| baseUrl | http://127.0.0.1:8080/v1 | Root or OpenAI-compatible URL |
| backend | strata | Verified Strata behavior |
| apiKeyEnv | STRATA_API_KEY | Environment variable used for the key |
| apiKey | omitted | Optional literal key; prefer login/environment |
| timeoutMs | 4000 | Per-discovery-request timeout, not the generation timeout |
| concurrency | 4 | Concurrent model detail lookups |
| defaultContextWindow | 32768 | Conservative fallback when context metadata is missing |
| defaultMaxTokens | 16384 | Client-side output safety cap |
| defaults | {} | Optional overrides applied to every model |
| modelOverrides | {} | Exact model-ID overrides |

Pi controls generation timeouts and retries through its normal settings; a four-second metadata timeout does not limit inference to four seconds.

Advanced overrides are optional:
```json
{
  "defaults": {
    "samplingParams": { "top_k": 20 }
  },
  "modelOverrides": {
    "your-exact-model-id": {
      "samplingParams": { "temperature": 0.7 },
      "inputLimits": {
        "images": {
          "resize": { "maxWidth": 1024, "maxHeight": 1024, "maxBytes": 524288, "jpegQuality": 80 }
        }
      }
    }
  }
}
```

Overrides merge compatibility, cost and sampling fields. Explicit token/capability overrides are user-owned; avoid overriding verified context values.
Model identity and endpoint cannot be changed through a model override.

Secondary compatibility modes `auto`, `llama-cpp`, `ollama`, and `openai` are provided for adjacent local servers.
The real-service acceptance target is **Strata**. Other modes are covered by metadata unit tests, not claimed as equivalent live-service coverage.
llama.cpp mode inspects explicit template effort whitelists and uses configurable `chat_template_kwargs`; it does not incorrectly assume Strata's effort normalization.
Sleeping llama.cpp models are not woken just to inspect a template.
Strata aliases and idle-unloaded models remain usable, since Strata's metadata endpoints do not load them.

## Upgrading an initial installation

The stable version line starts at `1.0.0`; published `0.x` versions remain historical releases.
To pin the stable package:

```sh
pi install npm:pi-strata-provider@1.0.0
```

If `pi list` still shows an old Git installation, remove that **exact source** before installing the npm package. Do not keep both sources enabled: they register the same provider and command. The early Git source used a misspelled repository name; removing that source does not remove your Strata configuration, native credentials or model history.
For the original `v0.1.1` source:

```sh
pi remove git:github.com/Lxxyx/pi-strata-provder@v0.1.1
pi install npm:pi-strata-provider
```

The provider ID remains `local`, the automatic model remains `local/strata-auto`, and the optional configuration remains `strata-provider.json`.
The correctly spelled npm package is `pi-strata-provider`.

## Migrating a handwritten local provider

Remove the old `providers.local` block from `models.json` after backing it up.
Pi applies `models.json` above native providers: a stale hand-written block can override refreshed context, compatibility and authentication settings.

The extension intentionally does not delete user configuration on installation.
Run the recommended setup once, or select `local/strata-auto` and save it as the default with `Ctrl+S`.

No prompts, histories, keys, server model paths or full chat templates are included in persisted model metadata.

## Development and testing

```sh
npm ci --ignore-scripts
npm run check
npm run test:e2e
```

The regular check runs type checking and offline unit tests.
GitHub CI runs those tests on Windows and Linux with Node 22 and 24.

**The E2E suite makes real inference requests to an already running, vision-enabled Strata service.**
It uses temporary Pi configuration/workspaces, never your normal sessions or files.
For another address:
```sh
STRATA_E2E_URL=http://127.0.0.1:8081/v1 npm run test:e2e
```

Coverage includes startup discovery, all exposed effort levels, streamed text/usage, native tool results, real Pi write/edit/read, vision, manual compaction with retained memory, automatic threshold compaction, cancellation/recovery, cache restoration, authentication error/recovery and the actual Pi CLI. Cold CLI tests start with no cache or stored credentials and no explicit model flag, verify the physical response provider/model, and ensure an unavailable local server does not cause cloud fallback.

Automatic compaction is triggered with a temporary lower threshold and padding, rather than wasting a full 128K context.
Authentication recovery is tested through a temporary key-enforcing loopback proxy forwarding to the real Strata server; no model responses are mocked.
A sanitized report is written to `.artifacts/e2e-report.json`.

See [VALIDATION.md](VALIDATION.md) for the release acceptance record.

## Publishing

Package metadata targets the public official npm registry; no registry token belongs in this repository.
For the first stable release:

```sh
npm run check
npm pack
npm publish pi-strata-provider-1.0.0.tgz --registry=https://registry.npmjs.org/ --access=public --tag=latest
npm view pi-strata-provider@1.0.0 version dist.integrity --registry=https://registry.npmjs.org/
```

A successful browser authentication screen alone is not proof of publication: verify the final publish output and registry metadata. npm may require a fresh two-factor challenge or a compliant publishing credential. Disabling account two-factor authentication does not remove npm publishing requirements.
Published versions and public Git tags are immutable; documentation-only updates can be made on `main` without republishing the same npm version.

## Upstream references

Verified against Strata **v0.1.39**:
- [API, security, aliases and context](https://github.com/Niko1221/Strata/blob/v0.1.39/docs/DETAILS.md)
- [API key checks, model properties, runtime context and reasoning budgets](https://github.com/Niko1221/Strata/blob/v0.1.39/serve/server.py)
- [Thinking-effort normalization](https://github.com/Niko1221/Strata/blob/v0.1.39/serve/frontend.py)

Pi references:
[custom providers](https://pi.dev/docs/latest/custom-provider),
[virtual models](https://pi.dev/docs/latest/virtual-models),
[compaction](https://pi.dev/docs/latest/compaction),
[settings](https://pi.dev/docs/latest/settings).

## License

MIT. This is an independent integration, not an official Strata or Pi package.
