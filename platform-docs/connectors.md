# Connectors

ProAgentStore has two connector layers, for two different jobs.

1. **Ingest connectors** (this page's original subject): account-level OAuth providers —
   **Google Drive / Google Docs** and **Zoho WorkDrive** — whose files are imported into an
   agent instance's knowledge, narrowed by per-folder grants. (Gmail is a related OAuth
   integration used by the apply flow to read verification emails; it is not a knowledge-ingest
   connector.)
2. **Registry connectors** (the tool framework, issues #84–#90): a declared registry of
   integrations an agent drives as **tools** — GitHub, HTTP/REST, Web Search, Meta, tmux, and
   the experimental browser. See [Registry connectors](#registry-connectors) below.

## Registry connectors

A registry connector is declared ONCE in `workers/api/src/lib/connectors/registry.ts` as
`{ id, label, auth, scopes: {read, write}, grantModel, tools }`; the tool catalog, the
`connectorClient` auth dispatch, and capability-based gating all derive from that single entry.
An agent gets a connector's tools only when it declares them in `capabilities.tools`.

| Connector | Auth | Scopes | Tools (examples) |
|---|---|---|---|
| `github` | GitHub-App installation token | read + write | `github_list_issues`, `github_read_issue`, `github_create_issue` (write), `github_workflow_runs` |
| `http` | vault API key | read + write | `http_request` (call any REST API as configuration) |
| `web-search` | vault API key | read | `web_search` (Google Custom Search) |
| `meta` | platform token (`META_ACCESS_TOKEN`) | write | `whatsapp_send_message`, `instagram_send_dm` |
| `tmux` | none (runner relay) | read + write | `tmux_list_sessions`, `tmux_capture_pane`, `tmux_run_command` (write) |
| `browser` | none (runner relay) | read + write | `browser_snapshot`, `browser_navigate` (write), `browser_act` (write) — experimental |

**Auth** is minted through one path — `connectorClient(env, provider, {userId, instanceId})`:
a GitHub-App installation token, an OAuth refresh→access exchange, a key from the user's BYOK
vault (`user_api_keys`), or none for local relay connectors (tmux/browser reach the user's
machine over the WebSocket relay — machine ownership is already enforced by the relay-token
handshake).

**Write-consent gating (#90).** Every `scope:"write"` connector tool is refused unless the
instance has explicit write-consent for that connector (`instance_connector_consent`, migration
0051). `runRegistryTool` checks consent *before* dispatch, fail-closed; read-only connectors
reject write-scoped calls outright. So `github_create_issue`, Meta messaging, and `browser_*`
can only write where the instance owner has granted that connector's write scope. Reads
(`github_list_issues`, `browser_snapshot`, …) need only the connector granted / the runner online.

**The browser connector is experimental** and additionally gated behind the API worker's
`BROWSER_TOOLS_ENABLED` env flag (fail-closed when unset) — first-party / self-use only until the
browser trust model lands. It bridges the runner's real-Chrome hands (`/browser/snapshot` +
`/browser/act`) into the registry so a config/data agent can drive a browser without bespoke code.

## Recommended Permission Model (ingest connectors)

Connect providers to the account, not to individual agents.

```text
User account
  -> provider connection
  -> folder/shared-drive grants
  -> agent access
```

This avoids repeated OAuth flows, keeps revocation simple, and lets the user reuse one provider connection across many agents without giving every agent blanket access.

## Google Docs Through Google Drive

Google Docs files are Drive files with Google Docs MIME types. To let an agent work with Google Docs, connect Google Drive and grant the agent access to the relevant folders or shared drives.

Production OAuth callback:

```text
https://api.proagentstore.online/v1/drive/google/callback
```

Worker configuration:

```text
GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<worker secret>
```

Cloudflare secret:

```bash
wrangler secret put GOOGLE_CLIENT_SECRET
```

## Client Flow

1. The user opens the ProAgentStore console.
2. The user chooses **Connect Google Drive**.
3. Google asks the user to approve the OAuth consent screen.
4. ProAgentStore stores the encrypted account-level connection.
5. The user grants one or more folders or shared drives to an agent.
6. The agent imports, searches, reads, or writes only within those grants.

## Folder Grants

Folder grants are the boundary agents should use by default.

- Grant the smallest folder that contains the documents the agent needs.
- Prefer a shared drive or dedicated project folder for team workflows.
- Avoid whole-drive access unless the agent is explicitly an account-wide document manager.
- Revoke a folder grant when an agent no longer needs it.

## Zoho WorkDrive

Zoho WorkDrive follows the same model:

1. Connect the Zoho account to the user account.
2. Store the encrypted connection and refresh metadata.
3. Let the user grant selected WorkDrive folders or team folders to agents.
4. Enforce grants server-side before import, read, write, or search actions.

Nested WorkDrive folders must preserve the provider folder identity chain so grants on a parent folder can authorize descendants without confusing sibling folders.

## Agent Access Rules

Agents should never receive raw provider credentials.

Agents receive scoped platform capabilities:

- list granted folders
- search granted files
- import files into instance knowledge
- read allowed files
- write only when the grant and tool scope allow it

All access should be checked against the authenticated ProAgentStore user, the private agent instance, and the provider grant.

## Troubleshooting

If Google Drive or Google Docs connection fails:

- Confirm the OAuth app callback exactly matches `https://api.proagentstore.online/v1/drive/google/callback`.
- Confirm `GOOGLE_CLIENT_ID` is configured in the API worker environment.
- Confirm `GOOGLE_CLIENT_SECRET` is set as a Worker secret.
- Confirm the user approved the requested scopes.
- Confirm the agent has a folder or shared-drive grant after the account connection succeeds.

If an agent cannot see a document:

- Confirm the document is in a granted folder or shared drive.
- Confirm the provider account itself can access the document.
- Confirm the grant belongs to the same ProAgentStore account and private instance.
- Disconnect and reconnect only when OAuth refresh fails; missing grants should be fixed through folder access.
