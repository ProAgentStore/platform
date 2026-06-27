# PAGS Runtime Agent Platform Plan

## Goal

Make PAGS a real platform for runtime-backed agents, using Like4Like as the forcing function.

Today, only two agents are meaningfully working:

- `coder`
- `job-application-assistant`

Other local agent directories should be treated as placeholders until proven otherwise.

## Design Principle

**Share the infrastructure, don't share the domain logic.**

The platform gives every agent: an instance, a runner connection, a chat, knowledge, collections, voice I/O, and a workflow binding. What each agent does with those primitives is its own business.

```
SHARED (platform)              SPECIFIC (each agent)
──────────────────              ─────────────────────
Instance lifecycle              Workflow brain logic
AgentDO (chat, memory, KB)      Domain prompts
WebSocket relay                 Provider adapters
Runner registration             Extraction / validation
Console shell (tabs, badge)     Surface-specific panels
Voice I/O (STT/TTS)             Task type semantics
BYOK key vault                  Collection schemas
MCP tools                       Artifact types
Diagnostics                     Handoff reasons
```

Do NOT abstract domain logic into a "universal" layer. Each agent's workflow is genuinely different — that's fine. The platform's job is to make adding a new agent cheap, not to make all agents look the same.

## Product Model

Every runtime-backed agent declares capabilities as data:

```json
{
  "capabilities": {
    "surfaces": ["..."],
    "runtime": "...",
    "workflow": "...",
    "taskTypes": ["..."],
    "requiresRunner": true
  }
}
```

The platform provides:

- Agent registry and subscription
- Private instance state (AgentDO)
- Runtime registration + relay
- Task creation and mirroring
- Durable workflow execution
- Human handoff (generic reasons)
- Domain collections
- Console surfaces driven by capability metadata
- Voice I/O on all chat surfaces

Domain-specific prompts, business logic, and UI panels stay inside each agent's workflow and surface code.

## Current Agent Architecture

### Coder

```
subscribe → connect runner → add repo → start session → tmux
brain watches terminal → decides → sends keys/message
persistent sessions, terminal capture, repo management
```

- **Hands:** tmux + coding CLI (Claude/Gemini/Codex/Grok)
- **Brain:** CodingSessionWorkflow (durable, BYOK Claude)
- **Surface:** coding (repos, sessions, terminal, co-pilot, Overseer)
- **Lifecycle:** persistent — sessions survive runner restarts, repos are permanent

### Job Application Assistant

```
subscribe → connect runner → paste URL → workflow drives browser
brain reads page → decides → fills forms → pauses for human
one-shot tasks, evidence stored in ATS cache
```

- **Hands:** Playwright browser (real Chrome profile)
- **Brain:** JobApplyWorkflow (durable, BYOK Claude)
- **Surface:** apply (resume, apply panel, ATS tips, board)
- **Lifecycle:** one-shot — each application is a single task

### Like4Like Insurance Quotes (new)

```
subscribe → connect runner → create profile → select providers
workflow drives provider websites → extracts quotes → pauses for captcha
multi-provider, stores quotes + screenshots
```

- **Hands:** Playwright browser (same runtime as apply)
- **Brain:** InsuranceQuotesWorkflow (durable, BYOK Claude)
- **Surface:** insurance (profile, providers, quote runs, comparison)
- **Lifecycle:** batch — one quote run drives multiple provider sites

## Key Architectural Differences

| Aspect | Coder | Apply | Insurance |
|---|---|---|---|
| Runtime | tmux (local CLI) | Playwright (browser) | Playwright (browser) |
| Session model | Persistent (repos + sessions) | One-shot (per URL) | Batch (per quote run) |
| Brain scope | One repo at a time | One page at a time | Multiple providers |
| Human handoff | stuck / needs_input | captcha / stuck / needs_input | captcha / login / ambiguous_data |
| Output | Code changes (in repo) | Submitted application | Quote comparison JSON + screenshots |

**Apply and Insurance share the browser runtime and similar lifecycle.** Coder is fundamentally different (tmux, not Playwright) but uses the same platform plumbing.

## Capability Registry

Replace narrow union-style behavior with an extensible registry.

Current:
```ts
surfaces: ["apply" | "coding"]
runtime: "browser" | "coding" | null
workflow: "JOB_APPLY" | "CODING_SESSION" | null
```

Target:
```ts
interface AgentCapabilities {
  surfaces: string[];
  runtimeKind: "browser" | "local-cli" | null;
  workflowKind: string | null;
  taskTypes: string[];
  requiresRunner: boolean;
}
```

Initial values:
```
coder:
  surfaces: ["coding"]
  runtimeKind: "local-cli"
  workflowKind: "CODING_SESSION"
  taskTypes: ["coding.session"]
  requiresRunner: true

job-application-assistant:
  surfaces: ["apply"]
  runtimeKind: "browser"
  workflowKind: "JOB_APPLY"
  taskTypes: ["job.apply_agent"]
  requiresRunner: true

like4like-insurance-quotes:
  surfaces: ["insurance"]
  runtimeKind: "browser"
  workflowKind: "INSURANCE_QUOTES"
  taskTypes: ["insurance.quote_run"]
  requiresRunner: true
```

**IMPORTANT:** Keep the slug fallback in `agentCapabilities()` until seeded capabilities are verified in production. Remove it only after confirming all working agents have capabilities set in D1.

## Human Handoff

Generic handoff reasons (shared across all agents):

```
captcha
needs_input
stuck
approval_required
external_login
ambiguous_data
```

The console renders handoff UI from the reason, without knowing the agent type. Each workflow decides when and why to pause.

## Console Surfaces

Shared tabs (all agents):
- **Chat** — AgentDO chat + voice I/O (🎤/🔊)
- **Knowledge** — documents, memory, files, credentials, rules
- **Settings** — board maintenance, runner info, links

Surface-specific (driven by capabilities):
- **Board** — runtime task kanban (any agent with `requiresRunner`)
- **Coding** — repos, sessions, terminal, co-pilot, Overseer
- **Apply** — resume upload, apply URL panel, ATS tips
- **Insurance** — quote run creation, provider selection, comparison

## Implementation Phases

### Phase 1: Like4Like Skeleton (ship first, abstract later)

Build Like4Like as a standalone agent — same pattern as Coder was built. Don't refactor existing agents.

Tasks:
- Add `agents/like4like-insurance-quotes/agent.json`
- Add seed migration (capabilities in `agents.config`)
- Add InsuranceQuotesWorkflow scaffold (empty, returns stub)
- Add route to start quote run
- Add `insurance` surface with minimal UI (start button + board)
- Add provider/profile/vehicle/quote collections

Deliverables:
- Subscribe to Like4Like
- Connect runner (same browser runtime as apply)
- Start `insurance.quote_run` → see task on Board
- Console shows insurance surface

### Phase 2: Insurance Workflow MVP

One provider end-to-end.

Tasks:
- Implement one Australian provider (e.g., RACV)
- Drive the browser through the quote flow
- Extract quote data (premium, excess, cover type)
- Store screenshots as artifacts (R2 + metadata)
- Support `captcha` and `needs_input` handoffs
- Show quote result in the console

Deliverables:
- One provider works from start to result
- Console shows task, events, and extracted quote
- Evidence (screenshots) viewable

### Phase 3: Capability Registry Extension

Only after Like4Like proves the model, extend the registry.

Tasks:
- Add `insurance` to `AgentSurface` type
- Add `INSURANCE_QUOTES` to workflow type
- Verify `agentCapabilities()` resolves correctly for all three agents
- Add tests
- Remove slug fallback ONLY after verification

Deliverables:
- Three agents resolve capabilities from data
- Console surfaces render correctly for each
- No hardcoded slug behavior remains

### Phase 4: Extract Shared Runtime Task Layer

Only if Like4Like's task lifecycle duplicates apply's. Don't extract prematurely.

Tasks:
- Identify what's actually shared between `startJobApply` and `startInsuranceQuoteRun`
- Extract ONLY the proven common parts (validate instance → check runtime → create task → mirror → start workflow)
- Keep domain logic (profile, credentials, resume) INSIDE each agent's starter
- Add `workflow_owned` column to runtime tasks (BUT keep type-check fallback)

Deliverables:
- Shared task creation helper (if justified by real code overlap)
- Both apply and insurance use it
- Coder is NOT forced into this model (different lifecycle)

### Phase 5: Provider Expansion

Multiple Australian insurance providers.

Tasks:
- Add provider adapter pattern
- Add NRMA, Allianz, Budget Direct, etc.
- Normalize quote extraction across providers
- Add comparison summary (side-by-side)
- Handle partial success (some providers fail, others succeed)

Deliverables:
- Multi-provider quote comparison
- Partial success handling
- Provider-level error reporting

### Phase 6: Retire Google Cloud Path

Tasks:
- Identify remaining Like4Like Cloud Run/Firebase dependencies
- Move provider/prompt/task state to PAGS
- Archive old gateway paths
- Keep migration notes for reference

Deliverables:
- Like4Like runs entirely through PAGS
- Old Google Cloud path archived

## Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Breaking coder/apply during refactor | HIGH | Don't refactor them until Like4Like proves the pattern. Keep slug fallback. |
| startJobApply is deeply coupled | HIGH | Wrap it, don't rewrite its internals. Extract only the lifecycle, not the domain logic. |
| workflow_owned breaking orphan detection | MEDIUM | Keep type-check as fallback alongside the new flag. |
| Coder doesn't fit generic task model | MEDIUM | Don't force it. Coder has its own surface code — that's fine. |
| Artifact model adds unused complexity | MEDIUM | Use R2 + simple metadata table. Don't build a full abstraction until the second consumer needs it. |
| Console fragmentation (15+ JS files) | LOW | Keep surface-specific JS minimal. Shared tabs are already generic. |

## Non-Goals

- Do not make placeholder agents production-ready as part of this work.
- Do not refactor working agents before Like4Like proves the pattern.
- Do not build a full artifact abstraction before the second consumer needs it.
- Do not force Coder into the generic task model.
- Do not generalize domain prompts into one universal prompt system.
- Do not preserve backward compatibility with code that nobody uses.

## Testing Strategy

Automated tests:
- Capability resolution for all three agents
- Workflow authorization by capability
- Runtime task creation and mirroring
- Workflow-owned task cleanup (with type-check fallback)
- Console surface gating per agent type

Manual smoke tests:
```
subscribe coder → open coding tab → start session
subscribe job-application-assistant → connect runner → start apply → see task on board
subscribe like4like-insurance-quotes → connect runner → start quote run → see task on board
```
