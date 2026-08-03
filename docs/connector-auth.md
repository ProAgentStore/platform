# Connector auth for user-named endpoints

> Status: proposal. Supersedes nothing; fills a hole in `connector-manifest.md` (#143) that
> only became visible when the first connector let a *subscriber* name the remote system.

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

PAGS registered itself, for its own callback, with zero operator involvement and no secret. The
registration is cached per **(user, resource origin)** — one registration per server per user,
reused across instances — alongside the tokens, envelope-encrypted like every other credential.

This slots into existing machinery rather than replacing it: `lib/connector-oauth.ts` already
does HMAC-signed state, callback handling, and refresh-token storage; `connectorClient` already
dispatches by auth type. What is new is discovery + registration in front of the flow, and
keying the stored grant by resource origin instead of by connector id alone.

**It generalizes.** Any OAuth-protected MCP server the subscriber names works with no code and no
operator action — which is also the missing piece for #143 Phase 3.

## The harder half: unattended work needs a credential that survives

DCR gets PAGS *connected*. It does not keep it connected.

Authorization-code OAuth encodes "the user is present and consents right now." An agent chain
firing at 3am from a cron trigger has no user present. FWS issues a 24h access token with **no
refresh grant** — so even a perfect DCR+PKCE flow yields a chain that dies daily and needs a human
at a browser to restart it. That is not a machine credential.

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

| Work | Ticket |
|---|---|
| `dcr-oauth2` — discovery + DCR + PKCE | ProAgentStore/platform#180 |
| Unattended credential survivability | ProAgentStore/platform#181 |
| Console UI for connections + delivery outbox | ProAgentStore/platform#182 |
| Unify trigger retries onto the outbox | ProAgentStore/platform#17 (re-scoped) |
| `refresh_token` grant on the MCP OAuth provider | freewebstore-online/platform#114 |

## Recommendation

1. Add `dcr-oauth2` to the connector auth model (discovery + DCR + PKCE, grant keyed by resource
   origin). Unblocks outbound MCP generally and #143 Phase 3.
2. Add the `refresh_token` grant to FreeWebStore's OAuth provider.
3. Model `unattended` as connector metadata; warn at wiring time; treat credential expiry as its
   own delivery outcome.
4. Fix the ticket drift above — particularly unifying trigger retries onto the delivery outbox.

Items 1 and 2 are independent and can land in parallel. Item 3 is what stops this class of
problem being discovered by a dead-letter queue next time.
