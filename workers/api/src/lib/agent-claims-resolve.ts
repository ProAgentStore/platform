/**
 * Lint an agent's catalog copy against the capabilities that will ACTUALLY be resolved for it
 * (#362) — the one call both `POST /v1/agents` and `PUT /v1/agents/:id` make.
 *
 * PURE — no D1, no Env. Callers pass the post-write row shape; the judgement lives here so both
 * routes read the same fact from the same place, matching `trigger-capability.ts` (#358) and
 * `supervision-capability.ts` (#354).
 *
 * ── Why a second module rather than a call site
 *
 * `lintAgentClaims` (#66) ran on create and not on update, which is the path where a description
 * actually changes: copy gets rewritten as an agent finds its audience, long after the
 * capabilities were declared. So "runs a headless browser and posts on your behalf" could be
 * saved onto an agent declaring no runtime and no workflow, published to the catalog, and never
 * flagged — the check existed, was imported in that very file, and was simply not in the path.
 *
 * ── Why RESOLVED capabilities, not the declared block
 *
 * Two directions, and only one of them was ever covered:
 *
 *   • the copy changes and the capabilities do not — what #362 is about;
 *   • the capabilities change and the copy does not — the same mismatch, arrived at backwards,
 *     which neither route would have noticed.
 *
 * Reading the resolved capabilities catches both, and it reads the fact the RUNTIME reads
 * (`agentCapabilities`, which falls back to the slug/category derivation for pre-registry
 * agents) rather than a second, narrower copy of it. That matters in the allow direction: the
 * `coder` agent's description honestly promises a local runner, and its runtime backing comes
 * from the fallback — linting only `config.capabilities` would accuse it of overclaiming.
 *
 * Advisory, still. The header of `agent-claims-lint.ts` calls the heuristic overridable and that
 * does not change here: warnings ride alongside a 200/201, they never block the write.
 */
import { agentCapabilities, type AgentLike } from "./agent-capabilities.js";
import { lintAgentClaims } from "./agent-claims-lint.js";

/** The agent as it will exist AFTER the write — description included. */
export interface ResolvedClaimsInput extends AgentLike {
	description?: string | null;
}

/**
 * The welcome message, read from `config.identity.welcomeMessage` (#722).
 *
 * The lint's second family judges the welcome message as well as the description, because it is
 * the first sentence a subscriber reads and it carried the same false promise the description
 * did. There is no shared identity parser to reuse — `routes/instances.ts` and each seed test
 * parse `config.identity` inline, and `agentCapabilities` keeps its own `parseConfig` private —
 * so this is the same three lines, not a second vocabulary. It is deliberately NOT extended to
 * `identity.goal`: the goal is prompt text addressed to the model, not a claim addressed to a
 * buyer, and #722 is explicit that a goal saying "only once they have approved" is not evidence
 * that a gate exists.
 */
function welcomeMessageOf(config: string | null | undefined): string {
	if (!config) return "";
	try {
		const identity = (JSON.parse(config) as Record<string, unknown>).identity as Record<string, unknown> | undefined;
		const welcome = identity?.welcomeMessage;
		return typeof welcome === "string" ? welcome : "";
	} catch {
		return "";
	}
}

/** Catalog-integrity warnings for the post-write agent. Empty when the copy is backed. */
export function lintResolvedAgentClaims(agent: ResolvedClaimsInput): string[] {
	const caps = agentCapabilities(agent);
	return lintAgentClaims({
		description: agent.description,
		welcomeMessage: welcomeMessageOf(agent.config),
		// `tools` is the RESOLVED allowlist, for the same reason runtime/workflow are: it is what
		// the agent will actually be able to call, sanitized against the real catalog.
		capabilities: { runtime: caps.runtime, workflow: caps.workflow, tools: caps.tools },
	});
}
