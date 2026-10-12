/**
 * Durable browser takeovers over the real schema (#1031): the routes, the gate in front of the runner's
 * remote view, the pause → takeover → notification flow, and that nothing a notification carries is
 * anything but ids. Only the runtime seam is faked: a live runner, its takeover list, its controls.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { resolveNotificationDelivery } from "../lib/notification-policy.js";
import { OWNER_ATTENTION_EVENTS } from "../lib/owner-attention.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
/** Task ids the runner holds a takeover session for. */
let runnerTakeovers: string[] = [];
const sent: string[] = [];

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
vi.mock("./instances-runtime.js", async () => {
	const actual = await vi.importActual<typeof import("./instances-runtime.js")>("./instances-runtime.js");
	const runtime = { instance_id: "i1", user_id: "u1", runner_node: "mac", status: "online", last_seen_at: null };
	return {
		...actual,
		requireLiveRuntime: async () => runtime,
		getLiveRuntime: async () => runtime,
		callRuntime: async (_env: unknown, _rt: unknown, path: string) => {
			sent.push(path);
			if (path === "/takeover") return Response.json({ takeovers: runnerTakeovers });
			if (path.endsWith("/frame")) return Response.json({ frame: "", width: 1, height: 1 });
			if (path === "/local-browser/status") return Response.json({ state: "running" });
			return Response.json({ ok: true });
		},
	};
});

const { instanceRoutes } = await import("./instances.js");

beforeEach(() => {
	runnerTakeovers = [];
	sent.length = 0;
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('scout', 'u1', 't1031-scout', 'Scout', '{"capabilities":{"surfaces":[],"runtime":"local_browser","localBrowser":{}}}')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'scout', 'u1', 'active', '{}')`);
	const now = Date.now();
	d1.exec(`INSERT INTO local_browser_runs (id, instance_id, user_id, request_id, objective, status, policy, created_at, updated_at)
	         VALUES ('run-1', 'i1', 'u1', 'run-1', 'verify a posting', 'running', '{"engine":"claude","authMode":"subscription"}', ${now}, ${now})`);
});
afterEach(() => d1.close());

async function call(method: string, path: string, body?: unknown) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { DB: d1.DB } as unknown as Env, {
		waitUntil: () => undefined,
		passThroughOnException: () => undefined,
		props: {},
	} as never);
	// biome-ignore lint/suspicious/noExplicitAny: assertions read the JSON field by field
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const notifications = async () => ((await d1.DB.prepare("SELECT type, title, body, url, kind FROM notifications ORDER BY created_at").all<Record<string, string>>()).results ?? []);
const pause = (reason: string) => call("POST", "/i1/local-browser/runs/run-1/events", { events: [{ type: "run.paused", at: "2026-10-12T01:00:00Z", pauseReason: reason }] });

describe("a paused run asks for a takeover BEFORE anything is shown (#1031)", () => {
	it("records a requested takeover and notifies with a link to it — ids only", async () => {
		expect((await pause("captcha")).body.status).toBe("paused");
		const [t] = (await call("GET", "/i1/browser-takeovers")).body.takeovers;
		expect(t).toMatchObject({ state: "requested", reason: "captcha", subjectKind: "local_browser_run", subjectId: "run-1", mobileAllowed: true });
		const [n] = await notifications();
		expect(n).toMatchObject({ kind: "alert", url: `/console/instances/i1/research/run-1?takeover=${t.id}` });
	});

	it("a resumed run closes its takeover; an ended run closes it too", async () => {
		await pause("login_required");
		await call("POST", "/i1/local-browser/runs/run-1/events", { events: [{ type: "run.resumed", at: "2026-10-12T01:01:00Z" }] });
		expect((await call("GET", "/i1/browser-takeovers")).body.takeovers[0]).toMatchObject({ state: "resumed", endReason: "resumed_at_machine" });
		await pause("captcha");
		await call("POST", "/i1/local-browser/runs/run-1/cancel");
		expect((await call("GET", "/i1/browser-takeovers?state=ended")).body.takeovers[0]).toMatchObject({ endReason: "run_finished" });
	});

	it("takeover \"never\" ends the attempt instead of asking, and tells the runner to stop", async () => {
		await call("PUT", "/i1/browser-verification", { enabled: true, takeover: "never" });
		await pause("captcha");
		expect(await d1.DB.prepare("SELECT status, error_code FROM local_browser_runs WHERE id = 'run-1'").first()).toEqual({ status: "failed", error_code: "takeover_declined" });
		expect((await call("GET", "/i1/browser-takeovers")).body.takeovers).toEqual([]);
		expect(sent).toContain("/local-browser/cancel");
		// A verification instance hears that the attempt failed.
		expect((await notifications()).at(-1)).toMatchObject({ kind: "alert", url: "/console/instances/i1/research/run-1" });
	});
});

describe("the takeover routes (#1031)", () => {
	it("an owner can ask for a takeover; asking again joins it", async () => {
		const first = await call("POST", "/i1/browser-takeovers", { subjectKind: "runtime_task", subjectId: "task-9", reason: "login_required" });
		expect(first).toMatchObject({ status: 201, body: { created: true, takeover: { state: "requested", subjectId: "task-9" } } });
		const again = await call("POST", "/i1/browser-takeovers", { subjectKind: "runtime_task", subjectId: "task-9" });
		expect(again).toMatchObject({ status: 200, body: { created: false, takeover: { id: first.body.takeover.id } } });
		expect(await notifications()).toHaveLength(1);
		expect((await call("GET", `/i1/browser-takeovers/${first.body.takeover.id}`)).body.takeover.id).toBe(first.body.takeover.id);
	});

	it("refuses a run that is not paused, an unknown reason, and any request under takeover \"never\"", async () => {
		expect((await call("POST", "/i1/browser-takeovers", { subjectKind: "local_browser_run", subjectId: "run-1" })).status).toBe(409);
		expect((await call("POST", "/i1/browser-takeovers", { reason: "bored" })).status).toBe(400);
		await call("PUT", "/i1/browser-verification", { enabled: true, takeover: "never" });
		expect((await call("POST", "/i1/browser-takeovers", {})).body.error).toMatch(/never to ask/);
	});

	it("PATCH opens, refuses a phone when mobile is off, ends, and never sets expired", async () => {
		await call("PUT", "/i1/browser-verification", { enabled: true, allowMobile: false });
		const id = (await call("POST", "/i1/browser-takeovers", { subjectKind: "runtime_task", subjectId: "task-1" })).body.takeover.id;
		expect((await call("PATCH", `/i1/browser-takeovers/${id}`, { state: "active", device: "mobile" })).body.error).toMatch(/from a phone is off/);
		expect((await call("PATCH", `/i1/browser-takeovers/${id}`, { state: "active", device: "desktop" })).body.takeover).toMatchObject({ state: "active" });
		expect((await call("PATCH", `/i1/browser-takeovers/${id}`, { state: "expired" })).status).toBe(400);
		expect((await call("PATCH", `/i1/browser-takeovers/${id}`, { state: "ended" })).body.takeover).toMatchObject({ state: "ended", endReason: "declined" });
		expect(sent).toContain("/takeover/task-1/end");
		expect((await call("PATCH", `/i1/browser-takeovers/${id}`, { state: "active" })).status).toBe(409);
	});

	it("PATCH resumed on a runner task resumes it there", async () => {
		const id = (await call("POST", "/i1/browser-takeovers", { subjectKind: "runtime_task", subjectId: "task-2" })).body.takeover.id;
		expect((await call("PATCH", `/i1/browser-takeovers/${id}`, { state: "resumed" })).body.takeover).toMatchObject({ state: "resumed" });
		expect(sent).toContain("/takeover/task-2/resume");
	});
});

describe("the runner's remote view is gated on a durable takeover (#1031)", () => {
	it("no takeover anywhere: no frame", async () => {
		expect((await call("GET", "/i1/takeover/task-3/frame")).status).toBe(404);
		expect(sent).not.toContain("/takeover/task-3/frame");
	});

	it("the runner holds one with no row yet: it is recorded, and showing the frame opens it", async () => {
		runnerTakeovers = ["task-3"];
		expect((await call("GET", "/i1/takeover/task-3/frame")).status).toBe(200);
		expect((await call("GET", "/i1/browser-takeovers?subject_kind=runtime_task&subject_id=task-3")).body.takeovers[0]).toMatchObject({ state: "active" });
		await call("POST", "/i1/takeover/task-3/resume");
		expect((await call("GET", "/i1/browser-takeovers?subject_id=task-3")).body.takeovers[0]).toMatchObject({ state: "resumed" });
	});

	it("a closed takeover is not silently reopened", async () => {
		runnerTakeovers = ["task-4"];
		const id = (await call("POST", "/i1/browser-takeovers", { subjectKind: "runtime_task", subjectId: "task-4" })).body.takeover.id;
		await call("PATCH", `/i1/browser-takeovers/${id}`, { state: "ended" });
		const res = await call("GET", "/i1/takeover/task-4/frame");
		expect(res).toMatchObject({ status: 409, body: { error: expect.stringMatching(/This takeover is ended\. Ask for it again/) } });
	});
});

describe("notifications: events the policy decides, links that carry ids only (#1031)", () => {
	it("the new events are owner-attention events, so an instance rule can silence their push", () => {
		const ids = OWNER_ATTENTION_EVENTS.map((e) => e.id);
		for (const e of ["takeover_required", "browser_verification_failed", "browser_verification_completed"]) expect(ids).toContain(e);
		const d = resolveNotificationDelivery(
			{ type: "local-browser", severity: "alert", event: "takeover_required", instanceId: "i1" },
			{ instance: { rules: [{ event: "takeover_required", push: false }] } } as never,
		);
		expect(d.push).toMatchObject({ allowed: false, source: "instance" });
		expect(d.inapp.allowed).toBe(true);
	});

	it("no notification this feature writes carries a site URL, token, session or secret", async () => {
		await pause("captcha");
		await call("POST", "/i1/browser-takeovers", { subjectKind: "runtime_task", subjectId: "task-5" });
		const rows = await notifications();
		expect(rows.length).toBeGreaterThan(1);
		for (const r of rows) {
			expect(r.url).toMatch(/^\/console\/instances\/i1\/[a-z/0-9-]+(\?takeover=[0-9a-f-]+)?$/);
			expect(`${r.url} ${r.title} ${r.body}`).not.toMatch(/https?:|token|session|cookie|secret/i);
		}
	});
});

describe("the mobile preference applies to the remote view itself (#1031)", () => {
	it("a phone is refused the frame when mobile takeover is off; a desktop is not", async () => {
		await call("PUT", "/i1/browser-verification", { enabled: true, allowMobile: false });
		runnerTakeovers = ["task-6"];
		expect((await call("GET", "/i1/takeover/task-6/frame?device=mobile")).body.error).toMatch(/from a phone is off/);
		expect(sent).not.toContain("/takeover/task-6/frame");
		expect((await call("GET", "/i1/takeover/task-6/frame?device=desktop")).status).toBe(200);
	});
});
