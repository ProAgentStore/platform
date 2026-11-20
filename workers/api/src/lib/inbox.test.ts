import { describe, expect, it } from "vitest";
import { INBOX_KINDS, applyInboxQuery, countInbox, inboxCounts, readInbox, toIso, type InboxItem } from "./inbox.js";
import type { Env } from "../types.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");

/** A fake D1: rows (or an error) per source table, matched on the `FROM <table> r` the query names. */
function fakeEnv(rows: Record<string, Array<Record<string, unknown>> | Error>, seen: string[] = []): Env {
	const find = (sql: string) => Object.keys(rows).find((t) => sql.includes(`FROM ${t} r`));
	return {
		DB: {
			prepare(sql: string) {
				seen.push(sql);
				return {
					bind: () => ({
						async all() {
							const r = rows[find(sql) ?? ""];
							if (r instanceof Error) throw r;
							return { results: r ?? [] };
						},
						async first() {
							const r = rows[find(sql) ?? ""];
							if (r instanceof Error) throw r;
							return { n: (r ?? []).length };
						},
					}),
				};
			},
		},
	} as unknown as Env;
}

const inst = { instance_id: "i1", icfg: null, aname: "Coder", aslug: "coder-repo" };

describe("readInbox — one adapter per source", () => {
	it("maps every source into a normalised, deep-linked item", async () => {
		const env = fakeEnv({
			secure_input_requests: [{ id: "s1", label: "GitHub token", created_at: "2026-11-20 10:00:00", expires_at: "2026-11-20 13:00:00", ...inst }],
			website_access_requests: [{ id: "w1", hostname: "example.com", created_at: NOW - 1000, ...inst }],
			instance_permission_requests: [{ id: "p1", control: "connector_consent", connector: "github", requested_scope: "write", reason: "open a PR", created_at: "2026-11-20 09:00:00", expires_at: "2026-11-20T15:00:00.000Z", ...inst }],
			browser_takeovers: [{ id: "t1", subject_kind: "runtime_task", subject_id: "task9", reason: "captcha", created_at: NOW - 5000, expires_at: NOW + 60000, ...inst }],
			mcp_input_requests: [{ id: "m1", tool: "create_site", message: "Which template?", created_at: "2026-11-20 08:00:00", expires_at: "2026-11-20 20:00:00", ...inst }],
			coder_questions: [{ id: "q1", session_id: "sess1", question: "Which branch?", why: "two exist", asked_at: NOW - 9000, expires_at: NOW + 9000, ...inst }],
			account_change_requests: [{ id: "a1", target_description: "Delete agent X", action: "agent.delete", created_at: NOW - 3000, expires_at: NOW + 3000 }],
			instance_runtime_tasks: [{ id: "k1", type: "browser", status: "needs_human", ptitle: null, created_at: "2026-11-20 07:00:00", ...inst }],
			job_applications: [{ id: "j1", lead: JSON.stringify({ lead: { title: "Engineer", company: "Acme" } }), created_at: NOW - 1, updated_at: NOW - 2, ...inst }],
			agent_loop_runs: [{ id: "r1", session_id: "sess2", objective: "Fix bug", waiting_reason: "human", waiting_until: NOW + 1000, parked_since: NOW - 4000, started_at: NOW - 8000, ...inst }],
		});
		const { items, sources } = await readInbox(env, "u1", NOW);
		expect(sources.every((s) => s.ok)).toBe(true);
		expect(new Set(items.map((i) => i.kind))).toEqual(new Set(INBOX_KINDS));
		const by = Object.fromEntries(items.map((i) => [i.kind, i]));
		expect(by.secure_input.route).toBe("/instances/i1/secure-inputs/s1");
		expect(by.website_access.route).toBe("/instances/i1/website-requests/w1");
		expect(by.permission.route).toBe("/instances/i1/permissions?focus=permissions&permission_request=p1");
		expect(by.takeover.route).toBe("/instances/i1/tasks/task9?takeover=t1");
		expect(by.takeover.urgency).toBe("blocking");
		expect(by.coder_question.route).toBe("/instances/i1/coding/sess1");
		expect(by.approval).toMatchObject({ instanceId: null, route: "/preferences?approval=a1" });
		expect(by.task.route).toBe("/instances/i1/tasks/k1");
		expect(by.application.route).toBe("/instances/i1/applications?application=j1");
		expect(by.application.title).toContain("Engineer — Acme");
		expect(by.run_parked.route).toBe("/instances/i1/coding/sess2");
		expect(by.secure_input).toMatchObject({ id: "secure_input:s1", instanceName: "Coder", agentSlug: "coder-repo", createdAt: "2026-11-20T10:00:00.000Z", expiresAt: "2026-11-20T13:00:00.000Z" });
		// never a value: the secure-input row is built from its label only
		expect(JSON.stringify(by.secure_input)).not.toMatch(/ciphertext|secret_/);
	});

	it("reports a failing source instead of dropping it, and still returns the others", async () => {
		const env = fakeEnv({ secure_input_requests: new Error("D1 down"), browser_takeovers: [{ id: "t1", subject_kind: "manual", subject_id: "x", reason: "login_required", created_at: NOW, expires_at: NOW + 1, ...inst }] });
		const { items, sources } = await readInbox(env, "u1", NOW);
		expect(sources.find((s) => s.kind === "secure_input")).toMatchObject({ ok: false, error: "D1 down" });
		expect(sources.find((s) => s.kind === "takeover")?.ok).toBe(true);
		expect(items).toHaveLength(1);
	});

	it("marks a source truncated when it hits its cap", async () => {
		const many = Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, hostname: "h.com", created_at: NOW, ...inst }));
		const { sources } = await readInbox(fakeEnv({ website_access_requests: many }), "u1", NOW);
		expect(sources.find((s) => s.kind === "website_access")).toMatchObject({ ok: true, truncated: true });
	});

	it("is bounded: every source query carries a LIMIT and the owner predicate", async () => {
		const seen: string[] = [];
		await readInbox(fakeEnv({}, seen), "u1", NOW);
		expect(seen).toHaveLength(INBOX_KINDS.length);
		for (const sql of seen) expect(sql).toMatch(/WHERE r\.user_id = \?1 .*LIMIT \d+$/s);
	});
});

describe("countInbox", () => {
	it("sums COUNT(*) per source with no name join, and flags a failed source as partial", async () => {
		const seen: string[] = [];
		const ok = await countInbox(fakeEnv({ website_access_requests: [{}, {}], browser_takeovers: [{}] }, seen), "u1", NOW);
		expect(ok).toEqual({ count: 3, partial: false });
		expect(seen.every((s) => s.startsWith("SELECT COUNT(*)") && !s.includes("JOIN agents"))).toBe(true);
		expect(await countInbox(fakeEnv({ coder_questions: new Error("x") }), "u1", NOW)).toMatchObject({ partial: true });
	});
});

const item = (o: Partial<InboxItem>): InboxItem => ({ id: "x:1", kind: "task", instanceId: "i1", instanceName: "A", agentSlug: "a", title: "t", summary: "", createdAt: "2026-11-20T10:00:00.000Z", expiresAt: null, urgency: "normal", route: "/", ...o });
const q = (o: Partial<Parameters<typeof applyInboxQuery>[1]> = {}) => ({ kinds: [], instances: [], agent: null, urgency: null, sort: "newest" as const, ...o });

describe("applyInboxQuery", () => {
	const items = [
		item({ id: "a:1", kind: "task", createdAt: "2026-11-20T10:00:00.000Z", urgency: "low", expiresAt: "2026-11-20T18:00:00.000Z" }),
		item({ id: "b:1", kind: "takeover", instanceId: "i2", agentSlug: "b", createdAt: "2026-11-20T09:00:00.000Z", urgency: "blocking", expiresAt: "2026-11-20T12:30:00.000Z" }),
		item({ id: "c:1", kind: "secure_input", createdAt: "2026-11-20T11:00:00.000Z" }),
	];
	const ids = (o: Parameters<typeof q>[0]) => applyInboxQuery(items, q(o)).map((i) => i.id);

	it("sorts newest, oldest, urgency and expiring (never-expiring last)", () => {
		expect(ids({ sort: "newest" })).toEqual(["c:1", "a:1", "b:1"]);
		expect(ids({ sort: "oldest" })).toEqual(["b:1", "a:1", "c:1"]);
		expect(ids({ sort: "urgency" })).toEqual(["b:1", "c:1", "a:1"]);
		expect(ids({ sort: "expiring" })).toEqual(["b:1", "a:1", "c:1"]);
	});
	it("filters by kind, instance, agent and urgency together", () => {
		expect(ids({ kinds: ["task", "takeover"] })).toEqual(["a:1", "b:1"]);
		expect(ids({ instances: ["i2"] })).toEqual(["b:1"]);
		expect(ids({ agent: "b" })).toEqual(["b:1"]);
		expect(ids({ urgency: "blocking", kinds: ["takeover"] })).toEqual(["b:1"]);
		expect(ids({ kinds: ["approval"] })).toEqual([]);
	});
	it("counts the whole waiting set by kind, instance, agent and urgency", () => {
		const c = inboxCounts(items);
		expect(c.total).toBe(3);
		expect(c.byKind).toMatchObject({ task: 1, takeover: 1, secure_input: 1 });
		expect(c.byInstance[0]).toMatchObject({ instanceId: "i1", count: 2 });
		expect(c.byAgent[0]).toEqual({ slug: "a", count: 2 });
		expect(c.byUrgency).toEqual({ low: 1, blocking: 1, normal: 1 });
	});
});

describe("toIso", () => {
	it("reads epoch ms, ISO and SQLite UTC text alike", () => {
		expect(toIso(NOW)).toBe("2026-11-20T12:00:00.000Z");
		expect(toIso("2026-11-20T12:00:00.000Z")).toBe("2026-11-20T12:00:00.000Z");
		expect(toIso("2026-11-20 12:00:00")).toBe("2026-11-20T12:00:00.000Z");
	});
});
