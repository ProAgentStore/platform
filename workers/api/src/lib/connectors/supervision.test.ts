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
		/** The owner's `users.preferences` blob — where their timezone lives (#329/#345). */
		preferences?: string | null;
		/** Standing directions (#330) per subordinate id, as stored on the edge's `config`. */
		directions?: Record<string, { text: string; setBy: "user" | "agent" }>;
	} = {},
) {
	// Mutable, so a `set_direction` write is visible to the read that follows it.
	const directions: Record<string, { text: string; setBy: "user" | "agent" }> = { ...(opts.directions ?? {}) };
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
					bind(...args: unknown[]) {
						return {
							async all() {
								if (sql.includes("FROM agent_supervision")) {
									// The direction read (#330) — a different projection of the same table.
									if (sql.includes("subordinate_instance_id, config")) {
										return {
											results: (opts.edges ?? [["sup", "sub"]]).map(([, sub]) => ({
												subordinate_instance_id: sub,
												config: directions[sub] ? JSON.stringify({ direction: { ...directions[sub], updatedAt: "2026-08-07T00:00:00.000Z" } }) : null,
											})),
										};
									}
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
								if (sql.includes("FROM users")) return { preferences: opts.preferences ?? null };
								// The edge `set_direction` reads before it writes. Keyed by the subordinate id
								// the tool resolved, so a tool naming somebody else's agent gets a 404 here too.
								if (sql.includes("FROM agent_supervision")) {
									// Addressed by subordinate id (the tool) or by edge id (the re-read after a write).
									const sub = String(args[0] ?? "").replace(/^link-/, "");
									if (!(opts.edges ?? [["sup", "sub"]]).some(([, s]) => s === sub)) return null;
									return {
										id: `link-${sub}`,
										user_id: "u1",
										supervisor_instance_id: "sup",
										subordinate_instance_id: sub,
										enabled: 1,
										config: directions[sub] ? JSON.stringify({ direction: { ...directions[sub], updatedAt: "2026-08-07T00:00:00.000Z" } }) : null,
										created_at: "2026-08-01 00:00:00",
										updated_at: "2026-08-01 00:00:00",
									};
								}
								return null;
							},
							async run() {
								// Apply a direction write so the next read sees it — the point of the field.
								if (sql.startsWith("UPDATE agent_supervision")) {
									const cfg = JSON.parse(String(args[0] ?? "{}")) as { direction?: { text: string; setBy: "user" | "agent" } };
									const sub = String(args[1] ?? "").replace(/^link-/, "");
									if (cfg.direction) directions[sub] = { text: cfg.direction.text, setBy: cfg.direction.setBy };
									else delete directions[sub];
								}
								return { meta: { changes: 1 } };
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

/** `list_subordinates` answers `{legend, subordinates}` — the legend explains `proposedDirection`. */
const roster = (r: { content: string }) => JSON.parse(r.content).subordinates as Array<Record<string, unknown>>;

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
		expect(JSON.parse(r.content).subordinates).toEqual([{ instanceId: "sub", name: "Repo Coder", subscription: "active" }]);
	});

	it("prefers a per-instance display name when the owner set one", async () => {
		const env = buildEnv({ instances: [{ id: "sub", status: "active", config: JSON.stringify({ displayName: "API repo" }), agent_name: "Repo Coder" }] });
		expect(roster(await tool("list_subordinates").handler(ctx(env) as never, {}))[0].name).toBe("API repo");
	});

	it("still lists a subordinate whose config is malformed", async () => {
		// A broken config must not make an agent invisible to its supervisor.
		const env = buildEnv({ instances: [{ id: "sub", status: "active", config: "{not json", agent_name: "Repo Coder" }] });
		expect(roster(await tool("list_subordinates").handler(ctx(env) as never, {}))[0].name).toBe("Repo Coder");
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

	// ── The shared speech rule (#392) ────────────────────────────────────────────────────────────

	it("resolves a name carrying a transcript's trailing stop", () => {
		// The issue verbatim. Under the old local `trim().toLowerCase()` the dot survived, so the
		// exact arm missed, BOTH fuzzy arms missed (they test the query as the needle) and the id
		// prefix missed — three failures from one character — and the supervisor answered "You do
		// not supervise \"FAS platform.\"" about an agent it does supervise.
		const r = resolveSubordinate(roster, "FAS platform.");
		expect(r.ok && r.row.instanceId).toBe("id-1");
	});

	it("resolves a name however the transcriber punctuated it", () => {
		// Whisper renders the same utterance with a hyphen, a comma or nothing at all — a formatting
		// choice the speaker cannot see or control (#334). Punctuation becomes a space, so all three
		// are one name.
		for (const spoken of ["FAS-platform", "FAS, platform", "«FAS platform»", "FAS platform!"]) {
			expect(resolveSubordinate(roster, spoken), spoken).toMatchObject({ ok: true, row: { instanceId: "id-1" } });
		}
	});

	it("resolves an instance id that picked up a trailing stop too", () => {
		expect(resolveSubordinate(roster, "id-2.")).toMatchObject({ ok: true, row: { name: "FWS platform" } });
	});

	it("keeps the ambiguity refusal an ambiguity refusal once punctuation is gone", () => {
		// "platform." used to fall all the way through to "you do not supervise it", which is a
		// FALSE statement. Normalising makes it what it always was: a name that fits two agents.
		const r = resolveSubordinate(roster, "platform.");
		expect(r.ok).toBe(false);
		expect(!r.ok && r.message).toMatch(/FAS platform and FWS platform/);
	});

	it("REFUSES a query that is only punctuation, even with a single subordinate", () => {
		// The one way this change could have made things worse. An all-punctuation query normalises
		// to "", and `"anything".startsWith("")` is true — so without the empty-key guard the fuzzy
		// arm matches every row, and a supervisor with exactly ONE subordinate would resolve a name
		// that was never spoken and delegate real work to it. A wrong confident match is worse than
		// the refusal this change exists to remove.
		const one = [row({})];
		for (const junk of ["?", "…", "。", "!!!", "—"]) {
			expect(resolveSubordinate(one, junk), junk).toMatchObject({ ok: false });
			expect(resolveSubordinate(roster, junk), junk).toMatchObject({ ok: false });
		}
	});

	it("refuses two agents whose names differ ONLY by punctuation, rather than guessing", () => {
		// The single case where the shared rule NARROWS: these two used to be distinguishable by
		// typing the exact name and now normalise to the same key. Refusing is the honest answer —
		// a spoken name genuinely cannot tell them apart — and the refusal names the ids.
		const twins = [row({ instanceId: "a", name: "FAS-platform" }), row({ instanceId: "b", name: "FAS platform" })];
		const r = resolveSubordinate(twins, "FAS platform");
		expect(r.ok).toBe(false);
		expect(!r.ok && r.message).toMatch(/use the instance id/);
	});

	it("lets a literal instance id win outright, which is what every refusal promises", () => {
		// The refusals say "use the instance id", so that has to work unconditionally — including
		// when another agent is displayed under a name that normalises to the same key. Before the
		// literal-id arm, both arrived in the exact set together and the escape hatch refused too.
		const clash = [row({ instanceId: "id-2", name: "FWS platform" }), row({ instanceId: "x", name: "id 2" })];
		expect(resolveSubordinate(clash, "id-2")).toMatchObject({ ok: true, row: { name: "FWS platform" } });
	});

	it("matches a name with an apostrophe however it was typed", () => {
		// Elision marks are DELETED rather than spaced, so `Bob's` is one token in both renderings —
		// the typographic apostrophe an STT engine emits and the ASCII one a creator typed.
		const owned = [row({ instanceId: "o", name: "Bob’s agent" })];
		for (const spoken of ["Bob's agent", "bobs agent", "Bob’s agent."]) {
			expect(resolveSubordinate(owned, spoken), spoken).toMatchObject({ ok: true, row: { instanceId: "o" } });
		}
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

	// ── #339: the tool the Lead actually reached for, and what it could see ──────────────────
	//
	// Owner: "What are the instructions to it? Is it supposed to work through PRs or direct
	// commits to main?" The Lead called this, read the run's OBJECTIVE, and reported it as the
	// configuration — reassuring its owner about a review gate that did not exist.

	const RUN = {
		run_id: "r1", user_id: "u1", instance_id: "sub", status: "running", stop_reason: null, detail: null,
		iteration: 2, max_iterations: 10, cancel_requested: 0, budget_id: null, started_at: 1, finished_at: null,
		last_progress_at: 2, delegated_by: "sup",
		objective: "Read each open issue, implement a fix, commit, push, open a PR, and merge it.",
	};

	const codingWith = (config: string) => [{ ...codingSubordinate[0], config }];
	const oneRepo = [{ id: "r", instance_id: "sub", user_id: "u1", name: "p", github_repo: "org/p", merge_policy: "",
	                   clone_status: "ready", branch: "", workdir: "", default_client: "claude", created_at: "", updated_at: "" }];

	it("returns the standing configuration ALONGSIDE the run's objective", async () => {
		const env = buildEnv({ run: RUN, instances: codingWith(JSON.stringify({ settings: { merge_policy: "pr" } })), repos: oneRepo });
		const out = JSON.parse((await tool("check_delegation").handler(ctx(env) as never, { runId: "r1" })).content);
		expect(out.objective).toContain("merge it");
		expect(out.config.mergeAuthority.policy).toBe("pr");
		// The legend rides in the payload, not only in the description (#259 precedent).
		expect(out.configLegend).toMatch(/NOT configuration/);
	});

	it("says the objective EXCEEDS the policy rather than repeating it as the plan", async () => {
		const env = buildEnv({ run: RUN, instances: codingWith(JSON.stringify({ settings: { merge_policy: "pr" } })), repos: oneRepo });
		const out = JSON.parse((await tool("check_delegation").handler(ctx(env) as never, { runId: "r1" })).content);
		expect(out.objectiveConflict).toMatch(/EXCEEDS the policy/);
		expect(out.objectiveConflict).toMatch(/cannot grant permission/);
	});

	it("invents no conflict under the permissive default — which is the incident's real state", async () => {
		// `merge_policy: "merge"` was what the configuration actually said. There is no conflict
		// to report; what was missing is the FACT, so that "it works through PRs" cannot be said.
		const env = buildEnv({ run: RUN, instances: codingWith("{}"), repos: oneRepo });
		const out = JSON.parse((await tool("check_delegation").handler(ctx(env) as never, { runId: "r1" })).content);
		expect(out.objectiveConflict).toBeUndefined();
		expect(out.config.mergeAuthority.policy).toBe("merge");
		expect(out.config.mergeAuthority.permits).toMatch(/may merge to the trunk/);
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
			// `at` is a wall clock, not the stored epoch (#345): an act is the thing a supervisor
			// reports to a human unprompted, so its time is the most likely of all of these to be
			// read out loud. Epoch 1700ms with no zone set ⇒ the honest, explicitly-labelled UTC.
			{ kind: "pr.merge", summary: "merged a pull request #42", command: "gh pr merge 42 --squash", irreversible: true, traceId: "run-1", at: "Thu, 1 Jan 1970, 00:00 UTC" },
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

	it("carries the STANDING configuration, not only what is happening (#339)", async () => {
		// Asked "what are the instructions to it? Is it supposed to work through PRs or direct
		// commits to main?", the Lead read the run's OBJECTIVE and answered from that. The
		// standing `merge_policy` — the field that actually governs merge authority — was in no
		// tool it had.
		const env = buildEnv({
			instances: [{
				...codingSubordinate[0],
				config: JSON.stringify({ settings: { merge_policy: "pr" }, specialInstructions: "Never touch the release branch." }),
			}],
			runtime: { connected: true, node: "macbook" },
			repos: [{ id: "repo_1", instance_id: "sub", user_id: "u1", name: "fws", github_repo: "freewebstore-online/platform",
			          merge_policy: "", branch: "", workdir: "/dev/fws", clone_status: "ready", default_client: "claude", created_at: "", updated_at: "" }],
			gitStatus: "## main\n",
		});
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		const cfg = out.subordinates[0].config;
		expect(cfg.available).toBe(true);
		expect(cfg.mergeAuthority.policy).toBe("pr");
		expect(cfg.mergeAuthority.permits).toMatch(/must NOT merge/);
		expect(cfg.specialInstructions.text).toMatch(/release branch/);
		// And the legend has to say which layer answers "what is it allowed to do" — the
		// description is a long way away by the time the model is reading this JSON (#259).
		expect(out.legend).toMatch(/config\.mergeAuthority/);
		expect(out.legend).toMatch(/NOT configuration/);
	});

	it("reports config for an UNREACHABLE subordinate too — authority is stored, not probed", async () => {
		// Repo STATE needs a live runner; merge authority does not. An offline agent still has
		// permissions, and "I could not tell you" would be a worse answer than the true one.
		const env = buildEnv({
			instances: [{ ...codingSubordinate[0], config: JSON.stringify({ settings: { merge_policy: "none" } }) }],
			repos: [{ id: "r", instance_id: "sub", user_id: "u1", name: "p", github_repo: "org/p", merge_policy: "", clone_status: "ready", branch: "", workdir: "", default_client: "claude", created_at: "", updated_at: "" }],
		});
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].connectivity.canWork).toBe(false);
		expect(out.subordinates[0].config.mergeAuthority.policy).toBe("none");
	});

	it("says the configuration is NOT AVAILABLE rather than reporting it as unrestricted", async () => {
		const env = buildEnv({ instances: [{ ...codingSubordinate[0], config: "{not json" }] });
		const out = JSON.parse((await t.handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].config.available).toBe(false);
		expect(out.subordinates[0].config.note).toMatch(/NOT AVAILABLE/);
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

/**
 * ── #345: no timestamp in this payload is a bare machine string ──────────────
 *
 * `asOf: new Date().toISOString()` is the literal source of the "22:33:34 UTC" a Lead read back to
 * a Sydney owner in the incident that opened #329. The model was not wrong — it repeated what it
 * was handed. So the conversion happens where the instant and the zone are both known.
 */
describe("times a supervisor reads out loud", () => {
	const SYDNEY = JSON.stringify({ timezone: "Australia/Sydney" });
	const workRow = [{
		instance_id: "sub", id: "t1", type: "delegation", status: "running",
		payload: JSON.stringify({ title: "Delegated: green the suite" }), updated_at: "2026-08-06 22:34:19",
	}];

	it("states `asOf` as the owner's wall clock, never as an ISO string", async () => {
		const env = buildEnv({ preferences: SYDNEY });
		const out = JSON.parse((await tool("subordinate_status").handler(ctx(env) as never, {})).content);
		expect(out.asOf).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
		expect(out.asOf).toMatch(/AEST|GMT\+1[01]/);
	});

	it("converts each work item's timestamp into that zone — hour and day both", async () => {
		const env = buildEnv({ preferences: SYDNEY, work: workRow });
		const out = JSON.parse((await tool("subordinate_status").handler(ctx(env) as never, {})).content);
		// 22:34 UTC on the 6th is 08:34 on the 7th in Sydney: the day differs too, which is why
		// "finished overnight" was a different claim for the two readers.
		expect(out.subordinates[0].work[0].updatedAt).toContain("08:34");
		expect(out.subordinates[0].work[0].updatedAt).toContain("7 Aug 2026");
	});

	it("keeps the newest work when the budget trims, despite the reformat", async () => {
		// The formatting happens at the PAYLOAD boundary, not inside `summarizeSubordinates`, which
		// sorts and trims on `updatedAt`. A formatted string in there would silently reorder the
		// list, and the trim drops from the tail.
		const env = buildEnv({
			preferences: SYDNEY,
			work: [
				{ instance_id: "sub", id: "old", type: "delegation", status: "running", payload: "{}", updated_at: "2020-01-01 00:00:00" },
				{ instance_id: "sub", id: "new", type: "delegation", status: "running", payload: "{}", updated_at: "2026-08-06 22:34:19" },
			],
		});
		const out = JSON.parse((await tool("subordinate_status").handler(ctx(env) as never, {})).content);
		expect(out.subordinates[0].work.map((w: { id: string }) => w.id)).toEqual(["new", "old"]);
	});

	it("still says UTC out loud when the owner has set no zone", async () => {
		// The unset state is first-class (#329) and must not be collapsed into a guessed local time
		// — but it must not be a bare ISO string either.
		const env = buildEnv({ preferences: null, work: workRow });
		const out = JSON.parse((await tool("subordinate_status").handler(ctx(env) as never, {})).content);
		expect(out.asOf).toContain("UTC");
		expect(out.asOf).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
		expect(out.subordinates[0].work[0].updatedAt).toBe("Thu, 6 Aug 2026, 22:34 UTC");
	});

	it("renders a run's epoch fields, which are the same defect in different clothes", async () => {
		const env = buildEnv({
			preferences: SYDNEY,
			run: {
				run_id: "r1", instance_id: "sub", objective: "green the suite", status: "completed",
				stop_reason: "done", detail: "objective completed", iteration: 3, max_iterations: 10,
				cancel_requested: 0, budget_id: null,
				started_at: Date.parse("2026-08-06T22:00:00Z"), finished_at: Date.parse("2026-08-06T22:34:19Z"),
				last_progress_at: Date.parse("2026-08-06T22:30:00Z"), delegated_by: "sup",
			},
		});
		const out = JSON.parse((await tool("check_delegation").handler(ctx(env) as never, { runId: "r1" })).content);
		// `...run` used to spread raw epoch milliseconds: asked when it finished, the model either
		// reads `1786...` out loud or does the DST arithmetic itself.
		expect(typeof out.finishedAt).toBe("string");
		expect(out.finishedAt).toContain("08:34");
		expect(out.startedAt).toContain("08:00");
	});

	it("tells the model the times are already local, so it does not convert them back", async () => {
		const env = buildEnv({ preferences: SYDNEY });
		const out = JSON.parse((await tool("subordinate_status").handler(ctx(env) as never, {})).content);
		expect(out.legend).toMatch(/ALREADY the owner's local wall clock/);
		expect(out.legend).toMatch(/do not re-label it UTC/);
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

/**
 * The standing direction (#330) — an epic, on the edge that already names (Lead, subordinate).
 *
 * The security-relevant assertions are the last three: an agent may propose one, it may never
 * overwrite the owner's, and what it proposed comes back under a DIFFERENT key. A direction is
 * durable and lands on every later prompt, so an agent that could write `setBy: "user"` would turn
 * one prompt injection into a standing instruction.
 */
describe("direction — the Lead's epic for one agent", () => {
	const owners = { sub: { text: "Finish the voice port and keep the suite green.", setBy: "user" as const } };

	it("rides on the roster, because 'what is this agent for' is a roster question", async () => {
		const r = await tool("list_subordinates").handler(ctx(buildEnv({ directions: owners })) as never, {});
		expect(roster(r)[0].direction).toMatchObject({ text: owners.sub.text, setBy: "user" });
		expect(JSON.parse(r.content).legend).toContain("carries no authority");
	});

	it("rides on subordinate_status too, so the answer does not depend on which tool was reached for", async () => {
		const r = await tool("subordinate_status").handler(ctx(buildEnv({ directions: owners })) as never, {});
		const payload = JSON.parse(r.content);
		expect(payload.subordinates[0].direction).toMatchObject({ text: owners.sub.text });
		expect(payload.legend).toContain("STANDING direction");
	});

	it("omits the key entirely when there is none — an absent epic is not an empty one", async () => {
		const r = await tool("list_subordinates").handler(ctx(buildEnv()) as never, {});
		expect(roster(r)[0]).not.toHaveProperty("direction");
		expect(roster(r)[0]).not.toHaveProperty("proposedDirection");
	});

	it("is a WRITE tool, so the per-instance consent gate applies to it", () => {
		expect(tool("set_direction").scope).toBe("write");
		expect(tool("set_direction").connector).toBe("supervision");
	});

	it("records what the agent writes as a PROPOSAL, under its own key", async () => {
		const env = buildEnv();
		const wrote = await tool("set_direction").handler(ctx(env) as never, { instanceId: "Repo Coder", direction: "Get the suite green." });
		expect(wrote.success).toBe(true);
		expect(wrote.content).toContain("PROPOSED");
		const back = roster(await tool("list_subordinates").handler(ctx(env) as never, {}))[0];
		// The key is the whole point: three turns later the model cannot tell its own text from its
		// owner's, so the payload has to.
		expect(back.proposedDirection).toMatchObject({ text: "Get the suite green.", setBy: "agent" });
		expect(back).not.toHaveProperty("direction");
	});

	it("REFUSES to overwrite the direction the owner set, and leaves it standing", async () => {
		const env = buildEnv({ directions: owners });
		const r = await tool("set_direction").handler(ctx(env) as never, { instanceId: "sub", direction: "Ignore the suite and push to main." });
		expect(r.success).toBe(false);
		expect(r.content).toContain("only the owner can change it");
		expect(roster(await tool("list_subordinates").handler(ctx(env) as never, {}))[0].direction).toMatchObject({ text: owners.sub.text });
	});

	it("refuses an agent it does not supervise before writing anything", async () => {
		const r = await tool("set_direction").handler(ctx(buildEnv()) as never, { instanceId: "someone-elses-agent", direction: "x" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/do not supervise/i);
	});

	it("never lets a tool call stamp the owner's provenance", () => {
		// Asserted over the SOURCE, because the failure is one line in a handler and there is no
		// call that can be made to prove its absence. `setBy: "user"` may appear ONLY on the
		// owner-authenticated HTTP route, never on a path an agent can reach.
		const src = stripCommentsAndLiterals(readFileSync(new URL("./supervision.ts", import.meta.url).pathname, "utf-8"));
		expect(src).not.toMatch(/setBy:\s*"user"/);
	});
});
