/**
 * Keep smoke-test fixtures out of the public catalog (#65).
 *
 * Two of them sat in `GET /v1/agents` for months — "MCP Launch Smoke Agent" and "Codex MCP
 * Browser Test" — because publishing is a single `visibility` flip with nothing between a
 * throwaway fixture and the storefront. Anyone browsing the store saw them, which reads as an
 * unfinished product.
 *
 * Deliberately a NAME/DESCRIPTION heuristic and not a schema field: the fixtures already exist
 * and already say what they are, so a new `isTest` column would need back-filling by the same
 * judgement this makes, and every future fixture would have to remember to set it. The thing
 * that reliably identifies a smoke test is that its author called it one.
 *
 * It is an override-able guard, not a ban: `allowTestAgent: true` publishes anyway. A creator
 * legitimately shipping "A/B Test Runner" must not be blocked by a word match — they just have
 * to mean it.
 */

/**
 * Words that mark an agent as a fixture. Matched as WHOLE words against the slug, name and
 * description, so "latest", "contest" and "protest" don't trip it — the earlier instinct to
 * substring-match `test` catches far more real products than fixtures.
 */
const TEST_MARKERS = ["test", "tests", "smoke", "fixture", "scratch", "throwaway", "dummy", "sandbox"];

/** Slug/name/description tokens, lowercased, with separators treated as spaces. */
function tokens(...parts: (string | null | undefined)[]): string[] {
	return parts
		.filter((p): p is string => typeof p === "string" && p.length > 0)
		.flatMap((p) => p.toLowerCase().split(/[^a-z0-9]+/))
		.filter(Boolean);
}

/**
 * Does this agent look like a smoke-test fixture? Returns the marker that matched, so the
 * refusal can say WHICH word tripped it — a guard that won't tell you what it saw is one
 * people work around by renaming at random.
 */
export function testAgentMarker(agent: { slug?: string | null; name?: string | null; description?: string | null }): string | null {
	const found = new Set(tokens(agent.slug, agent.name, agent.description));
	for (const marker of TEST_MARKERS) if (found.has(marker)) return marker;
	return null;
}

/**
 * May this agent become publicly visible? Only `published` is gated — moving something back to
 * draft or unlisted must always work, including for an agent that is already published and
 * would now fail this check.
 */
export function blockPublishReason(
	agent: { slug?: string | null; name?: string | null; description?: string | null },
	nextVisibility: string | undefined,
	allowTestAgent = false,
): string | null {
	if (nextVisibility !== "published" || allowTestAgent) return null;
	const marker = testAgentMarker(agent);
	if (!marker) return null;
	return `This looks like a test fixture (matched "${marker}" in its slug, name or description) and would appear in the public catalog. Publish it with allowTestAgent: true if that is intended.`;
}
