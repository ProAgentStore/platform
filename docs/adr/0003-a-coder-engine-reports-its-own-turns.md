# ADR 0003 — A Coder engine reports its own turns

**Status:** Accepted (2026-08-08) · **Owner decision** · Supersedes nothing.

## Context

Coder drives a coding CLI on the user's machine. Until 2026-06-26 it did so through tmux: the CLI ran
in a pane, `capture-pane` scraped the rendered text, and every question the platform had — is the turn
over, what did it just do, what did it cost — was answered by matching strings the vendor prints in
its TUI. Commit `c94642f` replaced that with a child process driven over Claude Code's structured
`stream-json` interface, where a `result` event ends a turn as a fact.

Three subsystems were then built **on top of that structure**, each answering a question the pane
could not:

- **Usage (#267)** — `parseEngineUsage` reads the `result` event's own token and cost figures. A pane
  carries rendered text; a dollar figure scraped from it would be a guess dressed as a measurement.
- **Consequential acts (#294)** — `noteAct`/`settleAct` read `tool_use` and `tool_result` blocks. This
  exists because run `73ffc073` merged its own PRs to `main` unattended while `subordinate_status`
  reported "done": the delegation model rests on a supervisor being able to review what a subordinate
  did, and without an act record all it can review is the claim.
- **Merge authority (migration 0091)** — `readMergePolicyForRun` runs inside `CodingSessionWorkflow`
  and its breach record is written from that same act stream.

In 2026-08, #249 proposed bringing tmux back as a *selectable* engine backend, for a real PTY,
`tmux attach`, and crash survival. Assessing it produced three findings that are the reason for this
record:

1. The strongest evidence for the proposal — one-shot engines being judged idle and killed mid-turn —
   was **not PTY-shaped**. It was a timer written for a persistent CLI, applied to a process whose exit
   is exact. Fixed in #391 by deleting the timer, not by adding a terminal.
2. **A PTY is not tmux.** A PTY is a file descriptor and structured output parses straight through it.
   tmux is a screen buffer whose only exit is `capture-pane`, i.e. post-render text. The original
   proposal coupled two things that are separable, and only one of them costs anything.
3. The restore is **smaller-looking than it is**. `coding/tmux.ts` is still maintained for the terminal
   connector, `CodingRuntime` is an interface, and `runtime.ts:185` is a single call site — so
   "restore one class" reads as a contained change. It is not: the deleted class injected credentials
   by typing `export KEY="value"` into the pane it later captured and shipped to D1 and into the
   Pilot's prompt.

## Decision

**Every engine backend Coder drives must report its own turns.** Concretely, four rules. A change that
violates any of them is a regression regardless of what it enables.

**E1 — The turn boundary is an event, not an inference.** A backend must signal end-of-turn from the
engine itself: a structured completion event, or process exit for a one-shot engine. A backend whose
idle state is derived by matching text against rendered output is not admissible. Timers are a
backstop against a wedged process, never the primary signal.

**E2 — Usage and consequential acts come from the same stream as the work.** A backend must be able to
report per-turn token/cost usage and `tool_use`/`tool_result`-equivalent act records. A backend that
cannot is one where spend and irreversible actions are structurally invisible — and a missing row on a
page of dollars reads as zero dollars, not as unknown.

**E3 — A credential reaches an engine through the process environment, and nowhere its own output
capture can read.** No backend may place a secret anywhere that its snapshot, transcript or scrollback
can subsequently carry.

**E4 — If a real PTY is required, it goes inside `HeadlessSession`.** `node-pty` preserves E1–E3: the
spawn env, the usage drain, the act parser and the resolved-credential derivation all continue to
work. tmux is not the mechanism for a PTY on this platform.

**Scope.** This governs Coder sessions — `CodingRuntime`, `HeadlessSession`, the Pilot and the Co-pilot.
It does **not** govern the terminal connector family (tmux / kitty / iTerm2 Operators), which is a
different product with a different contract: it drives a pane the user already has, its writes are
recorded as explicitly unmetered (`recordUnmeteredEngineActivity`, #348), and its boundary is a
creator-declared backend ceiling enforced at dispatch (#402/#404). "Watch it work in my own terminal
and take over" is served there, deliberately.

## Consequences

**What this costs.**

- **No `tmux attach` to a Coder session.** A user who wants a pane they can attach to uses an Operator
  agent, and accepts that its drives are unmetered by construction.
- **No keystrokes in a Coder takeover.** `HeadlessSession.key()` is a no-op today. Under E4 the fix is
  node-pty; under no reading of this ADR is the fix tmux. Until then, takeover sends text only, and
  that limitation should be stated in the UI rather than silently swallowed.
- **A one-shot engine loses the turn in flight if the runner dies.** Claude resumes from `~/.claude`;
  a raw engine does not. The working tree is on disk and the Pilot is durable, so the loss is a turn,
  not a session.
- **Multi-turn memory for raw engines is a preset string, not a backend property.** `headless.ts` fixes
  the contract as "preset command is a prefix, turn text is the final argument", so an engine offering
  a resume subcommand gains continuity by editing one text field.

**What it buys.** Every Coder run has a cost row, an act record and an enforceable merge policy, on
every engine, without a second implementation to keep correct. Every coding feature has to be right
once.

## Enforcement

- **What would catch a violation:** nothing automatic today, which is why this ADR exists. A backend
  satisfying `CodingRuntime` type-checks; metering, acts and merge authority degrade to silence rather
  than to failure.
- **The check to add with any second backend:** a runtime assertion that a started session's backend
  reports a usage record and an act record within its first completed turn, and a test that fails when
  a backend is registered without them.
- **The review question, for any change touching `runtime.ts` engine construction, `handlers.ts`, or
  anything importing `coding/tmux.ts` outside the terminal-connector family:** *does this path produce
  a `result`-class event, a usage record, and an act record?* If any answer is no, it is a violation of
  this ADR and not a design choice.
- `coding/tmux.ts` has exactly two production importers, and both are the terminal connector:
  `coding/terminal.ts` (the generic tmux/kitty/iTerm2 adapter) and the runner's own `/tmux/*` handlers
  in `server.ts`, which serve the `tmux` connector's tools. A **third** importer, or any importer
  inside the Coder path (`coding/runtime.ts`, `coding/headless.ts`, `coding/handlers.ts`), is the
  signal to re-read this record.

## References

#249 (this decision) · #391 (turn boundary) · #402/#404 (operator backend ceiling) · #267 (usage) ·
#294 (acts) · #348 (unmetered labelling) · #247 (naming) · `c94642f` (the removal) · #433 (the docs
that describe this split as settled).
