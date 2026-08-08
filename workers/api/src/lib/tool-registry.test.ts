import { describe, expect, it } from "vitest";
import { getRegistryTool, registryConnectorGroups, registryToolDefs, registryToolNameSet, registryTools, runRegistryTool } from "./tool-registry.js";
import type { Env } from "../types.js";

const envNoGithub = {} as unknown as Env; // githubAppConfigured() → false

/** Env whose consent lookup returns `granted` for every (instance,connector,write). */
function envWithConsent(granted: boolean): Env {
	return {
		DB: {
			prepare(_sql: string) {
				return { bind() { return { first: async () => (granted ? { ok: 1 } : null) }; } };
			},
		},
	} as unknown as Env;
}

describe("tool registry", () => {
	it("registers the GitHub connector tools", () => {
		const names = registryToolNameSet();
		expect(names.has("github_workflow_runs")).toBe(true);
		expect(names.has("github_list_issues")).toBe(true);
		expect(names.has("github_read_issue")).toBe(true);
	});

	it("exposes ToolDef-shaped definitions (name/description/jsonSchema, verbatim pass-through)", () => {
		const def = registryToolDefs().find((d) => d.name === "github_workflow_runs");
		// The registry now carries a draft-07 jsonSchema, passed through verbatim (no
		// rebuild from an ad-hoc parameters map). Required fields live in `required`.
		expect(def?.jsonSchema.type).toBe("object");
		expect(def?.jsonSchema.properties.repo.type).toBe("string");
		expect(def?.jsonSchema.required).toContain("repo");
		expect(typeof def?.description).toBe("string");
		// It's the SAME schema object the tool declares — a true pass-through.
		expect(def?.jsonSchema).toBe(getRegistryTool("github_workflow_runs")?.jsonSchema);
	});

	it("every registry tool declares a jsonSchema and a tier; connector-tier tools name a connector", () => {
		for (const t of registryTools()) {
			expect(t.jsonSchema.type).toBe("object");
			expect(t.jsonSchema.properties).toEqual(expect.any(Object));
			expect(["base", "standard", "runtime", "connector"]).toContain(t.tier);
			// Connector-provided tools name their connector; first-party tools (run_pipeline #97,
			// standard-tier step tools #96) do not.
			if (t.tier === "connector") expect(typeof t.connector).toBe("string");
			else expect(t.connector).toBeUndefined();
		}
	});

	it("groups tools by connector for the catalog", () => {
		const gh = registryConnectorGroups().find((g) => g.connector === "github");
		expect(gh?.tools).toContain("github_read_issue");
	});

	it("unknown tool → failure, never throws", async () => {
		const r = await runRegistryTool("nope", { env: envNoGithub }, {});
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/unknown tool/i);
	});

	it("github tool with GitHub not connected → clear error, no throw", async () => {
		const r = await runRegistryTool("github_workflow_runs", { env: envNoGithub, userId: "u1" }, { repo: "owner/name" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/not connected|not configured/i);
	});

	it("getRegistryTool returns the tool with its scope", () => {
		expect(getRegistryTool("github_workflow_runs")?.scope).toBe("read");
		expect(getRegistryTool("github_create_issue")?.scope).toBe("write");
		expect(getRegistryTool("does_not_exist")).toBeUndefined();
	});

	it("blocks a WRITE tool without consent (fail-closed)", async () => {
		const r = await runRegistryTool("github_create_issue", { env: envWithConsent(false), userId: "u1", instanceId: "i1" }, { repo: "o/n", title: "hi" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/isn't permitted|not permitted|consent/i);
	});

	it("blocks a WRITE tool when there's no instance context (fail-closed)", async () => {
		const r = await runRegistryTool("github_create_issue", { env: envWithConsent(true), userId: "u1" }, { repo: "o/n", title: "hi" });
		expect(r.success).toBe(false);
	});

	it("passes the consent gate for a WRITE tool when granted (then fails later on not-connected)", async () => {
		const r = await runRegistryTool("github_create_issue", { env: envWithConsent(true), userId: "u1", instanceId: "i1" }, { repo: "o/n", title: "hi" });
		// Gate passed → handler ran → GitHub not configured in this env → its own error,
		// NOT the consent error.
		expect(r.content).not.toMatch(/isn't permitted/i);
		expect(r.content).toMatch(/not connected|not configured/i);
	});
});

describe("tmux connector", () => {
	it("registers the tmux tools with correct scopes", () => {
		const names = registryToolNameSet();
		expect(names.has("tmux_list_sessions")).toBe(true);
		expect(names.has("tmux_capture_pane")).toBe(true);
		expect(names.has("tmux_run_command")).toBe(true);
		expect(names.has("tmux_send_keys")).toBe(true);
		expect(getRegistryTool("tmux_list_sessions")?.scope).toBe("read");
		expect(getRegistryTool("tmux_capture_pane")?.scope).toBe("read");
		expect(getRegistryTool("tmux_run_command")?.scope).toBe("write");
		expect(getRegistryTool("tmux_send_keys")?.scope).toBe("write");
		expect(getRegistryTool("tmux_new_session")?.scope).toBe("write");
		expect(getRegistryTool("tmux_kill_session")?.scope).toBe("write");
	});

	it("groups tmux tools under the tmux connector for the catalog", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "tmux");
		expect(grp?.tools).toContain("tmux_list_sessions");
		expect(grp?.tools).toContain("tmux_run_command");
	});

	it("a READ tool with no runner connected → clear error, no throw", async () => {
		const r = await runRegistryTool("tmux_list_sessions", { env: envNoGithub, userId: "u1", instanceId: "i1" }, {});
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/runner|pags up/i);
	});

	it("a WRITE tool without consent is blocked before touching the runner (fail-closed)", async () => {
		const r = await runRegistryTool("tmux_run_command", { env: envWithConsent(false), userId: "u1", instanceId: "i1" }, { session: "dev", command: "ls" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/isn't permitted|not permitted|consent/i);
	});
});

describe("terminal connector", () => {
	it("registers the generic local terminal tools", () => {
		const names = registryToolNameSet();
		expect(names.has("terminal_list_targets")).toBe(true);
		expect(names.has("terminal_capture")).toBe(true);
		expect(names.has("terminal_run_command")).toBe(true);
		expect(getRegistryTool("terminal_run_command")?.connector).toBe("terminal");
		expect(getRegistryTool("terminal_run_command")?.scope).toBe("write");
	});

	it("groups terminal tools under the terminal connector for the catalog", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "terminal");
		expect(grp?.tools).toContain("terminal_list_targets");
		expect(grp?.tools).toContain("terminal_run_command");
	});
});

describe("meta connector (WhatsApp + Instagram)", () => {
	it("registers the meta write tools", () => {
		const names = registryToolNameSet();
		expect(names.has("whatsapp_send_message")).toBe(true);
		expect(names.has("instagram_send_dm")).toBe(true);
		expect(getRegistryTool("whatsapp_send_message")?.scope).toBe("write");
		expect(getRegistryTool("instagram_send_dm")?.scope).toBe("write");
	});

	it("groups meta tools under the meta connector", () => {
		const grp = registryConnectorGroups().find((g) => g.connector === "meta");
		expect(grp?.tools).toContain("whatsapp_send_message");
	});

	it("WhatsApp send is write-gated without consent (fail-closed)", async () => {
		const r = await runRegistryTool("whatsapp_send_message", { env: envWithConsent(false), userId: "u1", instanceId: "i1" }, { to: "+14155552671", text: "hi" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/isn't permitted|consent/i);
	});

	it("with consent but Meta not configured → clear not-configured error (no throw)", async () => {
		const r = await runRegistryTool("whatsapp_send_message", { env: envWithConsent(true), userId: "u1", instanceId: "i1" }, { to: "+14155552671", text: "hi" });
		expect(r.content).not.toMatch(/isn't permitted/i);
		expect(r.content).toMatch(/not configured/i);
	});

	it("Instagram DM with consent but not configured → clear not-configured error", async () => {
		const r = await runRegistryTool("instagram_send_dm", { env: envWithConsent(true), userId: "u1", instanceId: "i1" }, { recipient_id: "123", text: "hi" });
		expect(r.content).toMatch(/not configured/i);
	});
});

/** Consent granted to exactly ONE instance id; records which id was actually asked about. */
function envConsentOnlyFor(instanceId: string): { env: Env; asked: string[] } {
	const asked: string[] = [];
	const env = {
		DB: {
			prepare(_sql: string) {
				return {
					bind(...args: unknown[]) {
						asked.push(String(args[0]));
						return { first: async () => (args[0] === instanceId ? { ok: 1 } : null) };
					},
				};
			},
		},
	} as unknown as Env;
	return { env, asked };
}

describe("execution authority at the consent gate (#185)", () => {
	const WRITE_TOOL = "github_create_issue";
	const SUPERVISOR = "sup-1";
	const SUBORDINATE = "sub-1";

	it("DOWN-LENDING is refused: a consented supervisor cannot enable a write for an unconsented subordinate", async () => {
		// The exact bypass this rule exists to stop — wire a low-trust agent beneath a
		// high-trust one and it would inherit reach by configuration alone.
		const { env, asked } = envConsentOnlyFor(SUPERVISOR);
		const r = await runRegistryTool(WRITE_TOOL, { env, userId: "u1", instanceId: SUBORDINATE, onBehalfOf: SUPERVISOR }, {});
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/isn't permitted|not permitted|consent/i);
		// Consent was evaluated against the EXECUTOR, never the asker.
		expect(asked).toContain(SUBORDINATE);
		expect(asked).not.toContain(SUPERVISOR);
	});

	it("UP-BORROWING is refused: a supervisor gains nothing from a consented subordinate", async () => {
		const { env, asked } = envConsentOnlyFor(SUBORDINATE);
		const r = await runRegistryTool(WRITE_TOOL, { env, userId: "u1", instanceId: SUPERVISOR, onBehalfOf: SUBORDINATE }, {});
		expect(r.success).toBe(false);
		expect(asked).toContain(SUPERVISOR);
		expect(asked).not.toContain(SUBORDINATE);
	});

	it("the subordinate's OWN consent still works — containment is not a blanket denial", async () => {
		const { env } = envConsentOnlyFor(SUBORDINATE);
		const r = await runRegistryTool(WRITE_TOOL, { env, userId: "u1", instanceId: SUBORDINATE, onBehalfOf: SUPERVISOR }, {});
		// Past the consent gate (it fails later on not-connected), which is the point.
		expect(r.content).not.toMatch(/isn't permitted/i);
	});
});

/**
 * The capability-constraint gate (#404) — asserted HERE because the placement is the deliverable.
 *
 * Every other declared constraint on this platform is applied by withholding a tool before
 * dispatch is reached, which is why `optionsFor` is consulted in four places and none of them is
 * this function. A tool that serves several resources (`terminal_list_targets` reaches tmux, kitty
 * AND iTerm2) cannot be constrained that way, so the refusal has to happen at the dispatcher.
 */
describe("capability-constraint gate (#404)", () => {
	/** A DB that answers the constraint join with a tmux-only ceiling, and consent with a grant. */
	const envTmuxOnly = (asked: string[] = []) =>
		({
			DB: {
				prepare(sql: string) {
					const constraintQuery = sql.includes("agent_instances");
					return {
						bind(...args: unknown[]) {
							if (constraintQuery) asked.push(String(args[0]));
							return {
								first: async () =>
									constraintQuery
										? { agent_config: JSON.stringify({ capabilities: { surfaceOptions: { terminal: { backends: ["tmux"] } } } }), instance_config: "{}" }
										: { ok: 1 },
							};
						},
					};
				},
			},
		}) as unknown as Env;

	it("refuses an out-of-scope ARGUMENT, with a message naming the constraint that applied", async () => {
		const r = await runRegistryTool("terminal_capture", { env: envTmuxOnly(), userId: "u1", instanceId: "i1" }, { target: "x", backend: "iterm2" });
		expect(r.success).toBe(false);
		expect(r.content).toContain("`terminal.backends` (tmux)");
	});

	it("resolves against the EXECUTOR, never the asker — a supervisor cannot widen a subordinate", async () => {
		// Same rule as consent (#185): if the ceiling followed the asker, wiring a narrow agent
		// beneath a wide one would widen it by configuration alone.
		const asked: string[] = [];
		const r = await runRegistryTool("terminal_capture", { env: envTmuxOnly(asked), userId: "u1", instanceId: "sub-1", onBehalfOf: "sup-1" }, { target: "kitty:3" });
		expect(r.success).toBe(false);
		expect(asked).toEqual(["sub-1"]);
	});

	it("costs nothing for a connector with no constraint vocabulary — no lookup at all", async () => {
		// `env` here has NO DB. A tmux-connector tool reaching the gate would throw on it; instead
		// it runs and fails on the missing runner, proving the lookup was skipped.
		const r = await runRegistryTool("tmux_list_sessions", { env: {} as unknown as Env, userId: "u1", instanceId: "i1" }, {});
		expect(r.content).toMatch(/runner|pags up/i);
	});

	/**
	 * #441: the gate used to be SKIPPED when the authority could not be resolved, which made it the
	 * only permission-shaped check in this function that opens rather than closes on a blank. Both
	 * neighbours fail closed — write-consent passes an empty authority to `hasConsent`, which
	 * refuses, and the constraint read itself refuses when the store throws. These two assert the
	 * posture rather than leaving it to an `if`, because "it opens" and "it closes" both look like
	 * working code, and the #402 disclosure is what a call path that forgot an id costs.
	 */
	describe("no resolvable authority → refused, like every neighbouring gate", () => {
		/** A DB whose constraint join matches NOTHING — a deleted instance, or an agent id. */
		const envNoRow = () =>
			({
				DB: {
					prepare: () => ({ bind: () => ({ first: async () => null }) }),
				},
			}) as unknown as Env;

		it("refuses a constrained connector's tool when the ctx carries no instance at all", async () => {
			// `env` has no DB: reaching the lookup would throw, and reaching the HANDLER would fail on
			// the missing runner. Neither happens — the gate answers first, which is the deliverable.
			const r = await runRegistryTool("terminal_list_targets", { env: {} as unknown as Env, userId: "u1" }, {});
			expect(r.success).toBe(false);
			expect(r.content).toMatch(/could not be resolved/i);
			expect(r.content).toMatch(/rather than run unconstrained/i);
		});

		it("refuses an authority that is an AGENT id rather than an instance id", async () => {
			// The live second door: the agent-template chat surfaces pass `state.agentId` into
			// `instanceId`, so the join matches no row. "No ceiling declared" and "no such row" were
			// the same `undefined`, and the ceiling silently stopped applying on that surface while
			// write-consent, on the identical input, refused.
			const r = await runRegistryTool("terminal_capture", { env: envNoRow(), userId: "u1", instanceId: "agent_kitty_operator" }, { target: "kitty:1" });
			expect(r.success).toBe(false);
			expect(r.content).toMatch(/could not be resolved/i);
		});

		it("but a row that EXISTS and declares nothing still runs — that is every agent today", async () => {
			// The regression this whole change has to avoid. Reaching the handler (and failing there
			// on the absent runner) is the proof that the gate let it through.
			const declaresNothing = {
				DB: { prepare: () => ({ bind: () => ({ first: async () => ({ agent_config: "{}", instance_config: "{}" }) }) }) },
			} as unknown as Env;
			const r = await runRegistryTool("terminal_list_targets", { env: declaresNothing, userId: "u1", instanceId: "i1" }, {});
			expect(r.content).not.toMatch(/could not be resolved/i);
			expect(r.content).toMatch(/runner|pags up/i);
		});
	});
});
