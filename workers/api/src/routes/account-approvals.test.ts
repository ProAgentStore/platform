/**
 * #1268 — the account approval gate end to end: the middleware in front of real mutating routes, the owner's approvals API
 * and the gate settings, against the REAL migrated schema and real signed sessions. The targets are stand-ins that do what
 * the real handlers do to state (write the instance config, count calls), so "did it apply" is a fact read back from D1.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalGate } from "../lib/approval-gate-middleware.js";
import { HttpError, requireUser } from "../lib/auth.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import { patchInstanceConfig } from "../lib/instance-config.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";
import { accountApprovalRoutes, setGateReplay } from "./account-approvals.js";

const pushes: Array<{ userId: string; type: string; title: string; body: string; url: string; opts: Record<string, unknown> }> = [];
vi.mock("./push.js", () => ({
	notifyUser: async (_e: unknown, userId: string, type: string, title: string, body: string, url: string, opts: Record<string, unknown>) => {
		pushes.push({ userId, type, title, body, url, opts });
		return "sent";
	},
}));

const KEK = "7".repeat(64);
let d1: RealSchemaD1;
let env: Env;
let app: Hono<{ Bindings: Env }>;
let repoAdds: number;
let tokens: Record<string, string>;

function build(opts: { middleware?: boolean } = {}) {
	const a = new Hono<{ Bindings: Env }>();
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	if (opts.middleware !== false) a.use("/v1/*", approvalGate());
	a.route("/v1", accountApprovalRoutes);
	a.put("/v1/instances/:id/runner-node", async (c) => {
		const s = await requireUser(c);
		const body = (await c.req.json().catch(() => ({}))) as { runnerNode?: string };
		await patchInstanceConfig(c.env, c.req.param("id"), s.uid, "runnerNode", body.runnerNode ?? null);
		return c.json({ runnerNode: body.runnerNode ?? null });
	});
	a.post("/v1/instances/:id/coding/repos", async (c) => {
		await requireUser(c);
		repoAdds++;
		const body = (await c.req.json().catch(() => ({}))) as { repo?: string };
		if (body.repo === "bad") return c.json({ error: "no such repo" }, 400);
		return c.json({ added: body.repo ?? null }, 201);
	});
	a.delete("/v1/instances/:id/runtime", async (c) => {
		await requireUser(c);
		return c.json({ success: true });
	});
	return a;
}

const call = (who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
	app.request(path, { method, headers: { Authorization: `Bearer ${tokens[who]}`, "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
// biome-ignore lint/suspicious/noExplicitAny: test reads loose JSON
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const node = (id = "inst-1") => {
	const row = d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = ?").get(id) as { config: string | null };
	return (row.config ? (JSON.parse(row.config) as Record<string, unknown>).runnerNode : undefined) ?? null;
};
const enable = (actions: string[], expirySeconds = 3600) => call("u1", "PUT", "/v1/approval-gate", { enabled: true, actions, expirySeconds });
const hold = async (path = "/v1/instances/inst-1/runner-node", body: unknown = { runnerNode: "mac-mini" }) => json(await call("u1", path.endsWith("/repos") ? "POST" : "PUT", path, body));

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["inst-2"] });
	env = { DB: d1.DB, SESSION_SIGNING_KEY: "test-signing-key", KEY_ENCRYPTION_KEY: KEK } as unknown as Env;
	tokens = { u1: await signSession("u1", "test-signing-key"), u2: await signSession("u2", "test-signing-key") };
	repoAdds = 0;
	pushes.length = 0;
	app = build();
	setGateReplay((req, e, ctx) => Promise.resolve(app.fetch(req, e, ctx)));
});
afterEach(() => d1.close());

describe("gate off: behaviour is unchanged", () => {
	it("applies every mutation straight away and records nothing", async () => {
		const res = await call("u1", "PUT", "/v1/instances/inst-1/runner-node", { runnerNode: "mac-mini" });
		expect(res.status).toBe(200);
		expect(node()).toBe("mac-mini");
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM account_change_requests").get()).toEqual({ n: 0 });
		expect(pushes).toHaveLength(0);
	});

	it("a gate that is enabled but does not list the action lets it through", async () => {
		await enable(["repo_add"]);
		expect((await call("u1", "PUT", "/v1/instances/inst-1/runner-node", { runnerNode: "x" })).status).toBe(200);
		expect(node()).toBe("x");
	});

	it("only the owner's own gate applies: another account is unaffected", async () => {
		await enable(["runner_repin"]);
		const res = await call("u2", "PUT", "/v1/instances/inst-2/runner-node", { runnerNode: "y" });
		expect(res.status).toBe(200);
		expect(node("inst-2")).toBe("y");
	});
});

describe("gate on: a selected action is held", () => {
	beforeEach(async () => {
		await enable(["runner_repin", "repo_add", "instance_cancel_delete"]);
	});

	it("answers 202 approval_pending with the id, the diff and a poll URL, and changes nothing", async () => {
		const res = await call("u1", "PUT", "/v1/instances/inst-1/runner-node", { runnerNode: "mac-mini" });
		expect(res.status).toBe(202);
		const out = await json(res);
		expect(out).toMatchObject({ status: "approval_pending", action: "runner_repin", action_label: expect.any(String) });
		expect(out.approval_id).toMatch(/[0-9a-f-]{36}/);
		expect(out.poll).toBe(`/v1/approvals/${out.approval_id}`);
		expect(res.headers.get("Location")).toBe(out.poll);
		expect(out.diff_preview).toMatchObject({ method: "PUT", path: "/v1/instances/inst-1/runner-node", change: { runnerNode: "mac-mini" } });
		expect(new Date(out.expires_at).getTime()).toBeGreaterThan(Date.now());
		expect(node()).toBeNull();
	});

	it("sends one push whose link opens the exact request, and whose text never carries a secret", async () => {
		const out = await hold("/v1/instances/inst-1/coding/repos", { repo: "acme/app", token: "ghp_SUPERSECRET" });
		expect(pushes).toHaveLength(1);
		expect(pushes[0]).toMatchObject({ userId: "u1", type: "account_approval" });
		expect(pushes[0].url).toContain(`approval=${out.approval_id}`);
		expect(JSON.stringify(pushes[0])).not.toContain("ghp_SUPERSECRET");
		expect(JSON.stringify(out)).not.toContain("ghp_SUPERSECRET");
		expect(JSON.stringify(out.diff_preview.change)).toContain("[hidden]");
		expect(repoAdds).toBe(0);
	});

	it("keeps the exact body only encrypted, and a secret-looking value nowhere at all", async () => {
		await hold("/v1/instances/inst-1/coding/repos", { repo: "acme/app", note: "PLAINTEXT-MARKER", apiKey: "SECRET-VALUE-123" });
		const row = d1.sqlite.prepare("SELECT body_encrypted, diff_preview FROM account_change_requests").get() as { body_encrypted: string; diff_preview: string };
		expect(row.body_encrypted).not.toContain("PLAINTEXT-MARKER");
		expect(row.body_encrypted).not.toContain("SECRET-VALUE-123");
		expect(row.diff_preview).not.toContain("SECRET-VALUE-123");
		expect(row.diff_preview).toContain("acme/app");
	});

	it("the same request twice is one pending approval and one push", async () => {
		const a = await hold();
		const b = await hold();
		expect(b.approval_id).toBe(a.approval_id);
		expect(pushes).toHaveLength(1);
	});

	it("holds an MCP-originated call too, and ignores a bypass header sent from outside", async () => {
		const mcp = await call("u1", "PUT", "/v1/instances/inst-1/runner-node", { runnerNode: "a" }, { "X-PAGS-Client": "mcp" });
		expect(mcp.status).toBe(202);
		const forged = await call("u1", "PUT", "/v1/instances/inst-1/runner-node", { runnerNode: "b" }, { "X-Internal-Gate-Bypass": "deadbeef" });
		expect(forged.status).toBe(202);
		expect(node()).toBeNull();
	});

	it("refuses (503) rather than applies when the change cannot be held securely", async () => {
		env = { ...env, KEY_ENCRYPTION_KEY: undefined } as unknown as Env;
		const res = await call("u1", "PUT", "/v1/instances/inst-1/runner-node", { runnerNode: "z" });
		expect(res.status).toBe(503);
		expect(node()).toBeNull();
	});

	it("an unauthenticated request is left to the handler's own 401", async () => {
		const res = await app.request("/v1/instances/inst-1/runner-node", { method: "PUT", body: "{}" }, env);
		expect(res.status).toBe(401);
	});
});

describe("approval applies exactly once", () => {
	beforeEach(async () => {
		await enable(["runner_repin", "repo_add"]);
	});

	it("approve → applied: the stored request runs, the poll and the audit say so", async () => {
		const held = await hold();
		expect((await json(await call("u1", "GET", held.poll))).status).toBe("pending");
		const res = await call("u1", "POST", `/v1/approvals/${held.approval_id}/approve`, { device: "Pixel 9" });
		expect(res.status).toBe(200);
		const out = await json(res);
		expect(out).toMatchObject({ status: "applied", decidedByDevice: "Pixel 9", result: { status: 200 } });
		expect(node()).toBe("mac-mini");
		const events = (await json(await call("u1", "GET", held.poll))).events.map((e: { event: string }) => e.event);
		expect(events).toEqual(["request.created", "notification.outcome", "decision.approved", "apply.started", "apply.succeeded"]);
	});

	it("a second approve (a replay, a double tap) is a no-op", async () => {
		const held = await hold("/v1/instances/inst-1/coding/repos", { repo: "acme/app" });
		const first = await call("u1", "POST", `/v1/approvals/${held.approval_id}/approve`, {});
		const again = await call("u1", "POST", `/v1/approvals/${held.approval_id}/approve`, {});
		expect(first.status).toBe(200);
		expect(again.status).toBe(200);
		expect((await json(again)).duplicate).toBe(true);
		expect(repoAdds).toBe(1);
	});

	it("two approvals racing apply it once", async () => {
		const held = await hold("/v1/instances/inst-1/coding/repos", { repo: "acme/app" });
		await Promise.all([call("u1", "POST", `/v1/approvals/${held.approval_id}/approve`, {}), call("u1", "POST", `/v1/approvals/${held.approval_id}/approve`, {})]);
		expect(repoAdds).toBe(1);
	});

	it("a change the target rejects ends failed, with what it answered", async () => {
		const held = await hold("/v1/instances/inst-1/coding/repos", { repo: "bad" });
		const res = await call("u1", "POST", `/v1/approvals/${held.approval_id}/approve`, {});
		expect(res.status).toBe(502);
		const out = await json(res);
		expect(out).toMatchObject({ status: "failed", result: { status: 400 } });
		expect(JSON.stringify(out.result)).toContain("no such repo");
	});

	it("cannot be approved through MCP, by the agent that asked", async () => {
		const held = await hold();
		const res = await call("u1", "POST", `/v1/approvals/${held.approval_id}/approve`, {}, { "X-PAGS-Client": "mcp" });
		expect(res.status).toBe(403);
		expect(node()).toBeNull();
		expect((await json(await call("u1", "GET", held.poll))).status).toBe("pending");
	});

	it("another account can neither see nor decide it", async () => {
		const held = await hold();
		expect((await call("u2", "GET", held.poll)).status).toBe(404);
		expect((await call("u2", "POST", `${held.poll}/approve`, {})).status).toBe(404);
		expect(node()).toBeNull();
	});
});

describe("deny, cancel, expiry and drift leave the config alone", () => {
	beforeEach(async () => {
		await enable(["runner_repin"]);
	});

	it("deny: nothing applies, the poll says denied, and a later approve cannot revive it", async () => {
		const held = await hold();
		expect((await call("u1", "POST", `${held.poll}/deny`, { device: "iPhone" })).status).toBe(200);
		const after = await json(await call("u1", "POST", `${held.poll}/approve`, {}));
		expect(after).toMatchObject({ status: "denied", duplicate: true });
		expect(node()).toBeNull();
		expect((await json(await call("u1", "GET", held.poll))).decidedByDevice).toBe("iPhone");
	});

	it("cancel withdraws it", async () => {
		const held = await hold();
		expect((await call("u1", "POST", `${held.poll}/cancel`)).status).toBe(200);
		expect((await json(await call("u1", "GET", held.poll))).status).toBe("cancelled");
		expect((await call("u1", "POST", `${held.poll}/approve`, {})).status).toBe(200);
		expect(node()).toBeNull();
	});

	it("expiry: the poll reports expired and an approval after it is 410 and applies nothing", async () => {
		const held = await hold();
		d1.exec(`UPDATE account_change_requests SET expires_at = ${Date.now() - 1000}`);
		expect((await json(await call("u1", "GET", held.poll))).status).toBe("expired");
		const res = await call("u1", "POST", `${held.poll}/approve`, {});
		expect(res.status).toBe(410);
		expect((await json(res)).status).toBe("expired");
		expect(node()).toBeNull();
	});

	it("expiry is checked at approval itself, not only on read", async () => {
		const held = await hold();
		d1.exec(`UPDATE account_change_requests SET expires_at = ${Date.now() - 1000}`);
		expect((await call("u1", "POST", `${held.poll}/approve`, {})).status).toBe(410);
		expect(node()).toBeNull();
	});

	it("drift: if the target changed since the request, approval refuses with 409 and applies nothing", async () => {
		const held = await hold();
		await patchInstanceConfig(env, "inst-1", "u1", "runnerNode", "someone-else");
		const res = await call("u1", "POST", `${held.poll}/approve`, {});
		expect(res.status).toBe(409);
		const out = await json(res);
		expect(out.status).toBe("drift_detected");
		expect(out.message).toMatch(/changed since/);
		expect(node()).toBe("someone-else");
		expect((await json(await call("u1", "GET", held.poll))).status).toBe("failed");
	});

	it("a request that is asked for again after expiry is a fresh pending approval", async () => {
		const first = await hold();
		d1.exec(`UPDATE account_change_requests SET expires_at = ${Date.now() - 1000}`);
		const second = await hold();
		expect(second.approval_id).not.toBe(first.approval_id);
		expect(second.status).toBe("approval_pending");
	});
});

describe("the gate protects itself", () => {
	it("settings validate: known actions only, bounded expiry, at least one action when on", async () => {
		expect((await call("u1", "PUT", "/v1/approval-gate", { enabled: true, actions: ["nope"] })).status).toBe(400);
		expect((await call("u1", "PUT", "/v1/approval-gate", { expirySeconds: 5 })).status).toBe(400);
		expect((await call("u1", "PUT", "/v1/approval-gate", { enabled: true, actions: [] })).status).toBe(400);
		const on = await json(await call("u1", "PUT", "/v1/approval-gate", { enabled: true }));
		expect(on.gate.actions.sort()).toEqual(["coder_create", "instance_create", "repo_add"]);
	});

	it("turning it off, or dropping an action, is itself held while it is on", async () => {
		await enable(["runner_repin", "repo_add"]);
		const off = await call("u1", "PUT", "/v1/approval-gate", { enabled: false });
		expect(off.status).toBe(202);
		expect((await json(off)).action).toBe("gate_change");
		const shrink = await call("u1", "PUT", "/v1/approval-gate", { actions: ["repo_add"] });
		expect(shrink.status).toBe(202);
		const gate = await json(await call("u1", "GET", "/v1/approval-gate"));
		expect(gate).toMatchObject({ enabled: true, actions: ["runner_repin", "repo_add"] });
		expect(gate.pending).toBe(2);
	});

	it("making it stricter is not held", async () => {
		await enable(["repo_add"]);
		const more = await call("u1", "PUT", "/v1/approval-gate", { actions: ["repo_add", "runner_repin"] });
		expect(more.status).toBe(200);
	});

	it("an approved disable turns it off, once; then everything passes again", async () => {
		await enable(["runner_repin"]);
		const held = await json(await call("u1", "PUT", "/v1/approval-gate", { enabled: false }));
		expect((await json(await call("u1", "GET", "/v1/approval-gate"))).enabled).toBe(true);
		expect((await call("u1", "POST", `${held.poll}/approve`, {})).status).toBe(200);
		expect((await json(await call("u1", "GET", "/v1/approval-gate"))).enabled).toBe(false);
		expect((await call("u1", "PUT", "/v1/instances/inst-1/runner-node", { runnerNode: "free" })).status).toBe(200);
	});

	it("even a request that skipped the middleware cannot weaken an enabled gate", async () => {
		await enable(["runner_repin"]);
		const bare = build({ middleware: false });
		const res = await bare.request("/v1/approval-gate", { method: "PUT", headers: { Authorization: `Bearer ${tokens.u1}`, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) }, env);
		expect(res.status).toBe(403);
		expect((await json(await call("u1", "GET", "/v1/approval-gate"))).enabled).toBe(true);
	});

	it("lists the held and recent requests with the gate's pending count", async () => {
		await enable(["runner_repin"]);
		await hold();
		const list = await json(await call("u1", "GET", "/v1/approvals"));
		expect(list.pending).toBe(1);
		expect(list.approvals[0]).toMatchObject({ status: "pending", action: "runner_repin" });
	});
});
