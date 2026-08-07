import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_ACTS_PER_SUBORDINATE, SUPERVISION_TOOLS, resolveSubordinate, type SubordinateRow } from "./supervision.js";
import { stripCommentsAndLiterals } from "../source-guard.js";
import type { Env } from "../../types.js";

const tool = (name: string) => {
	const t = SUPERVISION_TOOLS.find((x) => x.name === name);
	if (!t) throw new Error(`missing tool ${name}`);
	return t;
};

/**
 * D1 stub that behaves like the REAL schema: `agent_instances` has no `name` column, so selecting
 * one is an error rather than a null. Live use hit exactly this — `SELECT i.name` took the whole
 * tool down with a D1_ERROR, which the model surfaced to the user as a platform failure.
 */
function buildEnv(
	opts: {
		edges?: Array<[string, string]>;
		instances?: Array<Record<string, unknown>>;
		work?: unknown[];
		runs?: unknown[];
		/** A registered runner for the subordinate, and whether its relay socket is live. */
		runtime?: { node?: string; version?: string; lastSeenAt?: string; connected: boolean };
		/** `coding_repos` rows for the subordinate (#276) — the repo a delegated goal would use. */
		repos?: Array<Record<string, unknown>>;
		/** What the fake runner answers for `git status --short --branch`. */
		gitStatus?: string;
		/** `agent_events` rows on the generic `act.consequential` name (#294). */
		acts?: unknown[];
		/** A single `agent_loop_runs` row for the check_delegation drill-down. */
		run?: Record<string, unknown> | null;
	} = {},
) {
	const INSTANCE_COLUMNS = new Set(["id", "user_id", "agent_id", "status", "config", "created_at", "updated_at"]);
	const runtimeRow = opts.runtime
		? {
				instance_id: "sub",
				endpoint_url: "https://runner.local",
				token_plaintext: "t",
				runner_node: opts.runtime.node ?? "macbook",
				runner_version: opts.runtime.version ?? "0.4.32",
				last_seen_at: opts.runtime.lastSeenAt ?? new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, ""),
			}
		: null;
	const env = {
		DB: {
			prepare(sql: string) {
				// Reject any column the real table does not have, the way D1 would.
				for (const m of sql.matchAll(/\bi\.([a-z_]+)\b/g)) {
					if (!INSTANCE_COLUMNS.has(m[1])) throw new Error(`D1_ERROR: no such column: i.${m[1]}`);
				}
				return {
					bind() {
						return {
							async all() {
								if (sql.includes("FROM agent_supervision")) {
									return {
										results: (opts.edges ?? [["sup", "sub"]]).map(([s, sub]) => ({
											supervisor_instance_id: s,
											subordinate_instance_id: sub,
										})),
									};
								}
								if (sql.includes("FROM agent_instances")) {
									return { results: opts.instances ?? [{ id: "sub", status: "active", config: null, agent_name: "Repo Coder" }] };
								}
								if (sql.includes("FROM instance_runtime_tasks")) return { results: opts.work ?? [] };
								if (sql.includes("FROM agent_loop_runs")) return { results: opts.runs ?? [] };
								if (sql.includes("FROM instance_runtimes")) return { results: runtimeRow ? [runtimeRow] : [] };
								if (sql.includes("FROM coding_repos")) return { results: opts.repos ?? [] };
								if (sql.includes("FROM agent_events")) return { results: opts.acts ?? [] };
								return { results: [] };
							},
							async first() {
								if (sql.includes("FROM instance_runtimes") || sql.includes("FROM instance_runtime_nodes")) return runtimeRow;
								if (sql.includes("FROM agent_loop_runs")) return opts.run ?? null;
								return null;
							},
							async run() { return { meta: { changes: 1 } }; },
						};
					},
				};
			},
		},
		RELAY: {
			idFromName: (n: string) => n,
			get: () => ({
				async fetch(req: Request) {
					if (req.url.endsWith("/status")) return new Response(JSON.stringify({ connected: opts.runtime?.connected === true }));
					// `/command` — the relay's runner RPC. Only `/coding/git` matters here.
					const sent = (await req.json().catch(() => ({}))) as { path?: string };
					if (sent.path === "/coding/git") return new Response(JSON.stringify({ output: opts.gitStatus ?? "" }));
					return new Response(JSON.stringify({ connected: opts.runtime?.connected === true }));
				},
			}),
		},
	} as unknown as Env;
	return env;
}

/** A subordinate whose work genuinely needs a machine — `capabilities.runtime: "coding"`. */
const codingSubordinate = [{
	id: "sub", status: "active", config: null, agent_name: "Repo Coder",
	slug: "coder-repo", category: "code",
	agent_config: JSON.stringify({ capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } }),
}];

const ctx = (env: Env) => ({ env, userId: "u1", instanceId: "sup" });

/** One `agent_events` row on the generic act name — a merge to the trunk, the case from #294. */
const ACT_ROW = {
	instance_id: "sub",
	trace_id: "run-1",
	message: "merged a pull request #42",
	context: JSON.stringify({ act: "pr.merge", command: "gh pr merge 42 --squash", target: "#42", irreversible: true, ok: true }),
	ts: 1700,
};

describe("list_subordinates", () => {
	it("does not select a column agent_instances lacks", async () => {
		// The regression guard. `agent_instances` has no `name`; a per-instance display name
		// lives in config.displayName. Getting this wrong is a hard error, not a soft miss.
		const r = await tool("list_subordinates").handler(ctx(buildEnv()) as never, {});
		expect(r.success).toBe(true);
		expect(r.content).not.toContain("D1_ERROR");
	});

	it("falls back to the template's name", async () => {
		const r = await tool("list_subordinates").handler(ctx(buildEnv()) as never, {});
		// `subscription`, not `status` — the field is agent_instances.status, the SUBSCRIPTION
		// lifecycle, which reads "active" for an idle agent and an on-fire one alike. Naming it
		// `status` invited the model to read it as work state; subordinate_status answers that.
		expect(JSON.parse(r.content)).toEqual([{ instanceId: "sub", name: "Repo Coder", subscription: "active" }]);
	});

	it("prefers a per-instance display name when the owner set one", async () => {
		const env = buildEnv({ instances: [{ id: "sub", status: "active", config: JSON.stringify({ displayName: "API repo" }), agent_name: "Repo Coder" }] });
		expect(JSON.parse((await tool("list_subordinates").handler(ctx(env) as never, {})).content)[0].name).toBe("API repo");
	});

	it("still lists a subordinate whose config is malformed", async () => {
		// A broken config must not make an agent invisible to its supervisor.
		const env = buildEnv({ instances: [{ id: "sub", status: "active", config: "{not json", agent_name: "Repo Coder" }] });
		expect(JSON.parse((await tool("list_subordinates").handler(ctx(env) as never, {})).content)[0].name).toBe("Repo Coder");
	});

	it("says so plainly when there is nobody to delegate to", async () => {
		const r = await tool("list_subordinates").handler(ctx(buildEnv({ edges: [] })) as never, {});
		expect(r.success).toBe(true);
		expect(r.content).toMatch(/do not supervise any agents/i);
	});
});

describe("resolveSubordinate — a name is what the model actually holds (#320)", () => {
	const row = (over: Partial<SubordinateRow>): SubordinateRow => ({
		instanceId: "id-1", name: "FAS platform", subscription: "active", columns: [], requiresRunner: false, ...over,
	});
	const roster = [row({}), row({ instanceId: "id-2", name: "FWS platform" })];

	it("resolves the instance id, which must keep working", () => {
		const r = resolveSubordinate(roster, "id-2");
		expect(r.ok && r.row.name).toBe("FWS platform");
	});

	it("resolves an exact name, case-insensitively", () => {
		const r = resolveSubordinate(roster, "fas platform");
		expect(r.ok && r.row.instanceId).toBe("id-1");
	});

	it("resolves a unique prefix or fragment — 'FAS' is how a user says it", () => {
		expect(resolveSubordinate(roster, "FAS").ok).toBe(true);
		expect(resolveSubordinate(roster, "fws").ok).toBe(true);
	});

	it("REFUSES an ambiguous name instead of picking one", () => {
		// Guessing here sends a goal to the wrong repository, which is precisely the failure a
		// supervisor cannot see. The refusal names the candidates so the next call can be right.
		const r = resolveSubordinate(roster, "platform");
		expect(r.ok).toBe(false);
		expect(!r.ok && r.message).toMatch(/FAS platform and FWS platform/);
	});

	it("prefers an EXACT name over a longer one it is a prefix of", () => {
		// Otherwise an agent literally called "FAS" becomes unreachable the moment a sibling is
		// named "FAS platform" — the fuzzy arm would report both and refuse forever.
		const two = [row({ instanceId: "a", name: "FAS" }), row({ instanceId: "b", name: "FAS platform" })];
		expect(resolveSubordinate(two, "FAS")).toMatchObject({ ok: true, row: { instanceId: "a" } });
	});

	it("lists the roster in a refusal, so the model does not need a second call to recover", () => {
		const r = resolveSubordinate(roster, "PAS");
		expect(!r.ok && r.message).toContain("FAS platform (id-1)");
	});
});

describe("tool shape", () => {
	it("gates delegate_goal as a write — it starts real work and spends real money", () => {
		expect(tool("delegate_goal").scope).toBe("write");
		expect(tool("list_subordinates").scope).toBe("read");
		expect(tool("check_delegation").scope).toBe("read");
	});

	it("belongs to the supervision connector so registry gating applies", () => {
		for (const t of SUPERVISION_TOOLS) expect(t.connector).toBe("supervision");
	});

	it("delegate_goal refuses an agent it cannot resolve, before spending anything", async () => {
		// Resolution happens against the ROSTER, so widening how a subordinate may be named cannot
		// widen who is reachable. `delegateToInstance` re-checks the graph on the resolved id too.
		const out = await tool("delegate_goal").handler(ctx(buildEnv()) as never, { instanceId: "not-mine", objective: "x" });
		expect(out.success).toBe(false);
		expect(out.content).toMatch(/do not supervise/i);
	});
});

describe("check_delegation", () => {
	it("answers WITHOUT an identifier now — it used to refuse and demand one", async () => {
		// It required a runId or an instanceId, which meant the model had to already know who to
		// ask about before it could find out anything. That is backwards for the "what is going
		// on?" question, and it is why the Lead could never answer without delegating first.
		const r = await tool("check_delegation").handler(ctx(buildEnv()) as never, {});
		expect(r.success).toBe(true);
		expect(JSON.parse(r.content).subordinates).toHaveLength(1);
	});
});

describe("subordinate_status — the observe verb", () => {
	const t = tool("subordinate_status");

	it("is a READ on the supervision connector, so registry gating and consent apply correctly", () => {
		expect(t.scope).toBe("read");
		expect(t.connector).toBe("supervision");
	});

	it("reports what a subordinate is doing, bucketed through THAT agent's declared columns", async () => {
		const env = buildEnv({
			instances: [{
				id: "sub", status: "active", config: null, agent_name: "Repo Coder",
				slug: "coder-repo", category: "code",
				agent_config: JSON.stringify({ capabilities: { surfaces: ["coding"], boardColumns: [
					{ id: "running", title: "Running", color: "#000", statuses: ["running"] },
				] } }),
			}],
			work: [{ instance_id: "sub", id: "t1", type: "delegation", status: "running",
			         payload: JSON.stringify({ title: "Delegated: green the suite" }), updated_at: "2026-08-05T10:00:00.000Z" }],
			runs: [{ instance_id: "sub", run_id: "r1", objective: "green the suite", status: "running", stop_reason: null,
			         detail: null, iteration: 4, max_iterations: 10, started_at: 1, finished_at: null, last_progress_at: 2 }],
		});
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].work[0]).toMatchObject({ status: "running", columnTitle: "Running", title: "Delegated: green the suite" });
		expect(out.subordinates[0].runs[0]).toMatchObject({ objective: "green the suite", iteration: 4, maxIterations: 10 });
	});

	it("reports a connected runner for an IDLE subordinate — the refusal that started this (#259)", async () => {
		// The live failure: asked to delegate a typecheck, the Coder Lead read four subordinates
		// with no work in flight, reported "No active runner" for all four, and told the user to
		// run `pags up` — which was running, relay connected, health ok. It had no connectivity
		// field to read, so it inferred one from `activeSessions: 0`. Two different questions.
		const env = buildEnv({ instances: codingSubordinate, runtime: { connected: true, node: "macbook" } });
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].work).toEqual([]); // idle …
		expect(out.subordinates[0].connectivity).toMatchObject({ canWork: true, state: "attached", node: "macbook", runnerVersion: "0.4.32" });
	});

	it("reports a cloud-only subordinate as reachable, never as a missing runner", async () => {
		// The default agent here declares no runtime. Telling a supervisor to run `pags up` for a
		// pipeline agent would invent a blocker that cannot exist.
		const out = JSON.parse((await t.handler(ctx(buildEnv()) as never, {})).content);
		expect(out.subordinates[0].connectivity).toMatchObject({ canWork: true, requiresRunner: false, remedy: null });
	});

	it("says the runner is down, and which machine, when it really is", async () => {
		const env = buildEnv({ instances: codingSubordinate, runtime: { connected: false, node: "studio", lastSeenAt: "2020-01-01 00:00:00" } });
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].connectivity).toMatchObject({ canWork: false, state: "runner-offline", remedy: "pags up" });
		expect(out.subordinates[0].connectivity.message).toContain("studio");
	});

	it("reports the branch and working tree of the repo a goal would run in (#276)", async () => {
		// The live failure: FWS was parked on `fix/36-assistant-bubble-order` after a run pushed a
		// PR, and FAS held a real uncommitted fix from ~50 hours earlier. `subordinate_status`
		// reported "Last action" and nothing about either, so a supervisor delegating "fix the
		// failing tests" would have had the work done on a merged feature branch unnoticed.
		const env = buildEnv({
			instances: codingSubordinate,
			runtime: { connected: true, node: "macbook" },
			repos: [{ id: "repo_1", instance_id: "sub", user_id: "u1", name: "fws/platform", branch: "", workdir: "/dev/fws", clone_status: "ready", default_client: "claude", created_at: "", updated_at: "" }],
			gitStatus: "## fix/36-assistant-bubble-order...origin/fix/36\n M src/a.ts\n",
		});
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].repo).toMatchObject({ name: "fws/platform", branch: "fix/36-assistant-bubble-order", dirty: true, changedFiles: 1 });
		expect(out.subordinates[0].repo.note).toContain("NOT be discarded");
	});

	it("omits `repo` entirely rather than guessing when nothing can answer", async () => {
		// Absent reads as "unknown", which is true. A fabricated clean-on-main is a fact the
		// supervisor would act on — and the whole class of bug here is acting on a stale picture.
		const env = buildEnv({ instances: codingSubordinate, runtime: { connected: true } });
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].repo).toBeUndefined();
	});

	it("does not probe the repo of a subordinate whose runner is unreachable", async () => {
		// The read goes over the same relay connectivity just said is down, so probing buys a
		// guaranteed timeout for a guaranteed null — on every status call the Lead makes.
		const env = buildEnv({
			instances: codingSubordinate,
			runtime: { connected: false, node: "studio" },
			repos: [{ id: "repo_1", instance_id: "sub", user_id: "u1", name: "fws/platform", branch: "", workdir: "/dev/fws", clone_status: "ready", default_client: "claude", created_at: "", updated_at: "" }],
			gitStatus: "## main\n",
		});
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].repo).toBeUndefined();
	});

	it("carries a legend saying idle is not offline", async () => {
		// The tool description is a long way from this JSON by the time the model reads it, and
		// the failure being prevented is precisely a model reasoning from an empty board.
		const out = JSON.parse((await t.handler(ctx(buildEnv()) as never, {})).content);
		expect(out.legend).toMatch(/canWork/);
		expect(out.legend).toMatch(/IDLE/);
	});

	it("surfaces the consequential acts a subordinate took (#294)", async () => {
		// "Last action" is the objective's own summary. A run that merged its own PRs to `main`
		// reported "done" and nothing else, which is the whole issue.
		const out = JSON.parse((await t.handler(ctx(buildEnv({ acts: [ACT_ROW] })) as never, {})).content);
		expect(out.subordinates[0].acts).toEqual([
			{ kind: "pr.merge", summary: "merged a pull request #42", command: "gh pr merge 42 --squash", irreversible: true, traceId: "run-1", at: 1700 },
		]);
	});

	it("bounds the acts payload — it sits OUTSIDE the observation char budget", async () => {
		// Acts are attached after summarizeSubordinates has already trimmed work to
		// MAX_OBSERVATION_CHARS, so nothing else caps them. A loop force-pushing in circles would
		// otherwise put tens of kilobytes of command text into every prompt this supervisor builds.
		const env = buildEnv();
		let limit: unknown;
		// The cap and the event name are BOUND now (#327), so the assertion reads the bindings
		// rather than the statement text — which is also the only place the cap still exists.
		const spied = { ...env, DB: { prepare(sql: string) {
			const stmt = (env as unknown as { DB: { prepare(s: string): { bind(...a: unknown[]): unknown } } }).DB.prepare(sql);
			if (!sql.includes("FROM agent_events")) return stmt;
			return { ...stmt, bind: (...args: unknown[]) => {
				if (args.includes("act.consequential")) limit = args[1];
				return stmt.bind(...args);
			} };
		} } } as unknown as Env;
		await tool("subordinate_status").handler(ctx(spied) as never, {});
		expect(limit).toBe(MAX_ACTS_PER_SUBORDINATE);
	});

	it("omits `acts` rather than sending an empty array", async () => {
		// `acts: []` reads as "this agent did nothing consequential". Only a stream-json engine
		// reports acts at all, so the honest meaning of absence is NOT OBSERVED.
		const out = JSON.parse((await t.handler(ctx(buildEnv()) as never, {})).content);
		expect(out.subordinates[0]).not.toHaveProperty("acts");
	});

	it("tells the model in the legend that a missing `acts` is not an all-clear", async () => {
		// Without this, a supervisor reads no acts and reassures the human that nothing was
		// changed — a confident wrong answer, which is worse than the silence it replaced.
		const out = JSON.parse((await t.handler(ctx(buildEnv()) as never, {})).content);
		expect(out.legend).toMatch(/irreversible/);
		expect(out.legend).toMatch(/NOT OBSERVED/);
	});

	it("REFUSES an instanceId outside the supervision graph rather than reading it", async () => {
		// Same posture as delegate_goal, which re-checks membership inside delegateToInstance
		// instead of trusting the tool description to discourage a model from naming another
		// owner's agent. A read is not exempt: it would leak what that agent is working on.
		const out = await t.handler(ctx(buildEnv()) as never, { instanceId: "someone-elses" });
		expect(out.content).toMatch(/do not supervise/i);
		// `success: false`, not true (#320). A refusal reported as success put a green tick on four
		// consecutive no-ops in one conversation — each followed by a retry — so a reader scanning
		// the tool log saw eight successful status calls where there had been four.
		expect(out.success).toBe(false);
	});

	it("names an agent by NAME, so the model can use the words the user used (#320)", async () => {
		// The measured cost: every one of four turns went subordinate_status("FAS platform") →
		// refused → list_subordinates → subordinate_status("<uuid>"). The retry was the DOCUMENTED
		// path (the refusal itself says to read the roster), so it was not a mistake the model
		// could learn its way out of. The user says "Focus on FAS platform"; a name is all it has.
		const env = buildEnv({ instances: [{ id: "sub", status: "active", config: JSON.stringify({ displayName: "FAS platform" }), agent_name: "Repo Coder" }] });
		const out = await t.handler(ctx(env) as never, { instanceId: "FAS platform" });
		expect(out.success).toBe(true);
		expect(JSON.parse(out.content).subordinates).toHaveLength(1);
	});

	it("says which agent it resolved a name to, rather than silently redefining the question", async () => {
		const env = buildEnv({ instances: [{ id: "sub", status: "active", config: JSON.stringify({ displayName: "FAS platform" }), agent_name: "Repo Coder" }] });
		const out = JSON.parse((await t.handler(ctx(env) as never, { instanceId: "fas" })).content);
		expect(out.resolved).toEqual({ asked: "fas", instanceId: "sub", name: "FAS platform" });
	});

	it("carries the repo's GitHub owner/name, not only its display label (#320)", async () => {
		// Asked for open tickets, the Lead passed `repo.name` — "fws" — to github_list_issues,
		// got "No github access", and asked the human for a path `coding_repos.github_repo`
		// already held. Same class as #259: a fact the platform has, missing from the picture.
		const env = buildEnv({
			instances: codingSubordinate,
			runtime: { connected: true, node: "macbook" },
			repos: [{ id: "repo_1", instance_id: "sub", user_id: "u1", name: "fws/platform", github_repo: "freewebstore-online/platform",
			          branch: "", workdir: "/dev/fws", clone_status: "ready", default_client: "claude", created_at: "", updated_at: "" }],
			gitStatus: "## main\n",
		});
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].repo.githubRepo).toBe("freewebstore-online/platform");
		// And the legend has to SAY which of the two is a GitHub path — the description is a long
		// way away by the time the model is reading this JSON (the #259 precedent).
		expect(out.legend).toMatch(/githubRepo/);
	});

	it("says so plainly when there is nobody to observe", async () => {
		const out = await t.handler(ctx(buildEnv({ edges: [] })) as never, {});
		expect(out.content).toMatch(/do not supervise any agents yet/i);
	});

	it("still reports the roster when the work reads fail — a broken read must not blind the supervisor", async () => {
		const env = {
			DB: {
				prepare(sql: string) {
					return { bind() { return { async all() {
						if (sql.includes("FROM agent_supervision")) return { results: [{ supervisor_instance_id: "sup", subordinate_instance_id: "sub" }] };
						if (sql.includes("FROM agent_instances")) return { results: [{ id: "sub", status: "active", config: null, agent_name: "Repo Coder" }] };
						throw new Error("D1 unavailable");
					} }; } };
				},
			},
		} as unknown as Env;
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].name).toBe("Repo Coder");
		expect(out.subordinates[0].work).toEqual([]);
	});
});

describe("check_delegation without a runId — the model reaches for the tool it already knows", () => {
	// Measured, not assumed: given both tools, the Lead called check_delegation three times in a
	// row and never called subordinate_status. A new tool name has to be DISCOVERED; the one
	// already in the model's habit does not. Both paths therefore return the same good answer.
	it("returns the same global picture subordinate_status does", async () => {
		const env = buildEnv({
			work: [{ instance_id: "sub", id: "t1", type: "delegation", status: "completed",
			         payload: JSON.stringify({ title: "Delegated: x" }), updated_at: "2026-08-05T10:00:00.000Z" }],
		});
		const viaNew = JSON.parse((await tool("subordinate_status").handler(ctx(env) as never, {})).content);
		const viaOld = JSON.parse((await tool("check_delegation").handler(ctx(env) as never, {})).content);
		expect(viaOld.subordinates).toEqual(viaNew.subordinates);
	});

	it("still answers a SPECIFIC run id from the run record, not the summary", async () => {
		// The drill-down branch is correct as-is and must not be swallowed by the summary.
		const t = tool("check_delegation");
		const out = await t.handler(ctx(buildEnv()) as never, { runId: "nope" });
		expect(out.success).toBe(false);
		expect(out.content).toMatch(/No delegated run with id nope/);
	});

	it("names the acts the run took, not only how it ended (#294)", async () => {
		// The issue, exactly: run 73ffc073's `detail` said the objective completed while it had
		// merged its own PRs to `main`. A supervisor drilling into a run must see the merge here.
		const env = buildEnv({
			run: { run_id: "r1", user_id: "u1", instance_id: "sub", objective: "fix the build", status: "completed",
			       stop_reason: "done", detail: "outcome: done", iteration: 7, max_iterations: 10,
			       cancel_requested: 0, budget_id: null, started_at: 1000, finished_at: 9000, last_progress_at: 8000 },
			acts: [ACT_ROW],
		});
		const out = JSON.parse((await tool("check_delegation").handler(ctx(env) as never, { runId: "r1" })).content);
		expect(out.acts).toHaveLength(1);
		expect(out.acts[0]).toMatchObject({ kind: "pr.merge", irreversible: true, command: "gh pr merge 42 --squash" });
		expect(out.actsLegend).toMatch(/irreversible/);
	});

	it("omits `acts` entirely for a run that reported none", async () => {
		// An empty array would read as "this run changed nothing", which no engine can attest to —
		// a raw Codex/Grok session reports no acts at all. Absence must mean NOT OBSERVED.
		const env = buildEnv({
			run: { run_id: "r1", user_id: "u1", instance_id: "sub", objective: "o", status: "completed",
			       stop_reason: "done", detail: null, iteration: 1, max_iterations: 10, cancel_requested: 0,
			       budget_id: null, started_at: 1, finished_at: 2, last_progress_at: 1 },
		});
		const out = JSON.parse((await tool("check_delegation").handler(ctx(env) as never, { runId: "r1" })).content);
		expect(out).not.toHaveProperty("acts");
	});

	it("no longer demands an instanceId just to say what is going on", async () => {
		// It used to refuse with "Give either a runId, or an instanceId" — which forced the model
		// to already know who to ask about before it could find out anything.
		const out = await tool("check_delegation").handler(ctx(buildEnv()) as never, {});
		expect(out.success).toBe(true);
		expect(out.content).not.toMatch(/Give either a runId/);
	});
});

// ── #303: the compiler is not switched off at the delegation boundary ────────
describe("the supervision module's types are load-bearing", () => {
	it("declares no `never` env or context, and casts to none", () => {
		// `env: never` reads like a narrow type and is the opposite of one: `never` is assignable to
		// everything, so eleven calls into graph loading, delegation, runtime connectivity, loop-run
		// lookup, repo probing and activity reads type-checked unconditionally — at exactly the
		// boundary that decides who may drive whom. A callee could change its env or context
		// contract and every call site here would keep compiling and fail in production.
		//
		// Scanned over the lexed source so the explanation in the module's own doc comment (which
		// has to quote the old shape) does not fail its own guard.
		const src = stripCommentsAndLiterals(readFileSync(new URL("./supervision.ts", import.meta.url).pathname, "utf-8"));
		const offenders = src
			.split("\n")
			.map((line, i) => ({ line: i + 1, text: line }))
			.filter(({ text }) => /\bas\s+never\b/.test(text) || /:\s*never\b/.test(text))
			.map(({ line, text }) => `supervision.ts:${line} ${text.trim()}`);
		expect(
			offenders,
			`Type these against what they actually use — every callee here takes the real Env, and\n` +
				`RegistryToolCtx already carries it plus the userId/instanceId/traceId/budgetId a whole-\n` +
				`context cast erases. Do NOT swap \`as never\` for \`as any\`; the goal is compile-time checking.\n` +
				`Offenders:\n${offenders.join("\n")}`,
		).toEqual([]);
	});
});
