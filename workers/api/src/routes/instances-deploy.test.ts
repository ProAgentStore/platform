/**
 * Deployment status routes (#488) — the Operator's counterpart to the Coder's Build Status panel.
 *
 * Three routes, driven through the real Hono app:
 *   GET  /:id/deploy-status   — latest build (uses config.githubRepo)
 *   GET  /:id/deploy-history  — paginated history (?repo=&perPage=)
 *   PUT  /:id/deploy-status   — save config.githubRepo
 *
 * GitHub API calls are stubbed: `lib/hosted-repo.ts` relies on `lib/github-cache.ts` which
 * calls `fetch`, so the tests stub `latestHostedBuild` and `listHostedBuilds` at the module
 * boundary through the env's `DB` and a thin mock of the shared client rather than mocking fetch.
 *
 * The property under test is the ROUTING: tenant isolation (nobody else's instance), the
 * validation gate on `owner/repo` format, the config read/write, and graceful degradation when
 * GitHub is unavailable — all without hitting the real Actions API.
 */
import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { instanceRoutes } from "./instances.js";

// ── Stub the GitHub read so tests never hit the network ─────────────────────
vi.mock("../lib/hosted-repo.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../lib/hosted-repo.js")>();
	return {
		...real,
		latestHostedBuild: vi.fn().mockResolvedValue({ available: true, run: { status: "completed", conclusion: "success", name: "CI", runNumber: 42, url: "https://github.com/a/r/actions/runs/1", branch: "main", sha: "abc1234", updatedAt: "2026-08-10T00:00:00Z" } }),
		listHostedBuilds: vi.fn().mockResolvedValue([{ status: "completed", conclusion: "success", name: "CI", runNumber: 42, url: "https://github.com/a/r/actions/runs/1", branch: "main", sha: "abc1234", updatedAt: "2026-08-10T00:00:00Z" }]),
	};
});

// ── Minimal in-memory D1 stub ───────────────────────────────────────────────

const SECRET = "deploy-status-secret";
const token = (uid: string) => signSession(uid, SECRET, { roles: ["user"] });

/**
 * A D1 stub that holds ONE instance and supports the SQL patterns these routes use:
 *   SELECT id, user_id, config … WHERE id=?1 AND user_id=?2
 *   UPDATE json_set(config, …)
 */
function buildApp(initialConfig: Record<string, unknown> = {}) {
	let stored = JSON.stringify(initialConfig);

	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					const [p1, p2] = args as [string, string, ...unknown[]];
					const mine = p1 === "inst-1" && p2 === "u1";
					return {
						async first() {
							if (!mine) return null;
							return { id: "inst-1", user_id: "u1", config: stored };
						},
						async all() { return { results: [] }; },
						async run() {
							// json_set path: UPDATE … json_set(…, path, json(value)) WHERE id=?3 AND user_id=?4
							if (sql.includes("json_set")) {
								const [path, value, id, uid] = args as [string, string, string, string];
								if (id !== "inst-1" || uid !== "u1") return { meta: { changes: 0 } };
								const key = path.replace("$.", "");
								const cur = JSON.parse(stored) as Record<string, unknown>;
								cur[key] = JSON.parse(value) as unknown;
								stored = JSON.stringify(cur);
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
	app.route("/v1/instances", instanceRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});

	const call = async (method: "GET" | "PUT", path: string, body?: unknown, uid: string | null = "u1") =>
		app.request(
			`/v1/instances/inst-1/${path}`,
			{
				method,
				headers: {
					...(uid ? { Authorization: `Bearer ${await token(uid)}` } : {}),
					"Content-Type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			env,
		);

	return { call, getStored: () => JSON.parse(stored) as Record<string, unknown> };
}

// ── GET /deploy-status ───────────────────────────────────────────────────────

describe("GET /v1/instances/:id/deploy-status", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("returns available:false + repo:null when no repo is configured", async () => {
		const { call } = buildApp({});
		const res = await call("GET", "deploy-status");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ repo: null, available: false, run: null });
	});

	it("returns available:false when the stored value is not owner/repo format", async () => {
		const { call } = buildApp({ githubRepo: "not-a-repo" });
		const res = await call("GET", "deploy-status");
		expect(res.status).toBe(200);
		const body = await res.json() as { available: boolean };
		expect(body.available).toBe(false);
	});

	it("calls latestHostedBuild and echoes back repo + the build result", async () => {
		const { call } = buildApp({ githubRepo: "owner/repo" });
		const res = await call("GET", "deploy-status");
		expect(res.status).toBe(200);
		const body = await res.json() as { repo: string; available: boolean; run: { runNumber: number } };
		expect(body.repo).toBe("owner/repo");
		expect(body.available).toBe(true);
		expect(body.run?.runNumber).toBe(42);
	});

	it("is 404 for a different user's instance", async () => {
		const { call } = buildApp({ githubRepo: "owner/repo" });
		expect((await call("GET", "deploy-status", undefined, "u2")).status).toBe(404);
	});

	it("is 401 without a session", async () => {
		const { call } = buildApp({ githubRepo: "owner/repo" });
		expect((await call("GET", "deploy-status", undefined, null)).status).toBe(401);
	});
});

// ── GET /deploy-history ──────────────────────────────────────────────────────

describe("GET /v1/instances/:id/deploy-history", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("returns available:false when ?repo is missing or not owner/repo format", async () => {
		const { call } = buildApp({});
		expect((await (await call("GET", "deploy-history")).json() as { available: boolean }).available).toBe(false);
		expect((await (await call("GET", "deploy-history?repo=bare-word")).json() as { available: boolean }).available).toBe(false);
	});

	it("returns paginated runs for a valid repo query param", async () => {
		const { call } = buildApp({});
		const res = await call("GET", "deploy-history?repo=owner/repo&perPage=1");
		expect(res.status).toBe(200);
		const body = await res.json() as { available: boolean; runs: unknown[] };
		expect(body.available).toBe(true);
		expect(Array.isArray(body.runs)).toBe(true);
	});

	it("is 404 for a different user", async () => {
		const { call } = buildApp({});
		expect((await call("GET", "deploy-history?repo=owner/repo", undefined, "u2")).status).toBe(404);
	});

	it("is 401 without a session", async () => {
		const { call } = buildApp({});
		expect((await call("GET", "deploy-history?repo=owner/repo", undefined, null)).status).toBe(401);
	});
});

// ── PUT /deploy-status ───────────────────────────────────────────────────────

describe("PUT /v1/instances/:id/deploy-status", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("SAVES a valid owner/repo and echoes it back", async () => {
		const { call, getStored } = buildApp({});
		const res = await call("PUT", "deploy-status", { repo: "owner/repo" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ repo: "owner/repo" });
		expect(getStored().githubRepo).toBe("owner/repo");
	});

	it("CLEARS the repo when an empty string is sent", async () => {
		const { call, getStored } = buildApp({ githubRepo: "owner/repo" });
		const res = await call("PUT", "deploy-status", { repo: "" });
		expect(res.status).toBe(200);
		expect((await res.json() as { repo: null }).repo).toBeNull();
		expect(getStored().githubRepo).toBeNull();
	});

	it("REJECTS a non-owner/repo string with 400", async () => {
		const { call } = buildApp({});
		const res = await call("PUT", "deploy-status", { repo: "not-a-repo" });
		expect(res.status).toBe(400);
	});

	it("leaves other config keys untouched", async () => {
		const { call, getStored } = buildApp({ runnerNode: "laptop", voiceMode: "tap" });
		await call("PUT", "deploy-status", { repo: "owner/repo" });
		expect(getStored().runnerNode).toBe("laptop");
		expect(getStored().voiceMode).toBe("tap");
	});

	it("is 404 for a different user — a stranger cannot configure another owner's repo", async () => {
		const { call, getStored } = buildApp({});
		expect((await call("PUT", "deploy-status", { repo: "owner/repo" }, "u2")).status).toBe(404);
		expect(getStored().githubRepo).toBeUndefined();
	});

	it("is 401 without a session", async () => {
		const { call } = buildApp({});
		expect((await call("PUT", "deploy-status", { repo: "owner/repo" }, null)).status).toBe(401);
	});
});
