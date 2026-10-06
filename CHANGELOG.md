# Changelog

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
- Publish source and installable package archives through GitHub; npm publication is deferred.
