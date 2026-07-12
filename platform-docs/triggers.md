# Triggers

Triggers let a private ProAgentStore instance start work from outside the chat UI.

Use triggers for:

- inbound webhooks from Zapier, Make, n8n, forms, product events, or custom apps
- recurring cron schedules for digests, syncs, monitoring, and reminders

Triggers are configured per private instance. A creator can build an agent that
supports event-driven work, but each client controls their own webhook URL,
schedule, connector grants, and trigger actions.

## Trigger Types

Webhook triggers expose a high-entropy URL:

```text
POST https://api.proagentstore.online/v1/triggers/webhook/<token>
```

Cron triggers are dispatched by ProAgentStore's API worker scheduler. The platform
checks due triggers every minute and advances the next run before dispatch so a
failing trigger cannot loop continuously.

## Actions

The first trigger actions are intentionally narrow:

- `create_task`: create an instance task from the payload.
- `add_knowledge`: add the payload as an instance knowledge document.
- `log_event`: record the event without changing agent state.

There is no arbitrary shell, generic API proxy, or hidden platform-owned AI spend
path. Triggered work lands in the same instance state, board, knowledge, and audit
surface as manual work.

## Schedules

Supported schedule forms:

```text
@hourly
@daily
@weekly
every 15 minutes
0 8 * * *
```

The MVP supports simple 5-field cron expressions with numeric or `*` fields. It
does not yet support ranges, lists, steps, timezones, or daylight-saving handling.

## API

Authenticated management routes:

```text
GET    /v1/triggers?instanceId=<instance-id>
POST   /v1/triggers
PUT    /v1/triggers/:id
DELETE /v1/triggers/:id
POST   /v1/triggers/:id/run
GET    /v1/triggers/:id/events
```

Create body:

```json
{
  "instanceId": "instance_uuid",
  "name": "Daily digest",
  "type": "cron",
  "action": "create_task",
  "schedule": "@daily"
}
```

Webhook body example:

```json
{
  "title": "New lead",
  "description": "Acme asked for an enterprise quote.",
  "sourceUrl": "https://example.com/leads/123"
}
```

## Current Limitations

- No payload-mapping UI yet.
- No connector polling triggers yet for Google Drive or Zoho WorkDrive.
- No MCP trigger-management tools yet.
- No retry policy UI yet.
- No timezone-aware schedule editor yet.
