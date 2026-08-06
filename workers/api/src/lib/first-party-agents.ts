/**
 * The first-party agents, as their migrations leave them — one copy, shared by every guard that
 * has to reason about a REAL agent (#315).
 *
 * These pins already existed, in `agent-self-description.test.ts`, and the prompt-drift guard needs
 * the same five. Two copies of "what a Repo Coder is" is precisely the drift this repo keeps paying
 * for: the copy that is not updated goes on passing, and a guard that checks a stale fixture is
 * worse than no guard, because it reports green.
 *
 * They are hand-pinned rather than parsed out of the seed SQL because the seeds are PATCHED by
 * later migrations (0063 seeds the Repo Coder, 0065 adds its `surfaceOptions`, 0070 its tools), so
 * the only faithful reading is a replay of the whole migration chain. `coder2-parity.test.ts`
 * already checks the seeded JSON against the hardcoded reference; this file's job is different —
 * it is the set of agents the prompt guards run against, and being representative matters more
 * than being byte-identical to any one migration.
 */
import { agentCapabilities, type AgentCapabilities } from "./agent-capabilities.js";

/** The Repo Coder (migrations 0063 + 0065 + 0070): an executor it hands goals to, no drive tools. */
export const CODER_REPO: AgentCapabilities = agentCapabilities({
	slug: "coder-repo",
	config: JSON.stringify({
		capabilities: {
			surfaces: ["coding"],
			runtime: "coding",
			workflow: "CODING_SESSION",
			surfaceOptions: { coding: { repos: "single", drive: false, copilot: false } },
			tools: ["repo_tree", "repo_read_file", "repo_git", "repo_remote", "github_list_issues", "github_read_issue", "github_create_issue"],
		},
	}),
});

/** The legacy hardcoded Coder: declares no tool allowlist, so it keeps the drive tools. */
export const LEGACY_CODER: AgentCapabilities = agentCapabilities({
	slug: "coder",
	config: JSON.stringify({ capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } }),
});

/** Repo Chat: the only agent with a genuine vector index of code. Cloud-only — no runner. */
export const REPO_CHAT: AgentCapabilities = agentCapabilities({
	slug: "repo-chat",
	config: JSON.stringify({
		capabilities: { surfaces: ["repo"], runtime: null, workflow: null, tools: ["search_knowledge", "list_knowledge", "read_knowledge"] },
	}),
});

/** The Coder Lead: delegates, writes no code, declares no surfaces at all (#318). */
export const CODER_LEAD: AgentCapabilities = agentCapabilities({
	slug: "coder-lead",
	config: JSON.stringify({
		capabilities: { surfaces: [], runtime: null, workflow: null, tools: ["list_subordinates", "delegate_goal", "check_delegation"] },
	}),
});

/** A plain cloud chat agent: no capabilities declared at all, so it gets the permissive default. */
export const PLAIN_CHAT: AgentCapabilities = agentCapabilities({ slug: "language-buddy", config: null });

/** Every fixture, for guards that assert over all of them. */
export const FIRST_PARTY_AGENTS: readonly { name: string; capabilities: AgentCapabilities }[] = [
	{ name: "coder-repo", capabilities: CODER_REPO },
	{ name: "coder (legacy)", capabilities: LEGACY_CODER },
	{ name: "repo-chat", capabilities: REPO_CHAT },
	{ name: "coder-lead", capabilities: CODER_LEAD },
	{ name: "plain chat", capabilities: PLAIN_CHAT },
];
