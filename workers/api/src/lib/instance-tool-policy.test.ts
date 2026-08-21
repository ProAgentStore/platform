import { describe, expect, it } from "vitest";
import {
	allToolPolicyInputs,
	EMAIL_PERMISSION_TOOLS,
	explainRefusal,
	explainWriteConsent,
	readDisabledTools,
	resolveToolPolicy,
	writeConsentOf,
} from "./instance-tool-policy.js";
import { toolNamesFor } from "../agent-do-tools.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

const caps = (over: Partial<AgentCapabilities>): AgentCapabilities =>
	({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;

/** A stand-in registry so these assertions don't move when the real catalog grows. */
const TOOLS = [
	{ name: "repo_tree", connector: "repo-local", scope: "read" as const, description: "d", jsonSchema: {} },
	{ name: "repo_read_file", connector: "repo-local", scope: "read" as const, description: "d", jsonSchema: {} },
	{ name: "tmux_run_command", connector: "tmux", scope: "write" as const, description: "d", jsonSchema: {} },
	{ name: "tmux_capture_pane", connector: "tmux", scope: "read" as const, description: "d", jsonSchema: {} },
	{ name: "sheets_read", connector: "google_sheets", scope: "read" as const, description: "d", jsonSchema: {} },
];
const byName = (p: ReturnType<typeof resolveToolPolicy>, n: string) => p.find((t) => t.name === n)!;

describe("resolveToolPolicy — the declared gate", () => {
	const declared = caps({ tools: ["repo_tree", "repo_read_file"] });

	it("allows exactly the declared tools", () => {
		const p = resolveToolPolicy(declared, [], TOOLS);
		expect(byName(p, "repo_tree").allowed).toBe(true);
		expect(byName(p, "repo_read_file").allowed).toBe(true);
	});

	// The hole this whole module exists to close: owning the instance used to be authority to
	// run anything in the registry, so a read-only agent's instance could still be driven to
	// read the owner's terminals or spreadsheets from the REST invoker / MCP.
	it("refuses every undeclared tool, reads included", () => {
		const p = resolveToolPolicy(declared, [], TOOLS);
		for (const n of ["tmux_run_command", "tmux_capture_pane", "sheets_read"]) {
			expect(byName(p, n).allowed).toBe(false);
			expect(byName(p, n).reason).toBe("not_declared");
		}
	});

	it("reports on EVERY tool, not just the allowed ones — 'what can it do' needs the negatives", () => {
		expect(resolveToolPolicy(declared, [], TOOLS)).toHaveLength(TOOLS.length);
	});

	it("carries scope through so a caller can assert an instance has no write tool at all", () => {
		const p = resolveToolPolicy(declared, [], TOOLS);
		expect(p.filter((t) => t.allowed && t.scope === "write")).toEqual([]);
	});
});

describe("resolveToolPolicy — the owner's off-switch", () => {
	const declared = caps({ tools: ["repo_tree", "repo_read_file"] });

	it("blocks a declared tool the owner switched off, and says why", () => {
		const p = resolveToolPolicy(declared, ["repo_read_file"], TOOLS);
		expect(byName(p, "repo_read_file").allowed).toBe(false);
		expect(byName(p, "repo_read_file").disabled).toBe(true);
		expect(byName(p, "repo_read_file").reason).toBe("disabled_by_owner");
		expect(byName(p, "repo_tree").allowed).toBe(true);
	});

	// An off-switch naming a tool the agent never had must not be reported as "the owner
	// disabled this" — it was already refused, and mislabelling it hides the real reason.
	it("keeps not_declared as the reason when a disabled name was never declared anyway", () => {
		const p = resolveToolPolicy(declared, ["sheets_read"], TOOLS);
		expect(byName(p, "sheets_read").allowed).toBe(false);
		expect(byName(p, "sheets_read").reason).toBe("not_declared");
	});

	it("an agent with everything declared can still be reduced to nothing by the owner", () => {
		const all = caps({ tools: TOOLS.map((t) => t.name) });
		const p = resolveToolPolicy(all, TOOLS.map((t) => t.name), TOOLS);
		expect(p.every((t) => !t.allowed)).toBe(true);
	});
});

describe("resolveToolPolicy — agents that declare nothing", () => {
	// A legacy agent with no declared list falls back to the per-surface default (FULL), which
	// deliberately contains NO connector tools — a legacy agent never had them in chat. The
	// REST invoker used to hand them out anyway, which is precisely the gap being closed, so
	// the gate matches chat rather than preserving the invoker's wider reach.
	//
	// This is a real behaviour change for `call_instance_tool` against a legacy agent: to use
	// a connector tool there, the agent must now DECLARE it (capabilities.tools). That is the
	// point — "which tools does this agent have" should have one answer, not one per surface.
	it("gives a legacy agent the same connector-free default the chat runtime gives it", () => {
		const legacy = caps({});
		const p = resolveToolPolicy(legacy, [], TOOLS);
		expect(byName(p, "sheets_read").allowed).toBe(false);
		expect(byName(p, "tmux_run_command").allowed).toBe(false);
	});

	it("still lets the owner switch off whatever a legacy agent does have", () => {
		const legacy = caps({});
		const withKb = [{ name: "search_knowledge", scope: "read" as const, description: "d", jsonSchema: {} }];
		expect(resolveToolPolicy(legacy, [], withKb)[0].allowed).toBe(true);
		const off = resolveToolPolicy(legacy, ["search_knowledge"], withKb);
		expect(off[0].allowed).toBe(false);
		expect(off[0].reason).toBe("disabled_by_owner");
	});
});

// ── The write-consent gate is REPORTED, never merged (#351) ──────────────────────────────
//
// The bug: four `terminal_*` write tools on a fresh instance read `allowed:true, reason:"ok"`,
// and the only way the agent could learn they were consent-gated was to make the failed
// side-effecting call. `allowed` still answers "is this tool part of this agent"; `writeConsent`
// answers "will the consent machinery refuse it anyway", and the two stay separate.
describe("resolveToolPolicy — writeConsent", () => {
	const all = caps({ tools: TOOLS.map((t) => t.name) });

	it("reports a declared, enabled write tool as consent-REQUIRED when nothing is granted", () => {
		const p = resolveToolPolicy(all, [], TOOLS, []);
		const t = byName(p, "tmux_run_command");
		expect(t.allowed).toBe(true); // unchanged: it IS one of this agent's tools
		expect(t.reason).toBe("ok"); // unchanged: no existing consumer moves
		expect(t.writeConsent).toBe("required"); // and it would still be refused
	});

	it("reports it granted once the owner has consented to that connector", () => {
		expect(byName(resolveToolPolicy(all, [], TOOLS, ["tmux"]), "tmux_run_command").writeConsent).toBe("granted");
	});

	// The trap that made this ticket: the instance's SURFACE is `tmux` but the tools it actually
	// gets come from the `terminal` connector, so consent granted against the surface name looks
	// right and does nothing. Consent is matched on the connector the listing already reports.
	it("matches consent on the tool's connector, not on a similarly named neighbour", () => {
		const tools = [{ name: "terminal_new_target", connector: "terminal", scope: "write" as const, description: "d", jsonSchema: {} }];
		const caps2 = caps({ tools: ["terminal_new_target"] });
		expect(resolveToolPolicy(caps2, [], tools, ["tmux"])[0].writeConsent).toBe("required");
		expect(resolveToolPolicy(caps2, [], tools, ["terminal"])[0].writeConsent).toBe("granted");
	});

	it("says n/a for a plain read tool — there is no gate to be refused by", () => {
		expect(byName(resolveToolPolicy(all, [], TOOLS, []), "repo_tree").writeConsent).toBe("n/a");
		expect(byName(resolveToolPolicy(all, [], TOOLS, ["repo-local"]), "repo_tree").writeConsent).toBe("n/a");
	});
});

// ── Tools an OWNER PERMISSION grants, which no declaration can (#721) ────────────────────
//
// The defect: `find_confirmation_link` reads the owner's Gmail and is excluded from
// CREATOR_SELECTABLE_TOOLS on purpose, so the listing — which resolved `toolNamesFor` and nothing
// else — could only ever report it `not_declared`, INCLUDING on the one instance in the account
// where `permissions.email` was actually on. The console then dropped the row (`listedTools` keeps
// `allowed || disabled`), so the panel captioned "Everything this agent is allowed to do" omitted
// the only tool that reads the owner's mail.
describe("resolveToolPolicy — grantedByPermission", () => {
	const legacy = caps({});
	const row = (grantedByPermission: readonly string[]) =>
		resolveToolPolicy(legacy, [], allToolPolicyInputs(), [], grantedByPermission).find((t) => t.name === "find_confirmation_link");

	it("reports the mailbox reader as this agent's once the owner has granted the permission", () => {
		const t = row(EMAIL_PERMISSION_TOOLS);
		expect(t?.allowed).toBe(true);
		expect(t?.reason).toBe("ok");
		// The reach is what makes the omission matter: it is the field `toolScopeSummary` reads
		// before asserting an agent reaches nothing outside the platform.
		expect(t?.reach).toBe("internet");
	});

	it("says needs_permission — never not_declared — when the permission is off", () => {
		const t = row([]);
		expect(t?.allowed).toBe(false);
		// "not one of this agent's tools" is the false statement being removed: it IS this agent's,
		// one checkbox away, and the checkbox sits directly under the panel that said otherwise.
		expect(t?.reason).toBe("needs_permission");
		expect(t?.reason).not.toBe("not_declared");
	});

	it("still lets the owner switch it off once granted — the row is a real switch, not a label", () => {
		const t = resolveToolPolicy(legacy, ["find_confirmation_link"], allToolPolicyInputs(), [], EMAIL_PERMISSION_TOOLS).find(
			(x) => x.name === "find_confirmation_link",
		);
		expect(t?.disabled).toBe(true);
		expect(t?.reason).toBe("disabled_by_owner");
	});

	it("grants nothing else — a permission is not a second declaration route", () => {
		const granted = resolveToolPolicy(legacy, [], allToolPolicyInputs(), [], EMAIL_PERMISSION_TOOLS);
		const plain = resolveToolPolicy(legacy, [], allToolPolicyInputs(), [], []);
		const differ = granted.filter((t, i) => t.allowed !== plain[i].allowed).map((t) => t.name);
		expect(differ).toEqual(["find_confirmation_link"]);
	});

	// THE test, and the reason this ticket is not "hide the Gmail checkbox".
	//
	// `agent-think.ts` builds the executable set as `toolNamesFor(capabilities)` plus
	// `find_confirmation_link` when `state.permissions?.email === true` — on the FLAG ALONE,
	// whatever `capabilities.tools` says. So narrowing the checkbox to agents that declare a
	// `gmail_*` tool would remove the only off-switch for a capability that stays live. This
	// asserts the containment the resolver's own header names, extended to permission grants: the
	// listing must never report as unrunnable a tool the chat runtime would execute. It fails on
	// the tempting fix, which is what it is for.
	const SHAPES: Array<[string, AgentCapabilities]> = [
		["declares nothing (FULL)", caps({})],
		["repo surface", caps({ surfaces: ["repo"] })],
		["coding surface", caps({ surfaces: ["coding"] })],
		["declared allowlist with no gmail tool", caps({ tools: ["repo_tree", "search_knowledge"] })],
		["declared allowlist WITH gmail tools", caps({ tools: ["gmail_search", "gmail_read_message"] })],
	];
	it.each(SHAPES)("everything the chat runtime would run for %s is allowed:true here, flag on and off", (_label, capabilities) => {
		for (const emailEnabled of [false, true]) {
			// Exactly agent-think.ts's two lines, re-derived rather than restated.
			const runtime = toolNamesFor(capabilities);
			if (emailEnabled) runtime.add("find_confirmation_link");

			const listed = new Map(
				resolveToolPolicy(capabilities, [], allToolPolicyInputs(), [], emailEnabled ? EMAIL_PERMISSION_TOOLS : []).map((t) => [t.name, t]),
			);
			for (const name of runtime) {
				const entry = listed.get(name);
				expect(entry, `${name} runs in chat but is absent from GET /v1/instances/:id/tools`).toBeDefined();
				expect(entry?.allowed, `${name} runs in chat (email=${emailEnabled}) but the listing reports it as not runnable`).toBe(true);
			}
		}
	});
});

// A listing that reads only the DECLARED scope cannot see a gate that runs per call. Both of
// today's per-call gates are derived from the tool's own declaration rather than a name list.
describe("writeConsentOf — the gates that decide per call, not per tool", () => {
	// #307: `http_request` is honestly scope:"read" (a GET must not need write consent), and
	// executeHttpRequest asks for consent on the RESOLVED method. So the tool runs, and some of
	// its calls don't — which is neither "granted" nor "required".
	const httpRequest = {
		name: "http_request",
		connector: "http",
		scope: "read" as const,
		description: "d",
		jsonSchema: { properties: { method: { type: "string" }, url: { type: "string" } } },
	};

	it("a caller-chosen HTTP method reads per_call until the connector is granted", () => {
		expect(writeConsentOf(httpRequest, new Set())).toBe("per_call");
		expect(writeConsentOf(httpRequest, new Set(["http"]))).toBe("granted");
	});

	// #262: the `mcp` write row is only the OUTER gate — the remote server is a tool input, so
	// reach is granted per (endpoint, tool). Reporting "granted" off the connector row alone
	// would over-report in exactly the direction this ticket is about.
	const mcpCall = { name: "mcp_call_tool", connector: "mcp", scope: "write" as const, description: "d", jsonSchema: {} };

	it("outbound MCP stays per_call even with connector consent granted", () => {
		expect(writeConsentOf(mcpCall, new Set())).toBe("required");
		expect(writeConsentOf(mcpCall, new Set(["mcp"]))).toBe("per_call");
	});
});

describe("explainWriteConsent", () => {
	it("names the connector to grant, and says nothing when nothing is in the way", () => {
		expect(explainWriteConsent({ name: "terminal_new_target", connector: "terminal", writeConsent: "required" })).toContain("terminal");
		expect(explainWriteConsent({ name: "http_request", connector: "http", writeConsent: "per_call" })).toContain("changes anything");
		expect(explainWriteConsent({ name: "mcp_call_tool", connector: "mcp", writeConsent: "per_call" })).toContain("per server");
		expect(explainWriteConsent({ name: "repo_tree", connector: "repo-local", writeConsent: "n/a" })).toBeNull();
		expect(explainWriteConsent({ name: "tmux_run_command", connector: "tmux", writeConsent: "granted" })).toBeNull();
	});
});

describe("readDisabledTools", () => {
	it("reads the list, and survives junk without throwing", () => {
		expect(readDisabledTools(JSON.stringify({ disabledTools: ["a", "b"] }))).toEqual(["a", "b"]);
		expect(readDisabledTools(JSON.stringify({ disabledTools: "nope" }))).toEqual([]);
		expect(readDisabledTools(JSON.stringify({ disabledTools: [1, "a", null] }))).toEqual(["a"]);
		expect(readDisabledTools("{not json")).toEqual([]);
		expect(readDisabledTools(null)).toEqual([]);
		expect(readDisabledTools(undefined)).toEqual([]);
	});
});

describe("explainRefusal", () => {
	it("distinguishes 'never had it' from 'you turned it off' — they need different fixes", () => {
		expect(explainRefusal("x", "not_declared")).toContain("not one of this agent's tools");
		expect(explainRefusal("x", "disabled_by_owner")).toContain("switched off");
		expect(explainRefusal("x", "disabled_by_owner")).toContain("Settings → Tools");
	});

	// The third fix, and it is a different one again: not "edit the agent" and not "turn it back
	// on", but "tick the permission". A sentence that sent the owner to the tool switches would be
	// sending them to a row that is not there yet.
	it("sends a permission-gated refusal to the permission, not to the tool list", () => {
		expect(explainRefusal("find_confirmation_link", "needs_permission")).toContain("permission");
		expect(explainRefusal("find_confirmation_link", "needs_permission")).toContain("Permissions & Connections");
		expect(explainRefusal("find_confirmation_link", "needs_permission")).not.toContain("not one of this agent's tools");
	});
});
