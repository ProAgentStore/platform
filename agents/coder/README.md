# Coder

**Your AI coding agent for any GitHub repo.** Subscribe, point it at a repository you own, and it runs a coding engine (Claude Code, Codex, Gemini CLI, Grok, or a local model) on **your own machine** in that repo — you drive it from any device, or hand it an objective and let it work autonomously, with live human takeover when it gets stuck.

It is **repo-agnostic**: the target is whatever repo you import, never the platform itself.

## Two Coders

| Slug | What | Where it is defined |
|---|---|---|
| `coder` | The original Coder — one instance, many repos, chat may drive the engine directly, Co-pilot view included. | This directory + migration `0021` |
| `coder-repo` | Repo Coder — one instance **per repository**, named in its typed `repo` setting. Same capabilities, expressed as declarations. Its chat delegates instead of typing (`drive:false`) and it has no Co-pilot. | Migrations `0063`, `0065`, `0070` — no code |
| `coder-lead` | Coder Lead — the cross-repo coordinator, as a plain cloud agent over a supervision graph. | Migration `0063` — no code |

The legacy `coder` declares nothing and keeps its historical behaviour byte-for-byte. Everything the other two do is data, which is the point: a Coder-equivalent can be stamped out from config without a monorepo PR.

## How It Works (brain + hands)

- **Hands (your machine):** run `pags up`. The runner prepares the repo you imported and launches the selected engine **as a child process** in that directory. It is not a tmux pane and the terminal view is not a scraped TUI. Claude Code is driven over its structured `stream-json` interface as a persistent multi-turn session; every other engine runs one-shot turns with stdout captured. After a runner restart the Claude session resumes from `~/.claude` via `--resume <session id>`.
- **Control (anywhere):** the console **Coding** tab shows the live terminal, lets you type instructions, and drives commits and pushes — all through your instance.
- **Brain (optional, autonomous):** handing a session an objective starts the durable `CodingSessionWorkflow` (BYOK Claude). It reads the terminal, sends the next instruction, repeats — and pauses to a console takeover when it needs you (an interactive login, a value only you have).

Sessions carry an `engineLabel` of `<engine>:<session id>`. The `coding_sessions.tmux_session` column keeps its legacy name but stores that label; there is no tmux session to attach to. tmux on this platform belongs to the *terminal-operator* agents (`packages/browser-runner/src/coding/terminal.ts`), which is a different family.

## Usage

1. Subscribe to **Coder** in the store → you get your workspace (your instance).
2. On your machine: `npm i -g @proagentstore/cli`, then `pags login` and `pags up`. No restart is needed after subscribing to a new agent — the runner attaches eligible instances as it finds them (CLI ≥ 0.4.30).
3. In the console **Settings** tab, pick the machine this agent runs on under **Runs on**.
4. In the **Coding** tab: **Add repo** — a local path (`~/dev/my-repo`, run in your real checkout), `owner/repo`, or a clone URL. Private repos clone with a GitHub App installation token.
5. **Start session** → drive it manually, or start a loop with an objective.

## Engines

Which CLI a session launches is one string: the preset **command**. Presets are per instance (`agent_instances.config.codingEngines`), editable in the console's **⚙ CLI engines** panel or via `GET`/`PUT /v1/instances/:id/coding/engines`. An instance that has saved nothing gets the shipped defaults:

| Preset | Default command | Notes |
|---|---|---|
| Claude Code | `claude --dangerously-skip-permissions` | The one *persistent* engine (stream-json, multi-turn) |
| Codex | `codex exec --sandbox danger-full-access` | One-shot; `workspace-write` also blocks network |
| Gemini CLI | `gemini --approval-mode yolo --skip-trust --prompt` | `--skip-trust` is required or it reverts to asking |
| Grok | `grok --permission-mode bypassPermissions -p` | `-p`, not `--prompt` (grok has no `--prompt`) |
| Local model (Ollama) | `ollama run llama3` | Bring your own — no cloud key, no per-token cost |

Every token in a preset reaches the CLI verbatim, so changing the engine's posture is a config change, not a code change. Each engine must carry its write-permission flag: run non-interactively there is no TTY to ask, and a CLI that defaults to read-only looks like an agent that investigates thoroughly and never fixes anything. Full rationale: `docs/coding-engines.md`.

A preset also carries a **sign-in method** (`auto` · `machine` · `subscription` · `api-key`) deciding whose credentials the engine launches with. Every mode except `api-key` actively strips the provider key from the engine's environment, so an exported `ANTHROPIC_API_KEY` cannot silently switch a subscription session to per-token billing. Each session reports what it *actually* authenticated with — presence only, never the credential — and warns when the outcome contradicts the setting.

## Autonomy And Reporting

- **`start_work`** hands a goal to the agent's own executor and returns a run id. The chat says work has started; it does not claim it has finished. On an agent with no separate executor the tool refuses rather than looping the chat into itself.
- **`check_work`** answers "did that actually happen?" from the run record — scoped to this instance, so it cannot report another agent's run as its own. This exists because the failure mode is symmetric: retracting a true report is as wrong as inventing one.
- **Loop presets** ("Fix bugs", "Quality check", "Security audit", "Refactor", "Add tests") are per-instance config resolved subscriber over creator over built-ins, and they appear wherever a loop can start — not just in the Co-pilot view they used to be hardcoded into.
- **Coding history survives a session ending.** It is stored per repo: `GET /v1/instances/:id/coding/repos/:repoId/timeline` returns the repo's whole history with session boundaries shown as separators.

## Multiple Machines

Several machines can each run `pags up` for the same instance. Routing follows whichever relay socket is live; an explicit pin (`config.runnerNode`, set from the **Runs on** picker) is authoritative and never silently falls back elsewhere; a session whose machine went away relocates to a live one on the next drive. A second runner on the *same* hostname is rejected with `4409` unless you pass `--force`. Full behaviour: `platform-docs/coder-multi-machine.md`.

## Architecture

| Piece | Where |
|---|---|
| Local coding runtime (hands) | `packages/browser-runner/src/coding/` — `headless.ts` (engine child process), `handlers.ts`, `runtime.ts`, `repo.ts` |
| Orchestrator brain (Pilot) | `workers/api/src/workflows/coding-session.ts` + `lib/coding-loop.ts` |
| Engine presets + sign-in | `workers/api/src/lib/coding-engines.ts` |
| Runner routing / node binding | `workers/api/src/lib/runner-client.ts`, `lib/runtime-nodes.ts`, `lib/runtime-attachment.ts` |
| Repos / sessions / history (D1) | `coding_repos`, `coding_sessions` (migration `0020`), `coding_timeline` (`0023`) — store in `lib/coding-store.ts`, `lib/coding-timeline.ts` |
| API | `/v1/instances/:id/coding/*` (`workers/api/src/routes/coding.ts`); node binding at `/v1/instances/:id/runner-node` (`routes/instances.ts`) |
| GitHub App (repo import) | `/v1/github/*` (`routes/github.ts`, `lib/github-app.ts`) — inert until configured |
| Console UI | `@proagentstore/coder-web` → `agents/coder/web/src/` (`CodingTab.tsx`, `CopilotView.tsx`, `TerminalView.tsx`, `ReposList.tsx`, `EnginesModal.tsx`), loaded by the console shell via `store/console/src/lib/surfaces.tsx` |
| Instance settings (incl. **Runs on**) | `store/console/src/tabs/SettingsTab.tsx` |

Not ported from AgentCoder: GCP cloud-VM provisioning (local runner only), standalone Stripe (folds into the OFO model), the Discord interface.
