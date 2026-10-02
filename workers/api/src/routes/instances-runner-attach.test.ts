import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIRMATION_WINDOW_MS } from "../lib/confirmation-window.js";
import { registerRunnerAttachRoutes, registerRunnerPinRoutes } from "./instances-runner-attach.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", () => ({ requireUser: async () => ({ uid: "u1" }), HttpError: Error }));
vi.mock("./instances-runtime.js", () => ({ requireOwnedInstance: async () => ({}) }));
vi.mock("../lib/runner-node-pin.js", () => ({ setRunnerNodePin: async () => ({ to: "laptop" }) }));
vi.mock("../lib/runner-repin.js", () => ({
	attachAgentOnNode: () => new Promise(() => {}),
	attachOnRepin: () => new Promise(() => {}),
}));

/** A live machine can complete after the API's confirmation window. Unknown counts are omitted. */
describe("attachment confirmation deadlines (#887)", () => {
	afterEach(() => vi.useRealTimers());
	it.each([ ["POST", "/inst/runner-attach"], ["PUT", "/inst/runner-node"] ])("%s %s does not invent eviction or detach counts", async (method, path) => {
		vi.useFakeTimers();
		const app = new Hono<{ Bindings: Env }>();
		registerRunnerPinRoutes(app);
		registerRunnerAttachRoutes(app);
		const response = app.request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runnerNode: "laptop" }) }, {} as Env, { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} });
		await vi.advanceTimersByTimeAsync(CONFIRMATION_WINDOW_MS);
		const res = await response;
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		const attachment = (body.attachment ?? body) as Record<string, unknown>;
		expect(attachment).toMatchObject({ unconfirmed: true, attached: false });
		expect(attachment.detail).toMatch(/instance_runner_node/);
		for (const field of ["evicted", "detachedFrom", "stillAttachedOn"]) expect(attachment).not.toHaveProperty(field);
		if (method === "PUT") expect(body.runnerNode).toBe("laptop");
	});
});
