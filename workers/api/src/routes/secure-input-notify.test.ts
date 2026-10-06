/**
 * The owner is told when an agent asks them for a secret, and the account can see who is waiting (#934).
 *
 * A request's console link went back to the AGENT only — no notification was written and the only
 * console listing sat on the chat tab — so a request could wait unseen for its whole day while the run
 * that asked for it waited too. Real schema; only `requireUser` is faked.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkConsoleLink } from "../../../../store/console/src/lib/routes";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { depositSecureInput } from "../lib/secure-input.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { instanceRoutes } = await import("./instances.js");
const { secureInputRoutes } = await import("./secure-input.js");

const KEY = "0".repeat(64);
let d1: RealSchemaD1;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't934-operator', 'tmux Operator')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES
	  ('i1', 'ag', 'u1', 'active', '{"displayName":"Macmini Terminal"}'),
	  ('i2', 'ag', 'u1', 'active', '{}'),
	  ('i9', 'ag', 'u2', 'active', '{}')`);
});
afterEach(() => d1.close());

const env = () => ({ DB: d1.DB, KEY_ENCRYPTION_KEY: KEY }) as unknown as Env;

/** Mounted in the production order (index.ts): instance routes first, then secure inputs. */
function app() {
	const a = new Hono<{ Bindings: Env }>();
	a.route("/v1/instances", instanceRoutes);
	a.route("/v1/instances", secureInputRoutes);
	a.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	return a;
}

async function request(instanceId: string, label: string) {
	const res = await app().request(`/v1/instances/${instanceId}/secure-inputs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label, destinationScope: "tmux" }) }, env());
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

const notifications = () => d1.DB.prepare("SELECT type, kind, title, body, url, instance_id FROM notifications WHERE user_id = 'u1'").all<Record<string, string>>().then((r) => r.results ?? []);

describe("POST /secure-inputs tells the owner (#934)", () => {
	it("writes one alert, deep-linked to the request, naming the agent and the label — never a value", async () => {
		const id = await request("i1", "Firebase auth code");
		const rows = await notifications();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ type: "secure-input", kind: "alert", instance_id: "i1" });
		expect(rows[0].title).toBe("🔐 Macmini Terminal needs a value");
		expect(rows[0].body).toContain("“Firebase auth code”");
		expect(rows[0].url).toBe(`/console/instances/i1/secure-inputs/${id}`);
		expect(checkConsoleLink(rows[0].url).ok).toBe(true);
	});

	it("names the agent when the instance has no display name", async () => {
		await request("i2", "OTP");
		expect((await notifications())[0].title).toBe("🔐 tmux Operator needs a value");
	});

	it("does NOT notify for a machine deposit — there is nothing for the owner to type", async () => {
		await depositSecureInput(env(), { instanceId: "i1", userId: "u1", label: "heartfull .env.prod", sourceNode: "Macmini", ttlMs: 60 * 60_000, value: "not-a-real-secret" });
		expect(await notifications()).toHaveLength(0);
	});
});

describe("GET /my/secure-inputs — who is waiting on the owner, account-wide (#934)", () => {
	async function pending() {
		const res = await app().request("/v1/instances/my/secure-inputs", {}, env());
		expect(res.status).toBe(200);
		return ((await res.json()) as { instances: Array<{ instanceId: string; pending: number; requestId: string; label: string }> }).instances;
	}

	it("is reached — `my` is never read as an instance id", async () => {
		expect(await pending()).toEqual([]);
	});

	it("counts owner requests per instance and names the OLDEST", async () => {
		const first = await request("i1", "first");
		d1.exec(`UPDATE secure_input_requests SET created_at = datetime('now', '-1 hour') WHERE id = '${first}'`);
		await request("i1", "second");
		await request("i2", "other");
		const rows = await pending();
		expect(rows.find((r) => r.instanceId === "i1")).toEqual({ instanceId: "i1", pending: 2, requestId: first, label: "first" });
		expect(rows.find((r) => r.instanceId === "i2")?.pending).toBe(1);
	});

	it("excludes machine deposits, entered values, expired requests and other users' requests", async () => {
		await depositSecureInput(env(), { instanceId: "i1", userId: "u1", label: "dep", sourceNode: "Macmini", ttlMs: 60 * 60_000, value: "x" });
		const entered = await request("i1", "entered");
		d1.exec(`UPDATE secure_input_requests SET status = 'ready' WHERE id = '${entered}'`);
		const old = await request("i2", "expired");
		d1.exec(`UPDATE secure_input_requests SET expires_at = datetime('now', '-1 minute') WHERE id = '${old}'`);
		d1.exec(`INSERT INTO secure_input_requests (id, instance_id, user_id, status, label, destination_scope, one_shot, expires_at, created_at, updated_at)
		         VALUES ('x9', 'i9', 'u2', 'pending', 'theirs', 'tmux', 1, datetime('now', '+1 hour'), datetime('now'), datetime('now'))`);
		expect(await pending()).toEqual([]);
	});
});
