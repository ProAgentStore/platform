# Coder agent — local vs cloud placement (design)

> **Status:** design, captured 2026-06-26. Forward-looking; gated on the CF Sandbox
> SDK (beta) and on the current agents being solid first. See
> `cloudflare-agent-stack-2026.md` §2.

Goal: let a coding session run **on the user's machine** (today) OR **in the cloud**
(new) — a per-session/per-repo choice. Maps onto the existing
`instance_runtimes.placement` field (`local` | `managed`).

## "Headless in the cloud" — clarified

- **No window / server-side: yes.** The cloud option runs in a **Cloudflare
  Sandbox** (server-side). Nothing to SSH into; the coding CLI runs as a process.
- **Blind / autonomous-only: no.** You still **see + drive it through the console**
  — the same **Summary co-pilot + Terminal** view; the worker routes `/capture` and
  `/act` to the sandbox instead of a local tunnel. You can read output, send
  messages, and **take over**. Headless only means "no window on *your* machine."

## Local vs cloud — the three real differences (surface in the UI)

| | **Local (`pags up`)** | **Cloud (CF Sandbox)** |
|---|---|---|
| **CLI auth** | machine's `claude` login (Max/Pro) | **BYOK Anthropic API key** (no local login) → pay-per-token |
| **Repo** | your **real local checkout** (branch/changes/deps) | **fresh git clone** from GitHub (private → GitHub App token) |
| **Deliverable** | edits in your working tree, live in your editor | a **branch + PR** (nowhere local to leave changes) |
| **Lifetime** | while machine + `pags up` run | managed/ephemeral; CF Sandbox timeout/persistence **beta, unspecified** → task runs, not indefinite sessions |
| **Best for** | hands-on dev on *your* code | autonomous "do X on `owner/repo`, open a PR" while away |

Two to make loud in the UI: **cloud costs tokens (your API key)** and **cloud
produces a PR**, not local file edits.

## Architecture (additive — same brain, same console)

- Console session view **unchanged** — already polls `/capture` + drives `/act`;
  agnostic to where the runtime lives.
- Add a **placement choice at session start**: *Run on → My machine | Cloud.*
- `placement: 'local'` → today's path (tunnel to `pags up`).
- `placement: 'managed'` → new **cloud coding runtime**: `CodingSessionWorkflow`
  drives a **CF Sandbox** (clone repo → launch the CLI with the BYOK key → expose
  snapshot/act) instead of the local runner. Same `coding_timeline` persistence.
- The runtime resolution (`lib/runner-client.ts` / `getRunnerConn`) gains a managed
  branch: for `placement='managed'`, talk to the platform-held Sandbox instead of
  the user's tunnel.

## Open questions / spike first

1. **Sandbox persistence/timeout** — how long does an interactive coding session
   survive? (Beta, undocumented.) Determines: real sessions vs one-shot tasks only.
2. **Interactivity** — can we keep a CLI process alive + stream its terminal, or is
   it request/response (clone → task → diff)? If the latter, cloud = "objective →
   PR" only (no live takeover), and the UI should say so.
3. **Cost** — per-Sandbox + per-token (BYOK). Show the user it's metered.
4. **PR flow** — branch naming, commit, push via GitHub App token, open PR.

**Recommended next step:** spike one `CodingSessionWorkflow` run against a CF
Sandbox (clone → run Claude Code with the BYOK key → stream `/capture` → open a PR)
to measure (1) and (2) before committing to the full placement toggle.
