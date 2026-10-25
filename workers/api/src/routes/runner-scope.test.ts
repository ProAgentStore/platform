/**
 * #1192: a runner-only sign-in is worth little if a coding engine reads it off disk. Real schema, real routes and the real
 * `requireUser`: the scope must be refused by the gate every route sits behind, survive a renewal, and not be mintable-up.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { runnerRouteAllowed } from "../lib/runner-scope.js";
import { signSession, verifySession } from "../lib/session.js";
import type { Env } from "../types.js";

const { deviceAuthRoutes, sessionRoutes } = await import("./device-auth.js");
const { authRoutes } = await import("./auth.js");

const KEY = "test-signing-key";
let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB, SESSION_SIGNING_KEY: KEY }) as unknown as Env;
const app = () => {
	const a = new Hono<{ Bindings: Env }>().route("/v1/auth/device", deviceAuthRoutes).route("/v1/auth/session", sessionRoutes).route("/v1/auth", authRoutes);
	// Stand-ins for routes that exist on the real API and are NOT a runner's: the gate is the same one in front of them.
	a.get("/v1/agents", async (c) => (await import("../lib/auth.js")).requireUser(c).then(() => c.json({ agents: [] })));
	a.post("/v1/instances/my/instances", async (c) => (await import("../lib/auth.js")).requireUser(c).then(() => c.json({})));
	a.get("/v1/instances/my/instances", async (c) => (await import("../lib/auth.js")).requireUser(c).then(() => c.json({ instances: [] })));
	a.post("/v1/instances/:id/runtime/heartbeat", async (c) => (await import("../lib/auth.js")).requireUser(c).then(() => c.json({ ok: true })));
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
};
async function call(method: string, path: string, opts: { body?: unknown; bearer?: string } = {}) {
	const res = await app().request(path, { method, headers: { "Content-Type": "application/json", ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}) }, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) }, env());
	// biome-ignore lint/suspicious/noExplicitAny: assertions read the JSON field by field
	return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}
const browser = (uid = "u1") => signSession(uid, KEY, { roles: ["user"] });

async function enroll(opts: { asks?: boolean; runnerOnly?: boolean } = {}) {
	const started = await call("POST", "/v1/auth/device/start", { body: { node: "dell-laptop", ...(opts.asks ? { scope: "runner" } : {}) } });
	const approve = await call("POST", `/v1/auth/device/requests/${started.body.user_code}`, { bearer: await browser(), body: { approve: true, ...(opts.runnerOnly !== undefined ? { runnerOnly: opts.runnerOnly } : {}) } });
	expect(approve.status).toBe(200);
	return { started, token: await call("POST", "/v1/auth/device/token", { body: { device_code: started.body.device_code } }) };
}

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login, roles) VALUES ('u1', 'one', '["user"]'), ('u2', 'two', '["user"]')`);
});
afterEach(() => d1.close());

describe("what a runner-only sign-in may call", () => {
	it("allows exactly the calls a runner makes", () => {
		for (const [m, p] of [
			["GET", "/v1/instances/my/instances"],
			["POST", "/v1/instances/abc/runtime"],
			["POST", "/v1/instances/abc/runtime/heartbeat"],
			["GET", "/v1/instances/abc/runtime/status"],
			["POST", "/v1/relay/abc/token"],
			["GET", "/v1/relay/abc/status"],
			["POST", "/v1/errors/runner-crashes"],
			["GET", "/v1/terminals/nodes"],
			["POST", "/v1/terminals/nodes/dell/claim"],
			["GET", "/v1/terminals/machines/m1/thresholds"],
			["POST", "/v1/terminals/machines/m1/watchdog/heartbeat"],
			["POST", "/v1/auth/session/refresh"],
			["GET", "/v1/auth/me"],
			["post", "/v1/relay/abc/token/"],
		] as const) expect(runnerRouteAllowed(m, p), `${m} ${p}`).toBe(true);
	});
	it("refuses the account: agents, billing, keys, secrets, profile, other machines' policy, and signing others in", () => {
		for (const [m, p] of [
			["GET", "/v1/agents"],
			["DELETE", "/v1/instances/abc"],
			["PUT", "/v1/preferences"],
			["GET", "/v1/billing/status"],
			["GET", "/v1/keys"],
			["PUT", "/v1/auth/me"],
			["GET", "/v1/auth/device/credentials"],
			["DELETE", "/v1/auth/device/credentials/dev_x"],
			["PUT", "/v1/auth/device/lifetime"],
			["POST", "/v1/auth/device/requests/BCDF-GHJK"],
			["PUT", "/v1/terminals/machines/m1/thresholds"],
			["POST", "/v1/terminals/nodes/dell/update"],
			["POST", "/v1/terminals/nodes"],
			["GET", "/v1/terminals/nodes/dell/forget-preflight"],
			["POST", "/v1/instances/abc/runtime/other"],
			["GET", "/v1/instances/abc/runtime"], // right path, wrong method
			["POST", "/v1/instances/my/instances"],
			["GET", "/v1/instances/abc/def/runtime"], // a segment cannot hide a slash
		] as const) expect(runnerRouteAllowed(m, p), `${m} ${p}`).toBe(false);
	});
});

describe("a runner-only device sign-in, through the real gate", () => {
	it("works for the runner's own calls and is refused on everything else, with the way out in the words", async () => {
		const { token } = await enroll({ runnerOnly: true });
		expect(token.body).toMatchObject({ scope: "runner", lifetime_days: 30 });
		const runner = token.body.session;
		expect((await verifySession(runner, KEY))?.scope).toBe("runner");
		expect((await call("GET", "/v1/instances/my/instances", { bearer: runner })).status).toBe(200);
		expect((await call("POST", "/v1/instances/i1/runtime/heartbeat", { bearer: runner })).status).toBe(200);
		expect((await call("GET", "/v1/auth/me", { bearer: runner })).status).not.toBe(403);
		for (const [m, p] of [
			["GET", "/v1/agents"],
			["PUT", "/v1/auth/me"],
			["GET", "/v1/auth/device/credentials"],
			["PUT", "/v1/auth/device/lifetime"],
		] as const) {
			const r = await call(m, p, { bearer: runner, body: m === "GET" ? undefined : { days: 90, display_name: "x" } });
			expect(r.status, `${m} ${p}`).toBe(403);
			expect(r.body.error).toMatch(/runner-only.*pags login/);
		}
	});
	it("cannot mint a full sign-in from itself: approving a device request needs a full session", async () => {
		const { token } = await enroll({ runnerOnly: true });
		const started = await call("POST", "/v1/auth/device/start", { body: { node: "attacker" } });
		const r = await call("POST", `/v1/auth/device/requests/${started.body.user_code}`, { bearer: token.body.session, body: { approve: true } });
		expect(r.status).toBe(403);
		expect((await call("POST", "/v1/auth/device/token", { body: { device_code: started.body.device_code } })).body.error).toBe("authorization_pending");
	});
	it("keeps its scope when it renews itself", async () => {
		const { token } = await enroll({ runnerOnly: true });
		const renewed = await call("POST", "/v1/auth/session/refresh", { bearer: token.body.session });
		expect(renewed.status).toBe(200);
		expect(renewed.body.scope).toBe("runner");
		expect((await verifySession(renewed.body.session, KEY))?.scope).toBe("runner");
		expect((await call("GET", "/v1/agents", { bearer: renewed.body.session })).status).toBe(403);
	});
	it("is still one machine's credential: the owner sees its scope, and revoking it ends it", async () => {
		const { token } = await enroll({ runnerOnly: true });
		const listed = await call("GET", "/v1/auth/device/credentials", { bearer: await browser() });
		expect(listed.body.credentials[0]).toMatchObject({ id: token.body.device_id, scope: "runner", status: "active" });
		await call("DELETE", `/v1/auth/device/credentials/${token.body.device_id}`, { bearer: await browser() });
		const after = await call("GET", "/v1/instances/my/instances", { bearer: token.body.session });
		expect(after.status).toBe(401);
	});
});

describe("who decides", () => {
	it("a machine can ASK for runner-only; the approval page shows it, and the owner's answer is what counts", async () => {
		const asked = await call("POST", "/v1/auth/device/start", { body: { node: "dell", scope: "runner" } });
		const seen = await call("GET", `/v1/auth/device/requests/${asked.body.user_code}`, { bearer: await browser() });
		expect(seen.body.request.requestedScope).toBe("runner");
		// the owner approves it as a FULL sign-in anyway
		await call("POST", `/v1/auth/device/requests/${asked.body.user_code}`, { bearer: await browser(), body: { approve: true, runnerOnly: false } });
		const token = await call("POST", "/v1/auth/device/token", { body: { device_code: asked.body.device_code } });
		expect(token.body.scope).toBeNull();
		expect((await call("GET", "/v1/agents", { bearer: token.body.session })).status).toBe(200);
	});
	it("a machine that did not ask can still be approved runner-only by the owner", async () => {
		const { started, token } = await enroll({ asks: false, runnerOnly: true });
		expect(started.body.user_code).toBeTruthy();
		expect(token.body.scope).toBe("runner");
	});
	it("by default a device sign-in is a full one, as before", async () => {
		const { token } = await enroll();
		expect(token.body.scope).toBeNull();
		expect((await verifySession(token.body.session, KEY))?.scope).toBeUndefined();
		expect((await call("GET", "/v1/agents", { bearer: token.body.session })).status).toBe(200);
	});
	it("a request that asks for anything but 'runner' asks for nothing, and runnerOnly must be a boolean", async () => {
		const odd = await call("POST", "/v1/auth/device/start", { body: { node: "n", scope: "admin" } });
		expect((await call("GET", `/v1/auth/device/requests/${odd.body.user_code}`, { bearer: await browser() })).body.request.requestedScope).toBeNull();
		expect((await call("POST", `/v1/auth/device/requests/${odd.body.user_code}`, { bearer: await browser(), body: { approve: true, runnerOnly: "yes" } })).status).toBe(400);
	});
	it("a denied request carries no scope and creates nothing", async () => {
		const started = await call("POST", "/v1/auth/device/start", { body: { node: "n", scope: "runner" } });
		await call("POST", `/v1/auth/device/requests/${started.body.user_code}`, { bearer: await browser(), body: { approve: false, runnerOnly: true } });
		expect((await call("POST", "/v1/auth/device/token", { body: { device_code: started.body.device_code } })).body.error).toBe("access_denied");
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM device_credentials").get()).toEqual({ n: 0 });
	});
});

describe("the allowlist covers what `pags up` really calls", () => {
	// The files a running runner executes (not the interactive commands). A path one of them calls that the allowlist refuses
	// would silently break every runner-only machine, so this reads the source rather than trusting the list above.
	const RUNNER_SIDE = [
		"commands/up.ts",
		"commands/runner/relay.ts",
		"commands/runner/update-bridge.ts",
		"commands/runner/membership.ts",
		"commands/runner/cleanup-sync.ts",
		"machine-claim.ts",
		"crash-delivery.ts",
		"session-refresh.ts",
		"watchdog/local.ts",
	];
	it("every /v1 path a runner-side file names is one a runner-only sign-in may call", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const root = join(__dirname, "..", "..", "..", "..", "packages", "cli", "src");
		const seen = new Set<string>();
		for (const file of RUNNER_SIDE) {
			let text: string;
			try {
				text = readFileSync(join(root, file), "utf8");
			} catch {
				continue; // a file that moved is the only thing this skips; the list above still gates the routes
			}
			for (const m of text.matchAll(/[`"'](?:\$\{[^}]*\})?(\/v1\/[A-Za-z0-9_\-/${}().]+)/g)) {
				const path = m[1].replace(/\$\{[^}]*\}/g, "x").replace(/\/+$/, "");
				if (/^\/v1\/(?:relay\/x\/connect)$/.test(path)) continue; // the relay socket authenticates with a relay token, not the session
				seen.add(path);
			}
		}
		expect(seen.size).toBeGreaterThan(5); // it did find the runner's calls
		const refused = [...seen].filter((p) => !["GET", "POST", "PUT", "DELETE"].some((m) => runnerRouteAllowed(m, p)));
		expect(refused).toEqual([]);
	});
});
