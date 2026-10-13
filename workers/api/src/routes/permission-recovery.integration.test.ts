/**
 * Blocked → asked → explicitly approved → grant verified → the EXACT blocked operation resumed once
 * (#1009), end to end through the real code: `runRegistryTool`'s consent gate, the shared request +
 * sealed continuation + owner ask, the owner-only approve/deny/cancel/resume routes, the tool-invoke
 * route's owner-liftable refusal, the expiry sweep, and the console's real link/focus/sign-in helpers.
 *
 * Faked, and only these: the push delivery (`notifyUser` — no real push is ever sent) and the GitHub
 * tool's external call (its handler is spied, so "the operation ran" is observed without a write to
 * GitHub). Isolated real-schema fixtures; no live grant, device or owner data. Simulated coverage only
 * — real-device push/cold-start validation is listed as owner work in the delivery report.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";
import { checkConsoleLink } from "../../../../store/console/src/lib/routes";
import { permissionRequestFocus } from "../../../../store/console/src/lib/permissionRequestFocus";

const h = vi.hoisted(() => ({ uid: "u1", push: vi.fn() }));
vi.mock("../lib/auth.js", async () => ({ ...(await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js")), requireUser: async () => ({ uid: h.uid, roles: [] }) }));
vi.mock("./push.js", async (orig) => ({ ...(await orig<typeof import("./push.js")>()), notifyUser: (...a: unknown[]) => h.push(...a) }));

const { registerPermissionRequestRoutes } = await import("./instances-permission-requests.js");
const { toolRoutes } = await import("./tools.js");
const { runRegistryTool, getRegistryTool } = await import("../lib/tool-registry.js");
const { sweepExpiredPermissionRequests } = await import("../lib/instance-permission-resume.js");
const { instancePermissionsLink } = await import("../lib/console-links.js");

const KEK = "a".repeat(64);
let d1: RealSchemaD1;
let env: Env;
/** Every call that actually reached the (spied) GitHub write. */
let ran: Array<Record<string, unknown>>;
let outcome: () => { success: boolean; content: string };
const ARGS = { repo: "acme/widget", title: "Retry exactly this", body: "synthetic" };

beforeEach(() => {
	h.uid = "u1";
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1','u1'), ('u2','u2');
		INSERT INTO agents (id, owner_id, slug, name, config) VALUES ('a1','u1','a1','A','{"capabilities":{"tools":["github_create_issue","github_list_issues"]}}');
		INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1','a1','u1','active','{}'), ('i2','a1','u1','active','{}'), ('iX','a1','u2','active','{}');`);
	env = { DB: d1.DB, KEY_ENCRYPTION_KEY: KEK } as unknown as Env;
	ran = [];
	outcome = () => ({ success: true, content: "Created issue #7" });
	for (const name of ["github_create_issue", "github_list_issues"]) {
		const tool = getRegistryTool(name)!;
		vi.spyOn(tool, "handler").mockImplementation(async (_ctx, input) => {
			ran.push({ tool: name, ...(input as Record<string, unknown>) });
			return outcome();
		});
	}
	h.push.mockReset();
	h.push.mockResolvedValue("sent");
});
afterEach(() => {
	vi.restoreAllMocks();
	d1.close();
});

function app() {
	const a = new Hono<{ Bindings: Env }>();
	const r = new Hono<{ Bindings: Env }>();
	registerPermissionRequestRoutes(r);
	a.route("/v1/instances", r);
	a.route("/v1/instances", toolRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
}
async function req(method: string, path: string, body?: unknown) {
	const res = await app().request(`/v1/instances${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
/** The blocked call, as an agent makes it — through the real dispatcher and its consent gate. */
const blocked = (args: Record<string, unknown> = ARGS, instanceId = "i1") => runRegistryTool("github_create_issue", { env, userId: "u1", instanceId }, args);
const row = (id: string) => d1.sqlite.prepare("SELECT status, continuation_ciphertext AS sealed FROM instance_permission_requests WHERE id = ?").get(id) as { status: string; sealed: unknown };
const events = (id: string) => (d1.sqlite.prepare("SELECT event, detail FROM instance_permission_request_events WHERE request_id = ? ORDER BY created_at, rowid").all(id) as Array<{ event: string; detail: string }>).map((e) => `${e.event}${e.event === "notification.outcome" ? `:${JSON.parse(e.detail).outcome}` : ""}`);
const consent = () => d1.sqlite.prepare("SELECT mode FROM instance_connector_consent WHERE instance_id = 'i1' AND connector = 'github' AND scope = 'write'").get() as { mode: string } | undefined;
async function block() {
	const r = await blocked();
	expect(r.success).toBe(false);
	return r.blocker!;
}

describe("1. the whole path, once", () => {
	it("blocked → asked → approved → grant read back → the exact operation runs once → resumed", async () => {
		const b = await block();
		expect(ran).toEqual([]); // nothing ran before the owner acted
		expect(b).toMatchObject({ control: "connector_consent", requestedScope: "write", operation: "github_create_issue", resource: "acme/widget", controlLink: instancePermissionsLink("i1", b.requestId), expiresAt: expect.any(String) });
		expect(b.remedy).toMatch(/Opening the link grants nothing/);
		// One push, to the exact typed permission-request link — never a generic console, no secret.
		expect(h.push).toHaveBeenCalledTimes(1);
		expect(String(h.push.mock.calls[0][5])).toBe(b.controlLink);
		// What is delivered — type, title, body, link — carries no key, argument value or token.
		const delivered = JSON.stringify(h.push.mock.calls[0].slice(2, 6));
		expect(delivered).not.toContain(KEK);
		expect(delivered).not.toContain("Retry exactly this");
		expect(row(b.requestId).sealed).not.toBeNull(); // sealed, never plaintext
		expect(JSON.stringify(d1.sqlite.prepare("SELECT * FROM instance_permission_requests").all())).not.toContain("Retry exactly this");

		const approved = await req("POST", `/i1/permission-requests/${b.requestId}/approve`, { mode: "always" });
		expect(approved).toMatchObject({ status: 200, body: { status: "resumed", verifiedScope: "write", mode: "always", result: { success: true } } });
		expect(consent()).toEqual({ mode: "always" });
		expect(ran).toEqual([{ tool: "github_create_issue", ...ARGS }]);
		expect(row(b.requestId)).toEqual({ status: "resumed", sealed: null }); // continuation wiped once used
		expect(events(b.requestId)).toEqual(["request.created", "continuation.sealed", "notification.outcome:sent", "request.approval_claimed", "continuation.claimed", "grant.verified", "continuation.dispatch_claimed", "continuation.dispatched"]);
		// A duplicate tap neither writes a second grant nor runs it again.
		expect((await req("POST", `/i1/permission-requests/${b.requestId}/approve`, { mode: "always" })).status).toBe(409);
		expect(ran).toHaveLength(1);
	});

	it("an `ask` consent keeps its own per-call approval: the resumed call is queued, not run", async () => {
		const b = await block();
		const approved = await req("POST", `/i1/permission-requests/${b.requestId}/approve`, { mode: "ask" });
		expect(approved.body).toMatchObject({ status: "awaiting_call_approval" });
		expect(ran).toEqual([]);
		expect((d1.sqlite.prepare("SELECT status FROM instance_runtime_tasks WHERE instance_id = 'i1'").get() as { status: string }).status).toBe("needs_approval");
	});
});

describe("2–3. owner and instance binding", () => {
	it("another owner cannot see or decide the request — nothing is granted or run", async () => {
		const b = await block();
		h.uid = "u2";
		expect((await req("POST", `/i1/permission-requests/${b.requestId}/approve`, { mode: "always" })).status).toBe(404);
		expect((await req("POST", `/iX/permission-requests/${b.requestId}/approve`, { mode: "always" })).status).toBe(404);
		expect(consent()).toBeUndefined();
		expect(ran).toEqual([]);
	});

	it("a request from instance i1 cannot be approved through instance i2", async () => {
		const b = await block();
		expect((await req("POST", `/i2/permission-requests/${b.requestId}/approve`, { mode: "always" })).status).toBe(404);
		expect(row(b.requestId).status).toBe("pending");
	});
});

describe("4. duplicates", () => {
	it("the same blocked operation reuses one request and buzzes the owner once", async () => {
		const a = await block();
		const b = await block();
		expect(b.requestId).toBe(a.requestId);
		expect(h.push).toHaveBeenCalledTimes(1);
		expect(d1.sqlite.prepare("SELECT count(*) AS n FROM instance_permission_requests").get()).toEqual({ n: 1 });
	});
});

describe("5, 6, 9, 13. terminal states", () => {
	it("deny: nothing is granted, the continuation is wiped, and a resume is refused", async () => {
		const b = await block();
		expect((await req("POST", `/i1/permission-requests/${b.requestId}/deny`)).status).toBe(200);
		expect(row(b.requestId)).toEqual({ status: "denied", sealed: null });
		expect((await req("POST", `/i1/permission-requests/${b.requestId}/resume`, { operation: "github_create_issue", args: ARGS })).status).toBe(409);
		expect(consent()).toBeUndefined();
		expect(ran).toEqual([]);
	});

	it("expiry: the sweep closes open requests only, and an expired one cannot be approved", async () => {
		const open = await block();
		const decided = (await blocked({ ...ARGS, title: "other" })).blocker!;
		await req("POST", `/i1/permission-requests/${decided.requestId}/deny`);
		expect(await sweepExpiredPermissionRequests(env, Date.now() + 31 * 60_000)).toBe(1);
		expect(row(open.requestId)).toEqual({ status: "expired", sealed: null });
		expect(row(decided.requestId).status).toBe("denied");
		expect(events(open.requestId)).toContain("request.expired");
		expect((await req("POST", `/i1/permission-requests/${open.requestId}/approve`, { mode: "always" })).status).toBe(409);
		expect(ran).toEqual([]);
	});

	it("cancel: a stale deep link reads a structured terminal state, and a later approve is refused", async () => {
		const b = await block();
		expect((await req("POST", `/i1/permission-requests/${b.requestId}/cancel`)).status).toBe(200);
		expect(await req("GET", `/i1/permission-requests/${b.requestId}`)).toMatchObject({ status: 200, body: { request: { id: b.requestId, status: "cancelled" } } });
		expect((await req("POST", `/i1/permission-requests/${b.requestId}/approve`, { mode: "always" })).status).toBe(409);
		expect(ran).toEqual([]);
	});
});

describe("7, 11. the grant is re-checked at the moment of the resume", () => {
	/** A request whose arguments were not kept (no key): approval verifies and claims, the caller resumes. */
	async function claimedWithoutContinuation() {
		const plain = { DB: d1.DB } as unknown as Env;
		const r = await runRegistryTool("github_create_issue", { env: plain, userId: "u1", instanceId: "i1" }, ARGS);
		const id = r.blocker!.requestId;
		const approved = await app().request(`/v1/instances/i1/permission-requests/${id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "always" }) }, plain);
		expect(await approved.json()).toMatchObject({ status: "claimed", resume: { method: "POST" } });
		return id;
	}

	it("revoked between approval and resume: 403 with the structured blocker, nothing run", async () => {
		const id = await claimedWithoutContinuation();
		d1.exec("DELETE FROM instance_connector_consent WHERE instance_id = 'i1'");
		const res = await req("POST", `/i1/permission-requests/${id}/resume`, { operation: "github_create_issue", args: ARGS });
		expect(res).toMatchObject({ status: 403, body: { status: "revoked", blocker: { requestId: id, controlLink: expect.any(String) } } });
		expect(ran).toEqual([]);
	});

	it("a grant that no longer covers the exact operation is reported as insufficient, nothing run", async () => {
		const id = await claimedWithoutContinuation();
		d1.exec(`UPDATE agent_instances SET config = '{"disabledTools":["github_create_issue"]}' WHERE id = 'i1'`);
		const res = await req("POST", `/i1/permission-requests/${id}/resume`, { operation: "github_create_issue", args: ARGS });
		expect(res).toMatchObject({ status: 403, body: { status: "insufficient", blocker: { requestId: id } } });
		expect(ran).toEqual([]);
	});

	it("changed arguments are refused against the approved fingerprint", async () => {
		const id = await claimedWithoutContinuation();
		const res = await req("POST", `/i1/permission-requests/${id}/resume`, { operation: "github_create_issue", args: { ...ARGS, title: "something else" } });
		expect(res.status).toBe(409);
		expect(ran).toEqual([]);
	});
});

describe("8. an owner the push cannot reach", () => {
	it("keeps the request and its link; a repeat of the blocked call asks again, and a delivered ask is never repeated", async () => {
		h.push.mockRejectedValueOnce(new Error("no subscription"));
		const b = await block();
		expect(row(b.requestId).status).toBe("pending");
		expect(events(b.requestId)).toContain("notification.outcome:unavailable");
		await block(); // the device is back
		await block();
		expect(h.push).toHaveBeenCalledTimes(2);
		expect(events(b.requestId).filter((e) => e.startsWith("notification.outcome"))).toEqual(["notification.outcome:unavailable", "notification.outcome:sent"]);
	});
});

describe("10. an uncertain outcome", () => {
	it("a write that reports failure after dispatch is `uncertain` and is never retried", async () => {
		const b = await block();
		outcome = () => ({ success: false, content: "GitHub answered 502" });
		const approved = await req("POST", `/i1/permission-requests/${b.requestId}/approve`, { mode: "always" });
		expect(approved).toMatchObject({ status: 409, body: { status: "uncertain" } });
		expect(ran).toHaveLength(1);
		expect(row(b.requestId)).toEqual({ status: "uncertain", sealed: null });
		expect((await req("POST", `/i1/permission-requests/${b.requestId}/resume`, { operation: "github_create_issue", args: ARGS })).status).toBe(409);
		expect(ran).toHaveLength(1);
	});
});

describe("stopped work is not resumed behind the owner's back", () => {
	it("a request whose originating run has stopped goes stale on approval instead of running", async () => {
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('run-1','u1','i1','synthetic','running',5,1)`);
		const r = await runRegistryTool("github_create_issue", { env, userId: "u1", instanceId: "i1", traceId: "run-1" }, ARGS);
		d1.exec("UPDATE agent_loop_runs SET status = 'cancelled' WHERE run_id = 'run-1'");
		const approved = await req("POST", `/i1/permission-requests/${r.blocker!.requestId}/approve`, { mode: "always" });
		expect(approved.body).toMatchObject({ status: "stale" });
		expect(ran).toEqual([]);
	});
});

describe("a declared tool the owner switched off (tool_enabled)", () => {
	it("refused via the tool route with a blocker; approval switches only it back on and runs the exact call", async () => {
		d1.exec(`UPDATE agent_instances SET config = '{"disabledTools":["github_list_issues"]}' WHERE id = 'i1'`);
		const refused = await req("POST", "/i1/tools/github_list_issues", { repo: "acme/widget" });
		expect(refused).toMatchObject({ status: 403, body: { blocker: { control: "tool_enabled", requestedScope: "enabled", operation: "github_list_issues" } } });
		expect(ran).toEqual([]);
		const id = (refused.body.blocker as { requestId: string }).requestId;
		// The card reads the request's kind, so it offers "Switch on github_list_issues", not write access (#1059).
		expect(await req("GET", `/i1/permission-requests/${id}`)).toMatchObject({ status: 200, body: { request: { control: "tool_enabled", operationKind: "github_list_issues" } } });
		const approved = await req("POST", `/i1/permission-requests/${id}/approve`, {});
		expect(approved).toMatchObject({ status: 200, body: { status: "resumed" } });
		expect(ran).toEqual([{ tool: "github_list_issues", repo: "acme/widget" }]);
		expect(JSON.parse((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = 'i1'").get() as { config: string }).config).disabledTools).toEqual([]);
	});

	it("a connector write request reads as connector_consent, so the card keeps its write-access choices (#1059)", async () => {
		const b = await block();
		expect(await req("GET", `/i1/permission-requests/${b.requestId}`)).toMatchObject({ status: 200, body: { request: { control: "connector_consent", connector: "github", requestedScope: "write" } } });
	});

	it("a tool the creator never declared gets no request — the owner cannot grant it", async () => {
		const refused = await req("POST", "/i1/tools/github_comment_issue", { repo: "acme/widget", number: 1, body: "x" });
		expect(refused.status).toBe(403);
		expect(refused.body.blocker).toBeUndefined();
		expect(d1.sqlite.prepare("SELECT count(*) AS n FROM instance_permission_requests").get()).toEqual({ n: 0 });
	});
});

describe("12. a signed-out tap keeps its destination", () => {
	it("the push link is a real console route that survives sign-in and focuses the exact request", async () => {
		const b = await block();
		// A real console route, focusing exactly this request. The sign-in round trip of this URL shape
		// (query kept, `session` stripped) is pinned beside the console's own helper in
		// store/console/src/lib/notification-click.test.ts — that helper reads `window`.
		expect(checkConsoleLink(b.controlLink).ok).toBe(true);
		expect(b.controlLink).toBe(`/console/instances/i1/settings?focus=permissions&permission_request=${b.requestId}`);
		expect(permissionRequestFocus(new URL(b.controlLink, "https://x").search)).toEqual({ controlId: "permissions-and-connections", requestId: b.requestId });
	});
});
