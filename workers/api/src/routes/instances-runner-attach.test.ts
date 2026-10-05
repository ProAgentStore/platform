import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRMATION_WINDOW_MS } from "../lib/confirmation-window.js";
import { registerRunnerAttachRoutes, registerRunnerPinRoutes } from "./instances-runner-attach.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", () => ({ requireUser: async () => ({ uid: "u1" }), HttpError: Error }));
vi.mock("./instances-runtime.js", () => ({ requireOwnedInstance: async () => ({}) }));
const { attachAgentOnNode, attachOnRepin, setRunnerNodePin } = vi.hoisted(() => ({
	attachAgentOnNode: vi.fn(),
	attachOnRepin: vi.fn(),
	setRunnerNodePin: vi.fn(),
}));
vi.mock("../lib/runner-node-pin.js", () => ({ setRunnerNodePin: (...a: unknown[]) => setRunnerNodePin(...a) }));
vi.mock("../lib/runner-repin.js", () => ({
	attachAgentOnNode: (...a: unknown[]) => attachAgentOnNode(...a),
	attachOnRepin: (...a: unknown[]) => attachOnRepin(...a),
}));

beforeEach(() => {
	setRunnerNodePin.mockReset().mockResolvedValue({ to: "laptop" });
	// A machine that never answers: only the confirmation window can end the request.
	attachAgentOnNode.mockReset().mockImplementation(() => new Promise(() => {}));
	attachOnRepin.mockReset().mockImplementation(() => new Promise(() => {}));
});

function app() {
	const a = new Hono<{ Bindings: Env }>();
	registerRunnerPinRoutes(a);
	registerRunnerAttachRoutes(a);
	return a;
}
const request = (method: string, path: string) =>
	app().request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runnerNode: "laptop" }) }, {} as Env, { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} });

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

/**
 * An attach that THROWS after the pin is saved is a pin move that may well have landed (#885). It
 * answered 500, and the caller told its user the move had failed while the pin was saved — so it
 * gets the slow machine's shape, with the reason.
 */
describe("a thrown attach is reported as unconfirmed, never as a failed request (#885)", () => {
	it.each([
		["PUT", "/inst/runner-node", attachOnRepin, /pin to laptop is saved/],
		["POST", "/inst/runner-attach", attachAgentOnNode, /attach request on laptop could not be confirmed/],
	] as const)("%s %s", async (method, path, attach, detail) => {
		attach.mockImplementation(async () => {
			throw new Error("relay DO fetch failed");
		});
		const res = await request(method, path);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		const attachment = (body.attachment ?? body) as Record<string, unknown>;
		expect(attachment).toMatchObject({ node: "laptop", attached: false, unconfirmed: true, error: "relay DO fetch failed" });
		expect(attachment.detail).toMatch(detail);
		expect(attachment.detail).toMatch(/instance_runner_node/);
		if (method === "PUT") expect(body.runnerNode).toBe("laptop");
	});

	it("still fails a pin that was never saved — with its own reason, not as unconfirmed", async () => {
		setRunnerNodePin.mockRejectedValue(new Error("Unknown machine name"));
		const res = await request("PUT", "/inst/runner-node");
		expect(res.status).toBe(500);
		expect(attachOnRepin).not.toHaveBeenCalled();
	});

	it("passes a confirmed attach through untouched", async () => {
		attachOnRepin.mockResolvedValue({ node: "laptop", attached: true, detachedFrom: ["desk"], stillAttachedOn: [] });
		const body = (await (await request("PUT", "/inst/runner-node")).json()) as { attachment: Record<string, unknown> };
		expect(body.attachment).toEqual({ node: "laptop", attached: true, detachedFrom: ["desk"], stillAttachedOn: [] });
	});
});
