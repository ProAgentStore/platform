import { describe, expect, it } from "vitest";
import { classifyRunnerError, describeRepoPolicyAct, enforceRepoPolicies, runRepoPolicyRemediation, SWITCH_BRANCH_MIN_CLI, type RepoPolicyActOutcome } from "./repo-policy-act.js";
import type { CodingRepo } from "./coding-types.js";
import type { RunnerConn } from "./runner-client.js";
import { RunnerUnreachableError } from "./runner-unreachable.js";
import type { Env } from "../types.js";

/**
 * The acting half of standing policies (#322).
 *
 * WHAT THIS SUITE DOES NOT COVER, said plainly rather than discovered later: it drives the real
 * `callRunner` path against a fake relay socket, so it proves what the CLOUD asks and what the
 * cloud reports about the answer. It cannot prove the machine did what it said — that is
 * `packages/browser-runner/src/coding/repo-write.test.ts`, which runs git against a real checkout.
 * The seam between them is the wire shape, which is declared twice on purpose (the worker does not
 * depend on the runner package) and is therefore the thing most able to drift.
 */

const REPO: CodingRepo = {
	id: "repo_1",
	instanceId: "inst_1",
	userId: "user_1",
	name: "fws/platform",
	provider: "github",
	branch: "main",
	workdir: "~/dev/fws/platform",
	cloneStatus: "ready",
	defaultClient: "claude",
	createdAt: "2026-08-08T00:00:00Z",
	updatedAt: "2026-08-08T00:00:00Z",
} as CodingRepo;

/**
 * A relay that answers `/coding/git-write` and `/coding/git` however the test says.
 *
 * `status` on the write is what an OLD runner (404) or a broken one (500) produces, since the
 * runner's own refusals come back as a 200 with a `refused` field.
 */
function fakeConn(opts: {
	write?: unknown;
	writeStatus?: number;
	/** What the read-only status call reports. `null` → the read fails. */
	statusOutput?: string | null;
	/** Successive answers to successive status calls — the observation, then the confirmation. */
	statusOutputs?: string[];
	calls?: Array<{ path: string; body: unknown }>;
}): RunnerConn {
	const calls = opts.calls ?? [];
	const queue = [...(opts.statusOutputs ?? [])];
	const env = {
		RELAY: {
			idFromName: (n: string) => n,
			get: () => ({
				async fetch(req: Request) {
					const body = (await req.json()) as { path: string; body: unknown };
					calls.push({ path: body.path, body: body.body });
					if (body.path === "/coding/git-write") {
						if (opts.writeStatus && opts.writeStatus !== 200) return new Response("nope", { status: opts.writeStatus });
						return new Response(JSON.stringify(opts.write ?? {}));
					}
					if (body.path === "/coding/git") {
						if (queue.length) return new Response(JSON.stringify({ output: queue.shift() }));
						if (opts.statusOutput === null) return new Response("gone", { status: 503 });
						return new Response(JSON.stringify({ output: opts.statusOutput ?? "## main\n" }));
					}
					return new Response("no", { status: 404 });
				},
			}),
		},
	} as unknown as Env;
	return { env, instanceId: "inst_1", relayName: "inst_1:node:Mac", runnerNode: "Mac" } as unknown as RunnerConn;
}

const REMEDIATION = { verb: "switch_branch", branch: "main" } as const;

describe("classifyRunnerError — an old CLI is not a failure", () => {
	it("names a 404 as an old runner, with the fix", () => {
		const r = classifyRunnerError(new Error("Runner /coding/git-write → 404: not found"));
		expect(r.status).toBe("unsupported");
		// Names the floor, because "update the CLI" without a number is a version somebody has to
		// go and find. This one is the release that ships the endpoint.
		expect(r.detail).toContain(SWITCH_BRANCH_MIN_CLI);
	});

	it("a disconnect is UNCONFIRMED, never failed — nobody knows whether it ran", () => {
		// Judged by `isRunnerUnreachable`, which owns the rule — including the marker that survives
		// a Workflow step boundary, where the receiving side gets a message and not a prototype.
		expect(classifyRunnerError(new RunnerUnreachableError("No runner connected — the relay has no live socket for this agent.")).status).toBe("unconfirmed");
		expect(classifyRunnerError(new Error("Runner /coding/git-write → 504: Runner disconnected")).status).toBe("unconfirmed");
	});

	it("anything else is a failure, quoted", () => {
		const r = classifyRunnerError(new Error("Runner /coding/git-write → 500: boom"));
		expect(r.status).toBe("failed");
		expect(r.detail).toContain("500");
	});
});

describe("runRepoPolicyRemediation — what was asked vs what was confirmed (#408's standard)", () => {
	it("asks for exactly one fixed-argv switch, and confirms with a SEPARATE read", async () => {
		const calls: Array<{ path: string; body: unknown }> = [];
		const outcome = await runRepoPolicyRemediation(fakeConn({ write: { ok: true, changed: true, from: "fix/36", to: "main", branch: "main" }, statusOutput: "## main\n", calls }), {
			repo: REPO,
			sessionId: "sess_1",
			remediation: REMEDIATION,
		});
		expect(outcome.status).toBe("confirmed");
		expect(outcome.from).toBe("fix/36");
		expect(outcome.observed).toBe("main");
		// The confirmation is a different endpoint from the write on purpose: a card that says
		// "done" on the writer's own account of its work is the failure #408 is about.
		expect(calls.map((c) => c.path)).toEqual(["/coding/git-write", "/coding/git"]);
		expect(calls[0]?.body).toMatchObject({ cmd: "switch-branch", branch: "main" });
	});

	it("is UNCONFIRMED when the write claims success and the read disagrees", async () => {
		const outcome = await runRepoPolicyRemediation(fakeConn({ write: { ok: true, changed: true, from: "fix/36", branch: "main" }, statusOutput: "## fix/36\n" }), {
			repo: REPO,
			sessionId: null,
			remediation: REMEDIATION,
		});
		expect(outcome.status).toBe("unconfirmed");
		expect(outcome.detail).toContain("still reads `fix/36`");
	});

	it("is UNCONFIRMED when the read cannot be taken at all", async () => {
		const outcome = await runRepoPolicyRemediation(fakeConn({ write: { ok: true, changed: true, from: "fix/36" }, statusOutput: null }), {
			repo: REPO,
			sessionId: null,
			remediation: REMEDIATION,
		});
		expect(outcome.status).toBe("unconfirmed");
		expect(outcome.detail).toContain("could not be read back");
	});

	it("reports the machine's own refusal in its own terms", async () => {
		const outcome = await runRepoPolicyRemediation(fakeConn({ write: { ok: false, refused: "dirty", from: "fix/36" } }), {
			repo: REPO,
			sessionId: null,
			remediation: REMEDIATION,
		});
		expect(outcome.status).toBe("refused");
		expect(outcome.detail).toContain("uncommitted changes");
	});

	it("does not confirm anything after a refusal — it never even re-reads", async () => {
		const calls: Array<{ path: string; body: unknown }> = [];
		await runRepoPolicyRemediation(fakeConn({ write: { refused: "unknown-branch" }, calls }), { repo: REPO, sessionId: null, remediation: REMEDIATION });
		expect(calls.map((c) => c.path)).toEqual(["/coding/git-write"]);
	});

	it("an old runner is UNSUPPORTED, and the checkout is untouched", async () => {
		const outcome = await runRepoPolicyRemediation(fakeConn({ writeStatus: 404 }), { repo: REPO, sessionId: null, remediation: REMEDIATION });
		expect(outcome.status).toBe("unsupported");
	});
});

describe("describeRepoPolicyAct — the card says what happened and how to undo it", () => {
	const outcome = (over: Partial<RepoPolicyActOutcome>): RepoPolicyActOutcome => ({
		status: "confirmed",
		requested: REMEDIATION,
		from: "fix/36",
		observed: "main",
		detail: "",
		...over,
	});

	it("a confirmed switch closes the card, names the branch it came from, and prints the undo", () => {
		const card = describeRepoPolicyAct("repo.on_default_branch", "fws/platform", outcome({}));
		expect(card.status).toBe("completed");
		expect(card.title).toBe("Switched fws/platform back to main");
		expect(card.description).toContain("Was on `fix/36`");
		expect(card.description).toContain("Undo: `git checkout fix/36`");
		// Why it was safe to do unattended, on the card, every time.
		expect(card.description).toContain("nothing came with it");
		expect(card.description).toContain("(standing policy `repo.on_default_branch`)");
	});

	it("EVERY other outcome leaves the card open and says the repo was not changed", () => {
		for (const status of ["unconfirmed", "unsupported", "refused", "failed"] as const) {
			const card = describeRepoPolicyAct("repo.on_default_branch", "fws/platform", outcome({ status, detail: "some reason" }));
			expect(card.status).toBe("needs_human");
			expect(card.description).toContain("did not happen");
			expect(card.description).toContain("Nothing was changed");
			expect(card.description).not.toContain("Undo");
		}
	});

	it("keeps the description inside the cap, attribution included", () => {
		const card = describeRepoPolicyAct("repo.on_default_branch", "x".repeat(400), outcome({ status: "failed", detail: "y".repeat(400) }));
		expect(card.title.length).toBeLessThanOrEqual(200);
		expect(card.description.length).toBeLessThanOrEqual(300);
		expect(card.description).toContain("(standing policy `repo.on_default_branch`)");
	});
});

/** A D1 double that answers the one repo read `enforceRepoPolicies` makes, and records card writes. */
function fakeEnv(repo: CodingRepo | null, conn: RunnerConn, writes: Array<{ sql: string; binds: unknown[] }>): Env {
	const DB = {
		prepare(sql: string) {
			return {
				// `logEvent`'s ~1% opportunistic retention DELETE runs straight off `prepare`, with no
				// bind. Answering it here rather than letting it throw keeps a 1-in-100 stderr line
				// out of an otherwise deterministic suite.
				async run() {
					writes.push({ sql, binds: [] });
					return { success: true };
				},
				bind(...binds: unknown[]) {
					return {
						async first() {
							if (!repo) return null;
							return {
								id: repo.id,
								instance_id: repo.instanceId,
								user_id: repo.userId,
								name: repo.name,
								provider: repo.provider,
								branch: repo.branch,
								workdir: repo.workdir,
								clone_status: repo.cloneStatus,
								default_client: repo.defaultClient,
								policies: JSON.stringify(repo.policies ?? {}),
								created_at: repo.createdAt,
								updated_at: repo.updatedAt,
							};
						},
						async run() {
							writes.push({ sql, binds });
							return { success: true };
						},
						async all() {
							return { results: [] };
						},
					};
				},
			};
		},
	};
	return { ...(conn.env as object), DB } as unknown as Env;
}

describe("enforceRepoPolicies — the run-end hook", () => {
	it("acts on a promoted violation and writes the outcome card", async () => {
		const calls: Array<{ path: string; body: unknown }> = [];
		const conn = fakeConn({
			// The first read (the observation) says fix/36; the write reports the move; the second
			// read is the confirmation. This double answers both reads the same way, so the
			// observation and the confirmation are made to disagree deliberately in the next test.
			statusOutput: "## fix/36\n",
			write: { ok: true, changed: true, from: "fix/36", to: "main", branch: "main" },
			calls,
		});
		const writes: Array<{ sql: string; binds: unknown[] }> = [];
		const env = fakeEnv({ ...REPO, policies: { "repo.on_default_branch": "act" } }, conn, writes);
		const findings = await enforceRepoPolicies(env, { conn, instanceId: "inst_1", userId: "user_1", repoId: "repo_1", repoLabel: "fws/platform", sessionId: "sess_1" });
		expect(findings.find((f) => f.policy === "repo.on_default_branch")?.remediation).toEqual(REMEDIATION);
		expect(calls.map((c) => c.path)).toContain("/coding/git-write");
		// The re-read reports fix/36 (this double is not stateful), so the honest report is that the
		// cloud asked and the machine did not corroborate — NOT that the branch was restored.
		const card = writes.find((w) => w.sql.startsWith("INSERT INTO instance_runtime_tasks"));
		expect(String(card?.binds[5])).toContain("did not happen");
		expect(String(card?.binds[4])).toBe("needs_human");
		// …and the run log carries the same sentence, which is the second surface #322 asks for.
		expect(writes.some((w) => w.sql.includes("coding_timeline") && String(w.binds[4]).includes("standing policy `repo.on_default_branch`"))).toBe(true);
	});

	it("writes the act to the unified trace, whether or not it worked", async () => {
		// #322's second acceptance criterion is that an autonomous action is answerable from the RUN
		// LOG, not only from a board card somebody may already have closed. `agent_events` is what
		// GET /trace and MCP `agent_trace` read, and it does not need a session to exist.
		const conn = fakeConn({ statusOutput: "## fix/36\n", write: { refused: "dirty", from: "fix/36" } });
		const writes: Array<{ sql: string; binds: unknown[] }> = [];
		const env = fakeEnv({ ...REPO, policies: { "repo.on_default_branch": "act" } }, conn, writes);
		await enforceRepoPolicies(env, { conn, instanceId: "inst_1", userId: "user_1", repoId: "repo_1", repoLabel: "fws/platform", sessionId: null });
		const ev = writes.find((w) => w.sql.startsWith("INSERT INTO agent_events"));
		expect(ev).toBeTruthy();
		expect(String(ev?.binds[7])).toBe("policy.act");
		expect(String(ev?.binds[8])).toContain("standing policy `repo.on_default_branch`");
		// The context carries the machine-readable half: which policy, which verb, what came of it.
		expect(JSON.parse(String(ev?.binds[9]))).toMatchObject({ policy: "repo.on_default_branch", verb: "switch_branch", branch: "main", status: "refused" });
	});

	it("a confirmed switch replaces the violation card with what it DID, and how to undo it", async () => {
		const conn = fakeConn({
			// Observation, then confirmation — the machine really moved between the two.
			statusOutputs: ["## fix/36\n", "## main\n"],
			write: { ok: true, changed: true, from: "fix/36", to: "main", branch: "main" },
		});
		const writes: Array<{ sql: string; binds: unknown[] }> = [];
		const env = fakeEnv({ ...REPO, policies: { "repo.on_default_branch": "act" } }, conn, writes);
		await enforceRepoPolicies(env, { conn, instanceId: "inst_1", userId: "user_1", repoId: "repo_1", repoLabel: "fws/platform", sessionId: "sess_1" });
		const card = writes.find((w) => w.sql.startsWith("INSERT INTO instance_runtime_tasks"));
		expect(String(card?.binds[4])).toBe("completed");
		expect(String(card?.binds[5])).toContain("Undo: `git checkout fix/36`");
		expect(String(card?.binds[5])).toContain("Switched fws/platform back to main");
	});

	it("does not call the write surface at all when the policy is only observing", async () => {
		const calls: Array<{ path: string; body: unknown }> = [];
		const conn = fakeConn({ statusOutput: "## fix/36\n", calls });
		const writes: Array<{ sql: string; binds: unknown[] }> = [];
		const env = fakeEnv({ ...REPO, policies: { "repo.on_default_branch": "observe" } }, conn, writes);
		await enforceRepoPolicies(env, { conn, instanceId: "inst_1", userId: "user_1", repoId: "repo_1", repoLabel: "fws/platform", sessionId: "sess_1" });
		expect(calls.map((c) => c.path)).not.toContain("/coding/git-write");
	});

	it("does not act when the checkout could not be read — a dropped socket is not a violation (#440)", async () => {
		const calls: Array<{ path: string; body: unknown }> = [];
		const conn = fakeConn({ statusOutput: null, calls });
		const writes: Array<{ sql: string; binds: unknown[] }> = [];
		const env = fakeEnv({ ...REPO, policies: { "repo.on_default_branch": "act" } }, conn, writes);
		const findings = await enforceRepoPolicies(env, { conn, instanceId: "inst_1", userId: "user_1", repoId: "repo_1", repoLabel: "fws/platform", sessionId: "sess_1" });
		expect(findings.every((f) => f.status === "unknown" || f.status === "unclaimed")).toBe(true);
		expect(calls.map((c) => c.path)).not.toContain("/coding/git-write");
	});

	it("survives a repo that is gone", async () => {
		const conn = fakeConn({});
		const env = fakeEnv(null, conn, []);
		await expect(enforceRepoPolicies(env, { conn, instanceId: "inst_1", userId: "user_1", repoId: "repo_1", repoLabel: "x", sessionId: null })).resolves.toEqual([]);
	});
});
