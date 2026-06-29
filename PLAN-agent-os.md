# PLAN: PAGS Agent-OS — per-agent UI + SDK

**Status:** Approved direction, not yet started. Builds on `docs/agent-platform-strategy.md` and `docs/platform-runtime-agent-plan.md`.

**One line:** PAGS becomes the **OS + store for specialised agents that each ship their own UI and backend** (the iPhone / App Store model). `coder` is flagship app #1. The SDK is *extracted* from real agents, not designed up front.

---

## Why this pathway (the decision)

Ruled out, with reasons:
- **A standalone "remote-control coding" app** — Anthropic shipped native Remote Control (Feb 2026) + a crowded field (Orca, Tactic, AgentsRoom). Dead on arrival. (See `docs/research/coding-agent-market-2026.md` in the OFO docs.)
- **A generic "drive any CLI" platform** — we already own two generic agent platforms (FAGS, PAGS); a third is redundant and saturated.
- **A new ProCodeStore** — coding-as-output collapses into FAS; coding-as-agent collapses into PAGS. There is no third marketplace primitive; the family has exactly two (output catalogs, agent markets).

What's left, and right: as agents get smart they **demand their own UI + backend** — the generic chat box is the fixed keyboard the iPhone removed. So PAGS = the OS; each agent = an app that paints its own screen. This is also **conformance, not invention**: FAS, FGS, and FAGS *already* ship a per-item UI with the store as catalog + SDK + services. **PAGS is the lone outlier** that hardcodes agent UIs into the console. We are closing that gap.

**FAGS ↔ PAGS split = runtime plane** (confirmed via SDK survey):
- **FAGS** — client-side (browser: WebGPU/Ollama/built-in AI/BYO key), free, no backend, ships own UI.
- **PAGS** — server-hosted (Workers/DO/D1) **+ runner/VM** (coder tmux, job-apply browser), paid, stateful, *should* ship own UI.

---

## Current state (verified 2026-06-29)

- **Console:** `store/console/src/pages/InstanceDetail.tsx` hardcodes `import CodingTab/BoardTab/...`, a `type Tab = "chat" | "board" | "coding" | "knowledge" | "settings"` union, and `validTabs`. Every new agent UI = editing this file. No dynamic registration.
- **SDK** `@proagentstore/sdk`: single `.` export, pure backend (`initPro`, `AiClient`, `DbClient`, `StorageClient`, `SubscriptionClient`, `UsageClient`). **No `./ui`, no `./hooks`.**
- **CLI** `@proagentstore/cli` (`pags`): `init / publish / runner / up / login / mcp / check`. `publish` provisions a GitHub repo but the platform-registration step is a TODO.
- **Bespoke agents** (`coder`, `job-application-assistant`): UI hardcoded as console tabs; routes hardcoded in `workers/api/src/index.ts`; workflows/DOs hardcoded exports; surfaces resolved via `workers/api/src/lib/agent-capabilities.ts` (`surfaces: ["coding" | "apply" | ...]`).

## Target model

An agent is a **self-contained package** — like a FAS app, but stateful:
```
agents/<id>/
  agent.json        # manifest: identity, surfaces, ui entry, backend, runtime, capabilities
  web/              # the agent's OWN UI (React + Vite), imports @proagentstore/sdk
  src/              # the agent's backend (worker / DO / workflow), optional
```
PAGS provides: **system services (SDK)** + **catalog** + a **console shell** that loads each agent's UI. The OS owns the chrome + services; each agent owns its canvas + backend.

---

## Workstreams

### 1. SDK v2 — model on FAS `@freeappstore/sdk` (the most mature in the family)
- `.` — **system services** an agent's UI + backend call: `auth, instances, ai, storage, memory, runner-client, billing, push, tasks`. (Extend today's `initPro`.)
- `./ui` — shared **lovable shell** components (the vibe / black-box surface) so all agents feel coherent — like FAS's 13 `./ui` components.
- `./hooks` — React hooks (`usePolling`, `useInstance`, `useRunner`, `useVoice`, …) extracted from the console.

### 2. Console → shell
Replace hardcoded tabs with a **surface registry**: `surface -> lazy component`. The agent manifest declares its surface(s) + UI entry; the console renders a generic shell and loads the agent's UI through the registry. First-party agents register statically at first — **the seam is what matters**, not dynamic remote bundles (that's P3).

### 3. CLI — finish `pags publish`
Bring to FAS parity: package UI bundle + backend + manifest, provision repo, write the registry, deploy. Complete the registration TODO.

### 4. Backend isolation (honest constraint)
On Cloudflare, an agent's DO/Workflow must live in a deployed worker — can't hot-load like a React bundle. So: **invert the UI first** (cheap, high signal); keep first-party agent backends in the host worker near-term; move to **per-agent workers + service bindings + dynamic route mount** in P3. UI and backend isolation are separable — don't block the first on the second.

---

## Phasing (the iPhone order: seed first-party → extract SDK → open)

- **P1 — Vertical slice: `coder` as app #1.**
  Define the agent-package contract. Stand up the SDK v2 skeleton (`.`, `./ui`, `./hooks`) with the services `coder` already uses. Convert the console to a **shell + surface registry**; extract `CodingTab` into `coder`'s own UI consuming the SDK, loaded via the registry. Ship `coder` bespoke + lovable. **No creator publish yet.** Backend stays host-resident.
- **P2 — App #2 on the same rails.**
  A second agent (job-apply, or new) on SDK v2 + the shell. Solidify the SDK from what apps #1 and #2 actually share. Backend still host-resident.
- **P3 — Open the App Store.**
  `pags publish` for creators; per-agent worker backends + service bindings; dynamic UI loading from published bundles.

## Non-goals / guardrails
- Don't build the full plugin platform up front — extract it from agents 1–3.
- Don't isolate backends before P3.
- Don't open to creators before 2–3 first-party agents prove the SDK.
- Keep store conventions: eventual repo-per-agent, vendored shared code, no cross-store npm deps.

---

## First slice (start here — additive, non-breaking)
1. **Contract:** write the `agent.json` manifest schema additions (`surfaces`, `ui` entry, `backend`, `runtime`).
2. **SDK skeleton:** add `./ui` and `./hooks` export subpaths to `@proagentstore/sdk` (stubs), keep `.` working.
3. **Registry seam:** in the console, replace the hardcoded `Tab` union with a `surface -> lazy component` registry; register the existing `CodingTab` through it as the first entry. **Same UI, now loaded via the registry** — flips the architecture from hardcoded to registry-driven without any visible change.

This first PR changes nothing a user sees, but converts the console from "host hardcodes every agent" to "agents register surfaces" — proving the seam with `coder`.
