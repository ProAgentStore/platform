import { describe, expect, it } from "vitest";
import { toolNamesFor } from "../agent-do-tools.js";
import { CONNECTORS, getConnector } from "./connectors/registry.js";
import { connectorPolicyOf, connectorRefusal, resolveConnectorPolicy } from "./instance-connector-policy.js";
import type { Connector } from "./connectors/types.js";

const drive = getConnector("google_drive") as Connector;
const workdrive = getConnector("zoho_workdrive") as Connector;
const gmail = getConnector("gmail") as Connector;
const github = getConnector("github") as Connector;

/** The tool names an agent that declared exactly this allowlist may run. */
const declaring = (...tools: string[]) => toolNamesFor({ surfaces: [], runtime: null, workflow: null, tools, boardColumns: [] });

describe("instance connector policy (#352)", () => {
	// The reported symptom: connect Drive once at ACCOUNT level and its folder-grant panel came
	// back on every instance, including terminal Operators that will never read a document. These
	// two are the same account state and the same connector — only the agent differs.
	it("withholds a file connector from an agent that cannot read its knowledge base", () => {
		const operator = declaring("tmux_capture_pane", "tmux_send_keys");
		expect(connectorPolicyOf(drive, operator)).toMatchObject({ allowed: false, reason: "no_knowledge" });
		expect(connectorPolicyOf(workdrive, operator)).toMatchObject({ allowed: false, reason: "no_knowledge" });
	});

	it("offers it to an agent that can, because a Drive import lands in the knowledge base and nowhere else", () => {
		const reader = declaring("search_knowledge");
		expect(connectorPolicyOf(drive, reader)).toMatchObject({ allowed: true, reason: "knowledge" });
		expect(connectorPolicyOf(workdrive, reader)).toMatchObject({ allowed: true, reason: "knowledge" });
	});

	it("stays permissive for an agent that declares no allowlist at all", () => {
		// Undeclared means the agent gets the per-surface DEFAULT server-side, so nothing here may
		// narrow it — every legacy agent must see exactly the panels it saw before.
		const undeclared = toolNamesFor({ surfaces: [], runtime: null, workflow: null, boardColumns: [] });
		expect(connectorPolicyOf(drive, undeclared).allowed).toBe(true);
		expect(connectorPolicyOf(workdrive, undeclared).allowed).toBe(true);
	});

	// Gmail is deliberately NOT gated here. `find_confirmation_link` is excluded from
	// CREATOR_SELECTABLE_TOOLS and granted at runtime by the owner's permissions.email flag; a
	// second answer computed from the tool allowlist would either soften that gate or contradict it.
	it("reports Gmail as reachable whatever the allowlist says, because its gate is elsewhere", () => {
		expect(connectorPolicyOf(gmail, declaring("tmux_send_keys"))).toMatchObject({ allowed: true, reason: "permission" });
		expect(connectorPolicyOf(gmail, declaring("search_knowledge"))).toMatchObject({ allowed: true, reason: "permission" });
	});

	// A connector WITH tools is the ordinary case, and its verdict must be the tool gate's verdict
	// — this reports it per connector, it does not decide it a second time.
	it("judges a tool-bearing connector on its own tools", () => {
		expect(connectorPolicyOf(github, declaring("github_list_issues"))).toMatchObject({ allowed: true, reason: "tools" });
		expect(connectorPolicyOf(github, declaring("search_knowledge"))).toMatchObject({ allowed: false, reason: "no_tools" });
	});

	it("returns every connector, not only the allowed ones", () => {
		const policy = resolveConnectorPolicy(CONNECTORS, declaring("tmux_send_keys"));
		expect(policy).toHaveLength(CONNECTORS.length);
		expect(policy.filter((p) => !p.allowed).length).toBeGreaterThan(0);
	});

	// Keyed on the DECLARED grant model, never on the two ids — a third file connector is gated by
	// declaring itself, which is the only reason putting these in the registry bought anything.
	it("gates any instance-resource connector with no tools, not a hardcoded pair", () => {
		const invented: Connector = {
			id: "acme_files",
			label: "Acme Files",
			auth: "oauth",
			scopes: { read: true, write: false },
			grantModel: "instance-resource",
			tools: [],
		};
		expect(connectorPolicyOf(invented, declaring("tmux_send_keys")).allowed).toBe(false);
		expect(connectorPolicyOf(invented, declaring("read_knowledge")).allowed).toBe(true);
	});
});

describe("connectorRefusal — the sentence a 403 says", () => {
	const operator = declaring("tmux_capture_pane", "tmux_send_keys");

	it("says nothing when the connector is allowed, so a caller can append it unconditionally", () => {
		expect(connectorRefusal(connectorPolicyOf(drive, declaring("search_knowledge")))).toBeNull();
		expect(connectorRefusal(connectorPolicyOf(github, declaring("github_list_issues")))).toBeNull();
	});

	// The fix is a capability edit and the owner has to know WHICH field, so the tools are named.
	// "Declare a knowledge tool" is advice; "declare search_knowledge" is an instruction.
	it("names the tools that would fix it, not the concept", () => {
		const msg = connectorRefusal(connectorPolicyOf(drive, operator));
		expect(msg).toContain("Google Drive");
		expect(msg).toContain("search_knowledge");
		expect(msg).toMatch(/knowledge base/);
	});

	it("explains a tool-bearing connector by its own tools", () => {
		const msg = connectorRefusal(connectorPolicyOf(github, declaring("search_knowledge")));
		expect(msg).toContain("GitHub");
		expect(msg).toContain("github_list_issues");
	});

	// Gmail's reach is the owner's permissions.email flag, which this rule deliberately does not
	// evaluate — so it must never produce a refusal that implies it did.
	it("never refuses a permission-gated connector", () => {
		expect(connectorRefusal(connectorPolicyOf(gmail, operator))).toBeNull();
	});
});
