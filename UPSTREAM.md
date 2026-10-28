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
Magpie plugin contract and verified against the installed 0.1.1813 host. Native
ZCode is a behavioral/API reference, not code copied into this package. Real
GitHub/LinuxDO browser handoffs remain a separately documented release gate.

This package is self-contained: all runtime sources, tests and documentation
live at the repository root. Update this record whenever an external reference
informs a behavioral decision, and keep attribution for adapted MIT code.
