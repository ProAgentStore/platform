/**
 * The route → AgentDO seam, held to a table (#438) — every value in it DERIVED by driving the
 * registered handler against a recording DO stub, never read out of the source.
 *
 * ── The defect this exists for
 *
 * #428: "Load older messages" returned the newest page forever. The middle layer of that failure
 * was a route that rebuilt the DO query string from scratch with only `limit`, dropping `before`
 * on its way to the object. Both `chat.ts` and `instances-chat.ts` did it, and the repair had to
 * be applied to both — the same "fixed in one sibling, missed in the other" shape as #421/#427
 * and #426/#431, this time at a seam.
 *
 * Nothing could see it. The route's tests asserted the route's response, the DO's asserted the
 * DO's, and the parameter died in the gap between them. #438 counted the tests asserting the
 * query string a route passes to its DO: zero.
 *
 * ── What this guard actually claims, and what it does not
 *
 * It claims exactly one property, the narrow one that is implementable:
 *
 *     for every query parameter a DO handler READS, every route forwarding to that DO path
 *     passes it through, with the value the caller sent.
 *
 * It does NOT claim to have caught #428 as it shipped, and it would not have. That was measured,
 * not assumed: with `agent-do.ts`, `chat.ts` and `instances-chat.ts` restored from `807787a^` —
 * the commit before the fix — this file's invariant PASSES. All three layers were broken at
 * once, so with the DO reading nothing there was no pairwise relationship left to violate.
 *
 * The pinned tables below do go red against that tree, but only because they were written after
 * the repair: had they existed first they would have recorded `/messages?limit` and a DO that
 * takes `limit`, and been green too. Pins catch the RE-drop, not the original omission. Both
 * halves of that are true and neither is worth overstating.
 *
 * What it does catch is the class that produced two of the four sibling defects in #438's
 * sample: a seam repaired in one route and not in its twin, and a future re-drop of `before`
 * from any of them. Deleting the `before` forward from `chat.ts` fails three assertions here,
 * naming the route, the parameter and the value that went missing.
 *
 * The DO half is a scan (`lib/do-seam.ts`) and sees a parameter a handler READS, not one it
 * HONOURS — a handler reading `before` and ignoring it looks identical here to one that seeks
 * with it. Only an executed round trip can tell those apart; `lib/message-page.ts` and the
 * console spec are where #428 put that, and this is deliberately not a second copy.
 *
 * ── How the route half is derived
 *
 *   1. mount ONE router on a bare Hono, so every route can say which module registered it
 *   2. drive each GET it registers as the OWNER, with EVERY parameter any DO GET handler reads
 *      present in the query string and carrying a distinct sentinel value
 *   3. record the URL the handler hands the DO — the AGENT binding is a stub that captures it
 *
 * A route that never reaches the object simply does not appear. That is why FORWARDS is pinned
 * exactly rather than checked for a subset: a route that stops reaching the DO — because it
 * started throwing before it got there — drops out of the derived table and fails here, instead
 * of quietly having no seam left to check.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { armFor, doQueryParams, lex, parseDoRouteTable } from "../lib/do-seam.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { chatRoutes } from "./chat.js";
import { instanceRoutes } from "./instances.js";
import { instanceStorageRoutes, storageRoutes } from "./storage.js";

const SECRET = "do-seam-contract-secret";
const UID = "owner-1";

// ─────────────────────────────────────────────────────────────────────────────
// The DO half — what the object reads, per path
// ─────────────────────────────────────────────────────────────────────────────

const SRC = new URL("../", import.meta.url).pathname; // workers/api/src
const read = (rel: string) => lex(rel, readFileSync(`${SRC}${rel}`, "utf-8"));
const AGENT_DO = read("agent-do.ts");
const DO_SOURCES = [AGENT_DO, read("agent-do-storage-routes.ts"), read("agent-do-knowledge.ts")];

/** The parameters the DO reads for a GET on this path. */
const doReads = (path: string) => doQueryParams(DO_SOURCES, AGENT_DO, "GET", path);

/**
 * The probe vocabulary is DERIVED, not listed: every parameter any GET arm of the DO's dispatch
 * table reads, with a distinct sentinel value. A parameter the object starts reading is
 * therefore sent by the probe from that moment, and any route that fails to forward it fails
 * here without anyone remembering to widen a list.
 *
 * Numeric parameters get numeric sentinels so the value can be compared after a route has
 * clamped it — `limit=7` survives `Math.min(2000, …)` unchanged, where `limit=probe` would not
 * and would leave the assertion unable to tell "forwarded" from "replaced by a default".
 */
const SENTINELS: Record<string, string> = {
	limit: "7",
	offset: "3",
	before: "msg:2026-01-01T00:00:00.000Z:probe",
	where: '{"status":"open"}',
	order_by: "created_at",
	order_dir: "asc",
	tags: "alpha,beta",
	user_id: "u-probe",
	mime_type: "text/plain",
	type: "chat",
};

/** Every parameter name any GET arm of the DO reads. */
function doVocabulary(): string[] {
	const names = new Set<string>();
	for (const arm of parseDoRouteTable(AGENT_DO)) {
		if (arm.method !== "GET" || !arm.handler) continue;
		// Ask through the same resolver the guard uses, on a path this arm claims.
		for (const path of PROBE_PATHS) {
			if (!arm.matches(path)) continue;
			for (const p of doReads(path)) names.add(p);
		}
	}
	return [...names].sort();
}

/**
 * Concrete DO paths to interrogate the dispatch table with. A regex arm (`/collections/[^/]+
 * /records`) has no single path, so the vocabulary needs one example per shape.
 */
const PROBE_PATHS = [
	"/messages",
	"/knowledge",
	"/collections",
	"/collections/jobs/records",
	"/files",
	"/activity",
	"/summaries",
	"/vectors",
	"/state",
	"/tasks",
	"/memory",
	"/ingest-repo/status",
	"/users/u-1/context",
];

// ─────────────────────────────────────────────────────────────────────────────
// The route half — driven
// ─────────────────────────────────────────────────────────────────────────────

interface Forward {
	/** The DO path the route asked for. */
	path: string;
	/** The query parameters it carried, as `name=value`, sorted. */
	query: string[];
}

/**
 * An env in which the caller OWNS everything — the opposite probe to
 * `instances.contract.test.ts`, whose D1 resolves nothing. A tenant gate that refuses stops the
 * request before the seam, so proving the gate and proving the hop need opposite fixtures.
 */
function ownerEnv() {
	const forwards: Forward[] = [];
	const row = (sql: string): Record<string, unknown> | null => {
		if (/FROM users/i.test(sql)) return { suspended: 0, roles: '["user"]', github_login: null };
		if (/FROM agents/i.test(sql)) {
			return { id: "agent-1", slug: "agent-1", name: "Probe", model: "m", owner_id: UID, config: "{}", is_published: 1 };
		}
		if (/FROM agent_instances/i.test(sql)) {
			return { id: "instance-1", user_id: UID, agent_id: "agent-1", config: "{}", status: "active" };
		}
		return null;
	};
	const DB = {
		prepare(sql: string) {
			const stmt = {
				bind: () => stmt,
				first: async () => row(sql),
				all: async () => ({ results: [] }),
				run: async () => ({ meta: { changes: 0 } }),
			};
			return stmt;
		},
		batch: async () => [],
	};
	const stub = {
		fetch: async (req: Request) => {
			const url = new URL(typeof req === "string" ? req : req.url);
			forwards.push({
				path: url.pathname,
				query: [...url.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort(),
			});
			// Shapes the callers destructure. Anything they then do with an empty list is fine —
			// the request has already crossed the seam, which is all this test observes.
			return new Response(JSON.stringify({ messages: [], records: [], files: [], activity: [], documents: [] }), {
				headers: { "content-type": "application/json" },
			});
		},
	};
	// Bindings a route must not need in order to talk to its DO. Reaching one throws, the route
	// answers 500, and it drops out of the derived table — which fails, rather than passing quietly.
	const boom = (what: string) => () => {
		throw new Error(`probe reached ${what}`);
	};
	const env = {
		SESSION_SIGNING_KEY: SECRET,
		DB,
		AGENT: { idFromName: (n: string) => n, get: () => stub },
		STORAGE: { get: boom("R2.get"), put: boom("R2.put") },
		AI: { run: boom("Workers AI") },
		RELAY: { idFromName: boom("RelayDO"), get: boom("RelayDO") },
	} as unknown as Env;
	return { env, forwards };
}

/** Concrete values for every path parameter these surfaces use. */
const PARAMS: Record<string, string> = {
	id: "agent-1",
	agentId: "agent-1",
	instanceId: "instance-1",
	name: "jobs",
	recordId: "rec-1",
	fileId: "file-1",
	docId: "doc-1",
	taskId: "task-1",
	turnId: "turn-1",
	uploadId: "upload-1",
	userId: "u-probe",
	seq: "1",
};

function concrete(pattern: string): string {
	return pattern.replace(/:([A-Za-z_][\w]*)/g, (_m, name: string) => {
		const value = PARAMS[name];
		if (!value) throw new Error(`No probe value for :${name} — add one to PARAMS.`);
		return value;
	});
}

const SURFACES: Array<{ module: string; prefix: string; router: Hono<{ Bindings: Env }> }> = [
	{ module: "chat.ts", prefix: "/v1/agents", router: chatRoutes },
	{ module: "storage.ts (agent)", prefix: "/v1/agents", router: storageRoutes },
	{ module: "storage.ts (instance)", prefix: "/v1/instances", router: instanceStorageRoutes },
	{ module: "instances.ts", prefix: "/v1/instances", router: instanceRoutes },
];

/** Drive one GET route as its owner with the whole vocabulary attached, and report what reached the DO. */
async function driveRoute(
	surface: (typeof SURFACES)[number],
	pattern: string,
	token: string,
	vocabulary: string[],
): Promise<Forward[]> {
	const { env, forwards } = ownerEnv();
	const app = new Hono<{ Bindings: Env }>();
	app.route(surface.prefix, surface.router);
	app.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	const query = new URLSearchParams(vocabulary.map((p) => [p, SENTINELS[p]] as [string, string]));
	await app.request(
		`${surface.prefix}${concrete(pattern)}?${query}`,
		{ headers: { Authorization: `Bearer ${token}` } },
		env,
	);
	return forwards;
}

/** module + route → what it handed the DO. Empty when the route never reached the object. */
async function deriveForwards(): Promise<Record<string, Forward[]>> {
	const token = await signSession(UID, SECRET, { roles: ["user"] });
	const vocabulary = doVocabulary();
	const out: Record<string, Forward[]> = {};
	for (const surface of SURFACES) {
		const seen = new Set<string>();
		for (const r of surface.router.routes) {
			if (r.method !== "GET" || seen.has(r.path)) continue;
			seen.add(r.path);
			const forwards = await driveRoute(surface, r.path, token, vocabulary);
			if (forwards.length) out[`${surface.module} GET ${r.path}`] = forwards;
		}
	}
	return out;
}

/** `path?name,name` — the shape of one forward, with the parameter names it carried. */
const shape = (f: Forward) => `${f.path}${f.query.length ? `?${f.query.map((q) => q.split("=")[0]).join(",")}` : ""}`;

const FORWARDED = deriveForwards();

describe("what the DO is asked for", () => {
	it("derives its probe vocabulary from the object, and it is not empty", () => {
		expect(doVocabulary()).toEqual(["before", "limit", "mime_type", "offset", "order_by", "order_dir", "tags", "type", "user_id", "where"]);
	});

	it("has a sentinel for every parameter it probes with", () => {
		for (const p of doVocabulary()) expect(SENTINELS[p], `add a sentinel value for ?${p}`).toBeTruthy();
	});

	it("every probe path is one the DO actually routes", () => {
		const arms = parseDoRouteTable(AGENT_DO);
		for (const path of PROBE_PATHS) expect(armFor(arms, "GET", path), `${path} is unrouted`).not.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The forwarding table — which route hands the object what
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `module + route → the DO request(s) it makes`, as `path?names`. Every entry DERIVED by driving
 * the route; the parameter VALUES are asserted separately, below.
 *
 * Pinned exactly, in both directions. A route that stops reaching the DO disappears from the
 * derived side and fails here — which matters because "no forward recorded" is what a route
 * throwing before the seam looks like, and it would otherwise silently have nothing left to
 * check. A route that starts talking to the object arrives here at once and has to be written
 * down, which is the moment to notice it is dropping a parameter.
 */
const FORWARDS: Record<string, string[]> = {
	"chat.ts GET /:id/messages": ["/messages?before,limit"],
	"chat.ts GET /:id/memory": ["/memory"],
	"chat.ts GET /:id/tasks": ["/tasks"],
	"chat.ts GET /:id/state": ["/state"],
	"chat.ts GET /:id/knowledge": ["/knowledge"],
	"storage.ts (agent) GET /:id/collections": ["/collections"],
	"storage.ts (agent) GET /:id/collections/:name": ["/collections/jobs"],
	// The pass-through routes carry the WHOLE query string, so the probe's full vocabulary
	// arrives — including names this DO path does not read. Forwarding more than the object
	// reads is harmless; forwarding less is the defect.
	"storage.ts (agent) GET /:id/collections/:name/records": [
		"/collections/jobs/records?before,limit,mime_type,offset,order_by,order_dir,tags,type,user_id,where",
	],
	"storage.ts (agent) GET /:id/collections/:name/records/:recordId": ["/collections/jobs/records/rec-1"],
	"storage.ts (agent) GET /:id/files": ["/files?before,limit,mime_type,offset,order_by,order_dir,tags,type,user_id,where"],
	"storage.ts (agent) GET /:id/files/:fileId": ["/files/file-1"],
	"storage.ts (agent) GET /:id/vectors": ["/vectors"],
	"storage.ts (agent) GET /:id/activity": [
		"/activity?before,limit,mime_type,offset,order_by,order_dir,tags,type,user_id,where",
	],
	"storage.ts (agent) GET /:id/summaries": [
		"/summaries?before,limit,mime_type,offset,order_by,order_dir,tags,type,user_id,where",
	],
	"storage.ts (agent) GET /:id/users/:userId/context": ["/users/u-probe/context"],
	"storage.ts (instance) GET /:id/collections": ["/collections"],
	"storage.ts (instance) GET /:id/collections/:name/records": [
		"/collections/jobs/records?before,limit,mime_type,offset,order_by,order_dir,tags,type,user_id,where",
	],
	"storage.ts (instance) GET /:id/collections/:name/records/:recordId": ["/collections/jobs/records/rec-1"],
	"storage.ts (instance) GET /:id/files": [
		"/files?before,limit,mime_type,offset,order_by,order_dir,tags,type,user_id,where",
	],
	"storage.ts (instance) GET /:id/files/:fileId": ["/files/file-1"],
	"storage.ts (instance) GET /:id/vectors": ["/vectors"],
	"storage.ts (instance) GET /:id/activity": [
		"/activity?before,limit,mime_type,offset,order_by,order_dir,tags,type,user_id,where",
	],
	"storage.ts (instance) GET /:id/memory": ["/memory"],
	"storage.ts (instance) GET /:id/agent-tasks": ["/tasks"],
	"storage.ts (instance) GET /:id/state": ["/state"],
	"storage.ts (instance) GET /:id/knowledge": ["/knowledge"],
	"storage.ts (instance) GET /:id/ingest-repo/status": ["/ingest-repo/status"],
	"storage.ts (instance) GET /:id/messages": [
		"/messages?before,limit,mime_type,offset,order_by,order_dir,tags,type,user_id,where",
	],
	"instances.ts GET /:instanceId/messages": ["/messages?before,limit"],
	"instances.ts GET /:instanceId/knowledge/:docId": ["/knowledge/doc-1"],
	"instances.ts GET /:instanceId/knowledge": ["/knowledge"],
};

describe("what each route hands the Durable Object", () => {
	it("forwards exactly what the table records", async () => {
		const derived = Object.fromEntries(
			Object.entries(await FORWARDED).map(([route, forwards]) => [route, forwards.map(shape)]),
		);
		expect(derived).toEqual(FORWARDS);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The invariant — a parameter the object reads reaches it from every route
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Routes that deliberately do NOT pass on a parameter the DO reads, with the reason.
 *
 * Empty today, and compared EXACTLY rather than as an upper bound — so a route that starts
 * honouring a parameter it used to drop fails here too, and this list can only change on
 * purpose. An entry is a claim that the caller's value must not reach the object (a route that
 * pins the value itself, or scopes it to the session); it is not somewhere to park a defect.
 */
const DROPS_A_PARAMETER: Record<string, string> = {};

describe("a parameter the object reads survives the hop", () => {
	it("every route forwarding to a DO path passes every parameter that path takes", async () => {
		const violations: Record<string, string> = {};
		for (const [route, forwards] of Object.entries(await FORWARDED)) {
			for (const f of forwards) {
				const sent = new Map(f.query.map((q) => [q.slice(0, q.indexOf("=")), q.slice(q.indexOf("=") + 1)]));
				for (const param of doReads(f.path)) {
					// Value, not just presence: a route that forwards `limit` but substitutes its own
					// default has dropped the caller's paging just as completely as one that omits it.
					if (sent.get(param) !== SENTINELS[param]) {
						violations[`${route} → ${f.path}`] = `?${param} sent as ${SENTINELS[param]}, arrived as ${sent.get(param) ?? "(absent)"}`;
					}
				}
			}
		}
		expect(
			violations,
			`A route dropped a query parameter its Durable Object reads — the #428 defect.\n` +
				`Forward it (build the DO query from the request's own parameters rather than a fresh\n` +
				`literal), or, if the caller's value genuinely must not reach the object, record the\n` +
				`route in DROPS_A_PARAMETER with the reason.`,
		).toEqual(DROPS_A_PARAMETER);
	});

	/**
	 * The #428 shape, named. `before` had to be repaired in `chat.ts` AND `instances-chat.ts`,
	 * because a seam fixed in one sibling and missed in the other is how two of the four defect
	 * pairs in #438's sample happened. There are THREE routes into `GET /messages` — the third,
	 * `storage.ts`'s instance proxy, was not in #428's write-up at all — and this fails the moment
	 * they stop agreeing.
	 */
	it("all three routes into GET /messages carry the paging cursor", async () => {
		const carriers = Object.entries(await FORWARDED)
			.filter(([, forwards]) => forwards.some((f) => f.path === "/messages"))
			.map(([route]) => route)
			.sort();
		expect(carriers).toEqual([
			"chat.ts GET /:id/messages",
			"instances.ts GET /:instanceId/messages",
			"storage.ts (instance) GET /:id/messages",
		]);
		for (const [, forwards] of Object.entries(await FORWARDED)) {
			for (const f of forwards.filter((x) => x.path === "/messages")) {
				expect(f.query).toContain(`before=${SENTINELS.before}`);
			}
		}
	});
});
