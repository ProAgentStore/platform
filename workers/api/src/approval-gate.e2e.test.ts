/**
 * #1268 — the gate through the REAL assembled Worker: the production middleware order, the real consent route, and the
 * in-process replay wired in index.ts. One MCP-marked mutation is held, approved from the console, applied exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
	class DurableObject {}
	class WorkflowEntrypoint extends DurableObject {}
	return { DurableObject, WorkflowEntrypoint };
});

import { type RealSchemaD1, realSchemaD1, seedTenant } from "./lib/d1-sqlite.js";
import { fakeKv } from "./lib/kv-fake.js";
import { signSession } from "./lib/session.js";
import type { Env } from "./types.js";

const { default: worker } = await import("./index.js");

const KEY = "approval-e2e-key";
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
let d1: RealSchemaD1;
let env: Env;
let token: string;

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
	worker.fetch(new Request(`https://api.proagentstore.online${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, ctx);
// biome-ignore lint/suspicious/noExplicitAny: test reads loose JSON
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const consent = () => d1.sqlite.prepare("SELECT connector, scope, mode FROM instance_connector_consent WHERE instance_id = 'inst-1'").all();

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	env = { DB: d1.DB, OAUTH_KV: fakeKv().kv, SESSION_SIGNING_KEY: KEY, KEY_ENCRYPTION_KEY: "9".repeat(64) } as unknown as Env;
	token = await signSession("u1", KEY);
});
afterEach(() => d1.close());

describe("the approval gate on the real Worker", () => {
	it("with the gate off, an MCP consent change applies immediately (behaviour unchanged)", async () => {
		const res = await call("PUT", "/v1/instances/inst-1/connectors/gmail/consent", { mode: "ask" }, { "X-PAGS-Client": "mcp" });
		expect(res.status).toBe(200);
		expect(consent()).toEqual([{ connector: "gmail", scope: "write", mode: "ask" }]);
	});

	it("holds an MCP consent change, refuses MCP's own approval, then applies once when the owner approves", async () => {
		expect((await call("PUT", "/v1/approval-gate", { enabled: true, actions: ["grants_consent"] })).status).toBe(200);

		const held = await call("PUT", "/v1/instances/inst-1/connectors/gmail/consent", { mode: "ask" }, { "X-PAGS-Client": "mcp" });
		expect(held.status).toBe(202);
		const pending = await json(held);
		expect(pending).toMatchObject({ status: "approval_pending", action: "grants_consent" });
		expect(consent()).toEqual([]);

		// The agent that asked cannot approve its own request, with the owner's very token.
		expect((await call("POST", `${pending.poll}/approve`, {}, { "X-PAGS-Client": "mcp" })).status).toBe(403);
		expect(consent()).toEqual([]);

		const approved = await call("POST", `${pending.poll}/approve`, { device: "iPhone 16" });
		expect(approved.status).toBe(200);
		expect(await json(approved)).toMatchObject({ status: "applied", decidedByDevice: "iPhone 16", result: { status: 200 } });
		expect(consent()).toEqual([{ connector: "gmail", scope: "write", mode: "ask" }]);

		const again = await json(await call("POST", `${pending.poll}/approve`, {}));
		expect(again.duplicate).toBe(true);
		expect(consent()).toHaveLength(1);

		const events = (await json(await call("GET", pending.poll))).events.map((e: { event: string }) => e.event);
		expect(events).toEqual(expect.arrayContaining(["request.created", "decision.approved", "apply.started", "apply.succeeded"]));
	});

	it("a replayed request is not held again, and the bypass marker is worthless from outside", async () => {
		await call("PUT", "/v1/approval-gate", { enabled: true, actions: ["grants_consent"] });
		const forged = await call("PUT", "/v1/instances/inst-1/connectors/gmail/consent", { mode: "ask" }, { "X-Internal-Gate-Bypass": "0".repeat(48) });
		expect(forged.status).toBe(202);
		expect(consent()).toEqual([]);
	});
});
