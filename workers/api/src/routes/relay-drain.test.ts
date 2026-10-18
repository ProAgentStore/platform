/**
 * #1161 — a machine reconnecting drains what was queued while it was away.
 *
 * The drain rides the relay CONNECT, not the registration: at startup the runner registers before
 * its socket is up, and the drain's admission asks the relay whether a socket is live, so a drain on
 * registration would meet "offline" and requeue with nothing left to drain it. Only the RelayDO and
 * the drain itself are faked; the token and the ownership check are real.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { drainPendingQueues } = vi.hoisted(() => ({ drainPendingQueues: vi.fn() }));
vi.mock("../lib/objective-queue-start.js", () => ({ drainPendingQueues }));

import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signRelayToken } from "../lib/session.js";
import type { Env } from "../types.js";

const { relayRoutes } = await import("./relay.js");

const KEY = "relay-test-signing-key-0123456789abcdef";
let d1: RealSchemaD1;
let upgrade: number;

/** A Response whose status reads as `status` — Node refuses to construct a 101 directly. */
function answer(status: number): Response {
	const res = new Response(null, { status: 200 });
	Object.defineProperty(res, "status", { value: status });
	return res;
}

function env(): Env {
	const RELAY = { idFromName: (n: string) => n, get: () => ({ fetch: async () => answer(upgrade) }) };
	return { DB: d1.DB, RELAY, SESSION_SIGNING_KEY: KEY } as unknown as Env;
}

async function connect(instanceId = "i1", uid = "u1") {
	const { token } = await signRelayToken(instanceId, uid, KEY);
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/relay", relayRoutes);
	return app.request(`/v1/relay/${instanceId}/connect?token=${encodeURIComponent(token)}&node=Sergeys-Mac-mini.local`, {}, env());
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	drainPendingQueues.mockReset().mockResolvedValue([]);
	upgrade = 101;
});
afterEach(() => d1.close());

describe("the relay connecting drains the instance's queue (#1161)", () => {
	it("an accepted socket drains the owner's pending objectives for that instance", async () => {
		const res = await connect();
		expect(res.status).toBe(101);
		expect(drainPendingQueues).toHaveBeenCalledTimes(1);
		expect(drainPendingQueues.mock.calls[0].slice(1)).toEqual(["i1", "u1"]);
	});

	it("a refused upgrade drains nothing — the machine still cannot work", async () => {
		upgrade = 409;
		const res = await connect();
		expect(res.status).toBe(409);
		expect(drainPendingQueues).not.toHaveBeenCalled();
	});

	it("a drain that fails never fails the connect", async () => {
		drainPendingQueues.mockRejectedValue(new Error("D1 unavailable"));
		const res = await connect();
		expect(res.status).toBe(101);
	});
});
