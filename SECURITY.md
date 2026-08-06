# Security

This documents the security model of the ProAgentStore platform and how to report a vulnerability. It describes the controls that are enforced; it is not an inventory of open issues.

## Reporting a vulnerability

Please report suspected vulnerabilities privately — do **not** open a public issue or PR. Email the maintainers (see the org profile) with a description, affected endpoint/file, and a reproduction. We aim to acknowledge quickly and will credit reporters who want it.

## Trust model at a glance

There are three authentication planes, deliberately kept distinct:

1. **End-user identity** — ProAgentStore's own Google + GitHub OAuth. The callback mints an **HS256 session JWT** (`lib/session.ts`) signed with `SESSION_SIGNING_KEY`; every API route verifies it locally (signature + `exp`, no `alg:none`) and **type-pins** it — `verifySession` rejects any token that carries a `typ` or lacks a `roles[]` array, so a relay token (`typ:"relay"`) or an OAuth `state` payload (both signed with the *same* key) can never be replayed as a full account session. We do **not** use Cloudflare Access for marketplace users. Return-to / redirect targets are allowlisted (`lib/origins.ts`); OAuth `state` is HMAC-signed and expiring.
2. **MCP** — OAuth 2.1 + PKCE (S256) with dynamic client registration. Tools carry scopes (`read` / `write` / `runtime` / `destructive`); destructive tools additionally require an explicit `confirm`. `MCP_READ_ONLY=1` blocks all mutating tools. Mutating tools gate **before dispatch** and write an audit record (`workers/mcp/src/safety.ts`).
3. **Internal / service-to-service** — Worker→Worker calls use a service binding + shared `INTERNAL_TOKEN`; human/admin access uses Cloudflare Access. (Service-binding calls bypass the CF Access JWT, so they authenticate with the internal token.)

## Session storage in the browser — the decision, and why (#296)

**Decision: the session token stays browser-readable in `localStorage` (`pags:session`, read/written by `packages/sdk/src/client.ts` and `store/admin/src/lib/api.ts`). It does not move to an `HttpOnly` cookie.** This is a deliberate choice, re-examined 2026-08-07, not an oversight — and the reasoning below is what should be re-read if it is ever revisited, because the usual one-liner ("localStorage is XSS-readable, cookies are not") does not survive contact with this architecture.

**What an XSS actually gets, under each option.** This is the whole question, and the two answers are much closer than the folklore suggests. The console renders agent-influenced text as HTML, so XSS is the threat that matters (see #297 and the 2026-07 `renderTerminal` finding).

- With `localStorage`: script reads the token and exfiltrates it. The attacker then has **up to 30 days of offline API access from their own machine**.
- With `HttpOnly`: script cannot read the token — and does not need to. It is executing **in the console's origin**, so it simply issues the requests itself and the browser attaches the cookie. It can create agents, drive the Coder, call `/v1/keys/:provider/reveal`, delete instances. Everything the user can do, for as long as the page is open.

So the real delta is not "compromised vs. safe". It is **the takeaway**: `HttpOnly` would downgrade *durable, portable account takeover* to *session-riding while the tab is open*. That is a genuine reduction and it is stated here plainly rather than argued away. What follows is why it is not worth its price **here**.

**Why the cookie does not fit this system.**

1. **It would re-introduce CSRF, which the Bearer scheme structurally does not have.** Today every mutating route — `DELETE /v1/agents/:id`, `POST /v1/instances/:id/apply`, and the whole admin surface (suspend, unpublish, delete, revoke keys) — is safe from cross-site forgery *because* the credential must be attached by script that can read it. An ambient cookie removes that property from every route at once, and would have to be replaced by a CSRF regime that does not exist. Trading one XSS mitigation for a new site-wide CSRF surface is not obviously a net win.
2. **The token must stay a portable bearer credential regardless.** `pags login` writes it to disk; `pags up` sends it as a Bearer to mint relay tokens; `store/admin` is a second SPA on a different path. A cookie cannot serve the CLI, so the outcome is **both** schemes accepted on every route — and "two ways to authenticate the same request" is precisely the shape that produced the suspension-bypass holes catalogued in `workers/api/src/lib/security-invariants.test.ts`. One credential, one code path, one place to apply the gate.
3. **It would not close the exposure that is actually largest.** The OAuth handoff delivers the session **in a URL** (`?session=<JWT>`, `store/console/src/lib/auth.ts`). The console calls `history.replaceState` immediately, which handles the history entry but not `Referer` on subsequent cross-origin subresources, nor any intermediary that logs URLs. Likewise the chat WebSocket upgrade carries the **account JWT** as `?token=` (`routes/chat.ts`) — WS clients cannot set an `Authorization` header. Both survive a storage change untouched. (The *relay* path already fixed its half: it mints a short-lived, instance-scoped `typ:"relay"` token instead, which `verifySession` type-pins against being replayed as a session. Doing the same for chat WS is the higher-value follow-up, and is tracked as such — it removes a long-lived credential from a query string, which is worth more than moving it between two script-reachable stores.)

**Compensating controls that are real today.**

- **Type-pinning.** `verifySession` rejects any token carrying a `typ` or lacking a `roles[]` array, so the relay token and the OAuth `state` payload — both signed with the *same* `SESSION_SIGNING_KEY` — cannot be replayed as an account session.
- **A revocation lever that works on a stolen token.** The JWT is stateless, so it cannot be individually revoked; but `requireUser` applies **operator suspension** (`isSuspended`) on every authenticated surface, including the two that verify inline (`/v1/auth/me`, the WS upgrade). Suspending the account kills a leaked token immediately, without rotating `SESSION_SIGNING_KEY` and logging everyone out. That is the incident response, and it is asserted by a source-scanning guard rather than trusted.
- **Blast-radius limits behind the session.** The provider-key reveal is rate-limited and owner-scoped; the Gmail refresh token is never revealable; MCP is a separate OAuth 2.1 plane with its own scopes and audit log; every mutating connector tool passes a per-instance write-consent gate.
- **Expiry.** 30 days (`THIRTY_DAYS`, `lib/session.ts`), no refresh/rotation. This is the weakest number in the design and the one most worth revisiting — it is what sets the length of the "takeaway" window above.

**What would change this decision.** A route whose damage is irreversible and instantaneous (money movement, or a destructive action with no undo and no approval gate); or shipping a genuine multi-tenant admin console used by people who are not the operator. If either lands, the correct move is not a cookie bolted onto a bearer system — it is a short-lived access token plus a refresh token in an `HttpOnly`, `SameSite` cookie, with CSRF protection introduced at the same time.

**Non-auth `localStorage` is out of scope** and was checked, not assumed: text scale, last route, push-dismissal, voice-debug flag, remembered browse URL, and resumable-upload part etags. None carries a credential or PII.

**Public wildcard CORS is an allowlist, and it is tested.** `workers/host` serves `*` on exactly five public documents (`/llms.txt`, `/llms-full.txt`, `/skills.json`, `/.well-known/mcp-server.json`, `/mcp-server.json`) plus the embeddable widget scripts — all unauthenticated, all cacheable, none credentialed. `workers/host/src/cors.test.ts` asserts that set exactly and that no `*` response ever carries `Access-Control-Allow-Credentials`. The API itself (`workers/api`) never uses `*`: it has an explicit origin allowlist and sets `credentials: true` solely so the browser will accept the `HttpOnly` OAuth state-binding cookie (`lib/oauth-nonce.ts`) on the cross-origin `/start` call.

## Secrets & cryptography

- Infra secrets are **not** in Doppler — that project no longer exists. Worker runtime secrets are set with `wrangler secret put` and cannot be read back; their names are inventoried in `~/dev/ops/inventory.yaml`, and values enter `secrets.enc.yaml` (SOPS, age-encrypted) on rotation. CI deploys using the GitHub repo secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`.
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

## Accepted dependency advisories

`pnpm audit` is expected to exit clean, and as of 2026-08-07 (#298) it reports **no unignored
advisory at any severity**. Three are suppressed in `pnpm.auditConfig.ignoreGhsas`.

Severity is a claim about a *package*, not about this *product*. Every entry below is therefore a
**reachability** claim with the evidence that supports it, plus the condition under which it stops
holding — because an ignore list whose entries nobody can re-derive is indistinguishable from an
ignore list that is wrong. If the reasoning stops holding, take the upgrade instead.

| Advisory | Package | Sev | Why it is not reachable here | Unblocker |
|---|---|---|---|---|
| `GHSA-f88m-g3jw-g9cj` | `sharp` (`wrangler > miniflare > sharp`) | high | Build-time only. `wrangler` is a `devDependency` in **every** manifest that has it (`workers/{api,host,mcp}`, `agents/job-application-assistant`, the three templates); `miniflare` is its local dev simulator and never ships. No deployed Worker contains `sharp`, and nothing in PAGS decodes images. `miniflare` pins `sharp` at an **exact** `0.34.5`, so an override would force an untested native binary into local dev for no production gain. | `wrangler`/`miniflare` releasing with `sharp >= 0.35.0`. |
| `GHSA-qwww-vcr4-c8h2` | `react-router` (`react-router-dom > react-router`) | high | The advisory states it "only affects your application if you are using the unstable RSC APIs". `store/console` and `store/admin` are client-rendered SPAs on `createBrowserRouter`; there is no RSC entry point, no server router, and no `@react-router/server` dependency anywhere in the tree. The fix is in `8.3.0`, a major bump across two consoles — real regression risk for an unreachable flaw. | A `7.x` backport, or a deliberate React Router 8 migration of both consoles. |
| `GHSA-g7r4-m6w7-qqqr` | `esbuild` (`vitest > vite`, `tsx`, `wrangler`) | low | The flaw is in esbuild's **dev server** (`--servedir`) and is **Windows-only**: `path.Clean` does not treat `\` as a separator, so a backslash request escapes the served root. Nothing here runs `esbuild --serve` — vite's dev server is vite's own, `tsx` and `wrangler` use esbuild purely as a bundler API, and no build or deploy runs on Windows. Same shape as `sharp` above: `wrangler` pins `esbuild` at an **exact** `0.27.3`, so a global override would force an untested bundler into the tool that produces every deployed Worker, to fix a server that is never started. | `wrangler` shipping with `esbuild >= 0.28.1`. A `vite>esbuild` / `tsx>esbuild` selective override would leave wrangler's copy behind and change nothing about the reported advisory. |

Advisories that **were** fixed rather than accepted, via `pnpm.overrides` — all transitives that
nothing here imports, where taking the bump was cheaper than justifying it:

| Advisory | Override | Note |
|---|---|---|
| `GHSA-8j4g-w8fx-2239` | `hono` → `^4.12.34` | ReDoS in `hono/cors` when `allowHeaders` is unset. Worth recording that PAGS was **already outside** the affected path: `workers/api/src/index.ts` sets `allowHeaders: ["Content-Type", "Authorization"]`, and the advisory says applications with a non-empty `allowHeaders` never reach the quadratic parser. Taken anyway — it is a patch bump, and the next `cors()` call site added without `allowHeaders` would be exposed. |
| `GHSA-frvp-7c67-39w9` | `@hono/node-server` → `^2.0.5` | Path traversal in `serve-static` on Windows via `%5C`. Reached only via `@modelcontextprotocol/sdk`'s Node HTTP transports; `packages/browser-runner` imports the SDK's **client** and `InMemoryTransport` only, and `workers/mcp` runs on Cloudflare Workers where a Node HTTP adapter cannot execute. Neither serves static files. |
| `GHSA-v422-hmwv-36x6` | `body-parser` → `^2.3.0` | Size limit silently disabled by an unparseable `limit`. Same unreachable path as above (`@modelcontextprotocol/sdk > express`); nothing here constructs an express app. |
| `GHSA-52cp-r559-cp3m` | `js-yaml` → `^4.3.0` | Traced to a `.bin/json2ts` codegen CLI that no dist file imports; a `wrangler deploy --dry-run` of `workers/mcp` produced a bundle containing zero `js-yaml`. |
| `GHSA-mwp4-54f8-5fhr` | `ip-address` → `^10.3.1` | See the note below. |

Note on `GHSA-mwp4-54f8-5fhr` (`ip-address`): the advisory describes an SSRF filter bypass, so it
is worth stating that PAGS's own guard never had that flaw. `lib/ssrf.ts` does not use
`ip-address` — it reads `parsed.hostname` from the WHATWG URL parser, which is the parser the
advisory names as *correct*, and checks the canonical dotted-decimal form. `https://012.0.0.1/`
therefore canonicalises to `10.0.0.1` and is blocked, which `lib/ssrf.test.ts` asserts directly.
