import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCodingSessionTools, repoToolRoutingHint, reposToolRoutingHint } from "./coding-tools.js";
import type { McpEnv } from "./http.js";
import { PLATFORM_GUIDE } from "./platform-guide.js";
import type { SafetyContext } from "./safety.js";
import { SERVER_INSTRUCTIONS } from "./tool-metadata.js";

/**
 * The meta-tool pattern is NAMED on every channel that can carry it (#743).
 *
 * ── What was measured, on 2026-08-23
 *
 * An external MCP client working through this server was asked to triage the open issues on a
 * repo attached to a Coder instance. It told its user:
 *
 *     "no, I don't have direct access to GitHub issues. I have no GitHub connector."
 *
 * — then drove the owner's CLI to run `gh issue list`, read a truncated terminal pane, and advised
 * configuring a connector. `github_list_issues`, `github_read_issue`, `github_create_issue`,
 * `github_comment_issue` and `github_update_issue` were all declared, consented and callable on
 * that instance through `call_instance_tool`.
 *
 * The cause was not the model. `grep -c "call_instance_tool\|list_instance_tools"` returned **0**
 * over `platform-guide.ts`, and `SERVER_INSTRUCTIONS` named neither — 2 hits in
 * `tool-metadata.ts` at the FILE level, but both were `TOOL_RISK` policy-map entries, not prose a
 * model reads. The two documents whose whole job is describing this platform to a model did not
 * contain the pattern, so it was undiscoverable by anything short of trial and error.
 *
 * ── Why four channels, and why this file holds all four
 *
 * They differ in the one property that matters — whether a client with a STALE tool list ever
 * sees the guidance:
 *
 *   · `SERVER_INSTRUCTIONS`   read once at `initialize`; inside the surface fingerprint
 *   · a tool's `description`  read from the client's CACHED list — the slowest channel of the four
 *   · `PLATFORM_GUIDE`        a RESULT, computed fresh; reaches a model THROUGH a stale cache
 *   · other tool RESULTS      fresh every call, and the only channel that can name THIS repo
 *
 * Deleting any one of them leaves a real population unserved, so a single assertion in one file is
 * what makes the set legible as a set. #670 is open on cached tool lists and #717 was invisible
 * for a day on the same mechanism, which is why the last two channels are not optional extras.
 *
 * ── What this file does NOT certify
 *
 * That a model CHOOSES `call_instance_tool` over `coding_session_message`. That is an eval, this
 * repo has no eval harness, and asserting it here would be a guard certifying ground it never
 * walked (ADR 0002; #740 refused the same thing). What is checkable is that the four strings say
 * it, and that is exactly and only what is asserted below.
 */

const env: McpEnv = { API_BASE: "https://api.test" };

/** The registered description of one coding tool, read off a real registration run. */
function describeCodingTool(name: string): string {
	const descriptions = new Map<string, string>();
	registerCodingSessionTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		{ tool: (n: string, d: string) => descriptions.set(n, d) } as any,
		env,
		(t?: string) => t || "session-token",
		(): SafetyContext => ({ env, subject: "u1", scopes: ["read"] }),
	);
	// G1: the harness is asserted before anything is read out of it. A registrar that registered
	// nothing would otherwise make every arm below pass against `undefined`.
	expect(descriptions.size, "registerCodingSessionTools registered nothing — this file is measuring nothing").toBeGreaterThanOrEqual(10);
	const d = descriptions.get(name);
	expect(d, `${name} is not registered by registerCodingSessionTools`).toBeDefined();
	return d as string;
}

describe("the meta-tool pattern is discoverable on every channel (#743)", () => {
	it("PLATFORM_GUIDE names both halves of the pattern, and the tool they replace", () => {
		// The channel that reaches a model through a stale `tools/list` (#703). It returned 0 hits
		// for either tool name before this.
		expect(PLATFORM_GUIDE).toContain("list_instance_tools");
		expect(PLATFORM_GUIDE).toContain("call_instance_tool");
		// Naming them is not enough: the guide has to say WHICH path is preferred, otherwise it
		// documents two options and leaves the caller where it started.
		expect(PLATFORM_GUIDE).toContain("coding_session_message");
		expect(PLATFORM_GUIDE, "the guide must state an order, not merely list both tools").toMatch(/BEFORE reaching for coding_session_message/);
		console.log(`✓ #743 ch.1: PLATFORM_GUIDE is ${PLATFORM_GUIDE.length} chars and names all three tools`);
	});

	it("SERVER_INSTRUCTIONS names the pattern, without displacing the id-first sequence", () => {
		expect(SERVER_INSTRUCTIONS).toContain("list_instance_tools");
		expect(SERVER_INSTRUCTIONS).toContain("call_instance_tool");
		expect(SERVER_INSTRUCTIONS).toMatch(/BEFORE reaching for coding_session_message/);
		// `index.test.ts` already holds `my_instances` inside the first 512 characters, which is
		// OpenAI's stated cut. Restated here because THIS file is what would push it out: a sentence
		// added ahead of the id-first one would pass every assertion above and break that one.
		expect(SERVER_INSTRUCTIONS.slice(0, 512), "the id-first sequence must still survive the 512-char cut").toContain("my_instances");
		console.log(`✓ #743 ch.2: SERVER_INSTRUCTIONS is ${SERVER_INSTRUCTIONS.length} chars; my_instances at index ${SERVER_INSTRUCTIONS.indexOf("my_instances")}`);
	});

	it("coding_session_message describes itself as the FALLBACK, not the first path", () => {
		const d = describeCodingTool("coding_session_message");
		expect(d).toMatch(/FALLBACK|fallback/);
		expect(d).toContain("list_instance_tools");
		expect(d).toContain("call_instance_tool");
		// The specific claim the failure turned on: the terminal answers with a truncated pane, and
		// a caller that does not know that reads a partial issue list as a complete one.
		expect(d, "it must say what the terminal route costs, not merely that another one exists").toMatch(/truncat/);
		console.log(`✓ #743 ch.3: coding_session_message description is ${d.length} chars and leads with the fallback rule`);
	});
});

describe("the per-instance routing hint — the half a stale cache cannot hide (#743)", () => {
	it("names the repo and the two tools when the repo has GitHub metadata", () => {
		const hint = repoToolRoutingHint({ id: "repo_1", name: "platform", githubRepo: "ProAgentStore/platform" });
		expect(hint).toContain("ProAgentStore/platform");
		expect(hint).toContain("list_instance_tools");
		expect(hint).toContain("call_instance_tool");
		console.log(`✓ #743 ch.4: repoToolRoutingHint emits ${hint.length} chars for a GitHub-hosted repo`);
	});

	it("says NOTHING for a local-only repo — there is no coordinate to route to", () => {
		// A hint that fires on every repo is a hint a reader learns to skip, and a local checkout
		// genuinely has no GitHub tools to offer.
		expect(repoToolRoutingHint({ id: "repo_2", name: "scratch" })).toBe("");
		expect(reposToolRoutingHint([{ id: "repo_2", name: "scratch" }])).toBe("");
		expect(reposToolRoutingHint([])).toBe("");
	});

	it("claims the tools MAY be available, never that they are", () => {
		// This worker knows the repo is on GitHub. It does NOT know whether the instance declares
		// `github_list_issues`, whether the owner switched it off, or whether write consent was
		// granted — all three live behind `list_instance_tools`. Asserting the capability here
		// would be #743 with the sign flipped: a caller told a tool exists that the agent cannot
		// run. The hedge is the correctness condition, so it is pinned.
		const hint = repoToolRoutingHint({ id: "repo_1", githubRepo: "o/r" });
		expect(hint).toMatch(/may have/);
		expect(hint).not.toMatch(/\bhas its own GitHub tools|\bcan run github_/);
	});

	it("carries the same rule into the repos LISTING, naming every hosted repo", () => {
		const hint = reposToolRoutingHint([
			{ id: "a", name: "one", githubRepo: "o/one" },
			{ id: "b", name: "local" },
			{ id: "c", name: "two", githubRepo: "o/two" },
		]);
		expect(hint).toContain("o/one");
		expect(hint).toContain("o/two");
		expect(hint, "a local-only repo has nothing to route and must not be listed").not.toContain("local");
		expect(hint).toContain("list_instance_tools");
		expect(hint).toContain("call_instance_tool");
	});

	it("reads plural repos as plural, so the sentence survives a multi-repo agent", () => {
		expect(reposToolRoutingHint([{ id: "a", githubRepo: "o/one" }])).toMatch(/^o\/one is on GitHub/);
		expect(reposToolRoutingHint([{ id: "a", githubRepo: "o/one" }, { id: "b", githubRepo: "o/two" }])).toMatch(/^o\/one, o\/two are on GitHub/);
	});
});

/** Every tool `registerCodingSessionTools` registers, with the handler as the SDK would call it. */
interface Captured {
	handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

/**
 * Drive the real handler, with the API answered by a stub.
 *
 * The two arms above measure the pure hint. This measures what a CALLER receives, which is the
 * acceptance criterion as written — a hint composed correctly and then never appended would pass
 * every assertion above.
 */
async function openConversationOver(repos: Record<string, unknown>[], repoId?: string): Promise<string> {
	const tools = new Map<string, Captured>();
	vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const body =
			(init?.method || "GET").toUpperCase() === "POST" && url.endsWith("/coding/sessions")
				? { session: { id: "csess_1" }, runnerConnected: true, continuity: { mode: "resume", reason: "last touched an hour ago" }, resumed: true }
				: { repos };
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	});
	registerCodingSessionTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		{ tool: (n: string, _d: string, _s: unknown, handler: Captured["handler"]) => tools.set(n, { handler }) } as any,
		env,
		(t?: string) => t || "session-token",
		(): SafetyContext => ({ env, subject: "u1", scopes: ["read", "write", "runtime"] }),
	);
	const t = tools.get("coding_session_open");
	expect(t, "coding_session_open is not registered — this arm is measuring nothing").toBeDefined();
	const res = await (t as Captured).handler({ instance_id: "inst_1", ...(repoId ? { repo_id: repoId } : {}) });
	return res.content[0].text;
}

describe("coding_session_open's RESPONSE carries the hint (#743, AC3)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("appends it when the repo has GitHub metadata", async () => {
		const said = await openConversationOver([{ id: "repo_1", name: "platform", githubRepo: "ProAgentStore/platform" }]);
		// The open is still reported first and unchanged — the hint is an addition, not a
		// replacement. #696 and ADR 0005 own that sentence and this must not disturb it.
		expect(said).toMatch(/^Continuing this repo's previous conversation on platform/);
		expect(said).toContain("ProAgentStore/platform");
		expect(said).toContain("list_instance_tools");
		expect(said).toContain("call_instance_tool");
		console.log(`✓ #743 AC3: coding_session_open answered ${said.length} chars, hint included`);
	});

	it("says nothing extra when the repo is a local checkout", async () => {
		const said = await openConversationOver([{ id: "repo_1", name: "scratch" }]);
		expect(said).toMatch(/^Continuing this repo's previous conversation on scratch/);
		expect(said).not.toContain("list_instance_tools");
		expect(said).not.toContain("call_instance_tool");
	});

	it("says nothing extra when the caller named a repo the listing does not hold", async () => {
		// `resolveRepoForOpen` trusts an explicit `repo_id` and synthesises a bare row for it. That
		// row has no GitHub coordinate, and inventing one would be a claim about a repo this worker
		// never saw.
		const said = await openConversationOver([{ id: "repo_1", name: "platform", githubRepo: "o/r" }], "repo_absent");
		expect(said).not.toContain("list_instance_tools");
	});
});
