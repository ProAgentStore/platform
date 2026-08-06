# Triggers

Triggers let a private ProAgentStore instance start work from outside the chat UI.

Use triggers for:

- inbound webhooks from Zapier, Make, n8n, forms, product events, or custom apps
- recurring cron schedules for digests, syncs, monitoring, and reminders
- scheduled Google Drive and Zoho WorkDrive folder syncs into knowledge

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
- `sync_connector`: import new or changed files from a granted Drive or
  WorkDrive folder.
- `log_event`: record the event without changing agent state.

There is no arbitrary shell, generic API proxy, or hidden platform-owned AI spend
path. Triggered work lands in the same instance state, board, knowledge, and audit
surface as manual work.

## Connector Sync

Folder sync triggers use the same account-level connector and per-agent grant
model as manual imports. Connect Google Drive or Zoho WorkDrive once, grant a
folder to an agent instance, then create a trigger with action `sync_connector`.

Example config:

```json
{
  "provider": "google_drive",
  "grantId": "grant_uuid",
  "limit": 10
}
```

Each trigger keeps a file fingerprint ledger, so later runs skip unchanged files
instead of importing duplicates.

## Schedules

Supported schedule forms:

```text
@hourly
@daily
@weekly
every 15 minutes
0 8 * * *
```

Simple 5-field cron expressions with numeric or `*` fields. Ranges, lists and
steps are not supported.

### Timezones

A cron trigger may carry `config.timezone` (an IANA zone, e.g.
`Australia/Melbourne`). The wall-clock schedules — `@daily`, `@weekly` and 5-field
cron — are then matched against the clock in that zone, so "daily at 08:00" stays
08:00 across a daylight-saving change instead of sliding an hour.

Absent (or unknown) timezone means UTC, which is what every trigger did before
timezones existed, so nothing changes for an existing trigger.

Interval schedules (`@hourly`, `every N minutes`) are durations, not clock times,
so a timezone does not apply to them.

Two DST edge cases, decided explicitly:

- **Spring forward** — the requested wall time may not exist (02:30 on the morning
  the clock jumps 02:00 to 03:00). The run is placed at the nearest real instant
  just after the jump rather than skipped, because a daily job silently missing
  once a year reads as a broken agent.
- **Fall back** — the wall time happens twice. The trigger fires **once**;
  firing twice would duplicate side effects.

### Next-run preview

```text
POST /v1/triggers/preview
{ "type": "cron", "action": "create_task", "schedule": "0 8 * * *",
  "config": { "timezone": "Australia/Melbourne" }, "count": 3 }
```

Returns `{ schedule, timezone, jitterMinutes, runs[], issues[], error }`. The run
times are computed by the same function the scheduler uses, so the console's
preview cannot drift from what actually happens — it does not calculate fire
times itself.

## Payload mapping

By default an action reads fixed conventional fields off the payload:
`create_task` uses `title`/`description`, `add_knowledge` uses
`content`/`text`/`title`/`sourceUrl`. Real sources nest their data, so a trigger
may declare `config.mapping` — a target field to a dotted payload path:

```json
{ "mapping": { "title": "lead.name", "description": "lead.note" } }
```

Mappable fields: `create_task` → `title`, `description`; `add_knowledge` →
`title`, `content`, `sourceUrl`; `log_event` → `message`. Array indices are
ordinary segments (`items.0.title`).

A mapped path that this particular payload does not have falls back to the
existing convention, so adding a mapping can never make a working trigger produce
less than it did.

## Config validation

Trigger config is a **whitelist** — a field the API does not recognise is dropped
before dispatch. Create and update therefore reject a config that would be partly
ignored, naming the field and why:

- an unrecognised field (a typo);
- a recognised field belonging to a **different** action (`pipeline` on a
  `create_task` trigger);
- `timezone`/`jitterMinutes` on a webhook trigger, which has no schedule;
- a mapping onto a field the action does not have, or a path that is not a path;
- for **cron** triggers only, missing required action config (`pipeline`,
  `collection`, `url`, connector `provider`/`grantId`). Webhook and manual runs
  may legitimately supply those in the payload, so they are not required there —
  a cron cannot, so a cron missing them can only ever fail at 3am.

`GET /v1/triggers` returns the config as the dispatcher will read it, so anything
the console shows you is guaranteed to be honoured.

## API

Authenticated management routes:

```text
GET    /v1/triggers?instanceId=<instance-id>
POST   /v1/triggers
PUT    /v1/triggers/:id
DELETE /v1/triggers/:id
POST   /v1/triggers/:id/run
GET    /v1/triggers/:id/events
POST   /v1/triggers/preview
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

## Run history

`GET /v1/triggers/:id/events` returns the recent runs of one trigger, owner-scoped
and newest first: `type` (webhook / cron / manual), `status` (received / running /
succeeded / failed), `message`, `payload` and `error`. The console renders this
under each trigger in instance Settings, including the scanned/imported/skipped
counts and per-file errors of a `sync_connector` run.

## Current Limitations

- No retry policy UI yet (failed dispatches go to the shared delivery outbox and
  are retried with backoff; see the Teamwork card).
- Cron grammar has no ranges, lists or steps.
- On a fall-back DST boundary the run lands on the first of the two occurrences;
  the choice is not configurable.
