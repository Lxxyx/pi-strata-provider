# Changelog

## Unreleased

- Discover the catalog through the gateway's `GET /v1/models` (`context_length`, `meta.n_ctx`, `architecture.input_modalities`) instead of `/props`, `/health` and `/api/models`, which Strata 0.1.63 answers only on the engine port; the engine is queried only for what the gateway does not publish.
- Ask a model once (a tiny `Please think` request) when neither the gateway nor the engine reports whether it thinks, instead of defaulting to "no reasoning", which silently disabled thinking on reasoning-capable models.
- Read endpoints, dynamic engine ports, API keys, pack templates and the gateway key from Strata's own state on disk (`AppData/Local/Strata/launch/*.json`, `~/.strata/data/native-instances/*.json`), so a protected gateway authenticates without a handwritten key.
- Add `readLocalState` / `PI_STRATA_LOCAL_STATE` and `capabilityProbe` / `PI_STRATA_CAPABILITY_PROBE` to disable those two sources, and a configurable provider ID (`provider`, `PI_STRATA_PROVIDER`) that keeps the default `local` and makes the login target, stored catalog and automatic model follow it.
- Raise `defaultMaxTokens` to 32768, bound per-level `reasoning_budget_tokens` by half the output ceiling (`off` sends an explicit `0` to switch off a server-configured budget) and reserve the output ceiling plus thinking in compaction presets.
- Grow the offline suite to 62 tests, 13 of them asserting transcripts from a live 0.1.63 host.

## 1.0.0

- Start the stable version line at `1.0.0`, preserving the published `0.1.2` as historical metadata.
- Keep `pi-strata-provider` as the canonical package/repository name and `local` as the provider ID.
- Document official npm installation, stable version pinning and migration from the old Git source.
- Add public official-registry publish defaults and clarify release authentication and verification.
- Preserve the runtime behavior covered by 43 offline tests and the previous 14 real-service E2E groups.

## 0.1.2

- Correct the package and repository name to `pi-strata-provider`.
- Publish the public npm package and document npm, GitHub and official-registry installation.
- Keep the provider ID `local` and all existing model, authentication and tuning behavior unchanged.

## 0.1.1

- Discover and persist the native catalog before initial model selection, including first-ever CLI startup without a cache.
- Prevent a fresh automatic local default from silently falling back to an authenticated cloud provider when Strata is unavailable.
- Preserve explicit CLI selections, resumed conversations and unrelated cloud defaults.
- Respect offline mode and scoped local CLI runtime keys without forwarding another provider's key to Strata.
- Expand validation to 43 offline tests and 14 real-service groups; CLI assertions verify the actual response provider and physical model.

## 0.1.0

- Add native Strata provider discovery and persistent Pi model catalogs.
- Add optional native authentication, a keyless placeholder and actionable error handling.
- Add stable automatic routing, template-aware capabilities and bounded thinking budgets.
- Add local-only recommended compaction setup and a single management menu.
- Support model aliases, idle-unloaded Strata models, runtime context limits and server sampling defaults.
- Add English documentation with an optional Simplified Chinese translation.
- Validate streaming, tools, vision, compaction, cancellation, cache restoration and authentication recovery against a real local Strata service.
- Publish source and package archives through GitHub; npm publication was deferred for this initial release.
