# Declarative connectors — the connector manifest

> ### Correction (2026-08-15, #606) — the format below is the proposal, not what shipped
>
> The runtime substrate described in the status block IS live, and the status block's own last
> sentence is the accurate one: *the substrate is done, creator-supplied manifests are not.* Two
> corrections to the **format** this document specifies:
>
> - **`secretRef` was never implemented.** It appears below at three points as the field naming a
>   secret. The shipped `ManifestAuth` (`lib/connectors/manifest.ts:73-83`) has no such field: an
>   OAuth2 manifest carries `clientIdEnv` / `secretEnv`, and a platform token carries `tokenEnv`.
>   **This is a superseded proposal, not a gap to build, and the narrowing was the point** — see
>   "Why `secretRef` did not survive" below.
> - **The `auth.type` list is the *creator-facing* set, and correctly so.** `sanitizeConnectorManifest`
>   accepts exactly `none | app | api-key | oauth2` (`manifest.ts:216`). The full union has a fifth
>   member, `platform-token`, which is built-in-only and which the sanitizer deliberately never emits.
>
> "COMPLETE" is scoped to epic #143 — the substrate. It is not a claim that a creator can supply a
> manifest: `sanitizeConnectorManifest` still has **no production caller** (grepped 2026-08-15 —
> `manifest.test.ts` only), while `compileConnector` has four (`web-search`, `meta`, `github`,
> `google-sheets`). The gate that would give it one is #53/#54.

> **Status:** **COMPLETE (2026-08)** — epic #143 fully landed. The executor
> (`executeHttpRequest`, #144), `compileConnector` + `sanitizeConnectorManifest` (#145), the
> per-tool `handler` escape hatch + the conversions of **web-search, github, meta, and
> google_sheets** to manifests (#146/#147), and the **generic OAuth2 handler**
> (`/v1/connectors/:id/oauth/*`) are
> all shipped and behavior-identical (174 connector tests green, api suite 1353). A connector is
> now data: an api-key/bearer SaaS is a manifest object; an OAuth SaaS is a manifest + an OAuth
> app registration — no bespoke route/tool code, no deploy per integration. This was the
> flexibility unlock after declarative agent capabilities (#141). Companion to
> [`agent-platform-strategy.md`](./agent-platform-strategy.md) (Tier‑1) and the gating plan in
> [`third-party-agents-plan.md`](./third-party-agents-plan.md) (#51 "open tool catalog"). The
> remaining piece for *creator-supplied* manifests is the curated-review gate (#53/#54), tracked
> in the third-party plan — the runtime substrate is done.

## The problem

> This section is the motivation as it stood when the proposal was written, and is kept as such.
> It has since been acted on for built-ins: four connectors are now compiled from manifests. It
> still describes the position of a **third-party** creator (#606).

Every connector today is a hand-written module under `workers/api/src/lib/connectors/`
(`github.ts`, `meta.ts`, `web-search.ts`, …). Adding Slack, Notion, Google Sheets, Linear, or
Stripe means: write a `.ts`, wire it into `registry.ts`, write tests, ship a monorepo deploy.
That is the last big **code-not-config** bottleneck in the platform — and it's the one that most
limits how flexible/powerful an agent can be, because an agent is only as capable as the
connectors it can reach.

The `http` connector is the existing escape hatch — it already lets an agent call *any* REST API
"as configuration" (`method`/`base`/`path`/`query`/`headers`/`body` with `{{param}}`
interpolation, `responseMap` extraction, `pagination`, SSRF-guarded `safeFetch`, and vault-key
injection via `auth`). **It proves the model works.** The manifest generalizes that proof from a
single tool to a whole connector: a connector becomes a data description of its auth + its tools,
and the platform's request engine executes it.

## The insight

`registry.ts` already reduces every connector to one shape:

```ts
{ id, label, auth, scopes: {read, write}, grantModel, tokenEnv?, tools: ToolDef[] }
```

and everything downstream — the tool catalog, `connectorClient` auth dispatch, capability gating
(`capabilities.tools`), the consent gate (`runRegistryTool`), and the three surfaces
(runtime / `/v1/instances/:id/tools` / MCP) — derives from that single entry. So if we can
*produce* that shape from data, **nothing downstream changes.** The manifest is a compiler that
emits the same `Connector` + `ToolDef[]` the registry already consumes.

## The manifest schema

A connector manifest is JSON (built-in ones committed as data; later, creator-supplied + reviewed):

```jsonc
{
  "id": "slack",
  "label": "Slack",
  "auth": {
    "type": "oauth2",                     // api-key | oauth2 | app | none
    "authUrl": "https://slack.com/oauth/v2/authorize",
    "tokenUrl": "https://slack.com/api/oauth.v2.access",
    "scopes": ["chat:write", "channels:read"],
    // PROPOSED, NEVER BUILT (#606). Shipped instead: "clientIdEnv" + "secretEnv", and the
    // sanitizer strips both from an untrusted manifest. See "Why `secretRef` did not survive".
    "secretRef": "SLACK_CLIENT_SECRET"    // resolved server-side, never in the manifest
  },
  "baseUrl": "https://slack.com/api",
  "tools": [
    {
      "name": "slack_post_message",
      "scope": "write",                   // write → consent-gated (migration 0051), unchanged
      "description": "Post a message to a channel.",
      "request": {                        // same engine as the http connector
        "method": "POST",
        "path": "/chat.postMessage",
        "body": { "channel": "{{channel}}", "text": "{{text}}" }
      },
      "params": {                         // → the LLM-facing JSON Schema
        "channel": { "type": "string", "required": true },
        "text":    { "type": "string", "required": true, "maxLength": 4000 }
      },
      "responseMap": "ts"                 // optional dotted/array[] extraction
    }
  ]
}
```

**Auth as data** maps 1:1 onto the existing `connectorClient` auth kinds:

| `auth.type` | Token source (unchanged) | Example connectors |
|---|---|---|
| `api-key` | user's BYOK vault (`user_api_keys`), injected into header/query per the tool | http, web-search |
| `oauth2` | refresh→access exchange; refresh token envelope-encrypted; `secretRef` server-side | Slack, Google Sheets, Notion, Linear |
| `app` | installation token (GitHub-App style) | github |
| `none` | reached over the runner relay or internal platform authority | terminal, tmux, browser, repo-local, supervision |

The one new capability is a **generic OAuth2 handler** driven by `auth` config — today Drive/Gmail/
GitHub each hand-roll their flow. Consolidating them into one manifest-driven `authorize` +
`callback` + `refresh` (keyed by connector id) is the single piece of *code* this proposal adds;
everything else is the manifest + the existing `http` request engine.

## How it folds in (zero downstream change)

```
manifest.json ──► compileConnector(manifest) ──► { Connector, ToolDef[] }  ──► REGISTRY (unchanged)
                        │                                    │
                        └── validate/sanitize                └── each ToolDef.handler = runManifestTool(request)
                            (like sanitizeDeclaredCapabilities)   (the http connector's request executor,
                                                                   promoted to a shared function)
```

- `registryConnectorGroups()`, `capabilities.tools` gating, `runRegistryTool` consent, the MCP
  proxy, and the console tool list all keep working — they only ever see `Connector`/`ToolDef`.
- The **http connector's request engine** (`connectors/http.ts` — interpolation, `responseMap`,
  `pagination`, `safeFetch` SSRF guard) is factored into `runManifestTool(request, ctx)` and reused
  by every manifest tool. This is why http was worth getting to 99% test coverage first: it's the
  executor the whole manifest layer stands on.
- An optional per-tool `handler` escape hatch stays for the rare tool that needs real code
  (e.g. Meta's template-vs-text branching) — a manifest tool is "request-as-data OR a named code
  handler," so migration is never all-or-nothing.

## Migration path (non-breaking)

1. **Extract the executor** — promote `http.ts`'s request logic to `runManifestTool`; http becomes
   its first (degenerate) consumer. No behavior change; the 43 http tests guard it.
2. **Add `compileConnector` + manifest validation** and register built-in manifests alongside the
   code connectors. Tool **names stay identical**, so persisted references (task IDs, `capabilities.tools`
   allowlists, consent rows keyed by connector id) are untouched.
3. **Convert `github` and `meta` to manifests** (keeping their one custom branch as a `handler`).
   Their existing dedicated tests (now 100%) become the behavior contract the manifest must satisfy.
4. **Generic OAuth2 handler** — landed for manifest OAuth2 connectors; Google Sheets is the
   first shipped OAuth2 manifest. Drive/Gmail still use their ingest-specific routes.
5. **Creator-supplied manifests** (the third-party unlock) — a reviewed manifest is a new
   integration with no deploy. Gated exactly like agent review (#53) + the safety scanner (#54):
   SSRF/host allowlist, scope sanity, secret-access, cost heuristics.

## Security (inherits, doesn't restart)

- **SSRF**: every manifest request goes through `safeFetch` (`lib/ssrf.ts`) — the host is data, so
  the guard is *more* important, not less; https-only + private-range/redirect revalidation apply
  to all manifest hosts.
- **Consent**: `scope:"write"` manifest tools ride the existing per-instance consent gate
  (`instance_connector_consent`, 0051) — unchanged.
- **Secrets**: `secretRef` resolves to a Worker secret / vault entry server-side; the manifest
  never contains a credential; OAuth refresh tokens stay envelope-encrypted (AES-256-GCM under
  `KEY_ENCRYPTION_KEY`). A creator-supplied manifest can *name* a secret only via the connect flow,
  never inline one.
  > **Superseded (#606).** The invariant held — a manifest still never contains a credential — but
  > `secretRef` is not how. See below.

### Why `secretRef` did not survive

`secretRef` was one free-form string naming "a Worker secret / vault slot". What shipped is typed
and per-flow: `clientIdEnv` / `secretEnv` on an OAuth2 manifest, `tokenEnv` on a platform token
(`lib/connectors/manifest.ts:73-83`).

The difference is not cosmetic, which is why this is recorded rather than renamed. A generic "name
any secret" field is exactly the escalation the sanitizer exists to prevent: on a creator-supplied
manifest it would let an untrusted author point at *any* Worker secret and have the platform resolve
it. So `sanitizeConnectorManifest` strips `clientIdEnv`/`secretEnv` and never emits `platform-token`
at all — those are built-in-only (`manifest.ts:78-83`, `:216`).

So the proposal's **security invariant** was kept — a manifest names a secret, never contains one —
and its **mechanism** was deliberately narrowed to reach it. Recorded as superseded because the
narrowing is a decision worth being able to find, not a typo.
- **Validation**: `sanitizeConnectorManifest` mirrors `sanitizeDeclaredCapabilities` — closed enum
  for `auth.type`, required-field + charset checks, `maxLength` caps on tool params, and a host
  allowlist for creator manifests.

## Non-goals / phasing

- Not a general workflow engine — that's the *next* frontier ("retire the `workflow` closed enum →
  declarative behavior via composed steps/triggers"; see strategy doc). Manifests describe *what an
  agent can touch*, pipelines describe *what it does over time*.
- Phase 1: built-in manifests only (github/meta/web-search/google_sheets converted). Phase 2:
  more OAuth2 SaaS manifests. Phase 3: creator-supplied manifests behind curated review (folds into
  #51/#53/#54 in the third-party plan).

## Why this first

It's the highest-leverage "the platform got more powerful without new code" win: it compounds per
integration, it's additive to a registry that's now fully test-covered, it carries no breaking
change (tool names + gating unchanged), and it establishes the manifest pattern the vocabulary-opening
work (declarative behavior, declarative surfaces) will reuse.
