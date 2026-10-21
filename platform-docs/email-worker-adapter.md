# Worker-backed email adapter contract (`email-worker/v1`)

Implemented by a **customer-owned HTTPS Worker** (or any HTTPS server) standing in for a mailbox
when there is no Google account to run Gmail's OAuth against. PAGS speaks ONE version of this
contract at a time; `/v1/email-worker/identity` is how a connection reports which one it speaks.

See [connectors.md § Worker-backed email](connectors.md#worker-backed-email) for how this fits
into the platform (connecting, pinning, consent, audit). This page is the wire contract only.

A minimal, runnable reference implementation of every call below is
`workers/api/src/lib/connectors/email-worker.fixture.ts` — read it alongside this page; it is
what this platform's own tests drive against, so it cannot drift from what PAGS actually sends.

## Transport

- Every call is `POST` (identity included — no query strings, no path parameters past the fixed
  route) to `{endpoint}{path}`, where `endpoint` is the https base URL the owner configured.
- `Authorization: Bearer <secret>` on every call, the same secret the owner pasted when
  connecting. Reject anything else with `401` or `403`.
- `Content-Type: application/json` request and response, always.
- A `5xx` is read as **transient** and may be retried (PAGS retries once). A `4xx` is read as the
  adapter's **considered refusal** and is never retried — answer with the real status, not `200`
  with an error flag inside.
- Any non-2xx SHOULD carry a body `{ "error": { "code": "<snake_case>", "message": "<one line,
  safe to show the owner>" } }`. `message` must not contain a message body, a credential, or raw
  provider-internal detail — it is relayed into the platform's audit log and (via the tool
  result) toward an LLM.

## Calls

### `POST /v1/email-worker/identity`

Request: `{}` (no body fields required).

Response:

```json
{ "contractVersion": "email-worker/v1", "account": { "address": "support@example.com" } }
```

`contractVersion` is required; `account.address` is optional (`null` if the Worker has no stable
notion of "its own address"). This is the ONLY call PAGS makes before a connection is stored — a
Worker that cannot answer this is never saved as a connection.

### `POST /v1/email-worker/messages/list`

Request:

```json
{ "folder": "inbox", "cursor": null, "limit": 10 }
```

All three fields are optional; `folder` defaults to whatever the Worker considers primary,
`limit` defaults to 10. Response:

```json
{
  "messages": [
    { "id": "m1", "threadId": "t1", "from": "a@example.com", "to": "me@example.com", "subject": "Hi", "date": "2026-01-01T00:00:00Z", "snippet": "…", "hasAttachments": false }
  ],
  "nextCursor": null
}
```

`id` and `threadId` MUST be stable across calls — they are the only handles PAGS has to read or
reply to a message later, and the issue's AC1 ("preserve stable provider message and thread IDs")
is specifically about this pair. `nextCursor` is opaque; return it as given to `messages/list` to
continue, `null` to say "no more."

### `POST /v1/email-worker/messages/get`

Request: `{ "id": "m1" }`. Response: the message in full —

```json
{
  "id": "m1", "threadId": "t1", "from": "a@example.com", "to": "me@example.com", "cc": null,
  "subject": "Hi", "date": "2026-01-01T00:00:00Z", "body": "the full text",
  "attachments": [ { "filename": "invoice.pdf", "mimeType": "application/pdf", "size": 10240 } ]
}
```

`404` with the standard error body when `id` is unknown.

### `POST /v1/email-worker/messages/send`

Request:

```json
{ "to": "x@example.com", "cc": null, "subject": "Subj", "body": "text", "idempotencyKey": "a-uuid" }
```

Response: `{ "id": "new-id", "threadId": "new-thread-id" }`.

**Idempotency is required, not advisory.** `idempotencyKey` identifies ONE logical send. If a
request with a given key arrives twice (PAGS retries once on a `5xx` or network failure, reusing
the same key), the SECOND request must return the SAME `{id, threadId}` as the first and must
**not** send a second message. A simple approach: keep a short-lived map of `idempotencyKey →
response` and replay it on a repeat, exactly as the reference fixture does.

### `POST /v1/email-worker/messages/reply`

Request: `{ "messageId": "m1", "body": "text", "idempotencyKey": "a-uuid" }`. Response:
`{ "id": "new-id", "threadId": "t1" }` — `threadId` MUST be the parent message's thread. `404`
when `messageId` is unknown. Same idempotency requirement as `send`.

## Inbound delivery events (Worker → PAGS)

The owner pastes a `webhookUrl` (from `GET /v1/email-worker/connections`) into their own Worker's
config — a capability URL, `https://api.proagentstore.online/v1/email-worker/inbound/{token}`,
where `token` IS the credential (no `Authorization` header is checked, same as
`POST /v1/triggers/webhook/{token}`). The Worker `POST`s to it on its own schedule:

```json
{ "type": "message.received", "eventId": "evt-123", "messageId": "m2", "threadId": "t1" }
```

- `type`: `message.received` | `message.delivered` | `message.bounced`.
- `eventId` is **required** and must be unique per real-world event — PAGS dedupes on it, so a
  retried delivery (the Worker's own backoff, or a double-send bug) produces exactly one audit
  receipt, however many times it is resent. Reuse the provider's own event id if there is one;
  otherwise synthesize a stable one (do not use `Date.now()` alone — a collision silently drops a
  real event).
- `messageId`/`threadId` are optional but should be included whenever the event is about a
  specific message — they end up in the audit receipt and the console's activity view.

PAGS responds `202 { ok: true, deduped: <bool> }` and never retries a webhook delivery itself —
that is the Worker's responsibility, with its OWN idempotency key (`eventId`) making retries safe.

## Credential posture (why this contract looks the way it does)

- The secret is a **single opaque bearer token** — no OAuth, no refresh flow, no scopes. The
  owner rotates it by calling `POST /v1/email-worker/connections` again with a new value (same
  `endpoint`+`accountId` → the stored secret is replaced, the `webhookUrl` is unchanged).
- Nothing in this contract ever puts the secret in a URL, a query string, or a log line. The
  inbound direction uses a SEPARATE high-entropy token for that exact reason — the two must never
  be the same value, so that a URL pasted into a third-party tool (a log aggregator, a Slack
  message) cannot be replayed as the outbound credential.
- PAGS never shows an endpoint, a secret, or a webhook token to the model driving an agent — the
  connector's tools (`email_worker_list_messages`, `_read_message`, `_send`, `_reply`) take no
  such argument. Only message content and ids cross into a prompt.
