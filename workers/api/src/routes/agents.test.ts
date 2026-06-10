import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { agentRoutes } from "./agents.js";

const TEST_SECRET = "test-secret";

function testApp(agentOwner = "user-1", hasCloudflareKey = true) {
	const app = new Hono();
	app.route("/v1/agents", agentRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) {
			return c.json({ error: err.message }, err.status as 400);
		}
		throw err;
	});
	const agent = {
		id: "agent-1",
		owner_id: agentOwner,
		slug: "agent-one",
		name: "Agent One",
		description: "",
		category: "general",
		icon: "",
		icon_bg: "#000",
		model: "",
		visibility: "draft",
		status: "inactive",
		worker_name: null,
		cron_schedule: null,
		created_at: "2026-06-10T00:00:00Z",
		updated_at: "2026-06-10T00:00:00Z",
	};
	const env = {
		SESSION_SIGNING_KEY: TEST_SECRET,
		GITHUB_ORG: "ProAgentStore",
		DB: {
			prepare(sql: string) {
				return {
					bind() {
						return {
							first: async () => {
								if (sql.includes("FROM agents")) return agent;
								if (sql.includes("FROM user_api_keys")) {
									return hasCloudflareKey
										? {
												created_at: "2026-06-10T01:00:00Z",
												last_used_at: null,
											}
										: null;
								}
								return null;
							},
							all: async () => ({ results: [] }),
						};
					},
				};
			},
		},
	};
	return { app, env };
}

describe("agent slug validation", () => {
	const SLUG_RE = /^[a-z0-9-]+$/;

	it("accepts valid slugs", () => {
		expect(SLUG_RE.test("my-agent")).toBe(true);
		expect(SLUG_RE.test("summarizer")).toBe(true);
		expect(SLUG_RE.test("code-explainer-v2")).toBe(true);
		expect(SLUG_RE.test("a")).toBe(true);
		expect(SLUG_RE.test("123")).toBe(true);
	});

	it("rejects invalid slugs", () => {
		expect(SLUG_RE.test("My-Agent")).toBe(false); // uppercase
		expect(SLUG_RE.test("my agent")).toBe(false); // space
		expect(SLUG_RE.test("my_agent")).toBe(false); // underscore
		expect(SLUG_RE.test("my.agent")).toBe(false); // dot
		expect(SLUG_RE.test("")).toBe(false); // empty
		expect(SLUG_RE.test("café")).toBe(false); // accented
	});
});

describe("agent ops route", () => {
	it("requires authentication", async () => {
		const { app, env } = testApp();
		const res = await app.request("/v1/agents/agent-1/ops", {}, env);
		expect(res.status).toBe(401);
	});

	it("returns owner-only ops status without GitHub token configured", async () => {
		const { app, env } = testApp("user-1", true);
		const token = await signSession("user-1", TEST_SECRET);
		const res = await app.request(
			"/v1/agents/agent-1/ops",
			{ headers: { Authorization: `Bearer ${token}` } },
			env,
		);
		const data = await res.json<{
			billing: { hasCloudflareKey: boolean; mode: string };
			deploy: { configured: boolean; message: string };
			agent: { workerUrl: string; model: string };
		}>();

		expect(res.status).toBe(200);
		expect(data.billing).toMatchObject({
			hasCloudflareKey: true,
			mode: "user-owned",
		});
		expect(data.deploy).toMatchObject({
			configured: false,
			message: "GitHub deploy token is not configured",
		});
		expect(data.agent.workerUrl).toBe("https://agent-one.proagentstore.online/");
		expect(data.agent.model).toBe("@cf/meta/llama-3.2-3b-instruct");
	});

	it("rejects non-owner access", async () => {
		const { app, env } = testApp("other-user", true);
		const token = await signSession("user-1", TEST_SECRET);
		const res = await app.request(
			"/v1/agents/agent-1/ops",
			{ headers: { Authorization: `Bearer ${token}` } },
			env,
		);
		expect(res.status).toBe(403);
	});
});

describe("agent update allowed fields", () => {
	const allowed = [
		"name",
		"description",
		"category",
		"icon",
		"icon_bg",
		"model",
		"visibility",
		"cron_schedule",
	];

	it("includes expected fields", () => {
		expect(allowed).toContain("name");
		expect(allowed).toContain("description");
		expect(allowed).toContain("model");
		expect(allowed).toContain("visibility");
		expect(allowed).toContain("cron_schedule");
	});

	it("excludes dangerous fields", () => {
		expect(allowed).not.toContain("id");
		expect(allowed).not.toContain("owner_id");
		expect(allowed).not.toContain("slug"); // slug is immutable after creation
		expect(allowed).not.toContain("created_at");
		expect(allowed).not.toContain("worker_name"); // infra-managed
	});
});

describe("agent update SQL builder", () => {
	it("builds correct parameter numbering", () => {
		// Simulate the route's SQL builder logic
		const body: Record<string, unknown> = {
			name: "New Name",
			description: "Updated desc",
		};
		const allowed = [
			"name",
			"description",
			"category",
			"icon",
			"icon_bg",
			"model",
			"visibility",
			"cron_schedule",
		];
		const sets: string[] = ["updated_at = datetime('now')"];
		const params: unknown[] = [];

		for (const key of allowed) {
			if (body[key] !== undefined) {
				params.push(body[key]);
				sets.push(`${key} = ?${params.length + 1}`);
			}
		}

		params.unshift("agent-id"); // ?1 = id

		expect(params).toEqual(["agent-id", "New Name", "Updated desc"]);
		expect(sets).toEqual([
			"updated_at = datetime('now')",
			"name = ?2",
			"description = ?3",
		]);

		const sql = `UPDATE agents SET ${sets.join(", ")} WHERE id = ?1`;
		expect(sql).toBe(
			"UPDATE agents SET updated_at = datetime('now'), name = ?2, description = ?3 WHERE id = ?1",
		);
	});

	it("handles single field update", () => {
		const body: Record<string, unknown> = { visibility: "published" };
		const allowed = [
			"name",
			"description",
			"category",
			"icon",
			"icon_bg",
			"model",
			"visibility",
			"cron_schedule",
		];
		const sets: string[] = ["updated_at = datetime('now')"];
		const params: unknown[] = [];

		for (const key of allowed) {
			if (body[key] !== undefined) {
				params.push(body[key]);
				sets.push(`${key} = ?${params.length + 1}`);
			}
		}
		params.unshift("agent-id");

		expect(params).toEqual(["agent-id", "published"]);
		expect(sets[1]).toBe("visibility = ?2");
	});
});
