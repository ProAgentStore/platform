/**
 * `/v1/feedback` (#514) — the capture and read surface, driven through the real handlers against
 * an in-memory `agent_feedback`.
 *
 * The properties worth holding:
 *   – capture is owner-scoped THROUGH the instance, and 404s a stranger before it writes anything
 *   – the row a capture produces carries the turn's anchors, so `agent_trace(trace_id=…)` is the
 *     caller's very next call — that is the whole "file the tickets better" criterion
 *   – reads are always the caller's own; `?instance_id=` narrows, it never widens
 *   – triage moves `status`/`issue_url` and NOTHING else; the body is not editable
 *   – NO model is touched on any of these paths (there is no AI binding in this env at all)
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { feedbackRoutes } from "./feedback.js";
import type { Env } from "../types.js";

const SECRET = "feedback-test-secret";
const tokenFor = (uid: string) => signSession(uid, SECRET, { roles: ["user"] });

interface Row {
	id: string;
	ts: number;
	user_id: string;
	instance_id: string;
	author: string;
	surface: string;
	sentiment: string | null;
	body: string;
	trace_id: string | null;
	message_id: string | null;
	session_id: string | null;
	timeline_seq: number | null;
	target_role: string | null;
	target_text: string | null;
	target_at: string | null;
	prompt_text: string | null;
	context: string | null;
	status: string;
	issue_url: string | null;
}

/** @param owns `instanceId::uid` pairs the ownership SELECT will answer for. */
function buildApp(owns: string[] = ["i1::u1"], seed: Row[] = []) {
	const rows: Row[] = [...seed];
	const DB = {
		prepare(sql: string) {
			const s = sql.trim();
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							if (s.includes("FROM agent_instances")) {
								const [id, uid] = args as [string, string];
								return owns.includes(`${id}::${uid}`) ? { id, agent_id: "a1", user_id: uid, status: "active", config: "{}" } : null;
							}
							// COUNT(*) for pagination total
							if (s.includes("COUNT(*) AS n") && s.includes("FROM agent_feedback")) {
								const uid = args[0] as string;
								let out = rows.filter((r) => r.user_id === uid);
								let i = 1;
								if (s.includes("instance_id = ?")) out = out.filter((r) => r.instance_id === args[i++]);
								if (s.includes("status = ?")) out = out.filter((r) => r.status === args[i++]);
								return { n: out.length };
							}
							return null;
						},
						async all() {
							if (!s.includes("FROM agent_feedback")) return { results: [] };
							const uid = args[0] as string;
							let out = rows.filter((r) => r.user_id === uid);
							// Mirror the WHERE the route composes, in bind order.
							let i = 1;
							if (s.includes("instance_id = ?")) out = out.filter((r) => r.instance_id === args[i++]);
							if (s.includes("status = ?")) out = out.filter((r) => r.status === args[i++]);
							// Apply OFFSET and LIMIT from the SQL (limit+1 probe)
							const limitMatch = /LIMIT (\d+)/.exec(s);
							const offsetMatch = /OFFSET (\d+)/.exec(s);
							const sqlLimit = limitMatch ? Number(limitMatch[1]) : undefined;
							const sqlOffset = offsetMatch ? Number(offsetMatch[1]) : 0;
							const sorted = [...out].sort((a, b) => b.ts - a.ts).slice(sqlOffset, sqlLimit !== undefined ? sqlOffset + sqlLimit : undefined);
							return { results: sorted };
						},
						async run() {
							if (s.startsWith("INSERT INTO agent_feedback")) {
								const [
									id, ts, user_id, instance_id, author, surface, sentiment, body, trace_id,
									message_id, session_id, timeline_seq, target_role, target_text, target_at,
									prompt_text, context, status, issue_url,
								] = args as never[];
								rows.push({
									id, ts, user_id, instance_id, author, surface, sentiment, body, trace_id,
									message_id, session_id, timeline_seq, target_role, target_text, target_at,
									prompt_text, context, status, issue_url,
								} as unknown as Row);
								return { meta: { changes: 1 } };
							}
							if (s.startsWith("UPDATE agent_feedback")) {
								const id = args[args.length - 2] as string;
								const uid = args[args.length - 1] as string;
								const row = rows.find((r) => r.id === id && r.user_id === uid);
								if (!row) return { meta: { changes: 0 } };
								let i = 0;
								if (s.includes("status = ?")) row.status = args[i++] as string;
								if (s.includes("issue_url = ?")) row.issue_url = args[i++] as string | null;
								return { meta: { changes: 1 } };
							}
							if (s.startsWith("DELETE FROM agent_feedback")) {
								const [id, uid] = args as [string, string];
								const idx = rows.findIndex((r) => r.id === id && r.user_id === uid);
								if (idx < 0) return { meta: { changes: 0 } };
								rows.splice(idx, 1);
								return { meta: { changes: 1 } };
							}
							return { meta: { changes: 0 } };
						},
					};
				},
			};
		},
	};
	const env = { SESSION_SIGNING_KEY: SECRET, DB } as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/feedback", feedbackRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	return { app, env, rows };
}

const send = (app: Hono<{ Bindings: Env }>, env: Env, method: string, path: string, tok: string, body?: unknown) =>
	app.request(
		path,
		{
			method,
			headers: { Authorization: `Bearer ${tok}`, ...(body ? { "Content-Type": "application/json" } : {}) },
			...(body ? { body: JSON.stringify(body) } : {}),
		},
		env,
	);

const capture = {
	instanceId: "i1",
	body: "you told me I chose that — I never said it",
	surface: "chat",
	traceId: "trace-abc",
	messageId: "msg-2",
	targetRole: "assistant",
	targetText: "As you chose, I skipped the tests.",
	targetAt: "2026-08-11T01:57:59.126Z",
	promptText: "why did you skip the tests?",
	context: { audioKey: "voice-7", dictation: "why did you skip the tests" },
};

describe("POST /v1/feedback", () => {
	it("records the complaint with the anchors that make the turn addressable", async () => {
		const { app, env, rows } = buildApp();
		const res = await send(app, env, "POST", "/v1/feedback", await tokenFor("u1"), capture);
		expect(res.status).toBe(201);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			user_id: "u1",
			instance_id: "i1",
			author: "user",
			body: capture.body,
			// The pointer that turns a complaint into the manual sequence that produced #503–#505.
			trace_id: "trace-abc",
			message_id: "msg-2",
			// …and the snapshot that outlives Clear chat and the trace's 14-day prune.
			target_text: "As you chose, I skipped the tests.",
			prompt_text: "why did you skip the tests?",
			status: "open",
		});
		expect(JSON.parse(rows[0].context ?? "{}")).toMatchObject({ audioKey: "voice-7", dictation: "why did you skip the tests" });
	});

	it("404s a stranger before it writes anything", async () => {
		const { app, env, rows } = buildApp(["i1::u1"]);
		const res = await send(app, env, "POST", "/v1/feedback", await tokenFor("u2"), capture);
		expect(res.status).toBe(404);
		expect(rows).toHaveLength(0);
	});

	it("401s without a session", async () => {
		const { app, env } = buildApp();
		const res = await app.request("/v1/feedback", { method: "POST", body: JSON.stringify(capture) }, env);
		expect(res.status).toBe(401);
	});

	it("400s on an empty body and on a missing instance", async () => {
		const { app, env } = buildApp();
		const tok = await tokenFor("u1");
		expect((await send(app, env, "POST", "/v1/feedback", tok, { instanceId: "i1", body: "  " })).status).toBe(400);
		expect((await send(app, env, "POST", "/v1/feedback", tok, { body: "something" })).status).toBe(400);
	});
});

describe("GET /v1/feedback", () => {
	const seed: Row[] = [
		{ id: "f1", ts: 3, user_id: "u1", instance_id: "i1", author: "user", surface: "chat", sentiment: null, body: "one", trace_id: "t1", message_id: null, session_id: null, timeline_seq: null, target_role: null, target_text: null, target_at: null, prompt_text: null, context: null, status: "open", issue_url: null },
		{ id: "f2", ts: 2, user_id: "u1", instance_id: "i2", author: "user", surface: "chat", sentiment: null, body: "two", trace_id: null, message_id: null, session_id: null, timeline_seq: null, target_role: null, target_text: null, target_at: null, prompt_text: null, context: null, status: "filed", issue_url: "https://x/1" },
		{ id: "f3", ts: 1, user_id: "u2", instance_id: "i9", author: "user", surface: "chat", sentiment: null, body: "not yours", trace_id: null, message_id: null, session_id: null, timeline_seq: null, target_role: null, target_text: null, target_at: null, prompt_text: null, context: null, status: "open", issue_url: null },
	];

	it("returns only the caller's rows, newest first, with the real total", async () => {
		const { app, env } = buildApp(["i1::u1"], seed);
		const res = await send(app, env, "GET", "/v1/feedback", await tokenFor("u1"));
		const out = (await res.json()) as { count: number; has_more: boolean; feedback: Row[] };
		// count = real total, not the truncated page length
		expect(out.count).toBe(2);
		expect(out.has_more).toBe(false);
		expect(out.feedback.map((r) => r.id)).toEqual(["f1", "f2"]);
	});

	it("narrows to one agent with instance_id, and to one column with status", async () => {
		const { app, env } = buildApp(["i1::u1"], seed);
		const tok = await tokenFor("u1");
		const one = (await (await send(app, env, "GET", "/v1/feedback?instance_id=i1", tok)).json()) as { count: number; feedback: Row[] };
		expect(one.feedback.map((r) => r.id)).toEqual(["f1"]);
		expect(one.count).toBe(1);
		const open = (await (await send(app, env, "GET", "/v1/feedback?status=open", tok)).json()) as { count: number; feedback: Row[] };
		expect(open.feedback.map((r) => r.id)).toEqual(["f1"]);
		expect(open.count).toBe(1);
	});

	it("gives another user none of it", async () => {
		const { app, env } = buildApp(["i1::u1"], seed);
		const out = (await (await send(app, env, "GET", "/v1/feedback", await tokenFor("u2"))).json()) as { feedback: Row[] };
		expect(out.feedback.map((r) => r.id)).toEqual(["f3"]);
	});

	it("reports the real total even when the page is smaller, and has_more when a next page exists", async () => {
		// 3 rows for u1 to force a page boundary at limit=2
		const bigSeed: Row[] = [
			{ id: "g1", ts: 5, user_id: "u1", instance_id: "i1", author: "user", surface: "chat", sentiment: null, body: "a", trace_id: null, message_id: null, session_id: null, timeline_seq: null, target_role: null, target_text: null, target_at: null, prompt_text: null, context: null, status: "open", issue_url: null },
			{ id: "g2", ts: 4, user_id: "u1", instance_id: "i1", author: "user", surface: "chat", sentiment: null, body: "b", trace_id: null, message_id: null, session_id: null, timeline_seq: null, target_role: null, target_text: null, target_at: null, prompt_text: null, context: null, status: "open", issue_url: null },
			{ id: "g3", ts: 3, user_id: "u1", instance_id: "i1", author: "user", surface: "chat", sentiment: null, body: "c", trace_id: null, message_id: null, session_id: null, timeline_seq: null, target_role: null, target_text: null, target_at: null, prompt_text: null, context: null, status: "open", issue_url: null },
		];
		const { app, env } = buildApp(["i1::u1"], bigSeed);
		const tok = await tokenFor("u1");

		// First page: limit=2, expect has_more=true and count=3 (real total)
		const page1 = (await (await send(app, env, "GET", "/v1/feedback?limit=2", tok)).json()) as {
			count: number; has_more: boolean; feedback: Row[];
		};
		expect(page1.count).toBe(3);
		expect(page1.has_more).toBe(true);
		expect(page1.feedback.map((r) => r.id)).toEqual(["g1", "g2"]);

		// Second page: offset=2, expect has_more=false and same total
		const page2 = (await (await send(app, env, "GET", "/v1/feedback?limit=2&offset=2", tok)).json()) as {
			count: number; has_more: boolean; feedback: Row[];
		};
		expect(page2.count).toBe(3);
		expect(page2.has_more).toBe(false);
		expect(page2.feedback.map((r) => r.id)).toEqual(["g3"]);
	});
});

describe("PATCH /v1/feedback/:id + DELETE", () => {
	const seed = (): Row[] => [
		{ id: "f1", ts: 3, user_id: "u1", instance_id: "i1", author: "user", surface: "chat", sentiment: null, body: "the original words", trace_id: null, message_id: null, session_id: null, timeline_seq: null, target_role: null, target_text: null, target_at: null, prompt_text: null, context: null, status: "open", issue_url: null },
	];

	it("files a row against the issue it became", async () => {
		const { app, env, rows } = buildApp(["i1::u1"], seed());
		const res = await send(app, env, "PATCH", "/v1/feedback/f1", await tokenFor("u1"), {
			status: "filed",
			issue_url: "https://github.com/ProAgentStore/platform/issues/514",
		});
		expect(res.status).toBe(200);
		expect(rows[0]).toMatchObject({ status: "filed", issue_url: "https://github.com/ProAgentStore/platform/issues/514" });
	});

	it("cannot edit the body — the record of what was said is the evidence (#505)", async () => {
		const { app, env, rows } = buildApp(["i1::u1"], seed());
		await send(app, env, "PATCH", "/v1/feedback/f1", await tokenFor("u1"), { status: "triaged", body: "something else entirely" });
		expect(rows[0].body).toBe("the original words");
	});

	it("400s when neither status nor issue_url is offered", async () => {
		const { app, env } = buildApp(["i1::u1"], seed());
		expect((await send(app, env, "PATCH", "/v1/feedback/f1", await tokenFor("u1"), { note: "hi" })).status).toBe(400);
	});

	it("404s a stranger's patch and delete, and leaves the row alone", async () => {
		const { app, env, rows } = buildApp(["i1::u1"], seed());
		expect((await send(app, env, "PATCH", "/v1/feedback/f1", await tokenFor("u2"), { status: "dismissed" })).status).toBe(404);
		expect((await send(app, env, "DELETE", "/v1/feedback/f1", await tokenFor("u2"))).status).toBe(404);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("open");
	});

	it("deletes the owner's own row — it outlives the conversation, so this has to reach it", async () => {
		const { app, env, rows } = buildApp(["i1::u1"], seed());
		expect((await send(app, env, "DELETE", "/v1/feedback/f1", await tokenFor("u1"))).status).toBe(200);
		expect(rows).toHaveLength(0);
	});
});
