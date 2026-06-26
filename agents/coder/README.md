# Coder

**Your AI coding agent for any GitHub repo.** Subscribe, point it at a repository you own, and it runs a coding CLI (Claude Code / Gemini / Codex / Grok) on **your own machine** in that repo — you drive it from any device, or hand it an objective and let it work autonomously, with live human takeover when it gets stuck.

This is the AgentCoder port: a remote control + autonomous orchestrator for AI coding agents. It is **repo-agnostic** — the target is whatever repo you import, never the platform itself.

## How it works (brain + hands)

- **Hands (your machine):** run `pags up`. The runner clones the repo you imported and launches the coding CLI inside a tmux pane in that directory — the same local runner used for the browser runtime, with a second `coding` runtime.
- **Control (anywhere):** the console **Coding** tab shows the live terminal, lets you type instructions, and commit/push — synced through your instance.
- **Brain (optional, autonomous):** "Run with AI" hands a session to the durable `CodingSessionWorkflow` (BYOK Claude). It reads the terminal, sends the next instruction, repeats — and pauses to a console takeover when it needs you (interactive login, a value only you have).

## Usage

1. Subscribe to **Coder** in the store → you get your workspace (your instance).
2. On your machine: `npm i -g @proagentstore/cli` then `pags up`.
3. In the console **Coding** tab: **Add repo** (`owner/repo`, a GitHub URL, or a clone URL) or **Import from GitHub** (private repos, once the GitHub App is configured).
4. **Start session** → drive it manually, or **Run with AI** with an objective.

## Architecture

| Piece | Where |
|---|---|
| tmux + CLI runtime (hands) | `packages/browser-runner/src/coding/` |
| Orchestrator brain | `workers/api/src/workflows/coding-session.ts` + `lib/coding-loop.ts` |
| Repos / sessions (D1) | `coding_repos`, `coding_sessions` (migration 0020) |
| API | `/v1/instances/:id/coding/*` (`routes/coding.ts`) |
| GitHub App (repo import) | `/v1/github/*` (`routes/github.ts`, `lib/github-app.ts`) — inert until configured |
| Console | `store/console/console-coding.js` (Coding tab) |

Not ported from AgentCoder: GCP cloud-VM provisioning (self-hosted runner only), standalone Stripe (folds into the OFO $9 model), the Discord interface.
