# Coding engines — presets, params, and why an engine must be allowed to write

An **Engine** is the actual CLI a coding session drives (Claude Code, Codex, Gemini CLI, Grok, a
local model). Which one a session launches, and how, is one string: the **preset command**.

## Two ways to drive a CLI

*"Can I use tmux for coding?"* has two true answers, because there are two products.

- **A Coder engine** — the subject of the rest of this page. The runner launches the CLI as a
  **child process** and speaks to it directly. It is not a tmux pane, and the terminal view is not
  a scraped TUI.
- **A terminal-operator agent** — the tmux / kitty / iTerm2 Operators, built on the `terminal` and
  `tmux` connectors. Those drive a **real pane on your machine**, and nothing stops you pointing
  one at a pane that is running `claude` or `codex`. It is a supported path, and people use it.

|  | Coder engine (child process) | Terminal connector (tmux / kitty / iTerm2) |
|---|---|---|
| How it runs | child process, `stream-json` | a real pane on your machine |
| Turn boundary | a `result` event, or process exit — a fact | inferred from rendered text |
| Cost recorded | yes, from the CLI's own `total_cost_usd` (#267) | **no — unmetered by design** (#348) |
| Consequential-act record | yes, from `tool_use`/`tool_result` (#294) | no |
| Merge authority enforced | yes (migration 0091) | no — a rule in the agent's instructions instead |
| `tmux attach` from your own shell | no session to attach to | yes |
| Keystrokes (Escape, arrows, `y`) | no — takeover sends text only | yes |
| Which agents | Coder | tmux / kitty / iTerm2 Operators |

**The split is settled, not provisional.** #249 asked whether tmux should come back as a
selectable Coder engine backend; the answer was **no**, recorded as
[ADR 0003 — A Coder engine reports its own turns](adr/0003-a-coder-engine-reports-its-own-turns.md).
The short version: the strongest argument for it (turns being cut off mid-work) was a timer bug,
fixed in #391 without a terminal; a PTY is not tmux, and only tmux gives up measurement; and the
three subsystems built on structured output — usage, the acts audit, merge authority — cannot be
recovered from a screen buffer. If a real PTY is ever needed, ADR 0003 says it goes inside
`HeadlessSession` (node-pty), not into a pane.

So pick by what you need. Attach and keystrokes are on the operator path, and you accept that its
work produces no cost row. Measurement, an act record and an enforced merge policy are on the
Coder path, and you accept that there is no pane to attach to.

## The preset command is a prefix — every param reaches the CLI

Claude is the one *persistent* engine: the runner keeps it alive and speaks structured
`stream-json` to it across turns. Everything else runs **one-shot**:

```
spawn(bin, [...presetArgs, turnText])
```

So `codex exec --json --sandbox danger-full-access` plus the turn "fix the failing test" becomes

```
codex exec --json --sandbox danger-full-access "fix the failing test"
```

Nothing is filtered, reordered, or interpreted. `--model`, `-c key=value`, `--profile`, a flag we
have never heard of — it all passes through verbatim, and quoting works the way it looks like it
should (`-c model="o3"` → `model=o3`). That is deliberate: **engine posture is a config change,
not a code change.** Pinned by `headless.test.ts` → "passes EVERY preset param through to the
engine, with the turn text last".

The exceptions are structural protocol flags. Claude owns `-p`, `--input-format`,
`--output-format`, `--verbose`, and `--resume`; those carry the wire protocol, so a preset cannot
override them. Codex `exec` owns `--json` for the same reason: if the preset says `codex exec`, the
runner inserts `--json` once before appending the turn. Every other token you write is kept.

### What one-shot costs: a raw engine forgets every previous turn

The prefix contract above has a consequence it is easy to read past. `spawn(bin, [...presetArgs,
turnText])` is a **brand new process every turn**, so the Pilot's step 7 —

```
codex exec --json --sandbox danger-full-access "now do the same for the other two files"
```

— runs in a process that has never seen steps 1–6. **The working tree carries state; the
conversation does not.** The engine is not amnesiac about the repo (its edits are still there, and
it can read them), only about everything it said, decided, or was told.

Claude is the persistence exception, and its continuity is **not** in the preset either: the runner
keeps one stream-json process alive, and across runner restarts re-spawns it with
`--resume <session id>` against `~/.claude` — which is exactly why `--resume` is one of the
structural flags a preset may not set. Codex also uses structured JSON but remains one-shot: after
its first turn, the runner may resume the exact persisted `thread.started.thread_id` with
`exec resume <id>` rather than selecting a same-CWD latest session. The explicit-ID proof passed on
`codex-cli 0.151.0` on 2026-09-25 and is recorded in
[`codex-exec-resume-spike-2026-09-25.md`](codex-exec-resume-spike-2026-09-25.md). That opaque,
machine-local memory is only a #693 stopgap: platform timeline seeding remains the eventual source
of continuity, and `--last` remains prohibited.

**The prefix contract remains deliberate for every other one-shot engine.** A raw engine's
multi-turn memory, where its CLI supports it, is a preset string rather than a backend property
([ADR 0003](adr/0003-a-coder-engine-reports-its-own-turns.md)). Codex is the narrow exception:
the runner owns its explicit-ID argv and its default preset stays a fresh `codex exec`, so a preset
must not smuggle in a resume subcommand. The remaining vendor forms are not shipped defaults; add
one yourself only with the caveats below.

The **⚙ CLI engines** editor states this per preset, derived from the command's binary rather than
listed per engine (`engine-continuity.ts`, mirroring `deriveClientType`), so it stays right for
`npx claude` and for a custom wrapper.

### What one-shot also costs: a raw engine's spend cannot be measured

The same structural difference decides whether you can see what an engine costs. Claude Code ends
each turn with a structured event carrying its own token counts and cost; Codex `exec --json`
reports token counts but, on the observed `codex-cli 0.151.0` schema, no dollar figure. The runner
reads the fields the CLI reports and the platform banks a measured token row. A raw engine ends a
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
confidently wrong rather than obviously blank. The #730 probe does not rehabilitate `--last`; it
proved only that an explicitly captured Codex `thread_id` avoids this specific hijack on
`codex-cli 0.151.0`.

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

### Grok: an explicit session id, held by the runner (#1156)

xAI's Grok CLI 1.x takes an id it is *given*, which is what the rule above was missing: `-s <uuid>` starts a NEW
conversation under that id (it must be a UUID and must not exist), and `-r <uuid>` resumes exactly that one (it errors
when it does not exist — it never falls back to "the most recent"). So the runner, not the preset, carries Grok's
conversation (`packages/browser-runner/src/coding/grok-continuity.ts`): the first turn of a session runs with
`-s <a fresh UUID>`, every later turn with `-r <that UUID>`, and the id is kept per session in
`headless-sessions.json` (`grok:<session>`) so a runner restart resumes it too. A turn that fails forgets the id —
the next starts a clean conversation — and a CLI that rejects the flags themselves has the turn retried once without
them, after which that session runs one-shot as before.

**Status: built against `grok --help` of 1.0.62 (2026-10-18), not yet run end to end** — the CLI refuses every turn
until it is signed in. Until a signed-in run proves it, the platform still sends its own replay with every Grok turn
(`holdsConversationThisTurn` stays false), so nothing is lost if the CLI's memory is not what it says.

### Installing xAI's Grok CLI

It is a native binary from xAI's own installer, not an npm package. The npm packages named `grok-cli`
(`@vibe-kit/grok-cli`) are community tools that bill an `XAI_API_KEY` and take other flags; the shipped preset cannot
drive them.

| OS | Install | Sign in (subscription) |
|---|---|---|
| macOS / Linux | `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login` — or `grok login --device-auth` over SSH |
| Windows (PowerShell) | `irm https://x.ai/cli/install.ps1 \| iex` | same |

Both put it in `~/.grok/bin` (`%USERPROFILE%\.grok\bin`), and add that to PATH only in the shell's profile — which a
`pags up` under launchd, systemd or a Scheduled Task never reads. The runner therefore prefers `~/.grok/bin/grok` for
a preset that says `grok`, whatever PATH holds (`officialEngineBinary`), and `coding_engine_get`'s `machine` block
reports which file, which version, and `vendor: xai | community` for each machine. Update with `grok update`. Sign it
in from any device with `coding_engine_reauth` (`client_type: "grok"`), which runs `grok login --device-auth` on the
runner and returns the `accounts.x.ai` link and code.

## The shipped defaults

`DEFAULT_ENGINES` (`workers/api/src/lib/coding-engines.ts`) — what an instance that has saved
nothing gets:

| id | Label | Command | `auth` |
|---|---|---|---|
| `claude` | Claude Code | `claude --dangerously-skip-permissions` | unset → `auto` |
| `codex` | Codex | `codex exec --json --sandbox danger-full-access` | unset → `auto` |
| `gemini` | Gemini CLI | `gemini --approval-mode yolo --skip-trust --prompt` | `auto` (machine login) |
| `grok` | Grok | `grok --permission-mode bypassPermissions -p` | unset → `auto` |
| `local` | Local model (Ollama) | `ollama run llama3` | `machine` |

Two rules every default satisfies: **non-interactive** (a bare `codex`/`gemini`/`grok` launches a
TUI that dies instantly with "stdin is not a terminal" — headless mode has no PTY, which is what
tmux used to provide) and **allowed to write** (below). `grok` takes `-p`/`--single`, *not*
`--prompt`, which it has no such flag for — the old preset died on an unknown flag before reaching
the model. The `local` preset is a starting point rather than a recommendation: anything
prompt-in/text-out works by editing the command, and it costs nothing per token.

`deriveClientType` maps the command's real binary — skipping `FOO=bar` prefixes and wrappers like
`npx`/`env` — to `claude`, `codex`, `gemini`, or `grok`. Claude is persistent structured
stream-json; Codex is one-shot structured JSON when the preset is `codex exec`; Gemini and Grok
remain raw. An unrecognised binary maps to `codex`, so it is never mis-driven as Claude.

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

### Choosing the engine and its model, without editing a command (#792)

The CLI engines panel edits a preset. **Settings → Coding engine** *chooses*: an **Engine**
dropdown and a **Model** dropdown, for the owner who wants to move off a model whose usage window
is spent and should not have to know an argv to do it. Same state, second door:

- **Engine** writes `defaultEngineId` — the same key the panel's default writes.
- **Model** writes `--model <id>` **into that preset's own command** (`coding-engine-model.ts`). All
  four shipped CLIs take `--model` (verified against the installed binaries, 2026-09-20), and the
  prefix contract above already carries it to the engine. It is inserted after the binary (after
  `exec` for Codex), **never appended** — the Gemini and Grok presets end in the flag that takes the
  turn text as its value.
- "The CLI's own default" removes the flag. "Another model…" takes any id the CLI accepts.
- API: `GET`/`PUT /v1/instances/:id/coding/engine-choice`, body `{ engineId, model? }`. `model` is
  tri-state: **absent** leaves the command alone (switching engines never rewrites one), `null`
  clears the pin, a string sets it. MCP: `coding_engine_get` / `coding_engine_set`.

There is deliberately **no `model` field**. Migration 0126 deleted an `engine` dropdown that nothing
read while the agent asserted it back to its owner; a model setting beside the command would be
that defect again. Because the choice lives in the command, it cannot disagree with what launches.

The only suggestions offered are Claude Code's `fable` / `opus` / `sonnet` — the aliases its own
`--help` documents as tracking the latest model of each tier. The platform does not list "all
available models": that is a property of the CLI version and account on the owner's machine, and
a hardcoded catalogue is wrong the day a vendor ships. A model the CLI rejects fails on the first
turn, in the engine's own words.

The card also states the model the **last measured engine turn actually ran**, read from the
`ai_usage` ledger (`engine:` rows) rather than from the setting — so "which model is driving my
runs" has an observed answer, and a pin that has not taken effect yet (a session not restarted)
is visible as a disagreement. Engines that report no usage (see above) have none.

Choosing a model changes the preset's command, and a **running** session is matched back to its
preset by command. `engineAuthFor` therefore matches model-insensitively as a fallback, so a
running `api-key` engine does not lose its sign-in because its owner picked a model mid-session.

## Sign-in is a separate axis

`auth` decides whose credentials the engine launches with, independently of what it may do:

- `auto` — Claude uses the stored `claude setup-token` if saved, else its machine login; Codex uses its
  local `codex login` (including a ChatGPT subscription when configured) with `OPENAI_API_KEY` removed;
  other engines use the machine's own login
- `machine` — inject nothing; use the runner machine's login
- `subscription` — Claude uses the stored `claude setup-token`; Codex uses its local `codex login` with
  `OPENAI_API_KEY` removed, so a valid ChatGPT subscription is authoritative. Other engines have no
  shipped subscription credential and use their machine login instead.
- `api-key` — the engine's provider key from the vault (including Codex's `OPENAI_API_KEY`; per-token billing).
  Only with the owner's console confirmation (#1042), below.

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

### What the Usage total does not include

**A coding CLI driven through a pane is unmetered, and the total on the Usage page silently
excludes it.** A pane holds rendered text, not the `result` event the child-process engine reports
its own tokens and cost from, so there is nothing to read — and a dollar amount scraped out of
pane output would be a guess dressed as a measurement, which is worse than a gap. The cloud
records such a drive as **unmetered**: a name, never a number (#348).

So "compare my tmux spend against my Coder spend" has no answer, and a `$0` next to an operator
agent means *not measured*, not *free*. The engine really did run and really did spend; only this
platform cannot say how much. Your provider's own dashboard can.

The exposure is real but has been small. Measured across the whole account on **2026-08-08**:
`{ drives: 2, aiCliDrives: 0, instances: 1, windowDays: 14 }` — two pane drives on one instance in
a fortnight. That is a reading from one day, not a standing property; take a fresh one before
using it to decide anything.

This is a property of the path, not a bug awaiting a fix — see the table in
[Two ways to drive a CLI](#two-ways-to-drive-a-cli) and
[ADR 0003](adr/0003-a-coder-engine-reports-its-own-turns.md), which makes reporting your own turns
the admission requirement for a Coder engine precisely so this stays confined to the operator
family.

## Who pays for what: the platform plan vs your engine account (#871)

Owner decision, 2026-10-14. There are two separate bills, and the platform owns only one of them:

- **Platform access is the ProAgentStore subscription.** The runner, relay, sessions and coding
  runs are gated by the single platform-wide Pro entitlement (`requirePro` in `lib/billing.ts`:
  runtime registration, session open and a coding run's start). Coding agents, Local Coder
  included, have **no price of their own**. There is no per-agent entitlement, and none is
  planned. While PAGS billing is deferred (`PAYWALL_ENFORCE` unset), the gate does not refuse
  anyone.
- **Engine usage is the owner's own engine account.** Claude Code, Codex, Grok or Gemini sign in
  with the owner's own login or key on the owner's machine (the modes above), so the provider
  bills the owner directly. The platform never pays for engine turns and cannot see that bill
  (#348). Its `cost_micros` is a notional figure and `payer` records who is charged, as described
  above.

## Subscription CLI by default; API-key coding only by confirmed choice (#1042)

Actual coding runs on a subscription-authenticated local CLI. No shipped preset uses `api-key` (Gemini
used to; migration 0226 moved every stored `api-key` preset to its CLI login and lists them in
`apiCodingMigrated`). The advisory brain (Pilot, Co-pilot, chat) is separate and may still use a
provider key.

- **Choosing it.** In the coder UI's ⚙ CLI engines panel, a preset's sign-in can be set to its provider's
  API key — offered only when that key is stored in Profile → API Keys. Saving opens a blocking
  confirmation naming the provider, model and billing source, saying it is likely more costly and billed
  separately from any subscription. Only that confirmation sends `acknowledgeApiCoding`, and the API
  records it in `config.apiCodingOptIns` for the preset's exact command: a new model is a new bill and is
  confirmed again.
- **Who cannot.** A request from MCP (`X-PAGS-Client: mcp`) can never record a confirmation, select an
  unconfirmed API-key engine, or change a confirmed one's model (`coding_engine_set` is refused). The
  account default skips a coder whose default would be unconfirmed API-key coding (`api-key-not-confirmed`).
- **At spawn.** `resolveEngineEnv` refuses an unconfirmed `api-key` preset, and a confirmed one with no key
  stored, with the reason as the session's start error. Nothing falls back: not to the machine login, and
  no subscription engine ever receives a key. A signed-out subscription CLI stops the same way (engine
  preflight, #879).
- **While running.** Every session shows its engine, model and how it bills; an API-key session shows a
  persistent banner.
- **Cloudflare Workers AI** models (Llama 4 Scout, Llama 3.3 70B, Qwen 2.5 Coder 32B) are listed as
  "coming soon" once Cloudflare credentials are stored — there is no coding engine for them yet, so they
  cannot be selected. DeepSeek is not offered.

## The Brain model is separate (#1043)

Each coder also has a **Brain model** (Settings → "Brain — advises and orchestrates", or MCP
`set_coder_brain`'s `model`): the advisory and orchestration layer, on the owner's own provider key —
the one place an API key is allowed. It runs the assistant chat and its tools, coder-brain decisions,
the Co-pilot reading the terminal, the Loop orchestrator, the repo-agent route and the
job-application supervisor. It does NOT run the Pilot (which drives the engine, on Claude Sonnet), the
engine itself, or any credential, submission or approval step.

Choices are `lib/brain-models.ts`: Claude Sonnet 4.6 (Anthropic), and Llama 4 Scout, Llama 3.3 70B and
Qwen 2.5 Coder 32B on Cloudflare Workers AI — offered only with Cloudflare credentials stored. Saving
confirms provider, model, cost and who is billed. The coding screen shows the active Brain beside the
engine line. One setting (`lib/instance-brain.ts`, the instance's `state.model` once picked); until
one is picked the advisory surfaces run Sonnet as before. Nothing on the engine path reads it, so a
Brain choice cannot change, start or stand in for the coding engine or its sign-in.

**The coder brain is BYOK only (#1025).** When a coder's question goes unanswered past the human
timeout, the coder brain decides on the owner's own API key: their Anthropic key, or their own
Cloudflare account and token. The platform never pays for a brain call, and there is no fallback to
the platform's Workers AI binding (`byokBrainCall` → `runUserWorkersAi`). If the owner has no key
configured, the model call fails and the brain declines. The question moves to `escalated`, and the
owner gets an alert and an issue comment, so a person answers it instead of the brain. This is pinned
by `lib/coder-brain-byok.test.ts`.
