/**
 * Tags and the fleet snapshot (#961), over the real schema and through `instanceRoutes` — so the
 * test also holds `/my/snapshot` ahead of every `/:instanceId/…` route. Only GitHub is faked.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
const { listIssuesPage } = vi.hoisted(() => ({ listIssuesPage: vi.fn() }));
vi.mock("../lib/github-issues.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/github-issues.js")>("../lib/github-issues.js");
	return { ...actual, listIssuesPage };
});

const { instanceRoutes } = await import("./instances.js");

const issue = (number: number, labels: string[] = []) => ({ number, title: `t${number}`, state: "open", labels, comments: 0, updatedAt: "", url: `u/${number}` });
const ISSUES: Record<string, unknown> = {
	"acme/todo": { issues: [issue(1), issue(2, ["needs-human"])], page: 1, hasMore: false },
	"acme/nh": { issues: [issue(3, ["blocked-on-serge"])], page: 1, hasMore: false },
	"acme/broken": { issues: [], page: 1, hasMore: false, unreadable: true },
	"acme/paused-todo": { issues: [issue(11), issue(12)], page: 1, hasMore: false },
};

let d1: RealSchemaD1;
const now = Date.now();
beforeEach(() => {
	listIssuesPage.mockReset();
	listIssuesPage.mockImplementation(async (_env: unknown, _uid: unknown, repo: string) => ISSUES[repo] ?? { issues: [], page: 1, hasMore: false });
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: [] });
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't961-coder', 'Repo Coder')`);
	const inst = (id: string, tags: string[], user = "u1") =>
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('${id}', 'ag', '${user}', 'active', '${JSON.stringify({ displayName: id, tags })}')`);
	inst("i-dec", ["store"]);
	inst("i-hard", ["store"]);
	inst("i-work", ["store"]);
	inst("i-todo", ["store"]);
	inst("i-todo2", ["store"]);
	inst("i-nh", ["Store"]);
	inst("i-unk", ["store"]);
	inst("i-idle", ["store"]);
	inst("i-untagged", []);
	inst("i-secret", ["ops"]);
	inst("i-foreign", ["store"], "u2");
	const run = (id: string, i: string, extra: string) =>
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, last_alive_at, last_progress_at${extra ? ", waiting_reason, waiting_until, parked_since" : ""})
		         VALUES ('${id}', 'u1', '${i}', 'Fix ${i}', 'running', 10, ${now}, ${now}, ${now}${extra})`);
	run("r-hard", "i-hard", `, 'human', ${now + 600_000}, ${now}`);
	run("r-work", "i-work", "");
	d1.exec(`INSERT INTO mcp_input_requests (id, instance_id, user_id, endpoint, tool, status, message, schema_json, expires_at)
	         VALUES ('m1', 'i-dec', 'u1', 'https://x', 'build', 'pending', 'Which template?', '[]', '2999-01-01 00:00:00'),
	                ('m2', 'i-idle', 'u1', 'https://x', 'build', 'pending', 'expired ask', '[]', '2000-01-01 00:00:00')`);
	d1.exec(`INSERT INTO secure_input_requests (id, instance_id, user_id, status, label, destination_scope, expires_at) VALUES ('s1', 'i-secret', 'u1', 'pending', 'otp', 'tmux', '2999-01-01 00:00:00')`);
	const repo = (id: string, i: string, gh: string) =>
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, provider, clone_status, default_client) VALUES ('${id}', '${i}', 'u1', '${gh}', '${gh}', 'github', 'ready', 'claude')`);
	repo("p1", "i-todo", "acme/todo");
	repo("p2", "i-todo2", "acme/todo");
	repo("p3", "i-nh", "acme/nh");
	repo("p4", "i-unk", "acme/broken");
});
afterEach(() => d1.close());

async function call(path: string, init: RequestInit = {}) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(path, init, { DB: d1.DB } as unknown as Env);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
type Snap = { instanceId: string; status: string; reason: string; tags: string[]; work: { objective: string } | null; decision: { pending: number; first: string } | null; issues: { actionable: number; next: Array<{ number: number }> } | null };

describe("GET /my/snapshot (#961)", () => {
	it("one call: every tagged instance with its derived status, most-needs-attention first", async () => {
		const { status, body } = await call("/v1/instances/my/snapshot?tag=store");
		expect(status).toBe(200);
		const rows = body.instances as Snap[];
		const by = Object.fromEntries(rows.map((r) => [r.instanceId, r.status]));
		expect(by).toEqual({
			"i-dec": "decision_blocked",
			"i-todo": "idle_needs_work",
			"i-todo2": "idle_needs_work",
			"i-hard": "hard_blocked",
			"i-nh": "hard_blocked",
			"i-work": "working",
			"i-unk": "unknown",
			"i-idle": "idle",
		});
		// Ordered by what needs the reader, and only the caller's own, tagged instances.
		expect(rows.map((r) => r.status)).toEqual(["decision_blocked", "idle_needs_work", "idle_needs_work", "hard_blocked", "hard_blocked", "working", "unknown", "idle"]);
		expect(body.counts).toMatchObject({ "decision_blocked": 1, "idle_needs_work": 2, "hard_blocked": 2, working: 1, unknown: 1, idle: 1 });
		expect(body.total).toBe(8);
	});

	it("carries the work in flight, the question waiting, and the next issues to hand over", async () => {
		const rows = (await call("/v1/instances/my/snapshot?tags=store")).body.instances as Snap[];
		const get = (id: string) => rows.find((r) => r.instanceId === id)!;
		expect(get("i-work").work?.objective).toBe("Fix i-work");
		expect(get("i-dec").decision).toEqual({ pending: 1, first: "Which template?" });
		// An expired ask is not a decision waiting.
		expect(get("i-idle").decision).toBeNull();
		expect(get("i-todo").issues).toMatchObject({ actionable: 1, next: [{ number: 1 }] });
		expect(get("i-hard").reason).toContain("cannot be answered from chat");
	});

	it("reads a repo once however many instances share it", async () => {
		await call("/v1/instances/my/snapshot?tag=store");
		const repos = listIssuesPage.mock.calls.map((c) => c[2]);
		expect(repos.filter((r) => r === "acme/todo")).toHaveLength(1);
	});

	/**
	 * #1028, the live case: DoorDrop (paused, open unlabelled issues) read idle_needs_work, Properties
	 * (paused, repo unreadable) read unknown, and the paused Leads coder (a run parked on a person) read
	 * hard_blocked — the snapshot never selected `agent_instances.status`.
	 */
	it("a paused coder is `paused` — never idle_needs_work, unknown or hard_blocked — and its backlog is neither read nor offered (#1028)", async () => {
		const paused = (id: string) =>
			d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('${id}', 'ag', 'u1', 'paused', '${JSON.stringify({ displayName: id, tags: ["held"] })}')`);
		paused("i-doordrop");
		paused("i-properties");
		paused("i-leads");
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, provider, clone_status, default_client) VALUES
		           ('pd', 'i-doordrop', 'u1', 'pt', 'acme/paused-todo', 'github', 'ready', 'claude'),
		           ('pp', 'i-properties', 'u1', 'pb', 'acme/broken', 'github', 'ready', 'claude')`);
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, last_alive_at, last_progress_at, waiting_reason, waiting_until, parked_since)
		         VALUES ('r-leads', 'u1', 'i-leads', 'Fix leads', 'running', 10, ${now}, ${now}, ${now}, 'human', ${now + 600_000}, ${now})`);
		const { body } = await call("/v1/instances/my/snapshot?tag=held");
		const rows = body.instances as Snap[];
		expect(Object.fromEntries(rows.map((r) => [r.instanceId, r.status]))).toEqual({ "i-doordrop": "paused", "i-properties": "paused", "i-leads": "paused" });
		for (const r of rows) {
			expect(r.reason).toMatch(/Paused — it takes no work until it is resumed/);
			expect(r.issues).toBeNull(); // no `next` work suggestion, however many issues are open
		}
		expect(body.counts).toMatchObject({ paused: 3, idle_needs_work: 0, unknown: 0, hard_blocked: 0 });
		// A paused coder's repo is not read at all.
		expect(listIssuesPage.mock.calls.map((c) => c[2])).not.toContain("acme/paused-todo");
		// And it can be asked for by status, like any other.
		const only = (await call("/v1/instances/my/snapshot?status=paused")).body.instances as Snap[];
		expect(only.map((r) => r.instanceId).sort()).toEqual(["i-doordrop", "i-leads", "i-properties"]);
	});

	it("active coders are unchanged by a paused neighbour sharing their repo (#1028)", async () => {
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i-p-share', 'ag', 'u1', 'paused', '${JSON.stringify({ displayName: "share", tags: ["store"] })}')`);
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, provider, clone_status, default_client) VALUES ('ps', 'i-p-share', 'u1', 'todo', 'acme/todo', 'github', 'ready', 'claude')`);
		const rows = (await call("/v1/instances/my/snapshot?tag=store")).body.instances as Snap[];
		const by = Object.fromEntries(rows.map((r) => [r.instanceId, r.status]));
		expect(by).toMatchObject({ "i-todo": "idle_needs_work", "i-todo2": "idle_needs_work", "i-unk": "unknown", "i-nh": "hard_blocked", "i-p-share": "paused" });
		expect(rows.find((r) => r.instanceId === "i-todo")?.issues?.next.map((n) => n.number)).toEqual([1]);
		expect(rows.map((r) => r.status)).toEqual(["decision_blocked", "idle_needs_work", "idle_needs_work", "hard_blocked", "hard_blocked", "working", "unknown", "paused", "idle"]);
	});

	it("filters by status, and refuses a status that does not exist", async () => {
		const rows = (await call("/v1/instances/my/snapshot?tag=store&status=decision_blocked,idle_needs_work")).body.instances as Snap[];
		expect(rows.map((r) => r.instanceId).sort()).toEqual(["i-dec", "i-todo", "i-todo2"]);
		expect((await call("/v1/instances/my/snapshot?status=busy")).status).toBe(400);
	});

	it("a pending secret is hard_blocked; no tag lists every instance of the caller", async () => {
		const ops = (await call("/v1/instances/my/snapshot?tag=ops")).body.instances as Snap[];
		expect(ops).toEqual([expect.objectContaining({ instanceId: "i-secret", status: "hard_blocked" })]);
		const all = (await call("/v1/instances/my/snapshot")).body.instances as Snap[];
		expect(all).toHaveLength(10);
		expect(all.some((r) => r.instanceId === "i-foreign")).toBe(false);
	});
});

describe("instance tags (#961)", () => {
	it("are set, read back, listed on my/instances, and cleared", async () => {
		expect((await call("/v1/instances/i-untagged/tags", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: ["PAS-apps", "pas-apps", "store"] }) })).body).toEqual({ tags: ["PAS-apps", "store"] });
		expect((await call("/v1/instances/i-untagged/tags")).body).toEqual({ tags: ["PAS-apps", "store"] });
		const listed = (await call("/v1/instances/my/instances")).body.instances as Array<{ id: string; tags?: string[] }>;
		expect(listed.find((i) => i.id === "i-untagged")?.tags).toEqual(["PAS-apps", "store"]);
		// The display name the config already held is untouched by the tag write.
		expect(listed.find((i) => i.id === "i-untagged")).toMatchObject({ name: "i-untagged" });
		await call("/v1/instances/i-untagged/tags", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: [] }) });
		expect((await call("/v1/instances/i-untagged/tags")).body).toEqual({ tags: [] });
	});

	it("refuses a bad tag with its reason, and another owner's instance", async () => {
		const bad = await call("/v1/instances/i-idle/tags", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: ["a/b"] }) });
		expect(bad.status).toBe(400);
		expect(String(bad.body.error)).toContain('"a/b"');
		expect((await call("/v1/instances/i-foreign/tags")).status).toBe(404);
		expect((await call("/v1/instances/i-foreign/tags", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: ["x"] }) })).status).toBe(404);
	});
});

describe("my/instances names a Gmail Scout by source_mode, never by its Gmail tools (#1115)", () => {
	it("agent or instance source_mode gmail lists sourceMode; the Runner with the same Gmail reads does not", async () => {
		const tools = { capabilities: { runtime: "local_apply", tools: ["gmail_search", "gmail_read_message"] } };
		d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES
			('ag-scout', 'u1', 't1115-scout', 'Scout', '${JSON.stringify({ source_mode: "gmail", capabilities: { tools: ["gmail_search", "gmail_read_message"] } })}'),
			('ag-runner', 'u1', 't1115-runner', 'Runner', '${JSON.stringify(tools)}')`);
		d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
			('i-scout', 'ag-scout', 'u1', 'active', '{}'),
			('i-scout-inst', 'ag', 'u1', 'active', '${JSON.stringify({ source_mode: "gmail" })}'),
			('i-runner', 'ag-runner', 'u1', 'active', '{}')`);
		const listed = (await call("/v1/instances/my/instances")).body.instances as Array<{ id: string; sourceMode?: string }>;
		const mode = (id: string) => listed.find((i) => i.id === id)?.sourceMode;
		expect(mode("i-scout")).toBe("gmail");
		expect(mode("i-scout-inst")).toBe("gmail");
		expect(mode("i-runner")).toBeUndefined();
		expect(listed.find((i) => i.id === "i-runner")).not.toHaveProperty("sourceMode");
		expect(mode("i-idle")).toBeUndefined();
	});
});
