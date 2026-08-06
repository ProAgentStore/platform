# Connector auth for user-named endpoints

> Status: **implemented** (2026-08-06). Fills a hole in `connector-manifest.md` (#143) that only
> became visible when the first connector let a *subscriber* name the remote system.
>
> **What shipped:** the whole chain. Discovery (`lib/connectors/discovery.ts` — RFC 9728 → RFC
> 8414 through `safeFetch`), the survivability model (`lib/connectors/unattended.ts`, #181), and
> now RFC 7591 dynamic client registration (`lib/connectors/dcr.ts`) plus the PKCE S256
> authorize/callback round trip (`lib/mcp-oauth.ts`, `lib/mcp-oauth-store.ts`, `routes/mcp.ts`,
> migration 0085). A subscriber connects an OAuth-protected MCP server from the console with no
> operator action and no pasted token; the credential lands in `mcp_credentials` (#286) with
> `auth_mode:"oauth"` and is **renewed from its refresh token before each call**, so a cron-fired
> chain survives with nobody present.
>
> **Why the earlier deferral no longer holds.** This document previously argued the flow should
> wait, on the grounds that the only verified target advertised `grant_types_supported:
> ["authorization_code"]` — no refresh grant, so a completed flow bought a credential that dies
> every 24h. That reasoning was about *that server*, not about the mechanism. PAGS's own MCP
> server advertises, live:
>
> ```
> https://mcp.proagentstore.online/.well-known/oauth-authorization-server
>   grant_types_supported:            ["authorization_code", "refresh_token"]   ← refresh IS issued
>   code_challenge_methods_supported: ["S256"]
>   registration_endpoint:            /register                                 ← DCR available
>   token_endpoint_auth_methods:      [..., "none"]                             ← public client
> ```
>
> `unattendedFromGrantTypes` classifies that as `refresh` — the class #181 says is safe to wire.
> So the blocker was a property of one target, and a target in the `refresh` class exists. The
> `interactive-only` case did not disappear: `POST /v1/mcp/oauth/start` returns the verdict and
> the console repeats it on success, because authorizing such a server is legitimate for work you
> are present for and a trap in a chain.
>
> The vault-bearer path stays for servers that genuinely issue machine tokens. It is no longer the
> answer for OAuth-protected ones.

## The trigger for this

The Website Builder agent calls a website-builder MCP server that the **subscriber** configures
(`mcp_url`, a per-instance setting). The first real target — FreeWebStore's MCP — advertises:

```
grant_types_supported:                 ["authorization_code"]     # no refresh_token
token_endpoint_auth_methods_supported: ["none"]                   # public client + PKCE
code_challenge_methods_supported:      ["S256"]
registration_endpoint:                 /register                  # dynamic client registration
expires_in:                            86400                      # 24h access token
```

That is a correct, spec-compliant implementation of the MCP authorization spec. **PAGS could not
talk to it**, and shipped `auth: "token"` — a vault bearer the user pastes in — instead. Its own
docs call that path "a compatibility fallback for controlled integrations" and say "do not ask
users to paste access tokens."

So the platform's answer to its first user-named endpoint was the thing the endpoint explicitly
asks you not to do. That is a design gap, not an FWS quirk.

## Diagnosis: three assumptions that don't survive

`connector-manifest.md` models auth as data with four types — `api-key | oauth2 | app | none`.
Every one of them assumes the **operator knows the remote system at build time**. Look at what
`oauth2` requires:

```jsonc
"auth": {
  "type": "oauth2",
  "authUrl":   "https://slack.com/oauth/v2/authorize",
  "tokenUrl":  "https://slack.com/api/oauth.v2.access",
  "secretRef": "SLACK_CLIENT_SECRET"     // resolved server-side
}
```

Three baked-in assumptions:

1. **Endpoints are known when the manifest is written.** For outbound MCP the endpoint arrives at
   *runtime*, from a subscriber's settings field.
2. **A client is pre-registered, and its secret lives in the operator's env.** The operator cannot
   pre-register with a server they have never heard of. `secretRef` is unfillable here — there is
   no value that could go in it.
3. **A confidential client.** Modern MCP servers are public clients: PKCE, `auth_method: "none"`,
   no secret exists to hold.

The consequence is broader than MCP. **#143 Phase 3 wants creator-supplied manifests.** A creator
cannot add `SLACK_CLIENT_SECRET` to the operator's env, so any creator connector needing OAuth is
blocked on an operator deploy — which is precisely the thing #143 exists to abolish. The
"reviewed JSON manifest, no deploy" promise breaks exactly where it matters most.

**The hole is: user-named, arbitrary, third-party endpoints.** That is the direction the whole
platform is heading, and the auth model has no expression for it.

## The fix: a fifth auth type that discovers and registers itself

The standards for this already exist and MCP mandates them. Nothing needs inventing:

| Step | Spec | What it removes |
|---|---|---|
| Discover the auth server from the resource | RFC 9728 protected-resource metadata | hardcoded `authUrl`/`tokenUrl` |
| Discover endpoints | RFC 8414 AS metadata | manifest endpoint config |
| **Register the client at runtime** | **RFC 7591 dynamic client registration** | **`secretRef`, operator pre-registration** |
| Authorize without a secret | PKCE S256, public client | the client secret entirely |

Add `auth.type: "dcr-oauth2"`. The connector declares *nothing* about the remote server; the
resource URL is the input.

**This is proven, not theoretical.** Against FWS, live, just now:

```
POST https://agent.freewebstore.online/register
  → 201 {"client_id":"6bda1761-…","redirect_uris":["https://api.proagentstore.online/v1/connectors/mcp/oauth/callback"]}
```

PAGS registered itself, for its own callback, with zero operator involvement and no secret.

**It generalizes.** Any OAuth-protected MCP server the subscriber names works with no code and no
operator action — which is also the missing piece for #143 Phase 3.

### As built — three details worth stating, because each is a decision

**The registration cache keys on the AUTHORIZATION SERVER, not the resource origin.** The proposal
above said resource origin; the implementation uses `(user, issuer)` (`mcp_oauth_clients`,
migration 0085) because a `client_id` is only meaningful at the server that issued it. Two MCP
endpoints fronted by one authorization server then correctly share one registration, and a
registration can never be presented to a server that never minted it. Reuse is *correctness*
rather than economy: a refresh months later must present the same `client_id` the grant was issued
to, so re-registering per flow would strand every stored credential.

**The `state` pins the resource, not just the user.** This is the first flow where the remote
server is chosen by the user at runtime and is not necessarily trustworthy — the operator of any
server a subscriber connects sees our `state` in their own authorize request. A state proving only
"this user started some MCP flow" is therefore replayable *across servers*: drive our callback with
it and have a code exchanged, or a token filed, against a different endpoint. So the state carries
the flow id, the normalized resource, and a flow-type pin (`p:"mcp_oauth"` — `SESSION_SIGNING_KEY`
also signs account sessions and connector states), on top of the browser-binding nonce
(`lib/oauth-nonce.ts`). The callback requires the state's resource to equal the claimed flow row's
endpoint, reads nothing but `code` from its own query string, and claims the row with a
`DELETE … RETURNING` so a replay loses the race here rather than at the token endpoint.

**It reuses the existing machinery's shape, not its code.** `lib/connector-oauth.ts` verifies a
strictly smaller set of pins and stores under `(user_id, provider)`; sharing it would have meant
either weakening it or making it conditional. The state helpers are therefore separate and
deliberately non-interoperable, and the credential lands in `mcp_credentials` (#286) keyed on the
same normalized endpoint that consent, the trace and the connector already use.

## The harder half: unattended work needs a credential that survives

DCR gets PAGS *connected*. On its own it does not keep it connected.

Authorization-code OAuth encodes "the user is present and consents right now." An agent chain
firing at 3am from a cron trigger has no user present. So the flow only pays off with the renewal
attached: `ensureMcpAccessToken` (`lib/mcp-oauth-store.ts`) is what the connector calls instead of
the bare resolver — it renews from the stored refresh token when the access token has expired *or
is inside a 60s skew*, and a failed renewal reports the original `expired` rather than inventing a
new error class (a revoked grant genuinely needs a human; a transient outage must not be reported
as a revocation). This is also why the registration cache above is load-bearing: a refresh needs
the `client_id` the grant was issued to.

Where the server issues no refresh grant at all, none of that helps. FWS issues a 24h access token
with **no refresh grant** — so even a perfect DCR+PKCE flow yields a chain that dies daily and
needs a human at a browser to restart it. That is not a machine credential, and it is why the
`interactive-only` verdict is reported at authorization time rather than discovered later.

Refresh tokens are part of OAuth 2.1 and are how delegated access is meant to survive; omitting
the grant is a genuine gap on the server side, and the right ask of FWS. But the platform lesson
is bigger than FWS:

> **Whether a credential can survive unattended is a property of the connector, and the platform
> must know it — before wiring, not after.**

Today nothing models this. A subscriber can wire an interactive-only connector into a cron trigger
or an agent-to-agent connection, and the failure surfaces ~24 hours later as deliveries quietly
piling into the dead-letter queue. The outbox (0058) makes that *visible and replayable*, which is
a real improvement over silent loss — but replay cannot fix an expired credential, so every retry
is doomed and the human still finds out late.

Proposal: connectors declare `unattended: "yes" | "refresh" | "interactive-only"`, derived from
discovered metadata where possible (`refresh_token` in `grant_types_supported` → `refresh`).
Then:

- Wiring an `interactive-only` connector into a cron trigger or a connection **warns at create
  time** — the same principle as validating connection filters at create time, and for the same
  reason: a chain that looks healthy but cannot run is worse than one that fails loudly.
- Credential expiry becomes a **distinct delivery outcome** from a transient failure. A dead
  letter that says "reconnect FreeWebStore" is actionable; five backoff attempts against a
  401 are just noise.
- Expiring grants should notify **before** they lapse, not after.

## What this changes for the current chain

Short term the Website Builder needs FWS to add the `refresh_token` grant. That is standards-work
on the FWS side, not a PAGS workaround, and it is small: issue a refresh token, rotate on use,
advertise it in metadata. PAGS's existing refresh machinery then drives it unchanged.

The vault-bearer path (`auth: "token"`) should stay — it is legitimate for servers that genuinely
issue machine tokens — but it must stop being the *default answer* for OAuth-protected servers.
When discovery finds an auth server, PAGS should use it.

## Ticket corrections

Reading the tickets against the code turned up drift worth fixing:

- **#84** lists all six children unchecked; they are implemented and tested (registry, framework,
  tool-call API, GitHub, Sheets, consent). The epic reads as not-started.
- **#17 "Trigger retry policy, backoff, and failure notifications"** is now half-done in a way
  that is worse than not-done: migration 0058 gave *connections* an outbox with backoff,
  dead-lettering and replay, while *triggers* still have none (`lib/triggers.ts` contains no
  retry path). Two failure routes with different reliability guarantees is a trap. Re-scope #17
  to "triggers reuse the connection-delivery outbox" rather than building a second mechanism.
- **#19 "Trigger run history and connector sync observability in console"** gets more urgent:
  connections have **no console UI at all** — creating one is a raw API call — and the new
  delivery/replay endpoints are API-only too. The reliability work is invisible to the person who
  needs it.
- **#143** should absorb `dcr-oauth2` as Phase 2b; it is a precondition for Phase 3, not an
  extra.

## Tracking

| Work | Ticket | State |
|---|---|---|
| `dcr-oauth2` — discovery | ProAgentStore/platform#180 | **shipped** (`lib/connectors/discovery.ts`) |
| `dcr-oauth2` — DCR registration + PKCE flow | ProAgentStore/platform#180, #258 | **shipped** (`lib/connectors/dcr.ts`, `lib/mcp-oauth*.ts`, `routes/mcp.ts`, migration 0085) |
| Refresh-on-expiry so a chain survives unattended | ProAgentStore/platform#180 | **shipped** (`ensureMcpAccessToken`) |
| Unattended credential survivability | ProAgentStore/platform#181 | **shipped** (`lib/connectors/unattended.ts`) |
| Console UI for connections + delivery outbox | ProAgentStore/platform#182 |
| Unify trigger retries onto the outbox | ProAgentStore/platform#17 (re-scoped) |
| `refresh_token` grant on the MCP OAuth provider | freewebstore-online/platform#114 |

## What is left

1. ~~Add `dcr-oauth2` to the connector auth model~~ — **done** for the outbound MCP connector
   (discovery + DCR + PKCE + refresh). What has *not* happened is generalising it: it is wired to
   the `mcp` connector's endpoint, not exposed as an `auth.type` any manifest can declare. That
   generalisation is the piece #143 Phase 3 needs, and it is now a refactor rather than a design
   question.
2. Add the `refresh_token` grant to FreeWebStore's OAuth provider (freewebstore-online/platform#114).
   Independent of everything above; PAGS's refresh machinery drives it unchanged once it exists.
3. Model `unattended` as connector metadata; warn at wiring time; treat credential expiry as its
   own delivery outcome. The verdict is now surfaced at authorization time, but wiring an
   `interactive-only` server into a cron trigger still does not warn.
4. Fix the ticket drift above — particularly unifying trigger retries onto the delivery outbox.
