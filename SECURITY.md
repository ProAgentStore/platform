# Security

This documents the security model of the ProAgentStore platform and how to report a vulnerability. It describes the controls that are enforced; it is not an inventory of open issues.

## Reporting a vulnerability

Please report suspected vulnerabilities privately — do **not** open a public issue or PR. Email the maintainers (see the org profile) with a description, affected endpoint/file, and a reproduction. We aim to acknowledge quickly and will credit reporters who want it.

## Trust model at a glance

There are three authentication planes, deliberately kept distinct:

1. **End-user identity** — ProAgentStore's own Google + GitHub OAuth. The callback mints an **HS256 session JWT** (`lib/session.ts`) signed with `SESSION_SIGNING_KEY`; every API route verifies it locally (signature + `exp`, no `alg:none`). We do **not** use Cloudflare Access for marketplace users. Return-to / redirect targets are allowlisted (`lib/origins.ts`); OAuth `state` is HMAC-signed and expiring.
2. **MCP** — OAuth 2.1 + PKCE (S256) with dynamic client registration. Tools carry scopes (`read` / `write` / `runtime` / `destructive`); destructive tools additionally require an explicit `confirm`. `MCP_READ_ONLY=1` blocks all mutating tools. Mutating tools gate **before dispatch** and write an audit record (`workers/mcp/src/safety.ts`).
3. **Internal / service-to-service** — Worker→Worker calls use a service binding + shared `INTERNAL_TOKEN`; human/admin access uses Cloudflare Access. (Service-binding calls bypass the CF Access JWT, so they authenticate with the internal token.)

## Secrets & cryptography

- All infra secrets live in **Doppler** (`pags/prd`) and are pushed to Worker secrets; secrets set with `wrangler secret put` are mirrored back to Doppler.
- Every stored credential — user API keys, site-login credentials, the Gmail refresh token, cached GitHub installation tokens — is **envelope-encrypted** (`lib/crypto.ts`): a random-IV AES-256-GCM data key, itself wrapped with AES-KW under the master `KEY_ENCRYPTION_KEY`. Decryption verifies integrity (GCM tag + AES-KW).
- Secrets are never returned to the browser except the owner's **own** provider key via the rate-limited `/v1/keys/:provider/reveal` (for browser-direct realtime use); the Gmail refresh token is explicitly excluded from that path. List endpoints return booleans (`hasPassword`, …), never values.

## Tenant isolation

- Each agent **instance** is an isolated Durable Object; a subscriber's data never mixes with the template or with other subscribers.
- Every instance/agent/credential/coding/storage/profile route is scoped by `user_id` / `owner_id`, with parameterized SQL throughout (no string-built queries).
- Real-time chat WebSockets authenticate the upgrade with a `?token=` session and pin the **server-verified** user id to the socket — a client cannot name another user's id.
- GitHub App installation tokens are minted only for installations the user has a **verified binding** to (personal → login match; org → active-membership check), which prevents cross-tenant access to private repositories.

## Agent & runtime safety

- **Untrusted content is fenced.** Retrieved RAG material (documents, ingested URLs, repo files, webhook payloads) is wrapped and labelled as data-only in the model context, to resist prompt-injection that would otherwise chain read-tools into exfiltration.
- **Outbound fetches are guarded.** The `fetch_url` tool and URL ingestion require `https` and reject non-public hosts — loopback, RFC1918, link-local/cloud-metadata (`169.254.0.0/16`), CGNAT, integer/hex-encoded IPs, and IPv6 loopback/ULA/mapped forms (`lib/ssrf.ts`).
- **Sensitive tools are permission-gated.** Reading the owner's connected Gmail (`find_confirmation_link`) requires both the `email` permission flag and a connected account, checked at runtime.
- **The apply pipeline** runs the final submit only when not in `dryRun`, and the prompt is hard-locked against fabricating PII (EEO/demographic questions are always declined).

## The local runner (cloud → your machine)

The coding runner executes CLI engines and browser actions on the user's own machine. Key properties:

- The command-spawn path uses `spawn` with an **argv array (no shell)**, so shell metacharacters in an engine command are literal arguments, not injection.
- The relay is ownership-scoped: only the instance owner's token can connect a runner or drive it; registration and machine-takeover compare against the same owner.
- The runner's local HTTP server binds to loopback and is token-gated; run it with a token and avoid non-loopback binds.
- Coding engines may be launched with elevated permission flags to work autonomously. Treat the machine you run the runner on as one the agent can act on with your privileges — run it where that is acceptable, and review objectives you hand to autonomous loops.

## Hardening practices

- CI-only deploys (GitHub Actions); npm publishes via OIDC trusted publishing. No laptop deploys.
- Security-relevant changes ship with unit tests (`lib/ssrf.test.ts`, `packages/sdk/src/ui.test.ts`, `lib/github-app.test.ts`, MCP safety tests).
- Rendered model/user content is HTML-escaped before display; response headers include `X-Content-Type-Options`, `Referrer-Policy`, HSTS, and a Content-Security-Policy.
