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

### What one-shot costs: a raw engine forgets every previous turn

The prefix contract above has a consequence it is easy to read past. `spawn(bin, [...presetArgs,
turnText])` is a **brand new process every turn**, so the Pilot's step 7 —

```
codex exec --sandbox danger-full-access "now do the same for the other two files"
```

— runs in a process that has never seen steps 1–6. **The working tree carries state; the
conversation does not.** The engine is not amnesiac about the repo (its edits are still there, and
it can read them), only about everything it said, decided, or was told.

Claude is the exception, and its continuity is **not** in the preset either: the runner keeps one
stream-json process alive, and across runner restarts re-spawns it with `--resume <session id>`
against `~/.claude` — which is exactly why `--resume` is one of the structural flags a preset may
not set. `resumedConversation` is false for a raw engine under every circumstance.

The **⚙ CLI engines** editor states this per preset, derived from the command's binary rather than
listed per engine (`engine-continuity.ts`, mirroring `deriveClientType`), so it stays right for
`npx claude` and for a custom wrapper.

### What one-shot also costs: a raw engine's spend cannot be measured

The same structural difference decides whether you can see what an engine costs. Claude Code ends
each turn with a structured event carrying its own token counts and cost; the runner reads it and
the platform banks a measured row, which is what the **Usage** page adds up. A raw engine ends a
turn with plain stdout and reports no numbers at all, so there is nothing to bank.

**A missing row is not a zero.** An unmeasured engine is not cheaper than a measured one — the
transport does not change what is sent to the model's API — it is *invisible*, and on a page of
dollars invisible reads as free. So every drive of an unmeasurable engine records the absence
instead: a `usage.unmetered` entry on the instance's trace (`GET /v1/instances/:id/trace`, or the
MCP `agent_trace` tool), which the Usage page counts as what its total leaves out. The entry is
keyed per session per day, so a Pilot's forty instructions produce one observation, not forty.

Metering is a property of the **(driver, engine) pair**, not of the engine: Claude Code is measured
when the platform spawns it and unmeasured when it is driven through a terminal pane, because a
pane carries rendered characters and its own usage record never crosses the relay. Nothing anywhere
parses a cost out of terminal output — a dollar figure scraped from rendered text would be a guess
wearing a measurement's clothes. The **⚙ CLI engines** editor states the verdict per preset, beside
the continuity line and derived the same way.

#### Why no shipped preset resumes, though three CLIs offer it

A resume subcommand looks like the fix — multi-turn memory by editing one text field, no platform
change. Checked against the installed binaries on 2026-08-09, and **not shipped as a default**,
because every vendor's resume selects *the most recent session in this directory* rather than the
session the runner intends:

| CLI | Version | Resume | What it selects |
|---|---|---|---|
| Codex | `codex-cli 0.146.0` | `codex exec resume --last [PROMPT]` | newest recorded session in the cwd (`--all` disables the cwd filter) |
| Grok | `grok 0.2.118` | `-c, --continue` | "the most recent session for the current working directory" |
| Gemini CLI | `0.53.1` | `-r, --resume latest\|<index>` | latest, or an **index** into the project's session list — which shifts as sessions are added |

Measured, not inferred. `codex exec resume --last` does work: two turns in one directory, turn 2
asked what word turn 1 had said and answered correctly, on the same session id. Then a second,
unrelated `codex exec` ran in the same directory — and the next `resume --last` followed *that* one
instead, answering from the wrong conversation. That is the failure the platform must not ship by
default: **resuming into the wrong prior conversation is worse than starting clean**, because it is
confidently wrong rather than obviously blank.

It cannot be pinned from a preset, either. The contract is prefix + turn text, so there is no slot
for `resume <SESSION_ID>` — the turn text would take the session-id positional. And a coding repo
added by **local path is the user's real checkout**, so "the newest session in this directory" may
well be a conversation the human had themselves.

Two smaller findings from the same check, if you do go and edit the field: `codex exec resume`
accepts `--dangerously-bypass-approvals-and-sandbox` but **not** `--sandbox <mode>`, so the shipped
write flag does not carry over unchanged; and Grok's `-p/--single` is explicitly single-turn, so it
does not combine with `-c`.

You own the command field, and on a repo only ever driven by the agent this trade may be worth
making. The platform declines to make it *for* you.

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

### What the engine's cost figure is, and who pays it

Claude Code reports a `total_cost_usd` per turn and the ledger stores it. That figure is **not a
measurement of money**: per [Anthropic's docs](https://code.claude.com/docs/en/costs), the CLI
"computes the dollar figure locally from token counts priced at standard list rates … and may
differ from your actual bill", and for Max/Pro subscribers "the session cost figure isn't relevant
for billing purposes". It is tokens × list price — the same construction as the platform's own
estimate, run by a different process.

So the ledger records the two facts separately (migration `0092`):

| | |
|---|---|
| `cost_micros` | notional value — tokens × list price. True on every row. Never a bill. |
| `payer` | who is charged. `byok-api`, `subscription`, `platform`, or NULL for unknown. |

The runner observes the credential from the engine's merged spawn env and the capture poll
persists it, so `api-key` → `byok-api` and `subscription` → `subscription`. **`machine-login` maps
to unknown, not to subscription** — it means only that neither credential was in the env, so the
CLI used whatever login it has stored, which may be either.

Dollar limits (the per-tree delegation pool and the account circuit breaker) sum **charged rows
only**. Subscription and unknown engine work is bounded by a token ceiling instead, in the unit it
actually consumes — a subscription's own allowance is a rolling 5h + weekly token window, so there
is no dollar figure on the other side for a dollar ceiling to compare against.
