# ADR 0004 — An audit event points at content; it does not copy it

**Status:** Accepted (2026-08-18) · **Owner decision** · Supersedes nothing.

## Context

The MCP audit log (`workers/mcp/src/safety.ts`) is written by ~75 independent call sites, each
choosing what to record. Four of them — the four with the largest payloads — chose to record a byte
count (`base.ts`'s `messageBytes`, the two `messageBytes` sites in `coding-tools.ts`,
`instance-tools/coding.ts`'s `objectiveBytes`), for the defensible reason that they were the ones
big enough to notice. Three shared helpers (`dryRun`, `requirePermission`, `requireConfirmation`)
recorded the caller's whole `input` verbatim, for the equally defensible reason that when they were
written the input was a small argument object.

Neither decision is wrong alone. Together they produced a log that keeps prose only when the prose
changed nothing. Measured on 2026-08-18 across the 500 newest production events
(`2026-06-24T00:44:51Z` → `2026-08-17T22:44:56Z`, one subject): 212 events whose payload is only a
byte count, 115,487 bytes of instruction prose counted and discarded — and one `denied`
`write_agent_file` carrying the entire source file it refused to write, beside fourteen successful
ones carrying `{agent_id, path, message}` and no content at all. **The file we refused to write was
on the record; the file we wrote was not.**

Two earlier decisions had already settled the value question in the other direction, in code
comments rather than anywhere findable: `lib/connectors/mcp.ts` records an outbound MCP call as
`{endpoint, method, tool, status, durationMs, ok, failure, argKeys, argBytes, resultBytes}` — key
names and sizes, never values (#265) — and `routes/tools.ts` records an elicited answer the same
way, with the note *"`redactSecrets` is not a substitute for not writing them down."*

The traffic in question carries repository file contents, credential-adjacent prose, third-party
PII from agent replies, and the owner's own writing, under a 90-day KV TTL. So the obvious
"improvement" — start logging the bodies — would create a quarter-year archive of the owner's
repositories to solve a problem that turns out to be a missing join: the content overwhelmingly
exists already, in `instance_messages`, `coding_timeline`, the loop run record and the GitHub
commit. What was missing was the correlation id and the provenance, not the bytes.

## Decision

**An audit or trace event records the identity, the size and the shape of what a call carried —
and the correlation id of the record that holds the content. It does not carry a copy of the
content.**

**A1 — What an event may carry.** Tool name, subject, timestamp, argument **key names**, argument
and result **byte counts**, status and failure class, duration, and any id that resolves to the
durable record: `traceId`, `session_id`, `runId`, `messageId`, a commit SHA.

**A2 — What it may not carry.** Message text, file contents, an argument's values, or a response
body. There is no opt-in body-capture path: one was proposed with #701 and was **not** built,
because the content the capture would duplicate is reachable through A1's ids, and the store it
would need is a new breach surface the ledger is not. Revisit only on a concrete trace that could
not be reconstructed because the content existed nowhere.

**A3 — The refusal and rehearsal paths get no exemption.** A denial and a dry run are audit events
like any other. They were written first, which is why they were verbatim; being first is not a
reason. Where the paths disagree, the fix is to store LESS on the loud one, never more on the quiet
one.

**A4 — Every audit call site must find or create a correlation id.** Where a call has none, that is
a finding about the feature — content nothing can join back to — not a licence to inline the
payload. `call_instance_tool` was exactly that case and is why A4 is a rule rather than advice.

**A5 — A join key must not outlive the audit row, silently.** See below; this is the rule that was
missing from the proposal.

### A5 in full — the retention story, decided here rather than at day 91

The audit trail is KV with a **90-day TTL** (`safety.ts`). `coding_timeline` is D1 and effectively
permanent; `instance_messages` lives in the instance's Durable Object with no expiry. So the two
halves of a joinable record expire on opposite schedules: **the record of who asked for something
expires while the record of what happened persists.** At day 91 a `traceId` on a `coding_timeline`
row points at an audit event that is gone, and the question "who told the agent to do this" becomes
permanently unanswerable for content that is still sitting there.

`agent_events` is a third schedule again — `logEvent` prunes rows older than **14 days**
opportunistically — so the unified trace forgets fastest of all.

**Decided: the asymmetry stays, and it is stated rather than fixed.** Three reasons, in order of
weight:

1. **The direction of the asymmetry is the safe one.** The thing that expires is the *ledger of who
   acted*; the thing that persists is the *work product the owner asked for*. The reverse — content
   expiring while the accusation survives — would be far worse. An audit row that outlived its
   content would point at nothing and read as evidence of something unreadable.
2. **Lengthening the audit TTL is not free and not obviously right.** It is a per-event KV key; a
   longer TTL is a larger standing archive of who-did-what, which is itself the thing A2 declines
   to accumulate. "Keep the ledger forever" is a decision with a privacy cost, not a default.
3. **The store is changing anyway.** #704 step 5 records the direction: MCP audit belongs in
   `agent_events` (D1, migration 0038, already indexed on `user_id`/`trace_id`/`source`), where
   retention is a query and a cron rather than a per-key TTL, and where an MCP event and a chat
   event sharing a `trace_id` appear in one timeline. Setting a new TTL constant now would be
   choosing a number for a store we intend to replace.

What this rule *does* require, and what makes it a constraint rather than a shrug:

- **A reader that joins across the boundary must distinguish "no audit row" from "the audit row
  expired".** An empty join result at day 91 is not evidence that nothing was audited. Any surface
  that presents a joined view must say which side it could not resolve, in the ADR-0002 sense: the
  denominator is part of the answer.
- **The 90 days is a documented property, not an implementation detail.** It is already stated in
  `platform-docs/mcp.md`; a change to it is a decision that supersedes this record, not a constant
  edit.
- **When MCP audit moves to D1, this clause is what the migration has to answer:** pick a retention
  for the ledger deliberately, and make the trace's own 14-day prune and the ledger's retention
  agree or say why they differ.

No constant changes in the commit that carries this ADR. A5 is a decision to state the mismatch and
bound what may be concluded from it, not to alter a TTL.

## Consequences

- **Reconstructing a call requires one join.** That is the price of not keeping a 90-day archive of
  the owner's repositories, and it is paid by whoever is debugging rather than by everyone whose
  data is stored.
- **A new audit call site has more work to do**: find the id. Where none exists, the feature gets a
  finding rather than the log getting a body.
- **Some detail is genuinely lost.** A `call_instance_tool` invocation records its argument *key
  names* and a size; the values are gone and nothing else holds them. That is accepted: an
  arbitrary connector argument is the most likely of all these payloads to be a credential.
- **A joined view is incomplete after 90 days by design** (A5), and must say so rather than render
  an empty column.

## Enforcement

- **`workers/mcp/src/safety.test.ts` — "an audited value is an identity or a size, never a body".**
  It drives the three shared helpers and asserts no string ANYWHERE in the resulting event, at any
  depth, exceeds `AUDIT_VALUE_MAX` (120 characters — a uuid is 36, a commit SHA 40, a route with a
  uuid in it about 50). It is the deliverable that fails when someone "fixes" this the obvious wrong
  way, and it was watched going red against the pre-#701 code: four of its five cases failed.
- **`summarize()` in `safety.ts` enforces A1/A2/A3 mechanically** for every call site, including
  ones not yet written, by running inside `audit()` rather than at the helpers. A long string
  becomes a byte count under a `…Bytes` key — the shape the success paths had already chosen by
  hand.
- **`workers/mcp/src/instance-tools/contract.test.ts`** asserts the generic connector invoker
  records its own success (A4). It deliberately does NOT sweep every mutating tool: that sweep was
  written and thrown away, because this file drives every handler against one canned `{ok:true}`
  response and several tools audit inside a branch that response never reaches — it reported nine
  "silent" tools of which most were artefacts. Per ADR 0002 G3, a probe that cannot tell "did not
  audit" from "my fixture never got there" reports a number it did not measure.
- **Review.** The rule to ask at any new `audit()` call: *which record holds the content, and what
  is its id?* If the answer is "nothing does", that is A4, and the answer is not to paste the
  payload in.
