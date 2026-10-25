/** The checkout-action routes, driven as the owner (#1324): the discard confirmation, the HTTP status of each named failure, and the auto-stash switch. */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { realSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import { registerCheckoutActionRoutes } from "./coding-checkout-actions.js";
import type { Env } from "../types.js";

const { runCheckoutAction } = vi.hoisted(() => ({ runCheckoutAction: vi.fn() }));
vi.mock("../lib/checkout-actions.js", async (orig) => ({ ...(await orig<typeof import("../lib/checkout-actions.js")>()), runCheckoutAction }));

const SECRET = "checkout-actions-test-secret";

function build() {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	const env = { SESSION_SIGNING_KEY: SECRET, DB: d1.DB } as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	const routes = new Hono<{ Bindings: Env }>();
	registerCheckoutActionRoutes(routes);
	app.route("/v1/instances", routes);
	app.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	const call = async (method: string, path: string, body?: unknown, uid = "u1") => {
		const token = await signSession(uid, SECRET, { roles: ["user"] });
		return app.request(`/v1/instances/i1/coding${path}`, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	};
	return { call, d1 };
}

beforeEach(() => runCheckoutAction.mockReset());

describe("POST …/checkout/:action", () => {
	it("stash runs with the label and pull defaulting to true, and answers the outcome", async () => {
		runCheckoutAction.mockResolvedValue({ ok: true, action: "stash", machine: "tiny-laptop", summary: "Stashed 59 changed files.", result: {} });
		const { call } = build();
		const res = await call("POST", "/repos/r1/checkout/stash", { label: "run 0c59a0bf" });
		expect(res.status).toBe(200);
		expect(runCheckoutAction.mock.calls[0][1]).toMatchObject({ instanceId: "i1", userId: "u1", repoId: "r1", action: "stash", label: "run 0c59a0bf", pull: true, node: null });
	});

	it("discard without the exact confirmation is refused before the machine is asked", async () => {
		const { call } = build();
		for (const body of [{}, { confirm: "yes" }]) expect((await call("POST", "/repos/r1/checkout/discard", body)).status).toBe(400);
		expect(runCheckoutAction).not.toHaveBeenCalled();
		runCheckoutAction.mockResolvedValue({ ok: true, action: "discard", machine: "m", summary: "Discarded.", result: {} });
		expect((await call("POST", "/repos/r1/checkout/discard", { confirm: "discard_checkout", pull: false, runner_node: "Macmini.modem" })).status).toBe(200);
		expect(runCheckoutAction.mock.calls[0][1]).toMatchObject({ action: "discard", pull: false, node: "Macmini.modem" });
	});

	it("each named failure has its own status: an unreachable machine is a 502 that says so", async () => {
		const { call } = build();
		const cases: Array<[string, number]> = [["unreachable", 502], ["busy", 409], ["no_repo", 404], ["old_runner", 422], ["failed", 500]];
		for (const [reason, status] of cases) {
			runCheckoutAction.mockResolvedValueOnce({ ok: false, reason, machine: "Macmini.modem", error: `explicit ${reason}` });
			const res = await call("POST", "/repos/r1/checkout/stash", {});
			expect(res.status).toBe(status);
			expect(await res.json()).toMatchObject({ ok: false, reason, error: `explicit ${reason}` });
		}
	});

	it("an unknown action is a 404, and another owner's instance is not reachable", async () => {
		const { call } = build();
		expect((await call("POST", "/repos/r1/checkout/wipe", {})).status).toBe(404);
		expect((await call("POST", "/repos/r1/checkout/stash", {}, "someone-else")).status).toBe(404);
		expect(runCheckoutAction).not.toHaveBeenCalled();
	});
});

describe("GET/PUT …/auto-stash", () => {
	it("is off by default and the owner can switch it on and off", async () => {
		const { call } = build();
		expect(await (await call("GET", "/auto-stash")).json()).toEqual({ enabled: false });
		expect(await (await call("PUT", "/auto-stash", { enabled: true })).json()).toEqual({ enabled: true });
		expect(await (await call("GET", "/auto-stash")).json()).toEqual({ enabled: true });
		expect(await (await call("PUT", "/auto-stash", { enabled: false })).json()).toEqual({ enabled: false });
		expect(await (await call("GET", "/auto-stash")).json()).toEqual({ enabled: false });
	});

	it("rejects a non-boolean", async () => {
		const { call } = build();
		expect((await call("PUT", "/auto-stash", { enabled: "yes" })).status).toBe(400);
	});
});
