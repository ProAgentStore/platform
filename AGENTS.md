# AGENTS.md

## Delivery mode

**Straight to `main`. No branches, no pull requests.** Declared 2026-08-16.

**No branches. No pull requests. Ever.**
Commit directly to `main`. Do not run `git checkout -b`, `git switch -c`, or `gh pr create`. If you
find yourself on a non-`main` branch, stop and report it. (Declared 2026-08-16.)

## Dev Workflow

- When completing development work in this repo, commit the finished change and push it to the
  tracked remote branch as part of the task. Do not leave completed dev work only in the local
  worktree unless the user explicitly asks not to commit or push.
- Project-local Codex agent specs live in `.codex/agents/`. Keep the Dev Agent and BA Agent
  instructions there aligned with this workflow.
- For tasks with two or more independent areas of investigation, use subagents in parallel.
  Delegate codebase exploration, documentation research, testing, and reviews where appropriate.
  Wait for relevant agents and consolidate their results before finishing.

## Git workflow

- Commit finished work and push directly to `main` (see *Delivery mode*). Do not open pull requests unless Serge
  explicitly asks.
- **NEVER force-push.** That means `--force`, `--force-with-lease`, `--force-if-includes`, a short-flag cluster that
  carries `f` (`-f`, `-uf`), and a leading `+` on a refspec (`git push origin +main`, `+HEAD:main`), which forces
  that ref with no flag at all. The platform's evidence check records every one of these as a force-push (`push.force`,
  irreversible), so a run that does it is flagged. If a push is rejected, `git pull --rebase` and push again; if the
  rebase conflicts, stop and report.
- When a commit fully resolves an issue, put a closing keyword in its message (`closes #123`; `fixes` and `resolves`
  work the same). GitHub closes the issue on the push, and the release-note collector reads the same keywords. Work
  that only touches an issue says `refs #123` instead.
- Out-of-scope work found along the way gets its own issue that references the original. Do not fold it into the
  current change.

## Running the full test suite

Use one command, from any directory, and read its last line:

```bash
pnpm -w test:full > /tmp/suite.log 2>&1; echo "exit=$?"; tail -15 /tmp/suite.log
```

The last line is `SUITE GREEN …` or `SUITE RED …` with the file and test counts; the same
summary is in `test-results/vitest-summary.txt`. The exit code is non-zero unless vitest's
own JSON report (`test-results/vitest.json`) shows more than 0 tests and 0 failures.
Never claim green from an exit code without that line.

Do not hand-roll it (#920). Each of these produced a false green:

- `cd workers/api && pnpm test` — that package has no `test` script, so pnpm falls back to
  the POSIX `test` utility: zero output, exit 0 or 1 depending on the arguments. Only the
  root `package.json` defines the suite; `pnpm -w` runs it from anywhere.
- `npx vitest run` from a package dir — the include globs are rooted at the repo root, so it
  collects nothing.
- `cmd | tee log; echo $?` — that is `tee`'s status. And `${PIPESTATUS[0]}` is empty in
  zsh (the shell here); zsh spells it `${pipestatus[1]}`. Redirect to a file instead of
  piping, as above.

## Fail-before comparisons (old source, new tests)

**Status: accepted and delivered (#1021, closed).** The stash-free helper and its hardening are `b9fd69a5` …
`26845f2e`. The Engine git guard is `9ffe10da`. The defect reproductions run deterministically inside coder sessions
as of `ea398f9e`. Acceptance is the owner's queued objective (run b76eeb30) authorizing closure; no separate
independent review was performed. The behaviour below is what its isolated tests (`scripts/lib/fail-before.test.mjs`,
temporary repositories only) show.

What it does, as tested:

- **Refused before anything changes:** a symlink at the path or in any parent directory; a symlink or submodule at
  the base; git administrative metadata (any `.git` component in any case, the git dir and common dir, a linked
  worktree's admin files); a path inside a nested repository; traversal and canonical escapes; a path given twice;
  one argument that is several space-joined paths; and any earlier journal directory, readable or not.
- **Journal bound to its repository:** each journal records the canonical worktree root, git dir and common dir,
  lives in that git dir, and carries a digest. `--restore` refuses (exit 75) a journal that does not verify, was
  copied elsewhere, or belongs to a different repository than the one you run it from.
- **Backups verified first:** every backup must match its recorded hash before any file is written; one bad backup
  stops the whole restore, and the journal is kept.
- **Content, type and mode are one state:** the test runs at the base mode, the owned mode comes back after, and a
  mode-only or type change by anyone else is a conflict (exit 70, left as it is, journal kept).
- **Crash and error safety:** the intended state of each file is journalled before it is written, and every write
  (file or journal) is an atomic rename. A failure during setup rolls back exactly what was written; a failed
  rollback or restore keeps the journal with a truthful receipt, and `--restore` finishes it.
- **Exit status is the test's own** (127 missing command, 128+n on a signal); the argv runs with no shell.
- **Journal root:** `.git/pags-fail-before` must be a plain directory. A symlink or a file there is unknown
  state (exit 75), left as it is, and nothing is written through it.
- **I/O errors are receipts:** an unreadable path refuses at preflight with its error code; a restore stopped
  part-way reports exactly which files were put back and where it stopped, keeps the journal and backups, and
  `--restore` finishes it. The CLI never exits on a stack trace.
- **Cleanup and receipts:** a receipt lists every file it `written` (replaced) separately from those
  `restored` (verified back), so a stop between the two never reads as "nothing changed". Once every file is
  back, the journal stays readable until its backups are gone, then moves to an authenticated
  `<id>.completed.json` marker before the run directory is removed; a stop at any cleanup step is a success
  with `cleanupPending`, and `--restore` finishes it. An empty directory without a verifying marker is
  unknown state, never cleaned up.
- **Complete writes:** every write loops until all bytes are written (repeated zero progress is an error) and
  is checked before the rename.
- **Mode:** only plain permission bits (0777) are restored, exactly. A setuid, setgid or sticky file is refused
  before anything changes.

Remaining limits: POSIX only, regular files only; a foreign write that lands on the same file between the last
check and the rename is overwritten; the digest detects corruption, not a deliberate forgery; directories created
for base-only files are removed only when empty; directory entries are not fsynced, so a power loss can lose the
last rename.

Until acceptance, compare in an **isolated temporary worktree**, which never touches the active checkout or any stash:

```bash
WT=$(mktemp -d)/old && git worktree add --detach "$WT" HEAD \
  && cp path/to/new.test.ts "$WT/path/to/new.test.ts" \
  && ln -s "$PWD/node_modules" "$WT/node_modules" && ln -s "$PWD/workers/api/node_modules" "$WT/workers/api/node_modules" \
  && (cd "$WT" && npx vitest run --project unit path/to/new.test.ts > /tmp/fb.log 2>&1; echo "exit=$?")
git worktree remove --force "$WT"   # only the worktree this command created
```

Check every setup step's exit before running the comparison (the `&&` chain does that), and capture the test's
own exit status rather than a later `echo`, `grep` or pipeline's.

**Guards on the coding agents' own path (#1021).** Guidance alone is not the protection:

- **Pilot refusal (always on):** `no_stash_restore` in `workers/api/src/lib/coding-scope-constraints.ts` is a
  platform rule, like the termination one. Any Pilot-generated instruction that asks for `git stash pop` or
  `git stash apply` (the command, through `git -C`, or in prose) is refused before it reaches the engine, and
  the refusal goes into the step log. An owner directive cannot lift it; the owner's own direct messages are
  not screened. Tested end to end in `workers/api/src/workflows/coding-session/scope-evidence.test.ts`.
- **Prompts:** the repair-checkout objective forbids `git stash pop`/`apply` by name, and a dirty-checkout
  run is told to compare in an isolated `git worktree add --detach` checkout, never the stash.
- **Engine git guard (always on, every engine):** a command the ENGINE composes itself (the #1021 incident)
  meets a generated `git` shim first on the Engine's `PATH`
  (`packages/browser-runner/src/coding/git-guard.ts`, the `gh` guard's mechanism). `git stash pop`, `drop`
  and `clear` are refused, and `apply`/`branch` are allowed only with an exact object id (what
  `git stash create` printed), all before git runs (exit 3, `pags: refused`). It binds whatever the
  permission mode, inside compound commands and `sh -c`, because it is the `git` the shell resolves.
  Tested against real temporary repositories in `git-guard.test.ts`, including the incident command
  before and after. Gaps: an absolute `/usr/bin/git`, a rewritten `PATH`, or a git alias bypasses it;
  it does not install on Windows. It ships with the runner, so it reaches a machine with the CLI
  release that carries it.

Never do this with `git stash` (#1021). The stash is repo-global, so `pop` restores the top of everyone's stack,
not what you saved. A save that fails or saves nothing still lets a chained `pop` consume someone else's recovery
work, and zsh does not split `$SRC="a.ts b.ts"`, so an unquoted path variable is ONE pathspec and the save
fails. Never apply or pop a stash you did not just verifiably create.

## Release-note evidence (#1346, #1348, #1349)

A production release note posts only on complete, exact evidence for the pushed commit, and every uncertainty holds.
Work here keeps these rules: the range and the workflow runs are read page by page up to documented bounds (250
commits, 10 pages of 100 runs) in `lib/github-evidence.ts`; transient GitHub errors leave the row pending, permanent
ones hold it with a typed `hold_code`; the branch HEAD is never substituted for the pushed head; and the queue's
claim-before-send and 48-hour window do not change. Tests drive paginated GitHub fixtures and assert behavior:
`lib/github-evidence.test.ts`, `lib/release-note-queue.test.ts`, `routes/release-note-deliveries.integration.test.ts`.

## Local git hooks

`pnpm install` activates them in every checkout (husky's `prepare`, #1103) — no manual step, so they
follow a checkout to any machine. pre-commit: whitespace, the file-size ratchet (#302) over what is
staged, unstaged-edit refusal, Biome. pre-push: CI's guards, touched-project typecheck, related tests.
A commit that pushes a file past its pin is refused locally: split the file, or raise its pin in
`scripts/check-file-size.mjs` with a reason, in the same commit. The hooks never replace the
full-suite command above or CI. See CONTRIBUTING.md.

## Writing a guard test

Lock an invariant by testing what the code DOES, never by reading a source file and matching its
text (#915, `docs/testing-standards.md`). A text match cannot tell "someone broke it" from "someone
moved it", and #912's file move turned ~30 of them red with nothing broken. When adding a guard,
say which invariant it protects. Invariants of the Pilot's run belong in
`workers/api/src/workflows/coding-session/workflow-run.test.ts`, which runs the real workflow.

## ProAgentStore Access Rules

Use ProAgentStore account state only through the configured MCP server.

- Do not use the ProAgentStore web UI for account actions unless the user explicitly asks.
- Do not call private REST, GraphQL, database, or worker APIs directly unless the user explicitly overrides this rule.
- First inspect available MCP tools/resources before choosing an action. The surface is
  per-connection — some tools are gated to the console surfaces of the agents the connected
  user actually subscribes to, so call `tools/list` rather than assuming a name exists.
- Prefer read-only tools unless the task explicitly requires changes. You do not have to
  guess which those are: every tool carries `readOnlyHint` / `destructiveHint` annotations,
  and they are accurate — `readOnlyHint: true` means the tool only reads.
- Use `dry_run: true` before uncertain write/runtime/destructive actions.
- Confirm before destructive actions such as cancelling instances, deleting knowledge, unregistering runtimes, cancelling tasks, or overwriting files.
- Use the exact `confirm` value required by the MCP tool schema.
- Use `mcp_audit_log` when the user asks what MCP actions were attempted or completed.
- Never use a generic shell/API proxy as a substitute for a specific MCP tool.

## Expected MCP Server

```toml
[mcp_servers.proagentstore]
url = "https://mcp.proagentstore.online/mcp"
```

Use the public trial flow only for previews:

```text
list_agents -> chat_with_agent
```

Use private instance flow for durable user work:

```text
list_agents -> subscribe_agent -> my_instances -> add_instance_knowledge -> chat_with_instance -> instance_messages
```

Use the runtime flow when work has to happen on the user's own machine — a browser acting
on a real site, or a coding CLI in a real checkout. The runner reaches the platform over a
WebSocket relay, so "is a runtime registered" is a question you must ask, not assume:

```text
subscribe_agent -> register_instance_runtime -> instance_runtime_status -> run_instance_task -> approve_instance_task -> instance_task_events
```

## Reading results

The server sends `instructions` on `initialize`. Read them: they are the server's own
statement of how it expects to be driven, and they are maintained with the tool surface.

Two tools return a **structured object, not a bare array** — this is the shape to code
against:

```text
list_agents   -> {"agents": [...]}
my_instances  -> {"instances": [...]}
```

Both also declare an `outputSchema` and answer with `structuredContent`. Every other tool
returns a single text content block.

Failure is detected structurally, not by reading prose. This server does not set `isError`.
A failure is either text beginning `Error: `, or JSON carrying an `error` key. Check both;
treat anything else as success.

A first call on a fresh session that comes back saying the tool "has not been loaded yet"
and lists your parameters as possibly incorrect — or that the tool "is not registered" —
is **not** this server talking. Those sentences are written by the client from its own tool
registry while it is still processing `tools/list`. Retry the identical call; do not rename
parameters and do not conclude the tool is missing. The server's own session failures name
themselves (`Session not found`, `Invalid session id…`) and mean re-run `initialize`.
See `platform-docs/mcp.md` → *Result And Error Shape*.

## Vocabulary that decides an action

Four distinctions the platform makes and a caller routinely collapses. Getting one wrong
produces a confident, wrong report about someone's agent.

- **`mutates` is the field that answers "does this change anything"** — not `scope`. `scope`
  is what triggers the write-consent gate; the two are separate questions and a read can
  carry a write scope. Read `mutates`.
- **`reach` answers "does this touch anything outside the platform"**: `platform` (never
  leaves), `machine` (the owner's computer), `internet` (a third party, or any host the
  caller names). Do not derive this from whether a tool names a connector — that proxy is
  wrong in both directions. It fails closed: an unclassified tool reports `internet`.
- **`tier` has four values**, not two: `base` (always granted), `standard`
  (creator-selectable), `runtime` (needs a local runner), `connector` (external system).
- **A run's `health` has four values**: `working`, `waiting`, `stalled`, and `ended`.
  `ended` means the run is CLOSED and makes no claim that anything is running — and since
  it is returned for any run that is not `running`, it is the answer you will see most
  often. Quote `health`; do not derive your own verdict from `status` or from timestamps.
  `lastAliveAt` (a heartbeat) and `lastProgressAt` (the last instruction advance) are
  different facts: a healthy long step looks stale on the second and fresh on the first.
  A parked run carries `waitingReason`, and `waitingUntil` only when a resume time is
  actually knowable — a run waiting on a *person* has no such time.
