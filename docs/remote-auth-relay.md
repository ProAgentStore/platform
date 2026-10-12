# PAS remote MCP sign-in: the PAGS relay (#1005)

Design A, chosen by the owner on #1006: the PAS companion client on the owner's machine creates the
sign-in request at ProAppStore and relays it through the `pags` CLI. **ProAgentStore never holds a PAS
credential and never calls PAS.** It stores what the machine relayed, pushes the owner a link to that one
request, and its page sends the owner to ProAppStore's own approval page.

```
companion (machine) ── POST /v1/mcp/broker/v2/requests ──▶ ProAppStore      (PAS bearer, proof hash, PKCE, key)
companion ── pags remote-auth relay (stdin, public details) ──▶ ProAgentStore ──push──▶ owner's phone
owner's phone ── /console/remote-auth/:id ── "Sign in at ProAppStore" ──▶ PAS approval page (external browser)
companion ── poll / redeem / connected ──▶ ProAppStore                         (secrets stay on the machine)
companion ── pags remote-auth state <id> <state> ──▶ ProAgentStore            (what the page shows)
```

## The contract PAS #356 implements

**Relay**, once per PAS request: run `pags remote-auth relay` with the request as JSON on stdin.

```json
{
  "request_id": "req_…",
  "agent": { "id": "codex", "label": "Codex" },
  "machine": { "id": "mac-42", "label": "Remote Mac" },
  "resource": "https://mcp.proappstore.online/mcp/apps/example",
  "scopes": [],
  "approval_url": "<the approval_url PAS returned>",
  "expires_at": "<PAS expiry, ISO or epoch ms>"
}
```

It prints one line of JSON: `{"id":"rar_…","url":"https://proagentstore.online/console/remote-auth/rar_…","state":"pending","duplicate":false}`.
Exit code 2 is a refused input; 1 is a transport or API error, so retry with the **same** JSON. A retry is
the same request (`duplicate: true`, no second push).

**State**, every time the broker state changes: `pags remote-auth state <rar_id> <state>`, where state is one
of `pending approving approved_awaiting_machine consumed connected denied expired cancelled failed`.
Report `connected` only after the authenticated MCP read PAS requires. States only move forward, and a
terminal state is final.

**Never put in the relay** — the CLI refuses the whole relay if any key, at any depth, looks like one:
the machine proof, PKCE verifier, private key, any token, code, session, cookie or ciphertext. The
approval URL must not carry `code`, `token`, `state`-free OAuth legs or other credential parameters.

## What PAGS checks

- The resource is `<PAS MCP origin>/mcp` or `/mcp/apps/:appId` exactly; scopes are `[]`; the approval URL
  is https on a PAS origin (`REMOTE_AUTH_APPROVAL_ORIGINS`, `REMOTE_AUTH_MCP_ORIGIN` in the API worker);
  the expiry is within the hour.
- One request per owner and PAS request id. A relay of the same id with different details, or from another
  of the owner's machines, is refused. Only the machine that relayed a request may report its state.
- A request past its expiry shows as expired whatever was last reported.
- The push and the page carry ids only. The page is owner-scoped and served `no-store`, `no-referrer`.

## The owner's steps

1. Your phone gets "🔐 Approve a ProAppStore sign-in". Open it (signed-out, you return to the same request
   after signing in).
2. Check the agent, machine and access shown, then tap **Sign in at ProAppStore**. It opens ProAppStore's own
   page in your browser, where you choose Google or GitHub and approve.
3. The machine picks up the result from ProAppStore by itself. The page shows *Connected* only once the
   machine has made an authenticated ProAppStore MCP call.

**Limitation:** a web page cannot force your phone's default browser. If the link opens inside another app's
preview (for example ChatGPT's) and Google refuses there, open the request page in Safari or Chrome — the page
offers a "copy this page's link" button for that. It is a ProAgentStore link with no credential in it.

**Not covered here:** the PAS companion side (PAS #356) and real-device acceptance (#1006).
