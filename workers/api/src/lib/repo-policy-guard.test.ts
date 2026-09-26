/**
 * Standing policies: loop prevention, audit, scope and permission boundaries (#322), on the REAL
 * migrated schema. The flap breaker's memory is a query over the trace, and the properties that matter
 * (which rows count, whose rows count) are properties of that SQL, which a text-matching double
 * cannot check.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "./auth.js";
import { realSchemaD1, type RealSchemaD1, seedTenant } from "./d1-sqlite.js";
import { enforceRepoPolicies, FLAP_LIMIT, FLAP_WINDOW_MS } from "./repo-policy-act.js";
import type { RunnerConn } from "./runner-client.js";
import { signSession } from "./session.js";
import { registerRepoRoutes } from "../routes/coding-repos.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
afterEach(() => {
	d1?.close();
	d1 = undefined as unknown as RealSchemaD1;
});

/**
 * A machine whose checkout keeps drifting: every observation reads `fix/36`, the switch confirms
 * (the second read after a write says `main`), and by the next run end something has moved it off
 * again. That is the tug-of-war the breaker exists to end.
 */
function driftingMachine() {
	const calls: string[] = [];
	let justWrote = false;
	const env = {
		RELAY: {
			idFromName: (n: string) => n,
			get: () => ({
				async fetch(req: Request) {
					const { path } = (await req.json()) as { path: string };
					calls.push(path);
					if (path === "/coding/git-write") {
						justWrote = true;
						return Response.json({ ok: true, changed: true, from: "fix/36", to: "main", branch: "main" });
					}
					const output = justWrote ? "## main\n" : "## fix/36\n";
					justWrote = false;
					return Response.json({ output });
				},
			}),
		},
	};
	const conn = { env, instanceId: "inst_1", relayName: "inst_1:node:Mac", runnerNode: "Mac" } as unknown as RunnerConn;
	return { conn, calls, writes: () => calls.filter((p) => p === "/coding/git-write").length };
}

function setup(policies: Record<string, string> = { "repo.on_default_branch": "act" }) {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "user_1", instanceIds: ["inst_1"] });
	seedTenant(d1, { userId: "user_2", instanceIds: ["inst_2"] });
	d1.exec(
		`INSERT INTO coding_repos (id, instance_id, user_id, name, branch, workdir, policies)
		 VALUES ('repo_1', 'inst_1', 'user_1', 'fws/platform', 'main', '~/dev/fws/platform', '${JSON.stringify(policies)}')`,
	);
	const machine = driftingMachine();
	const env = { ...(machine.conn.env as object), DB: d1.DB } as unknown as Env;
	const runEnd = (userId = "user_1") =>
		enforceRepoPolicies(env, { conn: machine.conn, instanceId: "inst_1", userId, repoId: "repo_1", repoLabel: "fws/platform", sessionId: null });
	return { env, machine, runEnd };
}

/** A prior `policy.act` row, as `enforceRepoPolicies` writes one. */
function priorAct(over: { ts?: number; userId?: string; instanceId?: string; repoId?: string; policy?: string; status?: string } = {}) {
	const context = JSON.stringify({ policy: over.policy ?? "repo.on_default_branch", repoId: over.repoId ?? "repo_1", verb: "switch_branch", branch: "main", status: over.status ?? "confirmed" });
	d1.sqlite
		.prepare("INSERT INTO agent_events (id, ts, user_id, instance_id, source, level, event, message, context) VALUES (?, ?, ?, ?, 'coding', 'info', 'policy.act', 'x', ?)")
		.run(crypto.randomUUID(), over.ts ?? Date.now() - 60_000, over.userId ?? "user_1", over.instanceId ?? "inst_1", context);
}

const events = (event: string) =>
	(d1.sqlite.prepare("SELECT user_id, instance_id, context FROM agent_events WHERE event = ? ORDER BY ts").all(event) as Array<{ user_id: string; instance_id: string; context: string }>).map((r) => ({
		...r,
		context: JSON.parse(r.context),
	}));
const card = () => d1.sqlite.prepare("SELECT status, payload FROM instance_runtime_tasks WHERE id LIKE 'repo-policy%' OR id LIKE 'repo-%'").all() as Array<{ status: string; payload: string }>;

describe("loop prevention — the flap breaker (#322)", () => {
	it("a policy fighting something that keeps undoing it stops after FLAP_LIMIT confirmed switches, and says so", async () => {
		const { machine, runEnd } = setup();
		for (let i = 0; i < FLAP_LIMIT; i++) await runEnd();
		expect(machine.writes()).toBe(FLAP_LIMIT);
		expect(events("policy.act").filter((e) => e.context.status === "confirmed")).toHaveLength(FLAP_LIMIT);

		// The next run end observes the same drift — and does NOT act again.
		await runEnd();
		expect(machine.writes()).toBe(FLAP_LIMIT);
		const halted = events("policy.halted");
		expect(halted).toHaveLength(1);
		expect(halted[0]).toMatchObject({ user_id: "user_1", instance_id: "inst_1", context: { policy: "repo.on_default_branch", repoId: "repo_1", confirmed: FLAP_LIMIT, limit: FLAP_LIMIT } });
		// The violation stays VISIBLE: an open needs_human card naming why it stopped.
		const [open] = card();
		expect(open.status).toBe("needs_human");
		expect(JSON.parse(open.payload).title).toBe("fws/platform keeps leaving main");
		expect(JSON.parse(open.payload).description).toMatch(/stopped acting on this repo/);
	});

	it("below the limit it still acts", async () => {
		const { machine, runEnd } = setup();
		for (let i = 0; i < FLAP_LIMIT - 1; i++) priorAct();
		await runEnd();
		expect(machine.writes()).toBe(1);
		expect(events("policy.halted")).toEqual([]);
	});

	it("resumes by itself once the window drains — history older than the window does not count", async () => {
		const { machine, runEnd } = setup();
		for (let i = 0; i < FLAP_LIMIT; i++) priorAct({ ts: Date.now() - FLAP_WINDOW_MS - 60_000 });
		await runEnd();
		expect(machine.writes()).toBe(1);
	});

	it("only THIS owner's, THIS instance's, THIS repo's, THIS policy's CONFIRMED switches count", async () => {
		const { machine, runEnd } = setup();
		for (let i = 0; i < FLAP_LIMIT; i++) {
			priorAct({ repoId: "repo_other" });
			priorAct({ policy: "repo.tree_clean" });
			priorAct({ status: "refused" });
			priorAct({ status: "unconfirmed" });
			priorAct({ userId: "user_2", instanceId: "inst_2" });
			priorAct({ userId: "user_2" }); // another owner's row naming this instance
		}
		await runEnd();
		expect(machine.writes()).toBe(1);
		expect(events("policy.halted")).toEqual([]);
	});

	it("a count that cannot be read acts on nothing that tick", async () => {
		const { machine, runEnd } = setup();
		d1.exec("DROP TABLE agent_events");
		await runEnd();
		expect(machine.writes()).toBe(0);
	});
});

describe("scope and permission boundaries (#322)", () => {
	it("another owner's run end reaches nothing on this owner's repo", async () => {
		const { machine, runEnd } = setup();
		expect(await runEnd("user_2")).toEqual([]);
		expect(machine.writes()).toBe(0);
		expect(card()).toEqual([]);
	});

	it("observe never acts, however long the violation holds", async () => {
		const { machine, runEnd } = setup({ "repo.on_default_branch": "observe" });
		for (let i = 0; i < FLAP_LIMIT + 1; i++) await runEnd();
		expect(machine.writes()).toBe(0);
		expect(events("policy.halted")).toEqual([]);
	});

	it("the only thing that reaches the machine is the one fixed verb", async () => {
		const { machine, runEnd } = setup({ "repo.on_default_branch": "act", "repo.tree_clean": "observe" });
		await runEnd();
		expect(new Set(machine.calls)).toEqual(new Set(["/coding/git", "/coding/git-write"]));
	});
});

describe("audit — who declared a policy, and from what (#322)", () => {
	const SECRET = "policy-audit-secret";
	async function put(uid: string, instanceId: string, body: unknown) {
		const app = new Hono<{ Bindings: Env }>();
		const coding = new Hono<{ Bindings: Env }>();
		registerRepoRoutes(coding);
		app.route("/v1/instances", coding);
		app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: String(err) }, 500)));
		return app.request(
			`/v1/instances/${instanceId}/coding/repos/repo_1`,
			{ method: "PUT", headers: { Authorization: `Bearer ${await signSession(uid, SECRET, { roles: [] })}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
			{ SESSION_SIGNING_KEY: SECRET, DB: d1.DB } as unknown as Env,
		);
	}

	it("a promotion to act is recorded with what it replaced and who made it", async () => {
		setup({ "repo.on_default_branch": "observe" });
		const res = await put("user_1", "inst_1", { policies: { "repo.on_default_branch": "act" } });
		expect(res.status).toBe(200);
		const [declared] = events("policy.declared");
		expect(declared).toMatchObject({
			user_id: "user_1",
			instance_id: "inst_1",
			context: { repoId: "repo_1", before: { "repo.on_default_branch": "observe" }, after: { "repo.on_default_branch": "act" }, by: "user_1" },
		});
	});

	it("clearing every policy is recorded too", async () => {
		setup();
		await put("user_1", "inst_1", { policies: {} });
		expect(events("policy.declared")[0].context).toMatchObject({ before: { "repo.on_default_branch": "act" }, after: null });
	});

	it("a refused value, and another owner's attempt, change nothing and record nothing", async () => {
		setup({ "repo.on_default_branch": "observe" });
		expect((await put("user_1", "inst_1", { policies: { "repo.tree_clean": "act" } })).status).toBe(400);
		expect((await put("user_2", "inst_1", { policies: { "repo.on_default_branch": "act" } })).status).toBe(404);
		expect(events("policy.declared")).toEqual([]);
		expect(d1.sqlite.prepare("SELECT policies FROM coding_repos WHERE id = 'repo_1'").get()).toEqual({ policies: '{"repo.on_default_branch":"observe"}' });
	});
});
