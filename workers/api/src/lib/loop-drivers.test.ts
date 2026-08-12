import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LOOP_DRIVER, loopDriverFor, LOOP_DRIVER_IDS, pickLoopRepo } from "./loop-drivers.js";
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
function stubEnv(
	opts: { repos?: unknown[]; session?: unknown; claimTaken?: boolean; runnerOnline?: boolean; hasRuntimeRow?: boolean; failLoopRunInsert?: boolean } = {},
) {
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
								if (opts.failLoopRunInsert && q.includes("INSERT INTO agent_loop_runs")) throw new Error("D1_ERROR: database is locked");
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

	// ── #291 ──────────────────────────────────────────────────────────────────────
	it("refuses to start a run it could not record, instead of starting one nobody can stop", async () => {
		// The bug this closes: the coding driver wrapped `createLoopRun` in `.catch(() => undefined)`
		// (the chat driver never did — the asymmetry was the tell). The Pilot workflow was created
		// anyway and the caller got a `runId` with no `agent_loop_runs` row behind it, so
		// `requestCancel(runId)` and `isCancelRequested` had nothing to act on: an autonomous run
		// editing the user's repo and spending their tokens that the console could not show and the
		// user could not stop. Violates this module's stated invariant that EVERY driver opens a row.
		const { env, created } = stubEnv({
			repos: [{ id: "r1", name: "fws/platform", instance_id: "i1", user_id: "u1", clone_status: "ready" }],
			session: { id: "s1", client_type: "claude", status: "active" },
			failLoopRunInsert: true,
		});

		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });

		expect(out.ok).toBe(false);
		// The real regression: no untrackable Pilot was launched.
		expect(created).toHaveLength(0);
	});

	it("gives back the session driver claim it took, so the next attempt is not locked out", async () => {
		// Failing the start is only correct if it also unwinds. `claimSessionDriver` has already
		// marked the session as driven; leaving that behind would make every retry 409 with
		// "already being worked on" against a run that never existed.
		const { env, sql } = stubEnv({
			repos: [{ id: "r1", name: "fws/platform", instance_id: "i1", user_id: "u1", clone_status: "ready" }],
			session: { id: "s1", client_type: "claude", status: "active" },
			failLoopRunInsert: true,
		});

		await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });

		// `driver_id = NULL` is what distinguishes the RELEASE from the claim — both are
		// `UPDATE coding_sessions … driver_id`, so matching on that alone would pass vacuously.
		expect(sql.some((q) => q.includes("UPDATE coding_sessions") && q.includes("driver_id = NULL"))).toBe(true);
	});
});

describe("the coding driver refuses a checkout the platform has already condemned (#548)", () => {
	const brokenRepo = {
		id: "r1",
		name: "dev/aipa",
		instance_id: "i1",
		user_id: "u1",
		workdir: "~/dev/aipa",
		clone_status: "needs_attention",
		clone_error: "The configured checkout `/Users/serge-ivo/dev/aipa` has files but is not inside a git working tree — it is a plain folder, not a clone of a repository.",
	};

	it("409s with the folder verdict, and opens NOTHING", async () => {
		// The measured failure: three `git pull` runs admitted onto a folder with no `.git`, each
		// burning ~15 minutes of BYOK reasoning against an engine exiting 1 every turn, ending in
		// "stuck not resolved in time" — while D1 held `clone_error` naming the folder and the word
		// "git" the entire time. The assertion that matters is not the wording but the absence: no
		// Pilot, no session row, no `agent_loop_runs` row, no budget pool.
		const { env, sql, created } = stubEnv({ repos: [brokenRepo], session: null });
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.status).toBe(409);
			expect(out.error).toContain("/Users/serge-ivo/dev/aipa");
			expect(out.error).toMatch(/git working tree/);
		}
		expect(created).toHaveLength(0);
		expect(sql.some((q) => q.includes("INSERT INTO agent_loop_runs"))).toBe(false);
		expect(sql.some((q) => q.includes("INSERT INTO coding_sessions"))).toBe(false);
	});

	it("does NOT prescribe `pags up` for a problem `pags up` cannot fix", async () => {
		// #468/#530, twice fixed and reachable again here: the connectivity refusal
		// (`noSessionMessage`) is tuned for a missing runner, and a Lead relaying it for a broken
		// folder sends its owner to a terminal. This refusal is deliberately NOT routed through it.
		const { env } = stubEnv({ repos: [brokenRepo], session: null });
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).not.toMatch(/pags up/);
	});

	it("refuses even when a session is already live on that repo", async () => {
		// The incident's session reported `alive:true, ready:true, runState:"idle"`. Gating only
		// the OPENING of a new session would have admitted all three runs.
		const { env, created } = stubEnv({ repos: [brokenRepo], session: { id: "s1", client_type: "codex", status: "active" } });
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out.ok).toBe(false);
		expect(created).toHaveLength(0);
	});

	it("still starts on `unknown` — an unlooked-at path is not a condemned one", async () => {
		// The regression this guards: an offline laptop, or one that has never been up while the
		// console was open, must not stop every run. Only `needs_attention` — a verdict a machine
		// actually produced — blocks.
		const { env, created } = stubEnv({
			repos: [{ id: "r1", name: "dev/aipa", instance_id: "i1", user_id: "u1", clone_status: "unknown" }],
			session: { id: "s1", client_type: "claude", status: "active" },
		});
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out.ok).toBe(true);
		expect(created[0].binding).toBe("CODING_SESSION");
	});

	it("still starts on a stale `error`, which is a transport failure and not a filesystem verdict", async () => {
		// #440: `clone_status = "error"` carried "No runner connected — run `pags up`" on a healthy
		// 18-entry checkout for five days. Rows written before that fix still exist.
		const { env, created } = stubEnv({
			repos: [{ id: "r1", name: "pas/platform", instance_id: "i1", user_id: "u1", clone_status: "error", clone_error: "No runner connected — run `pags up`" }],
			session: { id: "s1", client_type: "claude", status: "active" },
		});
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out.ok).toBe(true);
		expect(created[0].binding).toBe("CODING_SESSION");
	});

	it("reports the RUNNER when the machine is off, even on a condemned repo", async () => {
		// Ordering, asserted. A `needs_attention` verdict can be days old; with the machine down
		// the runner diagnosis is both truer and more actionable, and leading with the folder would
		// send the owner to inspect a laptop that is shut.
		const { env } = stubEnv({ repos: [brokenRepo], session: null, runnerOnline: false });
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).not.toMatch(/git working tree/);
	});
});

describe("pickLoopRepo — WHICH engine an objective reaches (#374)", () => {
	const repos = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];

	it("takes the first when the caller does not care", () => {
		// A supervisor's `delegate_goal` names an agent, not a checkout — unchanged behaviour.
		expect(pickLoopRepo(repos)).toEqual({ ok: true, repo: { id: "r1" } });
		expect(pickLoopRepo(repos, null)).toEqual({ ok: true, repo: { id: "r1" } });
		expect(pickLoopRepo(repos, "")).toEqual({ ok: true, repo: { id: "r1" } });
	});

	it("takes the one the caller named", () => {
		// The Coding tab's Loop, which is open on ONE session and means that one. `repos[0]` would
		// claim a different session's driver and drive an engine the user is not looking at.
		expect(pickLoopRepo(repos, "r3")).toEqual({ ok: true, repo: { id: "r3" } });
	});

	it("REFUSES a repo this agent does not have, rather than falling back to the first", () => {
		// A fallback here is not a lenient default, it is the wrong repository being edited — and
		// unlike a refusal, that is not recoverable once the engine has run.
		const out = pickLoopRepo(repos, "r9");
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toMatch(/not on this agent/i);
	});

	it("says what to do when the agent has no repos at all", () => {
		const out = pickLoopRepo([]);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toMatch(/no repository/i);
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

	it("drives the repo the CALLER named, not the agent's first one (#374)", async () => {
		// The Coding tab's Loop is open on one session. Routing it through this driver without a
		// target would have handed the objective to `repos[0]` — on a multi-repo Coder, an engine
		// in a different checkout, whose session's driver claim it would also take.
		const { env, created } = stubEnv({
			repos: [
				{ id: "r1", name: "first/repo", instance_id: "i1", user_id: "u1" },
				{ id: "r2", name: "second/repo", instance_id: "i1", user_id: "u1" },
			],
			session: { id: "s1", client_type: "claude", status: "active" },
		});
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base, repoId: "r2" });
		expect(out.ok).toBe(true);
		expect(created[0].params.repoId).toBe("r2");
		expect((created[0].params.goal as { repo: string }).repo).toBe("second/repo");
	});

	it("refuses a repo that is not this agent's, and starts nothing", async () => {
		const { env, created } = stubEnv({
			repos: [{ id: "r1", name: "first/repo", instance_id: "i1", user_id: "u1" }],
			session: { id: "s1", client_type: "claude", status: "active" },
		});
		const out = await loopDriverFor(caps("CODING_SESSION")).start({ env, ...base, repoId: "nope" });
		expect(out).toMatchObject({ ok: false, status: 409 });
		expect(created).toHaveLength(0);
	});

	it("hands the Pilot the caller's step cap — and nothing when the caller named none", async () => {
		// `maxIterations` reached the `agent_loop_runs` row and stopped there, so a supervisor
		// could read "iteration 40 of 10": the Pilot's own per-round cap is 40 and nothing told it
		// otherwise. Absent stays absent so `delegate_goal`, which usually names no number, keeps
		// the Pilot's default instead of inheriting sanitizeMaxIterations' fallback of 10.
		const withCap = stubEnv({ repos: [{ id: "r1", name: "r" }], session: { id: "s1", client_type: "claude" } });
		await loopDriverFor(caps("CODING_SESSION")).start({ env: withCap.env, ...base, maxIterations: 25 });
		expect(withCap.created[0].params.maxSteps).toBe(25);

		const without = stubEnv({ repos: [{ id: "r1", name: "r" }], session: { id: "s1", client_type: "claude" } });
		await loopDriverFor(caps("CODING_SESSION")).start({ env: without.env, ...base });
		expect(without.created[0].params.maxSteps).toBeUndefined();
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
