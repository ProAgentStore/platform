# Cloudflare Email Sending and Email Routing

A Cloudflare address such as `admin@freeappstore.online` is often a **routed alias**, not a Gmail
mailbox: Email Routing receives mail for it and forwards or handles it, and Email Sending can send
as it — if the domain is onboarded for sending. Gmail OAuth is the wrong connector for that. This
page is how a private PAGS agent reads and sends through Cloudflare mail, using the worker-backed
email connector ([adapter contract](email-worker-adapter.md)) and a **bridge Worker you deploy in
your own Cloudflare account**.

## Why a bridge

Cloudflare Workers' email bindings (`send_email`, and the `email()` handler Email Routing calls) are
**account-scoped**: they can only be attached to a Worker in the same account as the domain. A PAGS
Worker cannot hold them. So you deploy `templates/cloudflare-email-bridge/` in your account; it
holds the bindings and speaks to PAGS over `email-worker/v1`.

The only credential PAGS ever holds is **one bearer secret** that you paste into the console. It is
stored encrypted and is never placed in a prompt, instruction, tool argument or log. **No Cloudflare
API key and no SMTP password is requested, stored or used anywhere.** PAGS has no standing access to
your Cloudflare account.

## Install

1. Onboard the domain in Cloudflare: **Email → Email Sending** (verify the domain) and **Email →
   Email Routing** (enable routing, verify each destination address).
2. Copy `templates/cloudflare-email-bridge/`, set `DOMAINS`, `SENDERS`, `REPLY_IDENTITIES` and `ROUTES`
   in `wrangler.toml`, create the KV namespace it names, and `wrangler deploy`.
3. `wrangler secret put BRIDGE_SECRET` (a long random value).
4. In PAGS (Preferences → Connections → Worker-backed email), add the bridge's `https://…` URL and
   that secret. PAGS probes the bridge, records what it reports, and shows you the inbound URL **once**.
5. `wrangler secret put PAGS_INBOUND_URL` with that URL, then in **Email Routing → Routing rules**
   send the addresses you want PAGS to see to the bridge Worker.
6. Approve the senders (below), pin the connection to the agent, and grant it write consent.

No Google account is involved at any step.

## Senders, routes and replies are different things

| | Meaning | Where it comes from |
|---|---|---|
| **Sender** | An address Email Sending will send **as**. | `SENDERS` in your bridge — read by PAGS from the bridge's own identity report. |
| **Route** | An address Email Routing accepts mail **for**, with a destination. Inbound only. | `ROUTES`. |
| **Reply identity** | The sender replies go out from. Must be an approved sender. | `REPLY_IDENTITIES`, then chosen by you in PAGS. |

**A route does not make an address send-capable.** If `info@example.com` is only in `ROUTES`, a
send from it is **refused** — by PAGS before anything is sent, and again by the bridge — with the
reason "routed-only". Approving it is refused too.

A send is allowed only for an address that is **both** reported as a sender by the bridge **and**
approved by you for this connection, **and** on an onboarded domain. Approving is
`PUT /v1/email-worker/connections/identities` `{endpoint, accountId, approvedSenders, replyIdentity}`
(or the console's *Approved senders*). With nothing approved, nothing is sent.

If the bridge later stops reporting an address as a sender, your approval for it is dropped on the
next probe.

## What is shown

`GET /v1/email-worker/connections` (and the agent's `email_worker_identities` tool) report, per
connection: the **domains**, each **sender** with whether it is approved and whether it is the reply
identity, each **route** with its **destination** and whether it can send, and **bridge health** —
whether the last probe or call succeeded, when, and the failure class (`bridge_unavailable`, `auth`,
`protocol`). A bridge that is down is shown as down; it is not discovered by an agent failing.

## Tools

| Tool | Scope | Notes |
|---|---|---|
| `email_worker_list_messages` | read | Inbound messages the bridge holds. Fenced as untrusted. |
| `email_worker_read_message` | read | One message; the **original** sender and recipient are preserved. |
| `email_worker_send` | **write** | `from` optional (default: first approved sender); must be an approved sender. |
| `email_worker_reply` | **write** | Sent from the reply identity, to the original sender; neither can be overridden. |
| `email_worker_identities` | read | Senders, routes, reply identity, domains, health. |
| `email_worker_list_events` | read | Audit events (inbound, delivery, send, reply, routing/bridge failures): ids and addresses, never bodies. |

All of them go through the same gates as every connector: the agent's declared tools, the
per-instance **account pin** (with several connections and no pin the call is refused — it never
picks one, and never falls back to Gmail), the **write consent** for sends, and any "ask each time"
approval. A denied tool, a missing consent, a wrong pin, a denied sender and a bridge failure read
differently, and only the last ever reaches the bridge.

## Inbound events (bridge → PAGS)

The bridge `POST`s to the inbound URL (the URL is the credential):

```json
{ "type": "message.received", "eventId": "in:<message-id>", "messageId": "…", "threadId": "…",
  "from": "alice@example.org", "to": "admin@example.com" }
```

* `from` / `to` are the **original** sender and recipient. For a Cloudflare connection `to` must match
  a configured route on a configured domain; anything else is **not** recorded as mail — it is a
  `routing_failure` receipt and the call answers `422`.
* `delivery.delivered` / `delivery.bounced` / `delivery.deferred` report outbound outcomes
  (`messageId`, optional `providerReceiptId`). A bounce is recorded as a failure.
* `bridge.failure` (`failureClass`) reports the bridge's own routing or sending failure.
* **Replay-safe**: the first event for an `eventId` is processed; a repeat answers
  `{ok:true, deduped:true}` and is recorded as a `deduped` receipt. Nothing is processed twice.

## Sending and idempotency

Each send/reply carries an **idempotency key** — the caller's `idempotency_key`, else one derived from
the run and the content — also sent to the bridge as `idempotencyKey`. The bridge must treat a repeated
key as the same send (the template does). PAGS records the accepted send, with the provider's receipt
id (`providerReceiptId`, Cloudflare Email Sending's message id), as a `sent` receipt — one per key,
enforced by the database — so a retry is answered from it **without reaching the bridge**. To send
identical text twice on purpose, pass a different `idempotency_key`.

## Audit receipts

`email_worker_receipts` is **append-only** (database triggers abort `UPDATE` and `DELETE`). A receipt
holds the connection, the kind (`send`, `reply`, `inbound`, `delivery`, `routing_failure`,
`bridge_failure`, `refusal`, `list`, `read`), the outcome (`ok`, `sent`, `failed`, `refused`,
`deduped`), a failure class, the stable ids (message, thread, provider receipt, event), the original
sender and recipient addresses and the idempotency key. It holds **no message body, subject, secret or
bridge response text**. Read it with `GET /v1/email-worker/receipts` (filters `endpoint`, `account`,
`kind`, `outcome`, `since`, `until`, `before`, `limit`) — this is the feed for an application audit
trail — or with the `email_worker_list_events` tool.

Failure classes you will see: `sender_routed_only`, `sender_not_approved`, `sender_wrong_domain`,
`sender_not_reported`, `sender_no_approved_sender`, `pin_ambiguous`, `pin_pinned_account_gone`,
`pin_not_connected`, `bridge_unavailable`, `auth`, `protocol`, `bounced`, `route_unrouted_recipient`,
`route_unknown_domain`.

## Conformance

`workers/api/src/lib/connectors/email-worker-cloudflare.test.ts` runs the connector against the real
bridge template (`templates/cloudflare-email-bridge/src/bridge.ts`) over in-memory Cloudflare
bindings. A bridge of your own is conformant when it answers the same calls the same way.

## Managing the connection over MCP (#1277)

An owner's agent can configure and inspect a bridge connection through the same API services the console uses. No MCP tool
accepts or returns the bridge secret.

1. `get_instance_email_worker` — state (`absent`, `ambiguous`, `stale_pin`, `connected`), the pin, identities and bridge health,
   the instance's write-consent mode, and `blockers[]`. Each way mail can fail to flow is a separate code: `no_connection`,
   `ambiguous_connection`, `stale_pin`, `bridge_unreachable` (with `failureClass` `auth`, `protocol` or `bridge_unavailable`),
   `no_identity_report`, `no_approved_sender`, `no_reply_identity`, `write_consent_off`, `write_consent_ask`.
2. `begin_email_worker_enrollment` returns a console link. The **owner** types the bridge secret there (the console's secure-input
   page; envelope-encrypted, one-shot). The request is bound to one endpoint and account, and only the enrollment can spend it —
   `tmux_secure_get` and `secure_input_inject` get nothing from it.
3. `complete_email_worker_enrollment` consumes the entered value on the server, calls the bridge's `/v1/email-worker/identity`
   with it and stores the connection only if the bridge identifies itself. `not_entered` consumes nothing; `probe_failed` keeps
   the value so a Worker fix does not cost a retype.
4. `test_email_worker_connection` re-tests the stored credential (no secret argument) and records health.
5. `set_instance_email_worker_account` pins the instance to one connection; `set_email_worker_identities` approves senders and the
   reply identity. A routed-only alias is refused. Write consent for sending stays the owner's console decision; MCP reports it and
   cannot change it.

Every writer takes `dry_run`; read the result back with `get_instance_email_worker`.

## Recipient scope, bounded reads and the checkpoint (#1278)

- **One mailbox.** Set `MAILBOX` (e.g. `admin@example.com`) to confine the bridge to the mail PAGS's agent is meant to process.
  Mail Email Routing delivers for any other address is neither stored nor forwarded (PAGS records it as a routing failure,
  never as mail received); listing, reading and replying are confined to the mailbox, and a direct message id for anything else
  is a `404` indistinguishable from an unknown id. Unset keeps the #1270 behaviour (every routed address). PAGS also checks the
  bridge's reported `mailboxes` on every list, read, reply and inbound event, so a bridge that has not been upgraded cannot
  widen an agent's reach.
- **Pagination.** The bridge indexes mail by arrival time per mailbox; `nextCursor` resumes at any depth (230 messages are 10
  pages of 25), and a new arrival never shifts or repeats the pages after it. Mail stored before the index existed is not listed.
- **Bounds, enforced in code.** At most 25 summaries per list; subject 200 and snippet 120 characters; a stored body is kept to
  50,000 characters (the raw message is read to 256 KiB at most); a read returns 6,000 characters by default and 20,000 at most,
  says `truncated` and gives `nextOffset`; a send or reply body over 20,000 characters is refused.
- **Per-run budget** (counted at PAGS, so it holds across the separate tool calls of a run): 60 summaries, 6 body reads, 60,000
  body characters. A refusal says what was used and fetches nothing.
- **Checkpoint.** Reading a message to its end, or replying to it, marks it *handled* for that agent instance. A list skips
  handled mail and reports `skippedHandled`, `scanned`, `more` and `nextCursor` — a scan that ran out of allowance among handled
  mail says `scan_budget` and hands back a cursor instead of claiming the mailbox is empty. `include_handled: true` shows
  everything. The checkpoint holds ids and times only, per instance and connection.
- **Replies** go out only from a configured reply identity (the bridge refuses any other, even another sender), to the original
  sender, and only for a parent that is in the mailbox; PAGS checks the parent before anything is sent.
