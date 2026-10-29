# Upstream Sources

This plugin draws on two MIT-licensed projects:

- AgentRouter provider: https://github.com/ZhaoJun233/agentrouter-magpie-plugin
  - Pinned commit: `1049163f2cd95b39b55b9ca23b1d91b139a80423` (2026-10-28).
  - Behavioral reference only. No code from it is bundled in this package; the
    account, login, check-in, catalog and wallet behavior was reimplemented
    against the Magpie plugin contract.
- Conditional history policy: https://github.com/yidu456/magpie-auto-codex-filter
  - Based on the policy at commit `cd68b072ddf3475203d42661d9cdca3a93212100`.
  - Copyright (c) 2026 alexcarterio and contributors; license in `LICENSE`.
  - `lib/responses-filter.mjs` adapts the policy to Web Fetch streams without Node-specific APIs or configuration rewriting. `lib/protocols.mjs` adds protocol-specific framing and error handling without applying Responses history deletion to other protocols.

`index.mjs` now composes the new `lib/provider.mjs` hooks with the shared filter.
`lib/accounts.mjs`, `lib/site-client.mjs`, `lib/headers.mjs` and `lib/catalog.mjs`
implement the explicit account modes, conservative migration, separate site
operations and per-model configuration. There are no mandatory GitHub system
tokens, login-based balance fallbacks or hard-coded model names in this runtime.
Site-password/session errors do not invalidate the independent inference key.

The multi-account, keyless-login and wallet-balance integration is based on the
Magpie plugin contract and verified against the installed 0.1.1976 host
(`300b7eee083d5e24fa7a55fe18974586308844d5`). Native
ZCode is a behavioral/API reference, not code copied into this package. Real
GitHub/LinuxDO browser handoffs remain a separately documented release gate.

Model metadata and SSE liveness references (reviewed 2026-10-29):

- The installed Magpie host's `fromModelsDev` keeps context/input/output and
  capabilities but drops `reasoning_options` when initializing `variants`.
  Its native export consumes `capabilities.reasoning` and variant keys.
- The maintained `@magpie-community/opencode-zen-free-auth` plugin maps
  models.dev effort declarations to `{ reasoningEffort: effort }` variants.
  This is an API/behavior reference; no fixed model profiles are copied here.
- Raw public registry: https://models.dev/api.json . Its provider-specific and
  manufacturer records are capability evidence, never account availability.
- Official Codex source: https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs .
  `process_sse` waits on parsed SSE events, so comments do not prevent
  `idle timeout waiting for SSE`. `response.in_progress` is non-content activity.
- Magpie's native gateway `fallback.go` holds lead events for up to four minutes
  and sends comment keepalives while waiting. The optional isolated gateway
  test therefore measures event liveness through the actual installed gateway,
  not only activity in the plugin or receipt of HTTP headers.

`lib/model-metadata.mjs` and `lib/model-registry.mjs` implement the shared
metadata resolver and read-only registry acquisition. `lib/sse-delivery.mjs`
separates non-content downstream liveness from buffered retry decisions; it
does not rewrite a winning upstream stream's response IDs or sequence numbers.

Account-name interoperability (reviewed 2026-10-29 against the same pinned
Magpie 0.1.1976 source):

- The plugin's original `saveAccount` preferred the user remark over the site's
  email, and its prompt called that remark `email`. That was a plugin identity
  bug, not a valid native alias contract. New logins use a UID-verified profile's
  email/username, retain legacy remarks only as labels, and no longer offer the
  misleading alias prompt.
- `internal/plugin/host.js`: `makeClient` exposes auth writes, configuration
  reads, logs and toasts; `input.magpie` exposes options, not a native alias
  setter. Unknown SDK client calls are no-op stubs. `save` and
  `internal/plugin/providers.go`'s `Saved` return provider/account only.
  `internal/provider/pluginsignin.go` and `internal/gui/plugins.go` do not turn
  a login input into a native display alias. The separate
  `/api/provider/accountname` GUI endpoint in `internal/gui/providers.go` is
  not an exposed plugin SDK method; this package does not guess its address,
  launch a native CLI from login, or patch host storage to invoke it.
- `internal/provider/plugin_accounts.go`: `pluginLabels` disambiguates equal
  `accountId` names, case-insensitively, by appending the `#slot` suffix of a
  sibling account's storage key. Display aliases do not change this decision.
- `internal/provider/account_names.go`: `SetAccountName` stores aliases in
  `providers.json`, not in plugin credentials. The GUI's
  `internal/gui/tests/account-alias.test.cjs` explicitly expects the original
  account name beside its alias; `internal/cli/accounts_alias_cli_test.go`
  expects `alias (original)` in quota titles. These are host display policies,
  not plugin-generated parentheses or proof that a rename was lost. They do
  not excuse passing an alias as the original account name.
- `internal/plugin/host.js`: `settle` compares names before UIDs. An existing
  account cannot be migrated safely just by returning its email instead of its
  old remark, even with the same UID. Refreshes therefore preserve existing
  envelope names, and existing-name migration is explicitly not claimed.
- `internal/provider/plugin_usage.go`: a nonempty `usage.user` replaces the
  canonical login name in the raw quota result. Current quota cards restore
  it in `perLogin` (`subscription_usage.go`); this is not the root cause of
  their parentheses. The plugin now omits the optional `user` field so the
  site username never becomes a third name for the host to reconcile.
- Native CLI caveat: `accounts --json` in this host looks up aliases with the
  login agent (`plugin:agentrouter`), while `SetAccountName` stores them by
  `PluginID` (`agentrouter`, or `agentrouter-plugin` on a provider-ID collision).
  The isolated gateway test checks shared aliases, a later rename, saved aliases
  and the quota export against distinct real-email account names. It verifies
  byte-for-byte that renaming leaves plugin credentials unchanged. No installed
  host or real account files are patched to work around native presentation.

This package is self-contained: all runtime sources, tests and documentation
live at the repository root. Update this record whenever an external reference
informs a behavioral decision, and keep attribution for adapted MIT code.
