/**
 * The instance REST surface, held to a table — every value in it DERIVED by driving the
 * registered handler, never read out of the source (#305).
 *
 * ── Why a contract test and not just a split
 *
 * `routes/instances.ts` carried 55 of these 75 routes in one file. Size was not the
 * problem it caused. The problem is that a route's TENANT GATE is one `await
 * requireOwnedInstance(...)` line — or, on a dozen of them, an inline `SELECT id FROM
 * agent_instances WHERE id = ?1 AND user_id = ?2` — inside a closure that looks exactly
 * like its forty neighbours. Delete it and nothing typechecks differently, no test fails,
 * and no reviewer scrolling past the fortieth near-identical block sees it. `SECURITY.md`
 * calls per-route `user_id`/`owner_id` scoping the thing that stops cross-tenant reads,
 * and until this file nothing asserted it for more than a handful of routes by hand.
 *
 * So the table below is derived by ASKING each route, not by reading it:
 *
 *   1. the ordered route table            — `instanceRoutes.routes`
 *   2. which module registered each route — each `register*Routes` mounted on a bare Hono
 *   3. what an ANONYMOUS caller gets      — drive it with no Authorization header
 *   4. what a NON-OWNER caller gets       — drive it with a valid session for a user who
 *                                           owns nothing, against a D1 that resolves no
 *                                           ownership row for anybody
 *
 * (4) is the invariant. A route that loses its `WHERE user_id = ?` stops refusing and
 * starts doing work against someone else's instance, and the status it returns changes —
 * so it moves in this table, which is pinned. A route added without a gate arrives in the
 * table at once and fails until someone writes down what it is allowed to do.
 *
 * ── Also the evidence that the #305 split changed no behaviour
 *
 * This table was generated against the pre-split `instances.ts` (all 75 routes, 55 of them
 * in that one file) and is byte-identical against the post-split modules. Registration
 * ORDER is included on purpose: Hono matches in registration order, so a split that moves
 * a block past a sibling pattern is a behaviour change even when the route SET is equal.
 * That is why `registerTaskRoutes` / `registerChatRoutes` / `registerKnowledgeRoutes` are
 * called from the exact positions their blocks occupied rather than gathered with the
 * other five at the top of the file.
 *
 * ── Reading a status in the table
 *
 *   401  refused before identity resolved (no bearer)
 *   404  the tenant gate refused — the honest answer for "not yours", and what almost
 *        every `:instanceId` route must give a stranger
 *   403  a policy gate refused ahead of the tenant gate
 *   200  the route answered. On the NON-OWNER probe that has to be justified per route.
 *
 * A 500 here is a FAILURE, not a pass: it means the handler got past its gate and fell
 * over on a stubbed binding. "Did not return 2xx" would have accepted that, which is why
 * the exact code is pinned instead.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { registerApplyRoutes } from "./instances-apply.js";
import { registerBehaviourRoutes } from "./instances-behaviour.js";
import { registerBrowseRoutes } from "./instances-browse.js";
import { registerChatRoutes } from "./instances-chat.js";
import { registerFileUploadRoutes } from "./instances-files.js";
import { registerKnowledgeRoutes } from "./instances-knowledge.js";
import { registerTaskRoutes } from "./instances-tasks.js";
import { registerDeployStatusRoutes } from "./instances-deploy.js";
import { registerConnectorBindingRoutes } from "./instances-terminal.js";
import { CONNECTOR_CONSTRAINTS } from "../lib/surface-options.js";
import { registerTranslationRoutes } from "./instances-translation.js";
import { instanceRoutes } from "./instances.js";

const SECRET = "instances-contract-secret";

/**
 * A D1 that resolves NOTHING. Every ownership lookup — `requireOwnedInstance`, the inline
 * `SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2`, the settings-schema
 * JOIN, the runtime rows — comes back empty, which is the state a stranger's request is
 * really in. Writes are counted rather than performed: a route that WRITES on this probe
 * has already lost, and the count is asserted below.
 */
function strangerEnv() {
	const writes: string[] = [];
	const DB = {
		prepare(sql: string) {
			const stmt = {
				bind: () => stmt,
				first: async () => null,
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
	// Bindings a gated handler must never reach. Each throws, so getting past the gate
	// surfaces as a 500 in the table rather than as a quiet pass.
	const boom = (what: string) => () => {
		throw new Error(`ungated: reached ${what}`);
	};
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB,
		AGENT: { idFromName: boom("AgentDO.idFromName"), get: boom("AgentDO.get") },
		STORAGE: { get: boom("R2.get"), put: boom("R2.put"), createMultipartUpload: boom("R2.mpu") },
		AI: { run: boom("Workers AI") },
		RELAY: { idFromName: boom("RelayDO"), get: boom("RelayDO") },
	} as unknown as Env;
	return { env, writes };
}

function buildApp() {
	const { env, writes } = strangerEnv();
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	return { app, env, writes };
}

/** Concrete values for every path parameter the surface uses. */
const PARAMS: Record<string, string> = {
	agentId: "agent-1",
	instanceId: "instance-owned-by-someone-else",
	taskId: "task-1",
	docId: "doc-1",
	turnId: "turn-1",
	uploadId: "upload-1",
	seq: "1",
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
	for (const r of instanceRoutes.routes) {
		const key = `${r.method} ${r.path}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ method: r.method, path: r.path });
	}
	return out;
}

/**
 * Bodies for the routes that VALIDATE before they check ownership. Without these the probe
 * short-circuits on a 400 and never reaches the tenant gate — it would assert that a
 * missing field is rejected, which is not the property under test.
 *
 * `POST /:instanceId/chat` used to be the clearest case and is deliberately NOT here any
 * more (#350): it now runs the ownership SELECT first, so an empty body from a stranger is
 * 404. Leaving it out is what makes that ordering an assertion — put a body back and the
 * probe stops being able to see the difference.
 */
const BODIES: Record<string, unknown> = {
	"POST /:instanceId/system-message": { content: "probe" },
	"POST /:instanceId/loop-decide": { objective: "probe", messages: [], iteration: 1, maxIterations: 2 },
	"POST /:instanceId/board/status": { jobKey: "j1", status: "" },
	"POST /:instanceId/tasks/direct": { title: "probe" },
	"POST /:instanceId/tasks/:taskId/hint": { hint: "probe" },
	"POST /:instanceId/tasks/:taskId/thread": { message: "probe" },
	"PUT /:instanceId/name": { name: "probe" },
	"POST /:instanceId/translate": { text: "probe", target: "fr" },
	"POST /:instanceId/browse": { url: "https://example.com" },
	"POST /:instanceId/apply": { url: "https://example.com/job" },
	"POST /:instanceId/input": { taskId: "task-1", value: "probe" },
};

/** Drive one route and report the status it answers with, plus any SQL it tried to write. */
async function probe(method: string, pattern: string, token?: string): Promise<{ status: number; writes: string[] }> {
	const { app, env, writes } = buildApp();
	const init: RequestInit = {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			"Content-Type": "application/json",
		},
	};
	if (method !== "GET" && method !== "DELETE") init.body = JSON.stringify(BODIES[`${method} ${pattern}`] ?? {});
	const res = await app.request(`/v1/instances${concrete(pattern)}`, init, env);
	return { status: res.status, writes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The route table — set AND order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generated from `instanceRoutes.routes` against the pre-split file and unchanged since.
 * `pnpm docs:drift` independently counts these against store/openapi.yaml; this pins the
 * ORDER too, which the OpenAPI scan (a set comparison over a regex) cannot see.
 */
const ROUTES = [
	"POST /:agentId/subscribe",
	"GET /my/instances",
	"POST /:instanceId/runtime",
	"GET /:instanceId/runtime",
	"GET /:instanceId/runner-node",
	"PUT /:instanceId/runner-node",
	"GET /:instanceId/terminal-session",
	"PUT /:instanceId/terminal-session",
	"POST /:instanceId/runtime/heartbeat",
	"PUT /:instanceId/voice-audio/:turnId",
	"GET /:instanceId/voice-audio/:turnId",
	"GET /:instanceId/voice-settings",
	"GET /:instanceId/trace",
	"PUT /:instanceId/voice-settings",
	"DELETE /:instanceId/voice-settings",
	"PUT /:instanceId/name",
	"GET /:instanceId/settings",
	"PUT /:instanceId/settings",
	"GET /:instanceId/runtime/status",
	"PUT /:instanceId/apply-resume",
	"POST /:instanceId/apply-resume/parse",
	"GET /:instanceId/apply-resume/status",
	"DELETE /:instanceId/apply-resume",
	"GET /:instanceId/apply-resume",
	"GET /:instanceId/tasks/:taskId/shots/:seq",
	"GET /:instanceId/takeover",
	"GET /:instanceId/takeover/:taskId/frame",
	"POST /:instanceId/takeover/:taskId/input",
	"POST /:instanceId/takeover/:taskId/resume",
	"GET /:instanceId/instructions",
	"PUT /:instanceId/instructions",
	"GET /:instanceId/apply-tips",
	"POST /:instanceId/input",
	"POST /:instanceId/takeover/:taskId/end",
	"POST /:instanceId/apply",
	"GET /behaviour-schema",
	"GET /:instanceId/behaviour",
	"PUT /:instanceId/behaviour",
	"DELETE /:instanceId/behaviour",
	"POST /:instanceId/browse",
	"GET /:instanceId/translation",
	"PUT /:instanceId/translation",
	"DELETE /:instanceId/translation",
	"POST /:instanceId/translate",
	"POST /:instanceId/files/multipart/create",
	"PUT /:instanceId/files/multipart/:uploadId/part",
	"POST /:instanceId/files/multipart/:uploadId/complete",
	"DELETE /:instanceId/files/multipart/:uploadId",
	"GET /:instanceId/terminal-target",
	"PUT /:instanceId/terminal-target",
	"GET /:instanceId/tmux-session",
	"PUT /:instanceId/tmux-session",
	"GET /:instanceId/deploy-status",
	"GET /:instanceId/deploy-history",
	"PUT /:instanceId/deploy-status",
	"DELETE /:instanceId/runtime",
	"GET /:instanceId/tasks",
	"GET /:instanceId/board",
	"POST /:instanceId/board/status",
	"GET /:instanceId/board-config",
	"PUT /:instanceId/board-config",
	"POST /:instanceId/tasks",
	"POST /:instanceId/tasks/direct",
	"POST /:instanceId/tasks/:taskId/run",
	"GET /:instanceId/tasks/:taskId/thread",
	"POST /:instanceId/tasks/:taskId/thread",
	"GET /:instanceId/tasks/:taskId",
	"POST /:instanceId/tasks/:taskId/approve",
	"POST /:instanceId/tasks/:taskId/hint",
	"POST /:instanceId/tasks/clear-finished",
	"DELETE /:instanceId/tasks/:taskId",
	"POST /:instanceId/tasks/:taskId/cancel",
	"GET /:instanceId/task-events",
	"POST /:instanceId/chat",
	"POST /:instanceId/loop-decide",
	"POST /:instanceId/system-message",
	"GET /:instanceId/messages",
	"POST /:instanceId/knowledge",
	"DELETE /:instanceId/knowledge/:docId",
	"GET /:instanceId/knowledge/:docId",
	"PUT /:instanceId/knowledge/:docId",
	"POST /:instanceId/knowledge/ingest-url",
	"GET /:instanceId/knowledge",
	"POST /:instanceId/cancel",
];

describe("the instance route surface", () => {
	it("registers exactly these routes, in this order", () => {
		expect(surface().map((r) => `${r.method} ${r.path}`)).toEqual(ROUTES);
	});

	it("has a probe value for every path parameter it uses", () => {
		// Non-vacuity. If a new parameter name appears, `concrete` throws here rather than in
		// the middle of a probe, where a thrown error would read as an ungated route.
		for (const r of surface()) expect(() => concrete(r.path)).not.toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Which module registered each route
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mount each helper on a BARE Hono and read what it put there — so the map below is the
 * modules' own answer, not a claim about where a handler is written. The routes left over
 * are `instances.ts`'s own.
 *
 * This is what makes a boundary hold. Nothing in the type system stops `POST
 * /:instanceId/knowledge` from being registered by whichever module a future edit happens
 * to be in; the split is only real while every route can still say where it lives.
 */
function routesOf(register: (app: Hono<{ Bindings: Env }>) => void): string[] {
	const probeApp = new Hono<{ Bindings: Env }>();
	register(probeApp);
	return probeApp.routes.map((r) => `${r.method} ${r.path}`);
}

const HELPERS: Record<string, (app: Hono<{ Bindings: Env }>) => void> = {
	"instances-apply.ts": registerApplyRoutes,
	"instances-behaviour.ts": registerBehaviourRoutes,
	"instances-browse.ts": registerBrowseRoutes,
	"instances-chat.ts": registerChatRoutes,
	"instances-files.ts": registerFileUploadRoutes,
	"instances-knowledge.ts": registerKnowledgeRoutes,
	"instances-tasks.ts": registerTaskRoutes,
	"instances-deploy.ts": registerDeployStatusRoutes,
	"instances-terminal.ts": registerConnectorBindingRoutes,
	"instances-translation.ts": registerTranslationRoutes,
};

/** module → the routes it owns. `instances.ts` is the remainder, computed not listed. */
const OWNERSHIP: Record<string, string[]> = {
	"instances-apply.ts": [
		"PUT /:instanceId/apply-resume",
		"POST /:instanceId/apply-resume/parse",
		"GET /:instanceId/apply-resume/status",
		"DELETE /:instanceId/apply-resume",
		"GET /:instanceId/apply-resume",
		"GET /:instanceId/tasks/:taskId/shots/:seq",
		"GET /:instanceId/takeover",
		"GET /:instanceId/takeover/:taskId/frame",
		"POST /:instanceId/takeover/:taskId/input",
		"POST /:instanceId/takeover/:taskId/resume",
		"GET /:instanceId/instructions",
		"PUT /:instanceId/instructions",
		"GET /:instanceId/apply-tips",
		"POST /:instanceId/input",
		"POST /:instanceId/takeover/:taskId/end",
		"POST /:instanceId/apply",
	],
	"instances-behaviour.ts": [
		"GET /behaviour-schema",
		"GET /:instanceId/behaviour",
		"PUT /:instanceId/behaviour",
		"DELETE /:instanceId/behaviour",
	],
	"instances-browse.ts": ["POST /:instanceId/browse"],
	"instances-chat.ts": [
		"POST /:instanceId/chat",
		"POST /:instanceId/loop-decide",
		"POST /:instanceId/system-message",
		"GET /:instanceId/messages",
	],
	"instances-files.ts": [
		"POST /:instanceId/files/multipart/create",
		"PUT /:instanceId/files/multipart/:uploadId/part",
		"POST /:instanceId/files/multipart/:uploadId/complete",
		"DELETE /:instanceId/files/multipart/:uploadId",
	],
	"instances-knowledge.ts": [
		"POST /:instanceId/knowledge",
		"DELETE /:instanceId/knowledge/:docId",
		"GET /:instanceId/knowledge/:docId",
		"PUT /:instanceId/knowledge/:docId",
		"POST /:instanceId/knowledge/ingest-url",
		"GET /:instanceId/knowledge",
	],
	"instances-tasks.ts": [
		"GET /:instanceId/tasks",
		"GET /:instanceId/board",
		"POST /:instanceId/board/status",
		"GET /:instanceId/board-config",
		"PUT /:instanceId/board-config",
		"POST /:instanceId/tasks",
		"POST /:instanceId/tasks/direct",
		"POST /:instanceId/tasks/:taskId/run",
		"GET /:instanceId/tasks/:taskId/thread",
		"POST /:instanceId/tasks/:taskId/thread",
		"GET /:instanceId/tasks/:taskId",
		"POST /:instanceId/tasks/:taskId/approve",
		"POST /:instanceId/tasks/:taskId/hint",
		"POST /:instanceId/tasks/clear-finished",
		"DELETE /:instanceId/tasks/:taskId",
		"POST /:instanceId/tasks/:taskId/cancel",
		"GET /:instanceId/task-events",
	],
	"instances-deploy.ts": [
		"GET /:instanceId/deploy-status",
		"GET /:instanceId/deploy-history",
		"PUT /:instanceId/deploy-status",
	],
	"instances-terminal.ts": [
		"GET /:instanceId/terminal-target",
		"PUT /:instanceId/terminal-target",
		"GET /:instanceId/tmux-session",
		"PUT /:instanceId/tmux-session",
	],
	"instances-translation.ts": [
		"GET /:instanceId/translation",
		"PUT /:instanceId/translation",
		"DELETE /:instanceId/translation",
		"POST /:instanceId/translate",
	],
};

/** What is left in `instances.ts` after #305: subscribe/cancel, runtime + nodes, voice, settings, trace. */
const INSTANCES_TS = [
	"POST /:agentId/subscribe",
	"GET /my/instances",
	"POST /:instanceId/runtime",
	"GET /:instanceId/runtime",
	"GET /:instanceId/runner-node",
	"PUT /:instanceId/runner-node",
	"GET /:instanceId/terminal-session",
	"PUT /:instanceId/terminal-session",
	"POST /:instanceId/runtime/heartbeat",
	"PUT /:instanceId/voice-audio/:turnId",
	"GET /:instanceId/voice-audio/:turnId",
	"GET /:instanceId/voice-settings",
	"GET /:instanceId/trace",
	"PUT /:instanceId/voice-settings",
	"DELETE /:instanceId/voice-settings",
	"PUT /:instanceId/name",
	"GET /:instanceId/settings",
	"PUT /:instanceId/settings",
	"GET /:instanceId/runtime/status",
	"DELETE /:instanceId/runtime",
	"POST /:instanceId/cancel",
];

describe("every route can say which module registered it", () => {
	for (const [module, register] of Object.entries(HELPERS)) {
		it(`${module} registers exactly its documented routes`, () => {
			expect(routesOf(register)).toEqual(OWNERSHIP[module]);
		});
	}

	it("the remainder is instances.ts's own, and nothing is unattributed", () => {
		const claimed = new Set(Object.values(OWNERSHIP).flat());
		const remainder = ROUTES.filter((r) => !claimed.has(r));
		expect(remainder).toEqual(INSTANCES_TS);
		// Both directions: a helper claiming a route the surface no longer has is dead config.
		const all = new Set(ROUTES);
		expect([...claimed].filter((r) => !all.has(r))).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 + 4. What a stranger gets — the tenant gate, derived
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `route → [anonymous status, non-owner status]`, both DERIVED by driving the handler.
 *
 * The second number is the invariant. 404 means the tenant gate refused: the route asked
 * D1 for a row scoped to the caller, got nothing, and stopped. Anything else is written
 * down with a reason.
 */
const GATES: Record<string, [number, number]> = {
	// `subscribe` creates; there is no instance to own yet. It resolves an AGENT (404 here
	// because the stub D1 publishes none), so it is gated on the agent's visibility, not on
	// a tenant row — the one route on this surface for which that is correct.
	"POST /:agentId/subscribe": [401, 404],
	// The list route IS the tenant query: `WHERE i.user_id = ?1`. A stranger gets 200 and an
	// empty list, which is the right answer and not a hole — asserted as empty below.
	"GET /my/instances": [401, 200],
	"POST /:instanceId/runtime": [401, 404],
	"GET /:instanceId/runtime": [401, 404],
	"GET /:instanceId/runner-node": [401, 404],
	"PUT /:instanceId/runner-node": [401, 404],
	// The last-selected terminal session for this instance (#491). Same gate as runner-node.
	"GET /:instanceId/terminal-session": [401, 404],
	"PUT /:instanceId/terminal-session": [401, 404],
	"POST /:instanceId/runtime/heartbeat": [401, 404],
	"PUT /:instanceId/voice-audio/:turnId": [401, 404],
	"GET /:instanceId/voice-audio/:turnId": [401, 404],
	"GET /:instanceId/voice-settings": [401, 404],
	"GET /:instanceId/trace": [401, 404],
	"PUT /:instanceId/voice-settings": [401, 404],
	"DELETE /:instanceId/voice-settings": [401, 404],
	// Was [401, 200] — the hole this table found (#305) and #350 closed. `readInstanceConfig`
	// answers `{}` for a row that is not yours exactly as it does for an owned instance with no
	// config, so reading it was never a tenant check; the route is gated on `requireOwnedInstance`
	// now. The probe still sends a well-formed `{name:"probe"}` (see BODIES) so this asserts that
	// a REAL rename is refused, not merely that a malformed one is.
	"PUT /:instanceId/name": [401, 404],
	"GET /:instanceId/settings": [401, 404],
	"PUT /:instanceId/settings": [401, 404],
	"GET /:instanceId/runtime/status": [401, 404],
	"PUT /:instanceId/apply-resume": [401, 404],
	"POST /:instanceId/apply-resume/parse": [401, 404],
	"GET /:instanceId/apply-resume/status": [401, 404],
	"DELETE /:instanceId/apply-resume": [401, 404],
	// The runner's own résumé download. Authenticated by a signed, expiring `?uid&exp&token`
	// HMAC rather than a session — the runner has no bearer — so a session, valid or not, is
	// simply not the credential this route accepts. 401 for everyone without the signature.
	"GET /:instanceId/apply-resume": [401, 401],
	"GET /:instanceId/tasks/:taskId/shots/:seq": [401, 404],
	"GET /:instanceId/takeover": [401, 404],
	"GET /:instanceId/takeover/:taskId/frame": [401, 404],
	"POST /:instanceId/takeover/:taskId/input": [401, 404],
	"POST /:instanceId/takeover/:taskId/resume": [401, 404],
	"GET /:instanceId/instructions": [401, 404],
	"PUT /:instanceId/instructions": [401, 404],
	"GET /:instanceId/apply-tips": [401, 404],
	"POST /:instanceId/input": [401, 404],
	"POST /:instanceId/takeover/:taskId/end": [401, 404],
	"POST /:instanceId/apply": [401, 404],
	// The behaviour FIELD TABLE — the vocabulary the console renders and the prompt is built
	// from. Public by design: it is the same table for every agent and carries no instance.
	"GET /behaviour-schema": [200, 200],
	"GET /:instanceId/behaviour": [401, 404],
	"PUT /:instanceId/behaviour": [401, 404],
	"DELETE /:instanceId/behaviour": [401, 404],
	"POST /:instanceId/browse": [401, 404],
	"GET /:instanceId/translation": [401, 404],
	"PUT /:instanceId/translation": [401, 404],
	"DELETE /:instanceId/translation": [401, 404],
	"POST /:instanceId/translate": [401, 404],
	"POST /:instanceId/files/multipart/create": [401, 404],
	"PUT /:instanceId/files/multipart/:uploadId/part": [401, 404],
	"POST /:instanceId/files/multipart/:uploadId/complete": [401, 404],
	"DELETE /:instanceId/files/multipart/:uploadId": [401, 404],
	// The terminal-target binding (#402). Same shape as `/runner-node` above and gated the same
	// way: the subscriber's half of a creator-declared ceiling is still the subscriber's, so a
	// stranger must not read WHICH pane someone else's agent drives, let alone rebind it.
	"GET /:instanceId/terminal-target": [401, 404],
	"PUT /:instanceId/terminal-target": [401, 404],
	// The tmux-session binding (#447) — the same route pair for the connector the one PUBLISHED
	// Operator actually runs on. Gated identically, and it has to be: which pane an agent may drive
	// is exactly as much somebody else's business as which terminal.
	"GET /:instanceId/tmux-session": [401, 404],
	"PUT /:instanceId/tmux-session": [401, 404],
	// Deployment / build status (#488). Owner-only: a stranger must not see which repo someone
	// else's instance tracks or read their build history.
	"GET /:instanceId/deploy-status": [401, 404],
	"GET /:instanceId/deploy-history": [401, 404],
	"PUT /:instanceId/deploy-status": [401, 404],
	"DELETE /:instanceId/runtime": [401, 404],
	"GET /:instanceId/tasks": [401, 404],
	"GET /:instanceId/board": [401, 404],
	"POST /:instanceId/board/status": [401, 404],
	"GET /:instanceId/board-config": [401, 404],
	"PUT /:instanceId/board-config": [401, 404],
	"POST /:instanceId/tasks": [401, 404],
	"POST /:instanceId/tasks/direct": [401, 404],
	"POST /:instanceId/tasks/:taskId/run": [401, 404],
	"GET /:instanceId/tasks/:taskId/thread": [401, 404],
	"POST /:instanceId/tasks/:taskId/thread": [401, 404],
	"GET /:instanceId/tasks/:taskId": [401, 404],
	"POST /:instanceId/tasks/:taskId/approve": [401, 404],
	"POST /:instanceId/tasks/:taskId/hint": [401, 404],
	"POST /:instanceId/tasks/clear-finished": [401, 404],
	"DELETE /:instanceId/tasks/:taskId": [401, 404],
	"POST /:instanceId/tasks/:taskId/cancel": [401, 404],
	"GET /:instanceId/task-events": [401, 404],
	"POST /:instanceId/chat": [401, 404],
	"POST /:instanceId/loop-decide": [401, 404],
	"POST /:instanceId/system-message": [401, 404],
	"GET /:instanceId/messages": [401, 404],
	"POST /:instanceId/knowledge": [401, 404],
	"DELETE /:instanceId/knowledge/:docId": [401, 404],
	"GET /:instanceId/knowledge/:docId": [401, 404],
	"PUT /:instanceId/knowledge/:docId": [401, 404],
	"POST /:instanceId/knowledge/ingest-url": [401, 404],
	"GET /:instanceId/knowledge": [401, 404],
	"POST /:instanceId/cancel": [401, 404],
};

describe("what a stranger gets from every route", () => {
	it("the gate table covers the surface exactly", () => {
		expect(Object.keys(GATES).sort()).toEqual([...ROUTES].sort());
	});

	it("derives the same statuses the table records", async () => {
		const stranger = await signSession("stranger", SECRET, { roles: ["user"] });
		const derived: Record<string, [number, number]> = {};
		for (const { method, path } of surface()) {
			const anon = await probe(method, path);
			const owner = await probe(method, path, stranger);
			derived[`${method} ${path}`] = [anon.status, owner.status];
		}
		expect(derived).toEqual(GATES);
	});

	/**
	 * The routes that a caller who owns nothing can get a 2xx out of. Each one is a claim that
	 * needs a reason, and the set is compared EXACTLY — so a route that starts answering a
	 * stranger fails here even if someone updates GATES without reading it.
	 */
	const ANSWERS_A_STRANGER: Record<string, string> = {
		"GET /my/instances": "IS the tenant query (WHERE i.user_id = ?1) — answers with an empty list",
		"GET /behaviour-schema": "the behaviour field table: the same static vocabulary for every agent, public by design",
	};

	it("only the documented routes answer a caller who owns nothing", () => {
		expect(
			Object.entries(GATES)
				.filter(([, [, owner]]) => owner >= 200 && owner < 300)
				.map(([r]) => r)
				.sort(),
			`A route that answers 2xx to a session owning nothing must be justified. Add\n` +
				`requireOwnedInstance (or the inline user_id-scoped SELECT) — or, if the route genuinely\n` +
				`has no tenant, record it in ANSWERS_A_STRANGER with the reason.`,
		).toEqual(Object.keys(ANSWERS_A_STRANGER).sort());
	});

	it("no route writes anything for a caller who owns nothing", async () => {
		// A status probe cannot see a write. `PUT /:instanceId/name` used to answer 200 AND issue
		// an UPDATE; what made that survivable rather than a cross-tenant write was that the
		// statement bound user_id and matched zero rows. Since #350 it refuses before writing at
		// all, so the exception is gone and this asserts the stronger property for every route on
		// the surface: a caller who owns nothing never reaches a statement.
		const stranger = await signSession("stranger", SECRET, { roles: ["user"] });
		const writers: Record<string, string[]> = {};
		for (const { method, path } of surface()) {
			const { writes } = await probe(method, path, stranger);
			if (writes.length) writers[`${method} ${path}`] = writes;
		}
		expect(writers).toEqual({});
	});

	it("the list route really is empty for a stranger, not merely 200", async () => {
		const stranger = await signSession("stranger", SECRET, { roles: ["user"] });
		const { app, env } = buildApp();
		const list = await app.request("/v1/instances/my/instances", { headers: { Authorization: `Bearer ${stranger}` } }, env);
		expect(await list.json()).toEqual({ instances: [] });
	});
});

/**
 * The binding routes are DERIVED from the vocabulary, so the table and the mounts cannot drift.
 *
 * `instances-terminal.ts` mounts `/terminal-target` and `/tmux-session` as literal strings on
 * purpose — `scripts/openapi-coverage.mjs` finds routes by statically scanning for
 * `router.get("/…")`, so a loop over the table would delete the whole surface from the drift check
 * and turn its spec entries into phantoms. That literal is the cost, and this is what pays for it:
 * every `bindRoute` in `CONNECTOR_CONSTRAINTS` must appear as a mounted GET and PUT.
 *
 * It matters because the refusal a `single` agent gives when nothing is bound is built from
 * `bindRoute` (#447). A route renamed here and not there sends a user to a 404; a route renamed
 * there and not here sends them to a path that governs a DIFFERENT connector's resource, which is
 * worse — they would bind a terminal and wonder why their tmux agent still refuses.
 */
describe("connector bindings — every declared bindRoute is actually mounted", () => {
	const bindRoutes = Object.entries(CONNECTOR_CONSTRAINTS).flatMap(([connector, fields]) =>
		Object.entries(fields)
			.filter(([, def]) => def.kind === "binding")
			.map(([field, def]) => ({ connector, field, route: (def as { bindRoute: string }).bindRoute })),
	);

	it("covers both connectors that declare a binding, so this test cannot pass vacuously", () => {
		expect(bindRoutes.map((b) => `${b.connector}.${b.field}`)).toEqual(["terminal.targets", "tmux.sessions"]);
	});

	it.each(bindRoutes)("mounts GET and PUT /:instanceId/$route for $connector.$field", ({ route }) => {
		const mounted = surface().map(({ method, path }) => `${method} ${path}`);
		expect(mounted).toContain(`GET /:instanceId/${route}`);
		expect(mounted).toContain(`PUT /:instanceId/${route}`);
	});
});
