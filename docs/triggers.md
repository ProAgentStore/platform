# Instance Triggers

ProAgentStore triggers let a private agent instance react to work that starts
outside chat:

- inbound webhooks from Zapier, Make, n8n, forms, product events, or custom apps
- cron schedules for digests, monitoring, syncs, and recurring checks

Triggers are instance-scoped. A creator can build an agent that supports scheduled
or event-driven work, but each client configures their own instance schedule,
webhook URL, account grants, and payload mapping.

## Security Model

Triggers are not arbitrary code execution and not a generic API proxy.

- Webhook triggers use a high-entropy capability URL.
- Authenticated trigger management is scoped to the instance owner.
- Cron triggers are dispatched by the platform worker scheduler.
- Dispatch targets the instance Durable Object only.
- Actions are narrow and auditable: `create_task`, `add_knowledge`, `log_event`.
- Every trigger run writes an `agent_trigger_events` row and an `agent_events`
  trace row.

## Database

Migration `0045_instance_triggers.sql` adds:

- `agent_triggers`: trigger definition, owner, instance, action, schedule/secret,
  next run, last run, and failure state.
- `agent_trigger_events`: append-only history of received, running, succeeded,
  and failed trigger runs.

## API

Authenticated routes:

- `GET /v1/triggers?instanceId=...`
- `POST /v1/triggers`
- `PUT /v1/triggers/:id`
- `DELETE /v1/triggers/:id`
- `POST /v1/triggers/:id/run`
- `GET /v1/triggers/:id/events`

Public webhook route:

- `POST /v1/triggers/webhook/:token`

Cron dispatch:

- The API worker has a Cloudflare cron trigger every minute.
- `scheduled()` calls `runDueTriggers(env)`.
- Due rows are advanced before dispatch so a failing trigger cannot hot-loop.

## Schedules

Supported MVP schedule forms:

- `@hourly`
- `@daily`
- `@weekly`
- `every N minutes`
- simple 5-field cron with numeric or `*` fields

The MVP intentionally does not implement full cron syntax such as ranges, lists,
steps, timezones, or daylight-saving handling.

## Dispatch Actions

`create_task`

Creates an instance task from the trigger payload. Payload fields `title`,
`description`, and `content` are recognized. This is the safest default because it
puts work on the agent's board without silently spending caller AI.

`add_knowledge`

Adds a document to the instance knowledge base. Payload fields `title`, `content`,
`text`, and `sourceUrl` are recognized.

`log_event`

Records the trigger event without changing the agent state. This is useful during
setup and for webhooks that should be audited before automation is enabled.

## Next Work

- Add payload mapping UI per action.
- Add connector polling triggers for Google Drive and Zoho WorkDrive folders.
- Add MCP tools for trigger management.
- Add retry/backoff policies and notification-on-failure preferences.
- Add timezone-aware schedule UX.
