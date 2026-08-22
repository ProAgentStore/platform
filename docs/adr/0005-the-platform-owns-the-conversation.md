# ADR 0005 — The platform owns the conversation

**Status:** Accepted (2026-08-22) · **Owner decision** · Supersedes nothing.

## Context

A Coder session is one child process's lifetime on one machine. It is reaped after six hours idle
(`IDLE_SESSION_MS`, `lib/coding-session-sweeper.ts`), deliberately set below one night so an
abandoned tab does not hold a process on somebody's laptop until morning. That is a good decision
about a real cost, and this record does not disturb it.

What survives a reap is the question.

**The durable record already exists.** `coding_timeline` is append-only in D1 at 100 000 characters
per entry (`lib/coding-timeline.ts:59`), interleaving `chat_user` · `chat_assistant` · `terminal` ·
`command` · `brain` · `outcome` · `system`, readable per session and — since #257 — per repo, with
each row tagged by the session that produced it. The console reloads history from it. The co-pilot
reads a recent slice. It is complete enough that a human can reconstruct a run from it.

**It is read only ever FOR THE HUMAN. Nothing feeds it back INTO an engine.**

What the engine gets on wake is something else entirely. `coding/headless.ts:266`:

```ts
this.claudeSessionId = readState(config.statePath, config.id) ?? (config.resumeFrom ? readState(config.statePath, config.resumeFrom) : null);
```

`readState` loads a JSON file on the runner's own disk (`defaultStatePath(this.reposBaseDir)`,
`coding/runtime.ts:238`) mapping our `coding_sessions.id` to **Claude Code's own** session id. The
conversation itself lives in `~/.claude`, owned by another program, on one machine. #408 built the
policy that decides whether to use it (`resolveSessionContinuity`, four-day window) and that policy
is correct — but the thing it points at is not ours.

Four consequences, all verified in code:

1. **Machine-bound.** The state file is local to the runner that wrote it. `reassignSessionNode`
   (`lib/coding-store.ts:550`) relocates a live session to another machine with a single-column
   `UPDATE`, and `lib/coding-session-lifecycle.ts:59` records that leaving the status alone is
   deliberate. Nothing carries the state file across, so the relocated session keeps its id and
   starts cold, silently. (#694 — traced, not yet reproduced.)
2. **Not ours to keep.** Clearing `~/.claude`, or the vendor changing its store, ends continuity and
   no D1 row can help.
3. **Opaque.** We cannot read, compact, or measure it. This is *why* `RESUME_WINDOW_MS` is four days:
   the argument in its header reasons from the length of a long weekend, which is honest reasoning
   about a quantity we cannot observe.
4. **Claude-only.** `headless.ts:260` returns `resumedConversation` false "for a raw (non-Claude)
   engine under every circumstance". Codex and Grok have no conversation at all — for them
   continuity does not degrade, it has never existed.

Measured 2026-08-17 on instance `bd43f4de` (Chess coder 2): after a 6h reap, a new open returned
`resumed: true` and the engine recalled its previous closing question **verbatim** in 8 seconds,
matching `coding_timeline` seq 9227. The mechanism works — on one machine, for one engine, within
four days, reachable from one surface. This record is about removing those four qualifiers.

## Decision

**`coding_timeline` is the source of truth for what a run knows. An engine's native memory is an
optimisation that may be preferred when present, and nothing may depend on it.**

Stated so it can be checked:

> **No code path may hand a user a cold engine when `coding_timeline` holds content for that repo.**

Where the engine's own memory is available and current, use it — `--resume` is cheaper and higher
fidelity than anything we can reconstruct, and this record does not deprecate it. Where it is not
available — past the window, a different machine, a different engine, a raw engine that never had
one, a cleared `~/.claude` — the obligation is to **seed the engine from the platform's record**,
not to start clean and say so politely.

"Fresh" remains legitimate in exactly one case: the user asked for it (`forceFresh` — the console's
**Fresh** button and `coding_session_fresh`). A clean slate someone requested is a feature. A clean
slate nobody chose is the defect this record exists to prevent.

## Consequences

**What this costs, stated plainly so it is not discovered later:**

- **Seeding is reconstruction, not restoration.** Claude Code's context is not a message list; it
  holds tool state, file caches and its own compaction. A brief built from our record gives
  continuity of *understanding*, not a byte-identical context. It will sometimes be better than the
  original — a curated brief beats a bloated transcript — and it must never be described to a user
  as "as if it never died".
- **Compaction becomes our problem.** Today the vendor's context management is also ours by
  accident. Owning the conversation means owning its growth. The platform already summarises chat
  after 20 messages; the same trick applies, and until it does, an unbounded brief is a token bill
  that grows every turn.
- **Token cost is unchanged by the storage choice.** Re-sending context each turn is a property of
  the model, not of D1 versus a file. Nobody should expect this to be cheaper.
- **A process is not data.** This buys nothing toward persisting a running child process. It buys
  reconstituting one fast enough that nobody notices — measured at 8 seconds above.
- **The machine must still be on.** Unmovable, and it must be reported as "your Mac mini is
  offline", never in session vocabulary.

**What it buys:**

- Machine independence — continue on the laptop what the desktop began; #694 stops being a special
  case and becomes ordinary.
- Survival of `~/.claude`, and of the vendor changing it.
- **Multi-turn memory for raw engines, which have never had any.** This is the part that makes the
  change a strict upgrade rather than a re-implementation of something the vendor already does well.
- `RESUME_WINDOW_MS` becomes a policy dial rather than a constraint. The owner asked for breaks of
  "night time or for a few days"; four days covers that, and beyond it the answer stops being a
  cliff.

**Sequencing.** Slice 1 is the fallback only — every branch where `resolveSessionContinuity` returns
`fresh` for a reason other than `forceFresh`. Those all start stone cold today, so there is nothing
to regress and no flag is needed. Slice 2 makes it primary for raw engines, which likewise cannot
regress. Only after both are proven does the question of Claude's default arise, and it may well
stay `--resume`.

## Enforcement

The violation is silent by construction — a cold engine looks exactly like a warm one until someone
asks it something it should remember. So the guard cannot be "review it carefully".

1. **Every `fresh` branch must be enumerated and must declare its seeding path.**
   `coding-session-continuity.test.ts` already enumerates all eight decisions and asserts each
   `reason` is distinct (added under #695). Extend that test so each non-`forceFresh` branch also
   asserts a seed source. A ninth branch added without one then fails at the point it is written.
2. **Relocation is the known hole.** A test must assert that a session moved by
   `reassignSessionNode` cannot present a cold engine. That is the case that produced this record,
   and it is reachable without the two-machine hardware test.
3. **Retention.** `coding_timeline` is permanent and the MCP audit trail is 90-day KV. If seeding
   ever depends on a record that expires, the guarantee expires with it. Any retention change to
   `coding_timeline` must be read as a change to this ADR.

## References

- #693 (this decision), #694 (relocation), #408 (`resolveSessionContinuity`), #257 (repo-scoped
  history), #695 · #697 (the user-facing half: a session is never a user-facing noun)
- `lib/coding-session-continuity.ts`, `lib/coding-timeline.ts`, `lib/coding-store.ts`,
  `packages/browser-runner/src/coding/headless.ts`
