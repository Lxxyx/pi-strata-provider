# Release validation

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
