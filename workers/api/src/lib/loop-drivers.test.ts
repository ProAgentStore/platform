import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LOOP_DRIVER, loopDriverFor, LOOP_DRIVER_IDS } from "./loop-drivers.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import type { Env } from "../types.js";

const caps = (workflow: string | null): AgentCapabilities =>
	({ surfaces: [], runtime: null, workflow, tools: undefined } as unknown as AgentCapabilities);

describe("loopDriverFor — the ONE Loop dispatches on what the agent DECLARES (#210)", () => {
	it("defaults to looping the chat", () => {
		// The right driver for any agent whose work happens through its own tools — a pipeline
		// agent, a doc agent, a connector agent.
		expect(loopDriverFor(caps(null)).id).toBe("chat");
		expect(loopDriverFor(undefined).id).toBe("chat");
		expect(loopDriverFor({} as AgentCapabilities).id).toBe("chat");
	});

	it("routes a coding agent to the engine, not to its own chat", () => {
		// The bug this replaces: the owner's Loop button hardcoded AGENT_LOOP, so on a Repo Coder
		// — whose chat declares drive:false and therefore has NO write tools — it read the repo in
		// a circle and never touched the engine. The supervisor path dispatched correctly; the
		// human's did not.
		expect(loopDriverFor(caps("CODING_SESSION")).id).toBe("coding");
	});

	it("falls back to the chat loop for a workflow with no driver, rather than refusing", () => {
		// JOB_APPLY and BROWSER_TASK need a URL, not an objective, so they have no entry yet.
		// "This agent cannot be looped" would be strictly worse than looping its tools.
		expect(loopDriverFor(caps("JOB_APPLY")).id).toBe(DEFAULT_LOOP_DRIVER.id);
		expect(loopDriverFor(caps("SOMETHING_NEW")).id).toBe(DEFAULT_LOOP_DRIVER.id);
	});

	it("every driver id is distinct — a duplicate would silently shadow one", () => {
		expect(new Set(LOOP_DRIVER_IDS).size).toBe(LOOP_DRIVER_IDS.length);
	});
});

/**
 * Env stub recording the writes + which Workflow binding was created.
 *
 * It models a CONNECTED runner by default (`runnerOnline`), because that is the state the coding
 * driver now reads before it does anything: connectivity is checked first so a refusal can name
 * the real blocker instead of blaming the runner (#271). A stub with no relay would make every
 * coding test assert against the offline path by accident.
 */
function stubEnv(opts: { repos?: unknown[]; session?: unknown; claimTaken?: boolean; runnerOnline?: boolean; hasRuntimeRow?: boolean } = {}) {
	const sql: string[] = [];
	const created: Array<{ binding: string; params: Record<string, unknown> }> = [];
	const runnerOnline = opts.runnerOnline ?? true;
	const hasRuntimeRow = opts.hasRuntimeRow ?? true;
	const runtimeRow = hasRuntimeRow
		? { instance_id: "i1", endpoint_url: "https://runner.local", token_plaintext: "t", runner_node: "macbook", runner_version: "0.4.32", last_seen_at: "2026-08-06 06:00:00" }
		: null;
	// Stateful: `getActiveSessionForRepo` must read null BEFORE the driver opens one and the row
	// afterwards, or the on-demand-open path can never be exercised at all.
	let sessionRow: unknown = opts.session ?? null;
	const wf = (binding: string) => ({ create: vi.fn(async (a: { params: Record<string, unknown> }) => { created.push({ binding, params: a.params }); return { id: "wf" }; }) });
	const env = {
		DB: {
			prepare(q: string) {
				sql.push(q);
				return {
					bind() {
						return {
							// A claim whose predicate matched nothing = somebody else holds it.
							async run() {
								if (q.includes("INSERT INTO coding_sessions")) sessionRow = { id: "csess_new", client_type: "claude", status: "active", repo_id: "r1", runner_node: "macbook" };
								return { meta: { changes: opts.claimTaken && q.includes("driver_id") ? 0 : 1 } };
							},
							async all() {
								if (q.includes("FROM instance_runtimes")) return { results: runtimeRow ? [runtimeRow] : [] };
								if (q.includes("FROM instance_runtime_nodes")) return { results: [] };
								return { results: opts.repos ?? [] };
							},
							async first() {
								// `agent_instances.config` is read for the node pin — an unpinned agent
								// routes to whichever machine actually holds a live socket.
								if (q.includes("FROM agent_instances")) return { config: null };
								if (q.includes("FROM instance_runtimes") || q.includes("FROM instance_runtime_nodes")) return runtimeRow;
								if (q.includes("FROM coding_repos")) return (opts.repos ?? [])[0] ?? null;
								return sessionRow;
							},
						};
					},
				};
			},
		},
		RELAY: {
			idFromName: (n: string) => n,
			get: () => ({
				async fetch(req: Request) {
					if (new URL(req.url).pathname === "/status") return new Response(JSON.stringify({ connected: runnerOnline }));
					return new Response(JSON.stringify({ ok: true }));
				},
			}),
		},
		AGENT_LOOP: wf("AGENT_LOOP"),
		CODING_SESSION: wf("CODING_SESSION"),
	} as unknown as Env;
	return { env, sql, created };
}

const base = { objective: "get the suite green", budgetId: "b1", depth: 0, instanceId: "i1", userId: "u1" };

describe("every driver opens an agent_loop_runs row — the fact that makes ONE button possible", () => {
	it("the chat driver does", async () => {
		// `check_delegation`, `subordinate_status` and the console's /loop/:runId poll all read
		// that table. If a driver skipped it, the UI would start a run it could never show, and a
		// supervisor would be handed a run id that resolves to nothing.
		const { env, sql, created } = stubEnv();
		const out = await loopDriverFor(caps(null)).start({ env, ...base });
		expect(out.ok).toBe(true);
		expect(sql.some((q) => q.includes("INSERT INTO agent_loop_runs"))).toBe(true);
		expect(created[0].binding).toBe("AGENT_LOOP");
	});

	it("the chat driver preserves delegated audit context", async () => {
		// `onBehalfOf` is audit-only, but losing it makes delegated chat-loop tools look like
		// ordinary subordinate actions in /trace. delegateToInstance now goes through this driver
		// too, so the driver must own that forwarding instead of one caller special-casing it.
		const { env, created } = stubEnv();
		await loopDriverFor(caps(null)).start({ env, ...base, onBehalfOf: "supervisor" });
		expect(created[0].params.onBehalfOf).toBe("supervisor");
	});

	it("the coding driver does, and threads the SAME run id into the Pilot", async () => {
		const { env, sql, created } = stubEnv({
			repos: [{ id: "r1", name: "fws/platform", instance_id: "i1", user_id: "u1", clone_status: "ready" }],
			session: { id: "s1", client_type: "claude", status: "active" },
		});
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out.ok).toBe(true);
		expect(sql.some((q) => q.includes("INSERT INTO agent_loop_runs"))).toBe(true);
		expect(created[0].binding).toBe("CODING_SESSION");
		// Same id, or the Pilot closes a different row than the one the caller is watching.
		if (out.ok) expect(created[0].params.loopRunId).toBe(out.runId);
	});
});

describe("the coding driver's preconditions are refusals, not crashes", () => {
	it("says what to do when the agent has no repo", async () => {
		const { env } = stubEnv({ repos: [] });
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out).toMatchObject({ ok: false, status: 409 });
		if (!out.ok) expect(out.error).toMatch(/no repository/i);
	});

	it("blames the runner ONLY when the runner is actually unreachable", async () => {
		// The runner really is down here, so `pags up` is the right advice and the machine is
		// named — a multi-machine user otherwise has to guess which laptop to wake.
		const { env } = stubEnv({ repos: [{ id: "r1", name: "fws/platform" }], session: null, runnerOnline: false });
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out).toMatchObject({ ok: false, status: 409 });
		if (!out.ok) expect(out.error).toMatch(/pags up/);
	});

	it("opens a session itself when none is live and the runner is connected", async () => {
		// #271. Requiring a live session made delegation SINGLE-USE — the Pilot ended the session
		// its own driver required, so the second goal always 409'd — and meant a supervisor could
		// not supervise unless a human first sat in the console opening one by hand.
		const { env, created } = stubEnv({ repos: [{ id: "r1", name: "fws/platform" }], session: null });
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out.ok).toBe(true);
		expect(created[0].binding).toBe("CODING_SESSION");
		// And it OWNS what it opened, so the Pilot cleans it up rather than leaking an idle session.
		expect(created[0].params.sessionOpenedByRun).toBe(true);
	});

	it("does not claim ownership of a session it merely reused", async () => {
		// The other half of the ownership rule. A human who opens a session by hand, hands it a
		// goal, and watches the session disappear has had their thing taken away by a background
		// job — and the next delegated goal then 409s, which is the bug.
		const { env, created } = stubEnv({
			repos: [{ id: "r1", name: "fws/platform" }],
			session: { id: "s1", client_type: "claude", status: "active" },
		});
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out.ok).toBe(true);
		expect(created[0].params.sessionOpenedByRun).toBe(false);
	});
});

describe('the "Delegated:" board card belongs to a supervisor, not to the owner', () => {
	const codingEnv = () => stubEnv({
		repos: [{ id: "r1", name: "fws/platform" }],
		session: { id: "s1", client_type: "claude" },
	});

	it("an owner pressing Loop gets NO delegation card — nobody delegated to them", async () => {
		// Their run is already visible as its coding-session card (#206). A card reading
		// "Overseer delegated on your behalf" for work they started themselves would be a lie.
		const { env, sql, created } = codingEnv();
		await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(sql.some((q) => q.includes("'delegation'"))).toBe(false);
		expect(created[0].params.boardTaskId).toBeUndefined();
	});

	it("a supervisor's delegation does get one", async () => {
		const { env, sql, created } = codingEnv();
		await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base, delegated: true });
		expect(sql.some((q) => q.includes("'delegation'"))).toBe(true);
		expect(String(created[0].params.boardTaskId)).toMatch(/^deleg-/);
	});
});

describe("one driver per engine — every path that starts a Pilot claims it (#208 hole)", () => {
	const codingEnv = (claimTaken = false) => stubEnv({
		repos: [{ id: "r1", name: "fws/platform" }],
		session: { id: "s1", client_type: "claude" },
		claimTaken,
	});

	it("claims the session before creating the workflow", async () => {
		// #208 put the claim on `/sessions/:id/run` ONLY. This path — the owner's Loop button and
		// every `delegate_goal` to a coding agent — reaches the same tmux pane and was left open,
		// so two Pilots could interleave `send-keys` into one terminal, each reasoning over output
		// the other was writing.
		const { env, sql, created } = codingEnv();
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out.ok).toBe(true);
		expect(sql.some((q) => q.includes("driver_id") && q.includes("UPDATE coding_sessions"))).toBe(true);
		// The Pilot must carry the claim, or nothing releases it when the run ends.
		expect(created[0].params.driverId).toBeTruthy();
	});

	it("refuses — and starts NOTHING — when another driver already holds the session", async () => {
		const { env, sql, created } = codingEnv(true);
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base, delegated: true });
		expect(out).toMatchObject({ ok: false, status: 409 });
		if (!out.ok) expect(out.error).toMatch(/already being worked on/i);
		// No workflow, no loop-run row, and no "Delegated:" card announcing work that never began.
		expect(created).toHaveLength(0);
		expect(sql.some((q) => q.includes("INSERT INTO agent_loop_runs"))).toBe(false);
		expect(sql.some((q) => q.includes("'delegation'"))).toBe(false);
	});

	it("claims BEFORE opening the run row, so a refusal leaves no orphan", async () => {
		// Order matters: a claim checked after the row is written leaves an `agent_loop_runs` row
		// that no workflow will ever close — the stranded-row failure #207C exists to sweep up.
		const { env, sql } = codingEnv();
		await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		const claimAt = sql.findIndex((q) => q.includes("driver_id") && q.includes("UPDATE coding_sessions"));
		const runAt = sql.findIndex((q) => q.includes("INSERT INTO agent_loop_runs"));
		expect(claimAt).toBeGreaterThanOrEqual(0);
		expect(claimAt).toBeLessThan(runAt);
	});
});
