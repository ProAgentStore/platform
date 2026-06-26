# Cloudflare's AI / agent / "vibecoding" stack (2026) — what's relevant to PAGS

> **Status:** research / reference, captured 2026-06-26. Forward-looking — relevant
> to the *"open the platform for user-built agents"* phase and to a cloud Coder
> placement. We are **not** adopting these yet; current priority is making the
> existing agents (Coder, apply) solid. Re-check versions before building.

Cloudflare shipped a full agent/code-execution stack in H1 2026. Several pieces
directly bear on PAGS's architecture decisions.

## 1. Dynamic Workers (Dynamic Worker Loader API) — the "code on the fly, isolated" primitive

The most important one for a **creator/AI-authored agent marketplace**.

- Hand the Workers runtime **code as a string at runtime**, get back an isolated
  V8 sandbox **in single-digit milliseconds** — no deploy pipeline.
  ```js
  const worker = env.LOADER.load({
    mainModule: "agent.js",
    modules: { "agent.js": agentCode },   // ← code as a string (from D1/R2)
    env: { ...scopedBindings },           // dynamic, per-tenant bindings
    globalOutbound: null,                 // block/inspect/rewrite outbound
  });
  ```
- **100× faster / cheaper than containers** (few MB, ms startup) → an ephemeral
  sandbox **per request/agent** is viable at consumer scale; no concurrency cap.
- **Dynamic bindings**: each tenant's code gets *scoped* tools via RPC/HTTP with
  **secrets injected server-side** (the code never sees your keys). "Every binding
  is heading for a dynamic counterpart — queues, DBs, object stores, AI, MCP."
- **Pricing:** beta-waived; later **$0.002 per unique Worker loaded/day** + normal
  CPU/invocation. **Constraint:** JS/TS for best perf (Python/WASM slower).
- Real platforms (e.g. Zite) use it to let users **build apps via chat**, each
  automation isolated in its own sandbox.

**Implication for PAGS:** this is the substrate for *"agents live in the DB, code
stored in the DB, written on the fly, run isolated, metered, paid by usage."* It
replaces "build your own sandbox" and is cheaper/simpler than per-Worker
Workers-for-Platforms deploys for AI-generated/ephemeral agent code.

## 2. Cloudflare Sandbox SDK — incl. "Run Claude Code on a Sandbox"

A server-side sandbox with **filesystem + shell/process + git**. Published tutorial
clones a GitHub repo into a sandbox and runs **Claude Code** server-side, returning
a diff.

- **Partially obsoletes** our earlier "CF can't host a shell → Coder must be local"
  assumption. A **cloud Coder placement** is now possible.
- Tutorial shows **discrete task runs** (clone → task → diff/PR). Docs **do not**
  specify CPU/timeout/**persistence**/cost for long-lived interactive sessions →
  suited to autonomous task runs; **unproven for persistent interactive sessions**.
  Beta. See `coder-cloud-vs-local-placement.md`.

## 3. Code Mode — a better tool loop

Instead of many individual tool calls, the model gets **one** tool —
`codemode({ code })` — and writes TypeScript orchestrating all configured tools in
a sandbox ("an entire API in 1,000 tokens"). `@cloudflare/codemode` rewritten
(Feb 2026) to be runtime-agnostic.

**Implication:** candidate to replace our hand-rolled tool loop (`lib/tools.ts`,
the max-3-round dedup loop) in the shared agent runtime — cheaper, more capable.

## 4. Cloudflare Agents SDK (v0.16.1, 2026-06-16)

First-party agent framework: **Codemode runtime + connector model**, **durable CDP
browser automation**, Think orchestration, **voice output-device selection**. Plus
**Project Think** ("next-gen AI agents on Cloudflare") and **Dynamic Workflows**
("durable execution that follows the tenant" = multi-tenant Workflows).

**Implication:** overlaps what we hand-built (`AgentDO`, the brain/hands, the
JobApply/Coding workflows). Same situation as **AI Gateway** (see memory
`cf-platform-products-vs-custom-builds`) — adopt-vs-keep evaluation rather than
reinventing. Notably their browser automation is now "durable CDP" — compare to our
browser-runner takeover machinery.

## How this updates our plans

| Our prior plan | Update |
|---|---|
| Tier-2 creator code via **Workers for Platforms** deploys | Lead with **Dynamic Workers (Worker Loader)** for on-the-fly/AI-generated code; WfP only for managed/custom-domain deploys. |
| Coder = **local runner only** | Add a **CF Sandbox cloud placement** (headless, no laptop). |
| Hand-rolled **tool loop** | Evaluate **Code Mode**. |
| Custom **AgentDO / brain** | Evaluate aligning with the **CF Agents SDK** (like AI Gateway). |

## Sources

- Dynamic Workers — <https://blog.cloudflare.com/dynamic-workers/>
- Sandbox SDK — <https://developers.cloudflare.com/sandbox/> · Claude Code tutorial — <https://developers.cloudflare.com/sandbox/tutorials/claude-code/>
- Code Mode — <https://blog.cloudflare.com/code-mode/> · <https://blog.cloudflare.com/code-mode-mcp/> · docs <https://developers.cloudflare.com/agents/model-context-protocol/protocol/codemode/>
- Agents SDK v0.16.1 — <https://developers.cloudflare.com/changelog/post/2026-06-16-agents-sdk-v0161/> · Project Think — <https://blog.cloudflare.com/project-think/>
- Dynamic Workflows — <https://blog.cloudflare.com/dynamic-workflows/> · Workers for Platforms — <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/>
