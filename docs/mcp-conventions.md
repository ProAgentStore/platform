# MCP tool conventions

How a ProAgentStore MCP tool is named, takes arguments, answers and fails. Written from the audit
in [`mcp-tool-audit.md`](./mcp-tool-audit.md) (#1241). The mechanics of adding a tool (file, gate,
scope, test) are in `workers/mcp/CLAUDE.md` § Adding a tool. This document is about what the
calling model experiences.

Where a rule is enforced, the enforcing test is named. The rest is review guidance.

## Names

- `snake_case`, `verb_noun` or `noun_verb` consistently within a family (`coding_loop_start`,
  `coding_loop_status`). One family keeps one order.
- Say the target in the name when a template and an instance both have the thing:
  `add_knowledge` (template) vs `add_instance_knowledge` (instance). A new tool on an instance
  carries `instance` in its name.
- **No second tool for an existing route.** Before adding a tool, grep the API path it would call:
  if a tool already calls it, extend that tool. The audit found four pairs that broke this (§4).
- Growing the surface needs an appended `TOOL_COUNT_CEILINGS` entry with a reason
  (`tool-count.test.ts`).

## Arguments

- `snake_case` keys. A camelCase key is accepted and renamed at the registration seam, and the
  reply says so (`argument-normalize.ts`). That is a safety net, not a licence: the schema stays
  snake_case.
- IDs are `<thing>_id` strings and are opaque: copy them from the tool that returned them.
  Accept an instance's slug wherever an `instance_id` is taken (`findInstanceForAgent`).
- Lists: prefer `z.array(z.string())`. Where a comma-separated string is the established shape
  (`labels`), keep it. The seam converts either form into the other, with a note.
- Booleans and numbers: declare the real type. The seam reads `"true"`/`"false"` and numeric
  strings as the declared type, with a note, because a client with a stale schema sends strings.
- Object arguments accept a JSON string as well (`z.union([z.record(z.unknown()), z.string()])`).
- Every authenticated tool takes the optional `token`. It is left out of argument tables and
  examples.
- Describe every argument (`.describe(...)`): its meaning, its format and where its value comes
  from ("Instance ID or slug from my_instances"). The first 160 characters are what an
  actionable error repeats.

## Descriptions

The description is the only documentation a calling model reliably reads. In this order:

1. **Verb-first purpose** in one sentence: what it does to what.
2. **When to use it instead of its siblings**: name them (`chat_with_instance`, not "the other
   chat tool").
3. **Required vs optional arguments** that are not obvious from the schema, and where their
   values come from.
4. **One concrete example** call or value.
5. **What it returns** and what to call next (pagination, polling, the follow-up tool).

Say what it does **not** do when a model would plausibly assume it does. Avoid version history in
descriptions; it belongs in the code comment above the registration.

## Results

- `jsonText` (compact JSON) or `text`. Never indented JSON (`conformance.test.ts`).
- Lists page with `nextCursor` (preferred) or `nextOffset`, and say `total` when it is known. A
  list never silently drops entries: a capped list says what it left out (the head-cut ratchet
  refuses a bare `.slice(0, N)`).
- A write returns enough to verify it: the id it created or changed, and a receipt.
- `completed` means the tool call returned, not that the work it started finished. Return the
  run/queue/session id to poll, and name the tool that polls it.

## Errors

- Non-2xx from the API is never formatted as success: `apiCall` returns `{error: "API <status>"}`,
  and the tool must check it before reporting.
- **Invalid arguments** are answered at the seam, for every tool, in this shape (do not hand-roll
  your own):

  ```
  Input validation error: Invalid arguments for tool <tool>.

  What is wrong:
  - `<arg>` <why>

  <tool> takes:
  - `<arg>` (<type>, required|optional) — <description>

  Corrected example: {"<arg>": <value>}
  ```

  The prefix stays `Input validation error`, because the call audit classifies `invalid_input` by
  it.
- **Unknown tool**: `Tool <name> not found. Did you mean …` with the nearest real names.
- A refusal from the API should say **what to do next**: the argument to add (`queue_if_busy:
  true`), the tool to call first (`list_instance_tools`), or that it cannot be retried.

## Safety arguments

- `dry_run` on every mutating tool, unless a read tool is a better preview. Say which one in a
  comment above the registration (`contract.test.ts`).
- `confirm` on every destructive tool, equal to the tool's own name (`remove_repo` is the one
  exception).
- Order: permission → dry run → confirmation → call → audit → answer.

## Time

- Accept ISO 8601 or epoch milliseconds for `since`/`until`. Return ISO 8601 UTC.
