/**
 * The Coder control plane, held to a table — every value in it DERIVED by driving the
 * registered handler, never read out of the source (#305).
 *
 * ── Why a contract test and not just a split
 *
 * `routes/coding.ts` carried 39 routes in one 1778-line file. Every one of them opens with the
 * same line — `const { uid, instanceId } = await requireOwned(c)` — inside a closure that looks
 * exactly like its thirty-eight neighbours. Delete it and nothing typechecks differently, no test
 * fails, and no reviewer scrolling past the thirtieth near-identical block sees it. `SECURITY.md`
 * calls per-route `user_id`/`owner_id` scoping the thing that stops cross-tenant reads, and this
 * surface is the one where "cross-tenant" means *someone else's laptop, their checkouts and a CLI
 * running with `--dangerously-skip-permissions`*. Nothing asserted it here for any route.
 *
 * So the tables below are derived by ASKING each route, not by reading it:
 *
 *   1. the ordered route table            — `codingRoutes.routes`
 *   2. which module registered each route — each `register*Routes` mounted on a bare Hono
 *   3. what an ANONYMOUS caller gets      — drive it with no Authorization header
 *   4. what a NON-OWNER caller gets       — drive it with a valid session for a user who owns
 *                                           nothing, against a D1 that resolves no ownership row
 *   5. what a SUSPENDED caller gets       — same, with the users row saying suspended
 *
 * (4) is the tenant gate. (5) is the moderation lever: `requireUser` is where suspension is
 * applied, so a route that authenticates any other way — or does not authenticate at all — keeps
 * working for an account an operator has stopped. `lib/security-invariants.test.ts` scans the
 * SOURCE for inline session verification, which by construction cannot see a route that verifies
 * nothing; driving it can. #317 is exactly that failure: a file dropped out of that scan and
 * quietly retired the guard.
 *
 * ── Also the evidence that the #305 split changed no behaviour
 *
 * The route table below was generated against the pre-split `coding.ts` (all 39 routes in that one
 * file) and is byte-identical against the post-split modules. Registration ORDER is included on
 * purpose: Hono matches in registration order, so a split that moves a block past a sibling
 * pattern is a behaviour change even when the route SET is equal. That is why `registerRepoRoutes`
 * / `registerCopilotRoutes` / `registerDiagnosticsRoutes` are called from the exact positions
 * their blocks occupied rather than gathered at the top of the file.
 *
 * ── And two things this file asserts that no source scan could
 *
 * `PAYER OBSERVATION` (#348/#356) and `MERGE AUTHORITY` (#314) are both single arguments passed at
 * a single call site, and both are load-bearing in a way a grep cannot check: one decides whether
 * a money ceiling is allowed to refuse work, the other whether an agent may put code on a trunk.
 * A prior refactor already lost the payer argument once, on the two `recordEngineUsage` call sites
 * that live elsewhere. So they are driven end-to-end, and what is asserted is the value that
 * reaches D1.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { codingRoutes } from "./coding.js";
import { registerCopilotRoutes } from "./coding-brains.js";
import { registerDiagnosticsRoutes } from "./coding-diagnostics.js";
import { registerPullRoutes } from "./coding-pulls.js";
import { registerRepoRoutes } from "./coding-repos.js";

const SECRET = "coding-contract-secret";

/** One `prepare(...).bind(...)` as it was issued — SQL plus the values actually bound. */
interface Statement {
	sql: string;
	binds: unknown[];
}

/**
 * A D1 that resolves NOTHING. Every ownership lookup — `requireOwned`'s `SELECT id FROM
 * agent_instances WHERE id = ?1 AND user_id = ?2`, `getSession`, `getRepo`, the runtime rows —
 * comes back empty, which is the state a stranger's request is really in. Writes are recorded
 * rather than performed: a route that WRITES on this probe has already lost, and the recording is
 * asserted below.
 *
 * `suspended` flips only the `users` row, so the caller is a perfectly valid session whose account
 * an operator has stopped.
 */
function strangerEnv(suspended = false) {
	const issued: Statement[] = [];
	const writes: string[] = [];
	const DB = {
		prepare(sql: string) {
			const stmt = {
				bind: (...binds: unknown[]) => {
					issued.push({ sql: sql.replace(/\s+/g, " ").trim(), binds });
					return stmt;
				},
				first: async () => (suspended && /FROM users/.test(sql) ? { suspended: 1 } : null),
				all: async () => ({ results: [] }),
				run: async () => {
					writes.push(sql.replace(/\s+/g, " ").trim());
					return { meta: { changes: 0 } };
				},
			};
			return stmt;
		},
		batch: async (stmts: unknown[]) => {
			writes.push(`BATCH x${stmts.length}`);
			return [];
		},
	};
	// Bindings a gated handler must never reach. Each throws, so getting past the gate surfaces
	// as a 500 in the table rather than as a quiet pass.
	const boom = (what: string) => () => {
		throw new Error(`ungated: reached ${what}`);
	};
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB,
		AGENT: { idFromName: boom("AgentDO.idFromName"), get: boom("AgentDO.get") },
		RELAY: { idFromName: boom("RelayDO.idFromName"), get: boom("RelayDO.get") },
		AI: { run: boom("Workers AI") },
		CODING_SESSION: { create: boom("CODING_SESSION.create") },
		STORAGE: { get: boom("R2.get"), put: boom("R2.put") },
	} as unknown as Env;
	return { env, issued, writes };
}

function buildApp(suspended = false) {
	const { env, issued, writes } = strangerEnv(suspended);
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", codingRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	return { app, env, issued, writes };
}

/** Concrete values for every path parameter the surface uses. */
const PARAMS: Record<string, string> = {
	instanceId: "instance-owned-by-someone-else",
	repoId: "repo-1",
	sessionId: "csess-1",
	number: "7",
};

function concrete(pattern: string): string {
	return pattern.replace(/:([A-Za-z_][\w]*)/g, (_m, name: string) => {
		const value = PARAMS[name];
		if (!value) throw new Error(`No probe value for :${name} — add one to PARAMS.`);
		return value;
	});
}

/** Every route the surface registers, in registration order, de-duplicated by method+path. */
function surface(): Array<{ method: string; path: string }> {
	const seen = new Set<string>();
	const out: Array<{ method: string; path: string }> = [];
	for (const r of codingRoutes.routes) {
		const key = `${r.method} ${r.path}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ method: r.method, path: r.path });
	}
	return out;
}

/** Drive one route and report the status, the statements it issued, and any it tried to run. */
async function probe(method: string, pattern: string, token?: string, suspended = false) {
	const { app, env, issued, writes } = buildApp(suspended);
	const init: RequestInit = {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			"Content-Type": "application/json",
		},
	};
	// Every route on this surface calls `requireOwned` FIRST, so an empty body reaches the gate.
	// If one ever starts validating ahead of it, its status moves in the table below and someone
	// has to decide whether that ordering is correct.
	if (method !== "GET" && method !== "DELETE") init.body = "{}";
	const res = await app.request(`/v1/instances${concrete(pattern)}`, init, env);
	return { status: res.status, issued, writes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The route table — set AND order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generated from `codingRoutes.routes` against the pre-split `coding.ts` and unchanged by the
 * split. `pnpm openapi:coverage` independently counts these (all 39 are a documented EXCLUSION —
 * the Coder control plane is runner-version coupled, so it is specified at summary level); this
 * pins the ORDER too, which a set comparison cannot see.
 */
const ROUTES = [
	"GET /:instanceId/coding/repos",
	"POST /:instanceId/coding/repos",
	"POST /:instanceId/coding/repos/:repoId/detect-github",
	"DELETE /:instanceId/coding/repos/:repoId",
	"GET /:instanceId/coding/repos/:repoId/instructions",
	"PUT /:instanceId/coding/repos/:repoId/instructions",
	"GET /:instanceId/coding/repos/:repoId/deployment",
	"GET /:instanceId/coding/repos/:repoId/deployments",
	"GET /:instanceId/coding/builds",
	"GET /:instanceId/coding/repos/:repoId/issues",
	"GET /:instanceId/coding/repos/:repoId/issues/:number",
	"GET /:instanceId/coding/work-mode",
	"PUT /:instanceId/coding/work-mode",
	"GET /:instanceId/coding/repos/:repoId/next-issue",
	"PUT /:instanceId/coding/repos/:repoId",
	"GET /:instanceId/coding/repos/:repoId/pulls",
	"GET /:instanceId/coding/repos/:repoId/pulls/:number",
	"GET /:instanceId/coding/sessions",
	"GET /:instanceId/coding/engines",
	"PUT /:instanceId/coding/engines",
	"POST /:instanceId/coding/sessions",
	"POST /:instanceId/coding/sessions/:sessionId/start",
	"GET /:instanceId/coding/sessions/:sessionId/capture",
	"POST /:instanceId/coding/sessions/:sessionId/signin",
	"GET /:instanceId/coding/status",
	"POST /:instanceId/coding/sessions/:sessionId/system-message",
	"POST /:instanceId/coding/sessions/:sessionId/explain",
	"POST /:instanceId/coding/sessions/:sessionId/agent",
	"POST /:instanceId/coding/overseer",
	"GET /:instanceId/coding/sessions/:sessionId/timeline",
	"GET /:instanceId/coding/repos/:repoId/timeline",
	"DELETE /:instanceId/coding/sessions/:sessionId/timeline",
	"POST /:instanceId/coding/sessions/:sessionId/message",
	"POST /:instanceId/coding/sessions/:sessionId/run",
	"POST /:instanceId/coding/sessions/:sessionId/resume",
	"POST /:instanceId/coding/sessions/:sessionId/end",
	"POST /:instanceId/coding/sessions/:sessionId/restart",
	"POST /:instanceId/coding/close-sessions",
	"POST /:instanceId/coding/kill-tmux",
	"GET /:instanceId/coding/browse",
	"GET /:instanceId/coding/diagnostics",
];

describe("the coding route surface", () => {
	it("registers exactly these routes, in this order", () => {
		expect(surface().map((r) => `${r.method} ${r.path}`)).toEqual(ROUTES);
	});

	it("has a probe value for every path parameter it uses", () => {
		// Non-vacuity. If a new parameter name appears, `concrete` throws here rather than in the
		// middle of a probe, where a thrown error would read as an ungated route.
		for (const r of surface()) expect(() => concrete(r.path)).not.toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Which module registered each route
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mount each helper on a BARE Hono and read what it put there — so the map below is the modules'
 * own answer, not a claim about where a handler is written. The routes left over are `coding.ts`'s
 * own.
 *
 * This is what makes the boundary hold. Nothing in the type system stops `GET /coding/builds` from
 * being registered by whichever module a future edit happens to be in; the split is only real
 * while every route can still say where it lives.
 */
function routesOf(register: (app: Hono<{ Bindings: Env }>) => void): string[] {
	const probeApp = new Hono<{ Bindings: Env }>();
	register(probeApp);
	return probeApp.routes.map((r) => `${r.method} ${r.path}`);
}

const HELPERS: Record<string, (app: Hono<{ Bindings: Env }>) => void> = {
	"coding-repos.ts": registerRepoRoutes,
	"coding-pulls.ts": registerPullRoutes,
	"coding-brains.ts": registerCopilotRoutes,
	"coding-diagnostics.ts": registerDiagnosticsRoutes,
};

/** module → the routes it owns. `coding.ts` is the remainder, computed not listed. */
const OWNERSHIP: Record<string, string[]> = {
	"coding-repos.ts": [
		"GET /:instanceId/coding/repos",
		"POST /:instanceId/coding/repos",
		"POST /:instanceId/coding/repos/:repoId/detect-github",
		"DELETE /:instanceId/coding/repos/:repoId",
		"GET /:instanceId/coding/repos/:repoId/instructions",
		"PUT /:instanceId/coding/repos/:repoId/instructions",
		"GET /:instanceId/coding/repos/:repoId/deployment",
		"GET /:instanceId/coding/repos/:repoId/deployments",
		"GET /:instanceId/coding/builds",
		"GET /:instanceId/coding/repos/:repoId/issues",
		"GET /:instanceId/coding/repos/:repoId/issues/:number",
		"GET /:instanceId/coding/work-mode",
		"PUT /:instanceId/coding/work-mode",
		"GET /:instanceId/coding/repos/:repoId/next-issue",
		"PUT /:instanceId/coding/repos/:repoId",
	],
	// The PR surface (#401) — the two routes that read pull requests and attribute them to agent
	// runs. Its own module for the same reason the others are: one answerable question per file.
	"coding-pulls.ts": [
		"GET /:instanceId/coding/repos/:repoId/pulls",
		"GET /:instanceId/coding/repos/:repoId/pulls/:number",
	],
	// The three routes that call a MODEL, and the only ones on this surface that can invent an
	// action rather than execute one. Keeping them nameable as a set is the point of the module.
	"coding-brains.ts": [
		"POST /:instanceId/coding/sessions/:sessionId/explain",
		"POST /:instanceId/coding/sessions/:sessionId/agent",
		"POST /:instanceId/coding/overseer",
	],
	"coding-diagnostics.ts": [
		"POST /:instanceId/coding/close-sessions",
		"POST /:instanceId/coding/kill-tmux",
		"GET /:instanceId/coding/browse",
		"GET /:instanceId/coding/diagnostics",
	],
};

/**
 * What is left in `coding.ts` after #305: the SESSION LIFECYCLE — open one, attach it to a
 * machine, watch its terminal, drive it, end it — plus the three timeline routes, which all read
 * the same `coding_timeline` store. `GET /repos/:repoId/timeline` is here rather than in
 * coding-repos.ts for that reason (and because moving it would change registration order).
 */
const CODING_TS = [
	"GET /:instanceId/coding/sessions",
	"GET /:instanceId/coding/engines",
	"PUT /:instanceId/coding/engines",
	"POST /:instanceId/coding/sessions",
	"POST /:instanceId/coding/sessions/:sessionId/start",
	"GET /:instanceId/coding/sessions/:sessionId/capture",
	"POST /:instanceId/coding/sessions/:sessionId/signin",
	"GET /:instanceId/coding/status",
	"POST /:instanceId/coding/sessions/:sessionId/system-message",
	"GET /:instanceId/coding/sessions/:sessionId/timeline",
	"GET /:instanceId/coding/repos/:repoId/timeline",
	"DELETE /:instanceId/coding/sessions/:sessionId/timeline",
	"POST /:instanceId/coding/sessions/:sessionId/message",
	"POST /:instanceId/coding/sessions/:sessionId/run",
	"POST /:instanceId/coding/sessions/:sessionId/resume",
	"POST /:instanceId/coding/sessions/:sessionId/end",
	"POST /:instanceId/coding/sessions/:sessionId/restart",
];

describe("every route can say which module registered it", () => {
	for (const [module, register] of Object.entries(HELPERS)) {
		it(`${module} registers exactly its documented routes`, () => {
			expect(routesOf(register)).toEqual(OWNERSHIP[module]);
		});
	}

	it("the remainder is coding.ts's own, and nothing is unattributed", () => {
		const claimed = new Set(Object.values(OWNERSHIP).flat());
		expect(ROUTES.filter((r) => !claimed.has(r))).toEqual(CODING_TS);
		// Both directions: a helper claiming a route the surface no longer has is dead config.
		const all = new Set(ROUTES);
		expect([...claimed].filter((r) => !all.has(r))).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3-5. What a stranger gets — the tenant gate and the suspension gate, derived
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `route → [anonymous, non-owner, suspended]`, all three DERIVED by driving the handler.
 *
 * This surface is uniform, and the uniformity IS the assertion: every one of the 39 routes
 * refuses before it does anything, so there is no exception list to argue about and no route
 * whose 2xx has to be justified. Anything other than 401/404/403 is a route that behaves
 * differently from all its neighbours, which is the thing worth being told about.
 *
 *   401  refused before identity resolved (no bearer)
 *   404  the tenant gate refused — the honest answer for "not yours"
 *   403  `requireUser` applied the suspension gate before the route ran
 *
 * A 500 here is a FAILURE, not a pass: it means the handler got past its gate and fell over on a
 * stubbed binding. "Did not return 2xx" would have accepted that, which is why exact codes are
 * pinned instead.
 */
const EXPECTED: [number, number, number] = [401, 404, 403];

describe("what a stranger gets from every route", () => {
	it("every route answers 401 anonymous, 404 to a non-owner, 403 to a suspended account", async () => {
		const stranger = await signSession("stranger", SECRET, { roles: ["user"] });
		const suspended = await signSession("suspended-user", SECRET, { roles: ["user"] });
		const derived: Record<string, [number, number, number]> = {};
		for (const { method, path } of surface()) {
			const anon = await probe(method, path);
			const owner = await probe(method, path, stranger);
			const susp = await probe(method, path, suspended, true);
			derived[`${method} ${path}`] = [anon.status, owner.status, susp.status];
		}
		const expected = Object.fromEntries(ROUTES.map((r) => [r, EXPECTED]));
		expect(
			derived,
			"A coding route that answers a caller who owns nothing hands them a machine: this surface\n" +
				"drives a CLI with --dangerously-skip-permissions over someone's real checkouts. Restore\n" +
				"`requireOwned` — it is the first line of the other 38 handlers.",
		).toEqual(expected);
	});

	it("no route writes anything for a caller who owns nothing", async () => {
		// A status probe cannot see a write: a route could refuse AFTER issuing one. This asserts
		// the stronger property — a caller who owns nothing never reaches a statement that runs.
		const stranger = await signSession("stranger", SECRET, { roles: ["user"] });
		const writers: Record<string, string[]> = {};
		for (const { method, path } of surface()) {
			const { writes } = await probe(method, path, stranger);
			if (writes.length) writers[`${method} ${path}`] = writes;
		}
		expect(writers).toEqual({});
	});

	it("every statement a stranger's request issues against a tenant table binds THAT caller", async () => {
		// The gap a status probe leaves open. A stub D1 answers null whatever you ask it, so a
		// route whose `SELECT ... FROM coding_sessions WHERE id = ?1` lost its `AND user_id = ?3`
		// still 404s here and looks correct — against real D1 it would return someone else's row.
		// So read the BINDS: whatever a route asks about a tenant-owned table, the caller's own id
		// has to be one of the values it binds.
		const TENANT_TABLES = /\b(agent_instances|coding_repos|coding_sessions|coding_timeline|instance_runtimes|instance_runtime_nodes)\b/;
		const stranger = await signSession("stranger", SECRET, { roles: ["user"] });
		const unscoped: Record<string, string[]> = {};
		for (const { method, path } of surface()) {
			const { issued } = await probe(method, path, stranger);
			const bad = issued.filter((s) => TENANT_TABLES.test(s.sql) && !s.binds.includes("stranger")).map((s) => s.sql);
			if (bad.length) unscoped[`${method} ${path}`] = bad;
		}
		// The Co-pilot/Overseer capability lookups are the documented exception, and they are reads
		// of the AGENT's declared shape rather than of the caller's data: `SELECT a.slug, a.category,
		// a.config FROM agent_instances i JOIN agents a … WHERE i.id = ?1` answers "does this agent
		// declare a Co-pilot at all". They run AFTER `requireOwned` has already refused a stranger,
		// so they are unreachable on this probe — and are listed by SQL, not by route, so widening
		// one into something that reads the instance's own data fails here.
		expect(unscoped).toEqual({});
	});

	it("the probe really reached a tenant statement on every route", async () => {
		// Non-vacuity for the assertion above: "no unscoped statements" is trivially true of a
		// route that issues none. Every route must have asked D1 about a tenant table at least
		// once, which is `requireOwned` doing its job.
		const stranger = await signSession("stranger", SECRET, { roles: ["user"] });
		const silent: string[] = [];
		for (const { method, path } of surface()) {
			const { issued } = await probe(method, path, stranger);
			if (!issued.some((s) => /FROM agent_instances/.test(s.sql))) silent.push(`${method} ${path}`);
		}
		expect(silent).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The payer observation (#348/#356) and the closing drain (#267)
// ─────────────────────────────────────────────────────────────────────────────

/** A D1 that answers as if `owner-uid` owns everything, and records what it was asked to write. */
function ownerEnv(opts: { session?: Record<string, unknown> | null; config?: string } = {}) {
	const ledger: Statement[] = [];
	const runs: Statement[] = [];
	const sessionRow =
		opts.session === undefined
			? {
					id: "csess-1",
					instance_id: "inst-1",
					repo_id: "repo-1",
					user_id: "owner-uid",
					client_type: "claude",
					status: "active",
					tmux_session: "claude:csess-1",
					runner_node: "laptop",
					launch_command: "claude",
					issue_number: null,
					issue_title: null,
					started_at: "2026-08-07T00:00:00.000Z",
					ended_at: null,
					updated_at: "2026-08-07T00:00:00.000Z",
				}
			: opts.session;

	const answer = (sql: string): unknown => {
		if (/SELECT id FROM agent_instances/.test(sql)) return { id: "inst-1" };
		if (/FROM users/.test(sql)) return null;
		if (/SELECT config FROM agent_instances/.test(sql)) return { config: opts.config ?? "{}" };
		if (/FROM coding_sessions/.test(sql)) return sessionRow;
		// A session stamped with a node resolves through `instance_runtime_nodes`; the legacy
		// single-machine path reads `instance_runtimes`. Both are the same registered machine here.
		if (/FROM instance_runtime(s|_nodes)/.test(sql)) {
			return { endpoint_url: "https://runner.invalid", token_plaintext: "tok", runner_node: "laptop" };
		}
		return null;
	};

	const DB = {
		prepare(sql: string) {
			const flat = sql.replace(/\s+/g, " ").trim();
			const stmt = {
				_sql: flat,
				_binds: [] as unknown[],
				bind(...binds: unknown[]) {
					stmt._binds = binds;
					return stmt;
				},
				first: async () => answer(flat),
				all: async () => ({ results: [] }),
				run: async () => {
					runs.push({ sql: flat, binds: stmt._binds });
					return { meta: { changes: 1 } };
				},
			};
			return stmt;
		},
		batch: async (stmts: Array<{ _sql: string; _binds: unknown[] }>) => {
			for (const s of stmts) ledger.push({ sql: s._sql, binds: s._binds });
			return [];
		},
	};

	/** The runner, reachable over a stub relay. `reply` decides what each runner path answers. */
	const relayFor = (reply: (path: string) => unknown) => ({
		idFromName: (n: string) => n,
		get: () => ({
			async fetch(req: Request) {
				const url = new URL(req.url);
				if (url.pathname === "/status") return Response.json({ connected: true });
				const body = (await req.json()) as { path: string };
				return Response.json(reply(body.path));
			},
		}),
	});

	return { DB, ledger, runs, relayFor };
}

/** The same mounted surface the stranger probe drives — the env is passed per request. */
function ownerApp() {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", codingRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	return app;
}

/** One engine turn, in the shape the runner drains onto the capture reply. */
const TURN = {
	id: "turn-1",
	model: "claude-sonnet-4-6",
	inputTokens: 1000,
	outputTokens: 200,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsd: 0.5,
};

/** The `payer` column is bind ?11 on the ai_usage insert — the LAST value bound. */
const payerOf = (row: Statement) => row.binds[row.binds.length - 1];

describe("the payer observation survives (#348/#356)", () => {
	/**
	 * Why this is driven rather than grepped. `authResolved` is ONE argument at ONE call site, and
	 * only the runner can supply it — the credential is decided by a merge with the machine's own
	 * shell, which happens there. Drop it in a move and every ledger row still writes: same tokens,
	 * same cost, `payer` silently NULL. The Usage page looks fine. What breaks is #343's spend
	 * ceiling, which then refuses work over money nobody was charged, and the only symptom is an
	 * agent that stops.
	 */
	async function capture(authResolved: string | undefined) {
		const { DB, ledger, relayFor } = ownerEnv();
		const env = {
			SESSION_SIGNING_KEY: SECRET,
			DB,
			RELAY: relayFor(() => ({ pane: "$ ", runState: "running", alive: true, usage: [TURN], ...(authResolved ? { authResolved } : {}) })),
		} as unknown as Env;
		const token = await signSession("owner-uid", SECRET, { roles: ["user"] });
		const res = await ownerApp().request(
			"/v1/instances/inst-1/coding/sessions/csess-1/capture",
			{ headers: { Authorization: `Bearer ${token}` } },
			env,
		);
		return { status: res.status, ledger, body: (await res.json()) as Record<string, unknown> };
	}

	it("carries the runner's observation onto the ledger row — an API key is BILLED", async () => {
		const { status, ledger } = await capture("api-key");
		expect(status).toBe(200);
		expect(ledger).toHaveLength(1);
		expect(ledger[0].sql).toContain("INSERT OR IGNORE INTO ai_usage");
		expect(payerOf(ledger[0])).toBe("byok-api");
	});

	it("a subscription turn is recorded as a subscription, which is what stops the money ceiling", async () => {
		// The regression #343 is about: a run halted over spend that was drawn from a plan, not
		// charged. It only reads correctly if the observation reaches the row.
		const { ledger } = await capture("subscription");
		expect(payerOf(ledger[0])).toBe("subscription");
	});

	it("a runner too old to report it writes UNKNOWN, never a guess", async () => {
		// `machine-login` and "field absent" both mean the same thing: the CLI signed in with
		// something stored on that machine and we cannot tell what. Recording a guess would be
		// worse than recording nothing, because a ceiling would then act on it.
		expect(payerOf((await capture(undefined)).ledger[0])).toBeNull();
		expect(payerOf((await capture("machine-login")).ledger[0])).toBeNull();
	});

	it("the drained spend is ledgered, not echoed back to the console", async () => {
		// `usage` is drained, so it lands on one poll in a hundred and is empty on the rest.
		// Returning it would look like a field that flickers.
		const { body } = await capture("api-key");
		expect(body.usage).toBeUndefined();
		expect(body.runnerConnected).toBe(true);
	});

	it("ending a session ledgers the closing turn (#267)", async () => {
		// A session's last turn routinely completes after its final capture poll, so a drain only
		// on /capture would lose the closing turn of EVERY session — a bias, not noise.
		const { DB, ledger, relayFor } = ownerEnv();
		const env = {
			SESSION_SIGNING_KEY: SECRET,
			DB,
			RELAY: relayFor(() => ({ usage: [{ ...TURN, id: "closing-turn" }] })),
		} as unknown as Env;
		const token = await signSession("owner-uid", SECRET, { roles: ["user"] });
		const res = await ownerApp().request(
			"/v1/instances/inst-1/coding/sessions/csess-1/end",
			{ method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" },
			env,
		);
		expect(res.status).toBe(200);
		expect(ledger).toHaveLength(1);
		expect(ledger[0].binds).toContain("owner-uid");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Merge authority (#314) — the per-repo half
// ─────────────────────────────────────────────────────────────────────────────

describe("merge authority is set through this route, and only with a value it knows (#314)", () => {
	async function putRepo(body: unknown) {
		const { DB, runs, relayFor } = ownerEnv();
		const env = { SESSION_SIGNING_KEY: SECRET, DB, RELAY: relayFor(() => ({})) } as unknown as Env;
		const token = await signSession("owner-uid", SECRET, { roles: ["user"] });
		const res = await ownerApp().request(
			"/v1/instances/inst-1/coding/repos/repo-1",
			{ method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
			env,
		);
		return { status: res.status, body: (await res.json()) as { error?: string }, runs };
	}

	it("persists a policy the vocabulary defines", async () => {
		const { status, runs } = await putRepo({ mergePolicy: "pr" });
		expect(status).toBe(200);
		const update = runs.find((r) => /UPDATE coding_repos/.test(r.sql));
		expect(update?.binds).toContain("pr");
		// Owner-scoped, like everything else that writes on this surface.
		expect(update?.binds).toContain("owner-uid");
	});

	it("refuses one it does not, rather than storing a policy nobody chose", async () => {
		// `resolveMergePolicy` falls THROUGH an unrecognised stored value to the next level, so a
		// typo that got written would silently resolve to the permissive default — an agent
		// merging to main because a field said "PR" with the wrong case. Reject at the edge.
		const { status, body, runs } = await putRepo({ mergePolicy: "PR" });
		expect(status).toBe(400);
		expect(body.error).toContain("mergePolicy must be one of");
		expect(runs.filter((r) => /UPDATE coding_repos/.test(r.sql))).toEqual([]);
	});

	it('clearing it back to inherit ("") is a value, not an omission', async () => {
		// `undefined` means "this PUT is about something else"; `""` means "stop overriding".
		// Collapsing the two would make the repo override impossible to remove.
		const { status, runs } = await putRepo({ mergePolicy: "" });
		expect(status).toBe(200);
		expect(runs.find((r) => /UPDATE coding_repos/.test(r.sql))?.binds).toContain("");
	});

	it("a PUT that changes nothing is refused, so an empty body cannot look like a policy change", async () => {
		const { status, body } = await putRepo({});
		expect(status).toBe(400);
		// `workdir` joined the list in #410 — the folder is editable through this same route now.
		// `policies` joined it in #322, which is why the message is pinned: every field this route
		// can change has to be NAMED here, or a caller sending the one that was forgotten is told
		// their request was empty.
		expect(body.error).toBe("name, urls, mergePolicy, workdir or policies is required");
	});
});
