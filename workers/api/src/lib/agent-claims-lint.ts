// Catalog claims lint (#66): flag catalog copy that promises a RUNTIME capability the agent's
// `capabilities` block can't back — for a store, a description that overstates what the agent
// does is an integrity bug, not polish. Heuristic + overridable, but loud: if the description
// claims a runtime capability (browser / posting / headless / local runner / cron / scheduled)
// while `capabilities.runtime` AND `capabilities.workflow` are both null, it's a mismatch.
// Pure so it can run at publish time and in CI. Consume from the create/update-agent route.

/** The runtime-backing an agent declares — only these fields decide whether a runtime claim
 *  is honest. Kept structural so it accepts the full AgentCapabilities. */
export interface ClaimsCapabilities {
	runtime: string | null;
	workflow: string | null;
}

/** A runtime capability a description might claim, with the phrases that signal it. */
const RUNTIME_CLAIMS: Array<{ capability: string; patterns: RegExp[] }> = [
	{ capability: "browser automation", patterns: [/\bbrowser\b/i, /\bplaywright\b/i, /\bheadless\b/i, /logged-in browser/i] },
	{ capability: "posting/publishing via a runner", patterns: [/\bpublishing\b/i, /\bposting\b/i, /\bposts? (to|on)\b/i] },
	{ capability: "a local runner", patterns: [/\blocal runner\b/i, /\bruns? (them|it)?\s*(locally|on your machine)\b/i, /\btmux\b/i] },
	{ capability: "scheduled/cron runs", patterns: [/\bcron\b/i, /\bscheduled\b/i, /after every deploy/i] },
];

/**
 * Lint one agent's description against its declared capabilities. Returns a list of human
 * violation messages (empty = OK). A runtime claim is honest as long as the agent declares
 * ANY runtime or workflow (we don't check which — that's the overridable, heuristic part).
 */
export function lintAgentClaims(input: { description?: string | null; capabilities?: ClaimsCapabilities | null }): string[] {
	const desc = (input.description || "").toString();
	if (!desc.trim()) return [];
	const backed = !!(input.capabilities && (input.capabilities.runtime || input.capabilities.workflow));
	if (backed) return []; // has a runtime/workflow → any runtime claim is plausibly honest
	const violations: string[] = [];
	for (const { capability, patterns } of RUNTIME_CLAIMS) {
		const hit = patterns.find((p) => p.test(desc));
		if (hit) {
			violations.push(
				`Description claims ${capability} (matched ${hit.source}) but capabilities declare no runtime/workflow. Wire the capability or rewrite the copy.`,
			);
		}
	}
	return violations;
}
