import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { adminMcpAuditRoutes } from "./admin-mcp-audit.js";
import { mcpAuditRoutes, readMcpAuditEvents } from "./mcp-audit.js";

/**
 * The owner-scoped MCP audit read path (#704).
 *
 * Two things are asserted here that nothing asserted before: that a caller reads only their
 * OWN subject's events (the prefix is built from `session.uid` and no query parameter can
 * widen it), and that exempting `session_id` from the key-name redactor did not open a hole —
 * a genuine secret in the SAME object still comes back `[redacted]`, because the value-shape
 * net is what actually protects this path.
 */

const SECRET = "mcp-audit-test-secret";

/** KV as it actually behaves: keys come back in LEXICOGRAPHIC order, truncated to `limit`. */
function makeKv(entries: Record<string, unknown>): KVNamespace {
	const data = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
	return {
		get: async (key: string) => data.get(key) ?? null,
		list: async ({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) => {
			const all = Array.from(data.keys())
				.filter((n) => n.startsWith(prefix))
				.sort();
			return { keys: all.slice(0, limit).map((name) => ({ name })), list_complete: all.length <= limit };
		},
	} as unknown as KVNamespace;
}

function testApp(kv?: KVNamespace) {
	const app = new Hono();
	app.route("/v1", mcpAuditRoutes);
	app.route("/v1/admin", adminMcpAuditRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		throw err;
	});
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		OAUTH_KV: kv,
		DB: {
			prepare(sql: string) {
				return {
					bind: () => ({
						first: async () => {
							if (sql.includes("SELECT suspended FROM users")) return { suspended: 0 };
							if (sql.includes("roles")) return { roles: '["user","admin"]', github_login: null };
							return null;
						},
						run: async () => ({}),
						all: async () => ({ results: [] }),
					}),
				};
			},
		},
	};
	return { app, env };
}

const tokenFor = (uid: string) => signSession(uid, SECRET, { roles: ["user", "admin"] });

const event = (over: Record<string, unknown> = {}) => ({
	time: "2026-08-18T00:00:00.000Z",
	tool: "coding_session_message",
	action: "completed",
	...over,
});

async function body(res: Response) {
	return (await res.json()) as { count: number; events: Array<Record<string, never>> };
}

describe("GET /v1/mcp-audit", () => {
	it("401s an anonymous caller", async () => {
		const { app, env } = testApp(makeKv({}));
		expect((await app.request("/v1/mcp-audit", {}, env)).status).toBe(401);
	});

	it("returns only the caller's own subject, never another's", async () => {
		// The isolation is structural — the prefix comes from `session.uid`. This drives the
		// route with both subjects' events in the same namespace and with `?user=` set to the
		// other one, because a copied-from-admin handler would honour that parameter.
		const kv = makeKv({
			"audit:mine:2026-08-18T00:00:00.000Z:a": event({ subject: "mine", tool: "list_agents" }),
			"audit:theirs:2026-08-18T00:00:01.000Z:b": event({ subject: "theirs", tool: "delete_agent" }),
		});
		const { app, env } = testApp(kv);

		const res = await app.request(
			"/v1/mcp-audit?user=theirs",
			{ headers: { Authorization: `Bearer ${await tokenFor("mine")}` } },
			env,
		);

		expect(res.status).toBe(200);
		const out = await body(res);
		expect(out.count).toBe(1);
		expect(out.events.map((e) => e.subject)).toEqual(["mine"]);
	});

	it("returns the newest events when the log holds more than the limit", async () => {
		// Same regime as the MCP-side bug: KV hands back the lexicographically FIRST keys,
		// which for an ISO-timestamped name are the oldest.
		const entries: Record<string, unknown> = {};
		for (let i = 0; i < 40; i++) {
			const time = `2026-08-18T00:${String(i).padStart(2, "0")}:00.000Z`;
			entries[`audit:mine:${time}:k${i}`] = event({ subject: "mine", time, seq: i });
		}
		const { app, env } = testApp(makeKv(entries));

		const res = await app.request(
			"/v1/mcp-audit?limit=5",
			{ headers: { Authorization: `Bearer ${await tokenFor("mine")}` } },
			env,
		);

		expect((await body(res)).events.map((e) => e.seq)).toEqual([39, 38, 37, 36, 35]);
	});

	it("501s with a reason rather than an empty list when the KV is unbound", async () => {
		const { app, env } = testApp(undefined);
		const res = await app.request(
			"/v1/mcp-audit",
			{ headers: { Authorization: `Bearer ${await tokenFor("mine")}` } },
			env,
		);
		expect(res.status).toBe(501);
	});
});

describe("read-time redaction of MCP audit events", () => {
	// The exemption is narrow on purpose and this is the test that proves the narrowness:
	// the point is not "session_id survives", it is that a real credential sitting in the
	// same object still does not.
	const withSecrets = {
		instance_id: "bd43f4de-1111-2222-3333-444455556666",
		session_id: "csess_6ce3627a-3c3f-439a-90f3-ff4a6de3167a",
		session_token: "not-a-shape-but-a-secret-name",
		note: "Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz012345",
		pat: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.QWJjRGVmR2hp",
		messageBytes: 1818,
	};

	async function readOne(kv: KVNamespace) {
		const { events } = await readMcpAuditEvents(kv, {
			prefix: "audit:mine:",
			limit: 10,
			subjectScoped: true,
		});
		return events[0]?.input as Record<string, string | number>;
	}

	it("keeps session_id — the only join key to what was typed into the engine", async () => {
		const kv = makeKv({
			"audit:mine:2026-08-18T00:00:00.000Z:a": event({ input: withSecrets }),
		});
		const input = await readOne(kv);
		expect(input.session_id).toBe("csess_6ce3627a-3c3f-439a-90f3-ff4a6de3167a");
		expect(input.instance_id).toBe("bd43f4de-1111-2222-3333-444455556666");
		expect(input.messageBytes).toBe(1818);
	});

	it("still redacts a genuine secret in the same object", async () => {
		const kv = makeKv({
			"audit:mine:2026-08-18T00:00:00.000Z:a": event({ input: withSecrets }),
		});
		const input = await readOne(kv);
		// Key-name rule: `session_token` is NOT what was exempted.
		expect(input.session_token).toBe("[redacted]");
		expect(input.pat).toBe("[redacted]");
		expect(input.jwt).toBe("[redacted]");
		// Value-shape net, under an innocent key name: it masks the secret substring and
		// leaves the surrounding prose, so assert the credential is gone, not the whole field.
		expect(input.note).toBe("Authorization: [redacted]");
		expect(JSON.stringify(input)).not.toContain("sk-ant-");
		expect(JSON.stringify(input)).not.toContain("ghp_");
	});

	it("redacts a secret-SHAPED value even when it hides under the exempted key", async () => {
		// The exemption skips the key-NAME rule only. A caller that stuffed a token into a
		// field called `session_id` is still covered by the value-shape net.
		const kv = makeKv({
			"audit:mine:2026-08-18T00:00:00.000Z:a": event({
				input: { session_id: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
			}),
		});
		expect((await readOne(kv)).session_id).toBe("[redacted]");
	});
});

describe("GET /v1/admin/mcp-audit", () => {
	it("orders a cross-subject sweep by time, not by subject name", async () => {
		// Key names sort by SUBJECT first, so slicing the names would return the newest events
		// of the alphabetically-last subject and call them the newest overall.
		const kv = makeKv({
			"audit:aaa:2026-08-18T09:00:00.000Z:a": event({ subject: "aaa", time: "2026-08-18T09:00:00.000Z" }),
			"audit:zzz:2026-08-18T01:00:00.000Z:b": event({ subject: "zzz", time: "2026-08-18T01:00:00.000Z" }),
		});
		const { app, env } = testApp(kv);

		const res = await app.request(
			"/v1/admin/mcp-audit?limit=1",
			{ headers: { Authorization: `Bearer ${await tokenFor("admin-1")}` } },
			env,
		);

		expect(res.status).toBe(200);
		expect((await body(res)).events.map((e) => e.subject)).toEqual(["aaa"]);
	});
});
