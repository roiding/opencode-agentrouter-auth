# AgentRouter provider: implementation contract

This document is the design contract for the implementation. It is not a
claim that every listed gate has passed at any given commit.

## Requirements

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| R1 | Separate password, GitHub, LinuxDO, system access-token and API-key login methods. Ask only relevant questions. | Method/prompt tests and an isolated Magpie host login. |
| R2 | Unattended check-in is opt-in and requires AgentRouter site credentials. | Disabled, missing-credential, wrong-user, captcha, daily-deduplication and persistence tests. |
| R3 | Select agentrouter.org or ps.air-outer.com per account. Preserve explicit legacy addresses. | URL resolution and migration tests for both endpoints. |
| R4 | Use native Magpie account records, account pools and smart/intent routing. Do not build a hidden account pool in fetch. | Concurrent-account tests and isolated host account/failover tests. |
| R5 | Custom headers are a baseline feature for every login method. Preserve native request/model overrides. | Header precedence, credential-boundary and selected-model tests. |
| R6 | API-key-only accounts provide inference protection and model discovery, not site-account features. | Tests proving that usage/check-in make no account API requests. |
| R7 | Preserve interactive GitHub and LinuxDO login, including callback-to-selected-endpoint mapping. Do not retain third-party browser sessions or automate daily OAuth. | State/cookie/code/identity tests plus supervised real login for each identity provider (completed 2026-10-29). |
| R8 | Protect Responses, Chat Completions, Anthropic Messages and Gemini, streaming and non-streaming. | Protocol-specific HTTP/SSE fixtures, cancellation and real local HTTP tests. |
| R9 | First request body unchanged; clean only an exact recoverable history error; bounded retries; no failed SSE output delivered. | Byte-level preservation, negative classification, replay limits and withheld-tool tests. |
| R10 | No default model, no changes to other providers, no OS-specific runtime or background proxy. | Config/model tests, source inspection, Node and Bun runs. |

## Ownership and modules

- Magpie owns account selection, per-account proxies, concurrency, smart routing,
  cross-account failover, check-in scheduling, and persistent credential storage.
- `index.mjs` assembles hooks and wraps only this provider's model transport.
- Account normalization owns versioned credentials and conservative migration.
- The site client owns login, OAuth state/exchange, account reads and key lookup.
  It is not wrapped by inference retries.
- Provider hooks own the login UI, account capabilities, model metadata and headers.
- The filter owns one selected-provider attempt. Protocol adapters describe the
  request, error envelope, completion conditions and permitted history repair.

## Authentication and persistence

Login methods are independent native buttons. Password and access-token methods
use the host's keyless API-method support, so there is no extra implicit API-key
question. Secrets use password prompts. Advanced fields are conditional.

| Mode | Unattended check-in | Account reads | Persistent secrets |
| --- | --- | --- | --- |
| API key | No | No | Inference key only |
| Access token | No | Read-only, if accepted by the site | Site token, user ID, selected inference key |
| Password, check-in off | No | Read-only site session | Site session and selected inference key; not the password |
| Password, check-in on | Yes | Read-only site session | Above plus explicitly authorized site username/password |
| GitHub / LinuxDO | No | Read-only site session | AgentRouter session and selected inference key only |

The account's site UID is authoritative. Reauthentication and check-in must not
replace it with another user's data. Account labels are display information,
not an identity or secret. Do not deduplicate different users by a shared label.

Account modes that acquire a key use an OAuth-shaped Magpie storage envelope
with `expires: 0` and versioned plugin state in `refresh`, as the native ZCode
plugin does. This is a storage envelope, not a GitHub/LinuxDO refresh token.
It also avoids the host automatically persisting all password prompt inputs in
API-key metadata. The loader uses only the normalized inference key.

Read existing keys; never reset a system access token or create/rotate a model
key implicitly. Use an explicitly selected active key, or the sole active key.
If there is ambiguity or the key list is unavailable, explain what is missing;
never persist a successful but keyless inference account.

Legacy account reads may retain existing site credentials, but check-in defaults
off unless an explicit account opt-in is present. Merely finding an old password
is not consent to daily logins. Existing custom request/site URLs are not moved
silently. Pure legacy API keys remain pure API keys.

## OAuth and endpoint mapping

The registered OAuth callback origin is agentrouter.org. The selected endpoint
can perform the subsequent AgentRouter-side exchange. These are different
addresses; selecting the mirror does not rewrite the identity provider's
registered callback or send its cookies to AgentRouter.

Each flow owns its state, anonymous site cookies, provider, selected endpoint,
expiration and one-shot callback. Validate the entire callback URL and state.
Accept only the known callback origins/paths. Perform the exchange on the same
selected site that issued the state. Never replay a consumed code.

The existing GitHub implementation avoids the site's consuming SPA callback by
using a child path. Whether LinuxDO accepts an equivalent callback must be
verified, not assumed. LinuxDO therefore defaults to completing the site's own
browser login and explicitly handing its resulting AgentRouter session back to
the plugin. The user pastes the site's `/api/user/self` request copied as cURL,
or a JSON session export. Clipboard text is parsed, never executed. Only a
trusted AgentRouter origin, the session Cookie, user ID, and site-only client
headers are accepted; a read-only self request verifies the identity before
key lookup. This avoids relying on an already-consumed OAuth code. Both methods
are available for GitHub as well. Real-browser logins for GitHub and LinuxDO
were verified against the live endpoints on 2026-10-29.
No third-party relay, daily browser-session replay, CAPTCHA solver, or persistent
GitHub/LinuxDO session belongs in this plugin.

## Check-in, balances and routing

`usage` is read-only. It never falls back to login. Unknown balances are not
zero, and token allowances or cumulative spend are not account balances.
An API-only account returns no fabricated quota window.

`checkin` requires account opt-in plus site username/password and runs only when
Magpie schedules it. Deduplicate concurrent and completed Beijing-day attempts
for the same site UID. Validate the UID returned by login before updating any
session. A site's password/session failure must not invalidate a working model
key. A newly successful login may update that account's site session and balance.
CAPTCHA is a user-action outcome, not a retry loop. A daily reward is not an
automatic quota reset; do not fabricate midnight reset windows for routing.

## Headers, models and request boundaries

Use native model/request headers as authoritative overrides. Account defaults
fill missing fields; do not merge headers from unrelated models. Apply the
selected account's inference credential using the outgoing protocol. Never
forward site cookies, site access tokens or passwords to inference endpoints.

Discover models per account. Preserve explicit user model declarations/settings
as manual overrides and trusted fallback lists; the upstream still enforces
their permissions. Public pricing metadata can describe protocols but cannot
by itself add models absent from the account's catalog. Do not invent a default
model, context limit, quota, or permission. An explicit model API address must
not be defeated by an unconditional loader baseURL.

The native gateway can retain the first seat's URL while trying another account.
The loader therefore resolves the selected account's default endpoint at dispatch,
using a stripped internal model hint from `chat.headers` to retain explicit
per-model API overrides. A reused URL must not keep the previous account's domain.

The filter sees Magpie's already-converted upstream protocol. Its first body is
preserved at this boundary, not necessarily at the agent's original boundary.
Unknown paths, management operations and non-replayable request formats pass
through without speculative repair or replay.

## Transport invariants

1. Preserve the original body for the first request and every non-cleaning retry.
2. Only a protocol-specific, explicit history error can authorize a repair.
   Authentication, quota, generic parameter and overload errors cannot do so.
3. Responses retains its safe portable-history transformation and rejects
   references/compaction it cannot reconstruct. Other protocols never receive
   Responses field deletions. Required thinking/tool signatures are not discarded.
4. One selected-provider invocation has the existing combined 20-retry limit and
   resource/rate/transport/availability budgets of 5/20/10/10. Magpie failover is a
   separate outer operation; caller cancellation bounds it, not a fake global
   counter shared between accounts.
5. Honor server wait hints, idle and total deadlines, cancellation during every
   stage, and request/response memory bounds. Buffered overflows fail, not leak.
6. Hold SSE output until a protocol-valid terminal result. Discard failed attempt
   text and client tool calls. Legitimate refusals/length stops are terminal,
   not transport failures. Keep usage trailers where the protocol requires them.
7. Responses uses completed/incomplete events; Chat uses completed choices and
   DONE; Anthropic uses message_stop; Gemini uses completed candidates or a
   terminal prompt block plus a well-formed normal stream end.
8. Preserve authoritative status, error details and routing/auth hints. Remove
   stale content-length/content-encoding only when returning decoded/rebuilt data.
9. Log structural diagnostics only. No prompt, body, password, cookie, token,
   authorization URL, state or code belongs in logs.
10. Buffering is not upstream exactly-once execution. Retried hosted tools and
    inference may already have run or incurred cost. Document latency and cost.

## Release gates

- [x] Versioned account state, conditional login prompts and opt-in persistence.
- [x] Read-only usage, UID-checked check-in and no fabricated routing windows.
- [x] Endpoint/header/model isolation and explicit legacy configuration retention.
- [x] All four inference protocols, HTTP/SSE errors and buffer/cancellation limits.
- [x] Node and Bun automated tests, including actual local compressed HTTP streams.
- [x] Isolated Magpie host: login UX, multiple accounts, models and failover.
- [x] Supervised GitHub and LinuxDO login against the real selected endpoint (2026-10-29).
- [x] Documentation, provenance and checksum manifest match the implementation.

Real-account validation is deliberately separate from mock coverage. No paid
inference, real credential changes, proxy mutation or third-party browser-session
capture is performed by the automated test suite.
