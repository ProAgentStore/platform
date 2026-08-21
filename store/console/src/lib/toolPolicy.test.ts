import { describe, expect, it } from "vitest";
import { changesAnything, consentChip, listedTools, mayWrite, type ToolPolicyEntry, reachesOutside, toolScopeSummary, writeConnectors, writesOwnData } from "./toolPolicy";

function tool(over: Partial<ToolPolicyEntry> & { name: string }): ToolPolicyEntry {
	return {
		connector: undefined,
		scope: "read",
		description: "",
		allowed: true,
		disabled: false,
		reason: "ok",
		writeConsent: "n/a",
		...over,
	};
}

/**
 * The shapes the registry actually produces, per instance-tool-policy.test.ts and
 * tool-reach-report.test.ts — including `mutates` (#563) and `reach` (#584), because a fixture
 * missing the fields the sentence reads is how the console's claims were graded against the
 * console's own assumptions. Anything here that differs from the server's answer is a bug in this
 * file; the server-side guards are the ones that pin the real values.
 */
const httpRequest = tool({ name: "http_request", connector: "http", scope: "read", writeConsent: "per_call", mutates: true, reach: "internet" });
const mcpCall = tool({ name: "mcp_call_tool", connector: "mcp", scope: "write", writeConsent: "per_call", mutates: true, reach: "internet" });
const tmuxRun = tool({ name: "tmux_run_command", connector: "terminal", scope: "write", writeConsent: "required", mutates: true, reach: "machine" });
const repoTree = tool({ name: "repo_tree", connector: "repo-local", scope: "read", writeConsent: "n/a", mutates: false, reach: "machine" });
const notMine = tool({ name: "sheets_read", connector: "sheets", allowed: false, disabled: false, reason: "not_declared", mutates: false, reach: "internet" });

/** The `BASE` tools every instance holds, and the two that make the two false claims false. */
const writeMemory = tool({ name: "write_memory", scope: "write", tier: "base", invocableBy: ["chat"], mutates: true, reach: "platform" });
const readMemory = tool({ name: "read_memory", scope: "read", tier: "base", invocableBy: ["chat"], mutates: false, reach: "platform" });
/** `scope:"read"`, no connector, `mutates:true`, and it POSTs anywhere. #584's ten instances. */
const fetchUrl = tool({ name: "fetch_url", scope: "read", tier: "base", invocableBy: ["chat"], mutates: true, reach: "internet" });

describe("listedTools", () => {
	it("lists what the agent HAS, on or off — not what it may run right now", () => {
		const off = tool({ name: "x", allowed: false, disabled: true, reason: "disabled_by_owner" });
		expect(listedTools([repoTree, off, notMine]).map((t) => t.name)).toEqual(["repo_tree", "x"]);
	});
});

describe("mayWrite", () => {
	it("counts a per_call read-scope tool as write-capable", () => {
		// The whole point: `http_request` is honestly scope:"read" because the CALLER names the
		// verb. That is a fact about the tool, not about what the agent can do with it.
		expect(httpRequest.scope).toBe("read");
		expect(mayWrite(httpRequest)).toBe(true);
	});

	it("counts a plain write tool, and no others", () => {
		expect(mayWrite(tmuxRun)).toBe(true);
		expect(mayWrite(mcpCall)).toBe(true);
		expect(mayWrite(repoTree)).toBe(false);
	});
});

describe("writeConnectors", () => {
	it("names the connector each write-capable tool needs granted", () => {
		expect(writeConnectors([repoTree, httpRequest, tmuxRun]).sort()).toEqual(["http", "terminal"]);
	});

	it("ignores tools belonging to some other agent", () => {
		expect(writeConnectors([notMine, repoTree])).toEqual([]);
	});

	it("keeps the grant control for a tool the owner switched off", () => {
		// Switching a tool off must not remove the checkbox: the grant outlives the switch, and a
		// re-enabled tool would otherwise come back with an access nobody could see any more.
		const offWrite = { ...tmuxRun, allowed: false, disabled: true, reason: "disabled_by_owner" as const };
		expect(writeConnectors([offWrite])).toEqual(["terminal"]);
	});

	it("dedupes connectors shared by several tools", () => {
		const httpFetch = tool({ name: "http_fetch", connector: "http", scope: "read", writeConsent: "per_call" });
		expect(writeConnectors([httpRequest, httpFetch])).toEqual(["http"]);
	});
});

describe("toolScopeSummary", () => {
	// The bug this module exists for. An agent whose only tool was `http_request` read
	// "This agent has no write tools — it can only read" directly above a checkbox offering to let
	// it act as you, next to a chip saying writes need that exact grant.
	it("does not claim read-only while offering a write-access checkbox", () => {
		for (const policy of [[httpRequest], [mcpCall], [tmuxRun], [repoTree, httpRequest]]) {
			const summary = toolScopeSummary(policy);
			expect(writeConnectors(policy).length).toBeGreaterThan(0);
			expect(summary).not.toMatch(/only read/);
			expect(summary).toMatch(/granted below/);
		}
	});

	it("says read-only only when there is nothing to grant", () => {
		expect(toolScopeSummary([repoTree])).toMatch(/only read/);
		expect(toolScopeSummary([])).toMatch(/only read/);
		expect(writeConnectors([repoTree])).toEqual([]);
	});

	it("agrees with the checkbox set for every combination", () => {
		const all = [httpRequest, mcpCall, tmuxRun, repoTree, notMine];
		for (let mask = 0; mask < 1 << all.length; mask++) {
			const policy = all.filter((_, i) => mask & (1 << i));
			const claimsWrite = !/only read/.test(toolScopeSummary(policy));
			expect(claimsWrite).toBe(writeConnectors(policy).length > 0);
		}
	});

	// #525, on the console side. The API listing now carries the agent's built-in tools, so the
	// read-only sentence would otherwise have been rendered over a switch labelled `write_memory` —
	// the same false assurance `list_instance_tools` was giving an operator over MCP.
	it("does not say 'only read' for an agent that can write its own memory", () => {
		const summary = toolScopeSummary([repoTree, writeMemory]);
		expect(summary).not.toMatch(/only read/);
		// …and does not point at a checkbox either: there is no connector to grant.
		expect(summary).not.toMatch(/granted below/);
		expect(writeConnectors([repoTree, writeMemory])).toEqual([]);
	});

	it("keeps the external claim for an agent that has both", () => {
		expect(toolScopeSummary([writeMemory, tmuxRun])).toMatch(/granted below/);
	});

	it("still says read-only when the built-in tools it holds are reads", () => {
		expect(toolScopeSummary([repoTree, readMemory])).toMatch(/only read/);
	});

	it("ignores a write the owner never had — a not_declared row is not this agent's", () => {
		const foreign = tool({ name: "write_memory", scope: "write", tier: "base", allowed: false, disabled: false, reason: "not_declared" });
		expect(toolScopeSummary([foreign])).toMatch(/only read/);
	});

	it("does not promise a grant 'below' for a connector-less write tool", () => {
		// Defective tool (the server refuses it outright), so "it can only read" is the operative
		// truth and there is no checkbox to point at.
		const orphan = tool({ name: "broken_write", scope: "write", writeConsent: "n/a" });
		expect(writeConnectors([orphan])).toEqual([]);
		expect(toolScopeSummary([orphan])).not.toMatch(/granted below/);
	});
});

/**
 * #584 — the sentence that was wrong on screen, and #577 — the one that could not render.
 *
 * ── What was measured, and what these fixtures stand for ────────────────────────────────────
 *
 * These are unit cases over hand-built policies, and on their own they would prove nothing about
 * the claim the page makes: the population is the 34 instances on the operator account, of which
 * TEN rendered "no tool that reaches outside the platform" with `fetch_url` switched on. This file
 * cannot see that population — the console has no access to `resolveToolPolicy`. The claim is
 * closed by TWO guards together, and neither is sufficient alone:
 *
 *   • `workers/api/src/lib/tool-reach-report.test.ts` measures the whole listing (104 rows, every
 *     capability shape) and pins what each tool reaches — including that `fetch_url` is
 *     `internet`, that `BASE` puts it on every agent, and that no row falls through to the default.
 *   • this file pins that the SENTENCE is a faithful reading of those rows.
 *
 * ── G4: watched fail ────────────────────────────────────────────────────────────────────────
 *
 * Restore `writeConnectors(policy).length > 0` / `scope === "write" && !connector` as the two
 * clauses of `toolScopeSummary` and every test in this block goes red: "an agent holding fetch_url"
 * and "reads that leave" on #584's clause, "a mutating tool the consent gate calls a read" and
 * "does not need write_memory" on #577's.
 */
describe("the reach claim is derived from reach (#584)", () => {
	it("never tells an agent holding fetch_url that nothing reaches outside the platform", () => {
		// The ten instances, reconstructed: BASE tools only, no connector tool anywhere — so the
		// old clause ("does any listed tool name a connector") saw nothing and claimed the negative.
		const policy = [readMemory, writeMemory, fetchUrl];
		expect(writeConnectors(policy), "the old predicate's input: no connector in sight").toEqual([]);
		const summary = toolScopeSummary(policy);
		expect(summary, "the false safety claim").not.toMatch(/no tool that reaches outside/);
		expect(summary).toMatch(/reach outside the platform/);
		expect(summary).toMatch(/other systems/);
		// …and it does not point at a checkbox that does not exist.
		expect(summary).not.toMatch(/granted below/);
	});

	it("counts a read that leaves — reach is not mutation", () => {
		// `web_search` changes nothing and carries whatever it is given to Google. An owner reading
		// this line is deciding what to put in the knowledge base, so "it can only read" alone
		// would answer the wrong question.
		const webSearch = tool({ name: "web_search", connector: "web-search", scope: "read", mutates: false, reach: "internet" });
		const summary = toolScopeSummary([readMemory, webSearch]);
		expect(summary).toMatch(/reach outside the platform/);
		expect(summary).toMatch(/can only read there/);
		expect(reachesOutside([readMemory, webSearch]).map((t) => t.name)).toEqual(["web_search"]);
	});

	it("does not let the reach clause swallow the own-data one", () => {
		// Found by the #525 case above while this was being written: an agent that writes its own
		// memory and only READS your machine used to end on "…but can only read there", which is
		// read as "read-only" — the exact claim #525 removed, coming back through the other clause.
		const summary = toolScopeSummary([repoTree, writeMemory]);
		expect(summary).toMatch(/change its own data/);
		expect(summary).toMatch(/read from outside the platform/);
		expect(summary).toMatch(/changes nothing there/);
		expect(summary).not.toMatch(/only read/);
	});

	it("says whose machine, and says both when it is both", () => {
		expect(toolScopeSummary([writeMemory, tmuxRun])).toMatch(/your own computer/);
		expect(toolScopeSummary([writeMemory, fetchUrl])).toMatch(/other systems/);
		const both = toolScopeSummary([writeMemory, tmuxRun, fetchUrl]);
		expect(both).toMatch(/your own computer, and other systems/);
	});

	it("a connector is not the question, in the other direction either", () => {
		// `supervision` names a connector, needs a grant, and never leaves the platform (both
		// instances are the same owner's). Deriving reach from `connector` would report external
		// access to a system that does not exist.
		const delegate = tool({ name: "delegate_goal", connector: "supervision", scope: "write", writeConsent: "required", mutates: true, reach: "platform" });
		const summary = toolScopeSummary([readMemory, delegate]);
		expect(summary, "it genuinely does not leave the platform").toMatch(/no tool that reaches outside the platform/);
		// …and the checkbox is still offered, because the gate still applies. #351 is untouched.
		expect(writeConnectors([readMemory, delegate])).toEqual(["supervision"]);
	});

	// #721. `find_confirmation_link` reads the owner's Gmail and `reach:"internet"` says so — but
	// the server used to send it `allowed:false, reason:"not_declared"` even on the one instance
	// whose owner had granted the mailbox, so `listedTools` dropped the row and this sentence went
	// on asserting the negative over it. The fix is server-side (the row now arrives allowed); what
	// this pins is that a listed mailbox reader is enough to stop the reach negative, so the fix
	// cannot be undone by a change on this side.
	it("stops claiming an otherwise platform-only agent reaches nothing once the mailbox is granted", () => {
		const platformOnly = [readMemory, writeMemory];
		expect(toolScopeSummary(platformOnly), "the precondition — this is the sentence at stake").toMatch(
			/no tool that reaches outside the platform/,
		);
		// The row exactly as the server now sends it with `permissions.email` on.
		const findLink = tool({ name: "find_confirmation_link", scope: "read", tier: "standard", invocableBy: ["chat"], mutates: false, reach: "internet" });
		const summary = toolScopeSummary([...platformOnly, findLink]);
		expect(summary).not.toMatch(/no tool that reaches outside/);
		// It reads the mailbox and changes nothing out there, so the honest sentence is the
		// read-that-leaves one — with the own-data half kept, per the clause above.
		expect(summary).toMatch(/read from outside the platform/);
		expect(summary).toMatch(/other systems/);
		// It has no connector, so it must not invent a grant checkbox for one.
		expect(writeConnectors([...platformOnly, findLink])).toEqual([]);
	});

	it("keeps the mailbox reader off the list while the permission is off", () => {
		// `needs_permission`, not `not_declared` (#721) — and either way there is no switch to
		// render, so the row is not listed and makes no claim in either direction.
		const ungranted = tool({ name: "find_confirmation_link", allowed: false, disabled: false, reason: "needs_permission", mutates: false, reach: "internet" });
		expect(listedTools([readMemory, ungranted]).map((t) => t.name)).toEqual(["read_memory"]);
		expect(consentChip(ungranted)).toBeNull();
	});

	it("makes NO reach claim when the server did not send one", () => {
		// An older API. The negative is unprovable here, so it is not asserted — the rule this
		// module exists to keep, one layer above any particular field.
		const legacy = tool({ name: "write_memory", scope: "write", tier: "base" });
		const summary = toolScopeSummary([legacy]);
		expect(summary).not.toMatch(/reaches outside/);
		expect(summary).not.toMatch(/reach outside/);
		expect(summary).toMatch(/can change things/);
	});

	it("leaves writeConnectors — the checkbox set — untouched by any of it", () => {
		// #584 AC3. The grant controls are #351's promise and are not part of this change.
		const all = [httpRequest, mcpCall, tmuxRun, repoTree, notMine, writeMemory, readMemory, fetchUrl];
		for (let mask = 0; mask < 1 << all.length; mask++) {
			const policy = all.filter((_, i) => mask & (1 << i));
			const expected = [...new Set(policy.filter((t) => (t.allowed || t.disabled) && t.connector && mayWrite(t)).map((t) => t.connector as string))];
			expect(writeConnectors(policy).sort()).toEqual(expected.sort());
		}
	});
});

describe("the change claim is derived from mutates (#577)", () => {
	it("counts a mutating tool the consent gate calls a read", () => {
		// AC3. `start_work` starts a durable autonomous run and is `scope:"read"` with no connector,
		// because a write-scoped connector-less tool is refused outright by `runRegistryTool`. This
		// policy carries NO `write_memory`, which is the case `BASE` masks on every real instance —
		// synthetic on purpose, and unreachable in production for the structural reason pinned in
		// `workers/api/src/lib/tool-reach-report.test.ts`.
		const startWork = tool({ name: "start_work", scope: "read", tier: "base", writeConsent: "n/a", mutates: true, reach: "platform" });
		expect(startWork.scope, "the field the old predicate read").toBe("read");
		expect(writesOwnData([readMemory, startWork])).toBe(true);
		const summary = toolScopeSummary([readMemory, startWork]);
		expect(summary, "an agent that can start autonomous work is not read-only").not.toMatch(/only read/);
		expect(summary).toMatch(/change its own data/);
	});

	it("does not need write_memory to be present to be right", () => {
		// The invariant #577 named: `BASE` always supplies six connector-less platform writes, so
		// the old predicate was true for every agent and its error could never show. Nothing here
		// depends on that any more.
		const runPipeline = tool({ name: "run_pipeline", scope: "read", tier: "base", mutates: true, reach: "platform" });
		const setBehaviour = tool({ name: "set_behaviour", scope: "read", tier: "base", mutates: true, reach: "platform" });
		expect([runPipeline, setBehaviour].some((t) => t.scope === "write"), "not one of them is scope:'write'").toBe(false);
		expect(toolScopeSummary([runPipeline, setBehaviour])).toMatch(/change its own data/);
	});

	it("still says read-only for an agent whose tools all merely read", () => {
		expect(changesAnything(readMemory)).toBe(false);
		const summary = toolScopeSummary([readMemory]);
		expect(summary).toMatch(/only read/);
		expect(summary).toMatch(/none that reach outside the platform/);
	});

	it("never contradicts the checkbox set, even on a row that disagrees with itself", () => {
		// A `mutates:false` row with a write gate on it is a server-side contradiction. Whichever
		// way it is resolved, the read-only sentence must not render above a control offering to
		// let the agent act as you — the defect this whole module was created for.
		const contradictory = tool({ name: "odd", connector: "http", scope: "read", writeConsent: "per_call", mutates: false, reach: "internet" });
		expect(changesAnything(contradictory)).toBe(true);
		expect(writeConnectors([contradictory])).toEqual(["http"]);
		expect(toolScopeSummary([contradictory])).not.toMatch(/only read/);
	});
});

describe("consentChip", () => {
	it("names the connector a refusal is asking for", () => {
		// The surface and the consent key are not always the same word (#351): a `tmux` instance
		// gets its tools from the `terminal` connector, and granting `tmux` does nothing.
		expect(consentChip(tmuxRun)).toBe("needs terminal write access");
		expect(consentChip(httpRequest)).toBe("writes need http access");
	});

	it("does not send the owner to a checkbox that is already ticked", () => {
		// mcp reaches per_call only AFTER the connector row is granted — reach is per server+tool.
		expect(consentChip(mcpCall)).toBe("granted per server + tool");
	});

	it("stays silent when nothing is in the way", () => {
		expect(consentChip(repoTree)).toBeNull();
		expect(consentChip(tool({ name: "t", connector: "terminal", scope: "write", writeConsent: "granted" }))).toBeNull();
	});

	it("stays silent for a tool that is already refused for a stated reason", () => {
		// Two explanations for one disabled switch is worse than one.
		expect(consentChip({ ...tmuxRun, allowed: false, disabled: true, reason: "disabled_by_owner" })).toBeNull();
		expect(consentChip(notMine)).toBeNull();
	});

	it("never renders the word 'undefined' when the server omits the connector", () => {
		expect(consentChip(tool({ name: "x", scope: "write", writeConsent: "required" }))).toBe("needs connector write access");
	});
});
