# Opening ProAgentStore to third-party agent creators

> **Status:** program plan, opened 2026-08-01. Turns PAGS from "first-party agents +
> curated fleet" into a **creator marketplace**. The vision/tiers live in
> `agent-platform-strategy.md`; this doc is the concrete, decision-locked build plan.
> Tracked by epic **ProAgentStore/platform#58**.

## Owner decisions (2026-08-01)

| Decision | Choice | Consequence |
|---|---|---|
| First-release scope | **Tier-1 config + Tier-2 custom code** | The sandbox is in scope from day one → the security bar is high |
| Trust model | **Curated review** | Every agent *and every version* is reviewed before it's listed |
| Monetization | **Free / beta first** | Open creation now; build payout plumbing behind a flag, launch later |

## The one gate

**Do not open to the public until Tier-2 sandboxing (#52) and cost governance (#56) are
proven.** A third party running custom code on our infra is the make-or-break problem;
everything else can ship incrementally behind invite → curated.

## Where we are (verified 2026-08-01)

Ready today for **first-party / curated** agents — three working paths (config/data via
`create_agent` + `agent-builder`; standalone-worker via `scaffold_agent` + templates;
runtime-backed Tier-0 like coder/apply). What blocks *third parties*:

1. **Capability vocabulary is a closed union** — `AgentSurface`/`workflow` in
   `lib/agent-capabilities.ts` are hardcoded; a new agent shape needs a monorepo PR.
2. **No isolated code execution** — no Dynamic Workers; creator custom logic can't run safely.
3. **No creator authoring UI** — creation is API/MCP only.
4. **Metering/payouts incomplete** — in flight on `feat/admin-platform-metering` (#28–#46).

## Workstreams

| # | Workstream | Note |
|---|---|---|
| #51 | Tier-1: declarative agent schema + **open tool catalog** + shared runtime | **Partly landed** — tool catalog + per-agent `capabilities.tools` allowlist (PR #59, live) and `repo-chat` dogfooded onto it (PR #61, live). A formal `AgentDefinition` (PR #62) was prototyped then **removed as unwired dead code** — rebuild it *with* the create/update wiring. Remaining: wire create/update to accept a full definition + shared-runtime convergence. |
| #52 | **Tier-2: sandboxed creator code via Dynamic Workers** | **Critical path.** Worker Loader + scoped bindings + server-side secret injection; never `eval()` |
| #53 | Curated publish + review pipeline | `draft → in_review → listed → suspended`; per-version review + rollback |
| #54 | Automated pre-review safety scanning | Tool-scope, SSRF, secret-access, prompt-injection, cost-bomb heuristics → risk score |
| #55 | Creator experience: onboarding + authoring UI + Coder flywheel | The missing "build an agent" surface; describe→Coder writes→sandbox→review |
| #56 | Cost governance & abuse controls | **Gates the public open.** Quotas, cost caps, kill switch, incident suspend |
| #57 | Metering → payout-ready (behind a flag) | Finish metering (#44); build Stripe Connect usage-share payout, launch deferred |

## Phasing

- **Phase 0 — foundation (partly in flight):** admin access-control (#28), metering (#44),
  usage/spend + kill switch (#39/#46), moderation UI (#41). The safety net that must exist first.
- **Phase 1 — Tier-1 to invited creators:** #51 + #53 + #55 (config-only authoring, curated).
  ✓ Foundation landed (tool catalog #59) and `repo-chat` is dogfooded
  onto it (#61 — declares its tools as data). Remaining: wire create/update to a full
  definition, the review pipeline (#53), and the authoring UI (#55).
- **Phase 2 — Tier-2 code (the hard part):** #52 + #54 + #56. Red-team the sandbox before
  any third party touches it.
- **Phase 3 — widen + monetize:** loosen curation as guardrails mature; flip payouts (#57).

## Security floor we build on

Tenant isolation, envelope crypto (AES-256-GCM DEK under `KEY_ENCRYPTION_KEY`), SSRF guard
(`lib/ssrf.ts`), MCP OAuth scopes, per-instance DO isolation — see `SECURITY.md`. Tier-2's
secret-isolation requirement extends this, it doesn't start from zero.

## Open questions

- **Custom surfaces:** the existing `CustomSurface` loads code into the console origin —
  unacceptable for untrusted agents. Restrict third parties to declarative surface types,
  or sandbox surface code too? (Decide in #51.)
- **repo-chat's canonical form** — first dogfood for the declarative schema (#51); also the
  open item from the monorepo-boundary epic #50.
- **Workers for Platforms vs Worker Loader** — WfP only for the managed/custom-domain creator
  worker case; Worker Loader is the default isolate path (#52).
