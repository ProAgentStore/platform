# Coding engines — presets, params, and why an engine must be allowed to write

An **Engine** is the actual CLI a coding session drives (Claude Code, Codex, Gemini CLI, Grok, a
local model). Which one a session launches, and how, is one string: the **preset command**.

## The preset command is a prefix — every param reaches the CLI

Claude is the one *persistent* engine: the runner keeps it alive and speaks structured
`stream-json` to it across turns. Everything else runs **one-shot**:

```
spawn(bin, [...presetArgs, turnText])
```

So `codex exec --sandbox danger-full-access` plus the turn "fix the failing test" becomes

```
codex exec --sandbox danger-full-access "fix the failing test"
```

Nothing is filtered, reordered, or interpreted. `--model`, `-c key=value`, `--profile`, a flag we
have never heard of — it all passes through verbatim, and quoting works the way it looks like it
should (`-c model="o3"` → `model=o3`). That is deliberate: **engine posture is a config change,
not a code change.** Pinned by `headless.test.ts` → "passes EVERY preset param through to the
engine, with the turn text last".

The one exception is Claude's structural flags (`-p`, `--input-format`, `--output-format`,
`--verbose`, `--resume`): those carry the wire protocol, so a preset cannot override them.
`buildClaudeArgs` strips them and their values; every other token you write is kept.

## The shipped defaults

`DEFAULT_ENGINES` (`workers/api/src/lib/coding-engines.ts`) — what an instance that has saved
nothing gets:

| id | Label | Command | `auth` |
|---|---|---|---|
| `claude` | Claude Code | `claude --dangerously-skip-permissions` | unset → `auto` |
| `codex` | Codex | `codex exec --sandbox danger-full-access` | unset → `auto` |
| `gemini` | Gemini CLI | `gemini --approval-mode yolo --skip-trust --prompt` | `api-key` |
| `grok` | Grok | `grok --permission-mode bypassPermissions -p` | unset → `auto` |
| `local` | Local model (Ollama) | `ollama run llama3` | `machine` |

Two rules every default satisfies: **non-interactive** (a bare `codex`/`gemini`/`grok` launches a
TUI that dies instantly with "stdin is not a terminal" — headless mode has no PTY, which is what
tmux used to provide) and **allowed to write** (below). `grok` takes `-p`/`--single`, *not*
`--prompt`, which it has no such flag for — the old preset died on an unknown flag before reaching
the model. The `local` preset is a starting point rather than a recommendation: anything
prompt-in/text-out works by editing the command, and it costs nothing per token.

`deriveClientType` maps the command's real binary — skipping `FOO=bar` prefixes and wrappers like
`npx`/`env` — to `claude` (structured stream-json) or one of `gemini`/`grok`/`codex` (raw spawn).
An unrecognised binary maps to `codex`, so it runs RAW rather than being mis-driven as Claude.

## Every engine must carry its write-permission flag

Each of these CLIs defaults to **read-only or ask-first** when run non-interactively — and headless
mode has no TTY, so there is nobody to ask.

This produced the quietest possible failure. `codex exec` shipped without `--sandbox`, so it
inherited `sandbox: read-only`. The engine read the repo, reasoned about it well, wrote a good
explanation… and could not change a byte. Not even `git pull`:

```
error: cannot open '.git/FETCH_HEAD': Operation not permitted
```

Nothing crashed. From the outside it looked like an agent that investigated thoroughly and never
got around to fixing anything.

Claude's preset has carried `--dangerously-skip-permissions` from day one. An engine without its
equivalent means **switching engines silently changes what the agent can do** — so the trust level
has to match across presets, or the choice is a trap.

| Engine | Flag in the shipped default | Also accepted |
|---|---|---|
| Claude Code | `--dangerously-skip-permissions` | `--permission-mode acceptEdits` |
| Codex | `--sandbox danger-full-access` | `--sandbox workspace-write`, `--dangerously-bypass-approvals-and-sandbox` |
| Gemini CLI | `--approval-mode yolo --skip-trust` | `--approval-mode auto_edit`, `-y` |
| Grok | `--permission-mode bypassPermissions` | `--permission-mode acceptEdits\|auto`, `--always-approve` |

**Gemini needs `--skip-trust` too.** With yolo alone it prints
`Approval mode overridden to "default" because the current folder is not trusted` and goes back to
asking — headless, with nobody to ask. A preset that looks correct and behaves read-only is worse
than one that is obviously wrong, so the two flags travel together.

**Why `danger-full-access` and not `workspace-write` for Codex.** `workspace-write` also blocks
network, so `git pull`, `pnpm install` and `gh pr create` — the ordinary work of a coding agent —
would still fail, just less obviously than before. If you want the narrower posture, set it: it is
one field in the editor, and the agent will then be unable to reach the network.

Two things enforce this:

- `coding-engines.test.ts` → "lets every CLI engine actually WRITE" asserts no shipped default
  forgets a flag, so a newly added engine cannot arrive read-only by omission.
- The **⚙ CLI engines** editor shows an inline warning under any command missing one, with a
  one-click fix. It only warns for engines it recognises — a local model or a custom wrapper has
  no permission concept, and a false warning on every custom preset trains people to ignore the
  real one.

## Where the setting lives

Presets are **per instance**, at `agent_instances.config.codingEngines`, edited two ways:

- **Console** → Coding tab → ⚙ **CLI engines**: label, launch command (free text), sign-in method,
  and which preset is the default.
- **API**: `GET`/`PUT /v1/instances/:id/coding/engines`, body
  `{ engines: [{id, label, command, auth?}], defaultEngineId }`.

An instance with nothing saved gets `DEFAULT_ENGINES` (`workers/api/src/lib/coding-engines.ts`);
the defaults are never written to the row, so improving them reaches every instance that has not
customised. An instance that **has** saved its presets keeps them — edit it there, or delete the
saved list to fall back.

A session persists the **command**, not the preset id, so an edited preset applies on the next
session start or **Restart** — the process gets its argv and credentials at spawn.

## Sign-in is a separate axis

`auth` decides whose credentials the engine launches with, independently of what it may do:

- `auto` — the stored `claude setup-token` if saved (Claude only), else the machine's own login
- `machine` — inject nothing; use the runner machine's login
- `subscription` — the stored `claude setup-token` (Claude only)
- `api-key` — the engine's provider key from the vault (per-token billing)

Every mode except `api-key` actively **strips** the provider key from the engine's env (an empty
value means remove, see the runner's `mergeEnv`). A developer with `ANTHROPIC_API_KEY` exported in
their shell must not silently pay per token for an engine they asked to run on a subscription.
See `docs/connector-auth.md`.
