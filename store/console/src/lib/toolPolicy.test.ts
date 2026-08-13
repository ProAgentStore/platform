import { describe, expect, it } from "vitest";
import { consentChip, listedTools, mayWrite, type ToolPolicyEntry, toolScopeSummary, writeConnectors } from "./toolPolicy";

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

/** The shapes the registry actually produces, per instance-tool-policy.test.ts. */
const httpRequest = tool({ name: "http_request", connector: "http", scope: "read", writeConsent: "per_call" });
const mcpCall = tool({ name: "mcp_call_tool", connector: "mcp", scope: "write", writeConsent: "per_call" });
const tmuxRun = tool({ name: "tmux_run_command", connector: "terminal", scope: "write", writeConsent: "required" });
const repoTree = tool({ name: "repo_tree", connector: "repo-local", scope: "read", writeConsent: "n/a" });
const notMine = tool({ name: "sheets_read", connector: "sheets", allowed: false, disabled: false, reason: "not_declared" });

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
		const writeMemory = tool({ name: "write_memory", scope: "write", tier: "base", invocableBy: ["chat"], writeConsent: "n/a" });
		const summary = toolScopeSummary([repoTree, writeMemory]);
		expect(summary).not.toMatch(/only read/);
		// …and does not point at a checkbox either: there is no connector to grant.
		expect(summary).not.toMatch(/granted below/);
		expect(writeConnectors([repoTree, writeMemory])).toEqual([]);
	});

	it("keeps the external claim for an agent that has both", () => {
		const writeMemory = tool({ name: "write_memory", scope: "write", tier: "base", invocableBy: ["chat"] });
		expect(toolScopeSummary([writeMemory, tmuxRun])).toMatch(/granted below/);
	});

	it("still says read-only when the built-in tools it holds are reads", () => {
		const readMemory = tool({ name: "read_memory", scope: "read", tier: "base", invocableBy: ["chat"] });
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
