# Release validation

## Unreleased: Strata 0.1.63 gateway discovery

Validated on 2026-11-20 with:

- Windows 10.0.19045 / Node 25.9.0
- Pi, Pi AI and Pi coding agent 1.5.2
- Strata 0.1.63 (`win/control/VERSION`), gateway on `http://127.0.0.1:8080/v1` with an API key required, the key published in `AppData/Local/Strata/launch/*.json`
- Live model: `iq3_xxs`, actual runtime context 131,072 tokens, vision enabled

Results:

- Type checking: passed.
- Offline unit tests: **62 / 62 passed**, 13 of them asserting transcripts taken from this host (the gateway 404s `/props`, `/health` and `/models`, answers `/v1/models` with `context_length` and `meta.n_ctx`, the engine answers `/props?model=...`, instance records carry dynamic ports and keys).
- Real-service end-to-end groups: **14 / 14 passed**, including live inference, vision, native tool calls, manual and automatic compaction with a retained memory token, cancellation, offline restore, authentication-failure guidance and stored-key recovery.
- CLI with the extension loaded: the catalog lists `local/iq3_xxs` at 131.1K context and 32.8K max output, `local/strata-auto` is registered, and `pi -p` completes inference on the automatic model.
- Measured endpoint behavior: gateway `GET /props|/health|/models` -> 404 or HTML; gateway `GET /v1/models` -> 200 with `context_length=131072`, `meta.n_ctx=131072`, `architecture.input_modalities=[text, image]`; engine `GET /props?model=...` -> 200 with the chat template and template efforts.

## v1.0.0

The stable release changes version metadata, publishing defaults and documentation only; runtime provider behavior is unchanged from the validated implementation below.

- Type checking and all **43 offline tests** passed again on 2026-10-06.
- The previous **14 real-service groups** remain the runtime acceptance baseline recorded under v0.1.1.
- The live endpoint was unavailable while preparing the stable release, so live inference was **not** rerun and is not claimed as new v1.0.0 E2E coverage.
- `0.1.2` was independently verified in the official npm registry with its published archive integrity before preparing this release.

## v0.1.1

Validated on 2026-10-06 with:

- Windows 11 / Node 24.11.1
- Pi and Pi AI 1.0.4
- Strata 0.1.39
- Live model: `swift-1.5-iq3_xxs`
- Actual runtime context: 131,072 tokens
- Vision enabled
- No key required by the live upstream server

Results:

- Type checking: passed.
- Offline unit tests: **43 / 43 passed**.
- Real-service end-to-end groups: **14 / 14 passed**.

| E2E group | Result |
| --- | --- |
| Startup discovery and stable automatic model | Passed |
| Streamed text, token usage and disabled thinking | Passed |
| Low / medium / high effort mappings and soft budgets | Passed |
| Native tool call with opaque result follow-up | Passed |
| Real Pi write / edit / read in an isolated workspace | Passed |
| Image input through Pi and Strata's real vision encoder | Passed |
| Manual compaction preserving a remembered verification code | Passed |
| Automatic threshold compaction with a real model-generated summary | Passed |
| Cancellation and subsequent successful inference | Passed |
| Persisted model catalog and offline catalog startup | Passed |
| Authentication failure, cached-state retention and corrected-key recovery | Passed |
| Actual Pi CLI loading the package and doing live inference | Passed |
| Cold CLI startup without a cache, stored credentials or explicit model flags | Passed |
| Unavailable local server does not cause cold CLI cloud fallback | Passed |

The automatic threshold test uses temporary settings and padding to trigger real compaction without filling all 128K tokens.
The authentication test uses a temporary key-enforcing loopback proxy; successful requests still go to the live Strata model.
Offline startup means catalog refresh is disabled; inference remains a local HTTP request to the running server.
No inference or summary responses are mocked.
CLI success assertions verify both the actual `local` provider and the physical Strata model, not only the reply text.

The test suite does not modify the upstream server configuration or restart/unload its model.
It creates and removes temporary Pi configuration and workspace directories.

This record proves compatibility of the tested stack, not a benchmark of optimal sampling or support for every model/backend.
