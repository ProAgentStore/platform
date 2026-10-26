---
description: "Require phone approval for selected account configuration changes and understand held requests, expiry, and state checks."
---

# Approval gate

The **approval gate** (#1268) is a per-account setting that stops major configuration changes from taking effect until
**you approve them from your phone**. It is not a new approval mechanism: it uses the same push notifications and deep links
as the other owner approvals, and it is enforced where every change arrives — the API — so the console, the REST API and
every MCP tool are covered by one decision.

It is **off by default**. With the gate off, nothing about how the platform behaves changes.

## Turning it on

Preferences → **Approval gate**: tick *Require approval for configuration changes*, choose the changes that need approval, and
choose how long a request stays open (default 24 hours).

| Action id | What is held |
|---|---|
| `coder_create` | Creating (or cloning) an agent type — on by default |
| `instance_create` | Creating a coder instance (subscribing) — on by default |
| `repo_add` | Adding a repo to a coder instance — on by default |
| `runner_repin` | Repinning an instance's runner machine, repo retargeting |
| `engine_model` | An instance's engine presets, engine choice or model |
| `connector_pin` | Which connected account an instance uses (Gmail, MCP, worker mail, Gmail identity) |
| `grants_consent` | Connector and MCP write consent, Discord/Slack/Drive/WorkDrive grants |
| `instance_cancel_delete` | Cancelling an instance, removing its runtime, deleting an agent type |
| `tool_allowlist` | An agent type's capabilities, a tool switched on or off for an instance |

The same settings are available over MCP (`get_approval_gate`, `set_approval_gate`) and `GET`/`PUT /v1/approval-gate`.

## What happens to a held change

1. The change is **not applied**. The exact request (method, path and body) is stored encrypted, together with a redacted
   preview of what it would do (secret-looking values are masked) and a fingerprint of the state it would change.
2. You get a push notification whose link opens Preferences on that request.
3. The caller gets **HTTP 202** with:

   ```json
   {
     "status": "approval_pending",
     "approval_id": "…",
     "action": "runner_repin",
     "action_label": "Repin an instance's runner machine",
     "target": "Instance … → mac-mini",
     "diff_preview": { "method": "PUT", "path": "…", "change": { "runnerNode": "mac-mini" }, "summary": "…" },
     "expires_at": "2026-10-23T09:00:00.000Z",
     "poll": "/v1/approvals/<approval_id>",
     "message": "Nothing has changed. …"
   }
   ```

   The same request made again while it is pending returns the same `approval_id`. An MCP tool returns this body as its
   result; follow it with `approval_status`.
4. Poll `GET /v1/approvals/<id>` (or `approval_status`). `status` is one of `pending`, `approved` (approved and applying),
   `applied`, `denied`, `cancelled`, `expired` or `failed`, with the audit `events` and, once it ran, `result` (what the change
   answered).

## Deciding

Approve or deny in the console (Preferences → Approval gate) or from the push link — `POST /v1/approvals/<id>/approve` or
`/deny`. **MCP cannot approve or deny**: the API refuses a decision that arrives with MCP's client marker, so an agent holding
your token cannot approve its own request. There is no MCP tool for it.

- **Approve** applies the stored change **once**: a second approval, a replay, or two taps at once are no-ops.
- **Drift:** before applying, the platform re-reads what the change would modify. If it is not what it was when you were
  asked, nothing is applied (`409`, `drift_detected`; the request ends `failed`) — ask again against the current state.
- **Expiry:** a request that passes its expiry is never applied (`410`, `expired`).
- **Deny** and **cancel** leave everything unchanged.

## The gate protects itself

While the gate is on, **turning it off or removing an action is itself held** for approval. Making it stricter (more actions)
applies at once. A request that somehow skipped the gate still cannot weaken it.

## Audit

Every request, push outcome, decision (who, when, from which device), apply start and apply result is recorded and shown under
the request in Preferences → Approval gate → History.

## What it does not cover

Only the changes in the table. Reads, chat, running tasks and the coding runs themselves are not held. Changes to the gate are
the only exception to "off means off": while it is on, weakening it needs approval.
