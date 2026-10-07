/**
 * The Apply route's delivery half (#955): a retry after the outbox failed re-delivers the SAME
 * event — the outbox's idempotency key then collapses it — and no other write path emits one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => ({ ...(await vi.importActual<object>("../lib/auth.js")), requireUser: async () => ({ uid: "u1", roles: [] }) }));
vi.mock("./instances-runtime.js", () => ({ requireOwnedInstance: vi.fn(async () => undefined) }));
vi.mock("../lib/connections.js", () => ({ deliverEvent: vi.fn() }));

const { deliverEvent } = await import("../lib/connections.js");
const { registerJobLeadRoutes } = await import("./instances-job-leads.js");
const deliver = deliverEvent as unknown as Mock;

const EVENT = { eventType: "job.lead.apply_requested", eventId: "scout-1:lead-1:1", sourceInstanceId: "scout-1", leadId: "lead-1", leadUrl: "u", lifecycleVersion: 1, requestedAt: "t", lead: {} };

function app(doReplies: Array<Record<string, unknown>>) {
	const sent: Array<Record<string, unknown>> = [];
	const AGENT = {
		idFromName: (n: string) => n,
		get: () => ({
			fetch: async (req: Request) => {
				sent.push((await req.json()) as Record<string, unknown>);
				return Response.json(doReplies.shift() ?? {}, { status: 200 });
			},
		}),
	};
	const a = new Hono<{ Bindings: Env }>();
	const r = new Hono<{ Bindings: Env }>();
	registerJobLeadRoutes(r);
	a.route("/v1/instances", r);
	a.onError((e, c) => c.json({ error: String(e) }, 500));
	const call = () => a.request("/v1/instances/scout-1/job-leads/lead-1/triage", { method: "POST", body: JSON.stringify({ action: "apply", source_instance_id: "forged" }) }, { AGENT } as unknown as Env);
	return { call, sent };
}

beforeEach(() => deliver.mockReset());

describe("POST …/job-leads/:id/triage — the durable handoff (#955)", () => {
	it("a retry after the outbox failed re-delivers the same event under the same trace", async () => {
		// First click: the lead is written, then the outbox insert fails. Second: the DO answers
		// "already applied" with the stored handoff, and the route delivers that same event again.
		const { call } = app([{ transitioned: true, event: EVENT }, { transitioned: false, event: EVENT }]);
		deliver.mockRejectedValueOnce(new Error("D1 outbox write failed")).mockResolvedValueOnce({ delivered: 1 });
		expect((await call()).status).toBe(500);
		expect((await call()).status).toBe(200);
		expect(deliver).toHaveBeenCalledTimes(2);
		for (const c of deliver.mock.calls) {
			expect(c[4]).toEqual([EVENT]);
			expect(c[5]).toMatchObject({ traceId: "scout-1:lead-1:1" });
		}
	});

	it("names the source instance from the authenticated route, never from the body", async () => {
		const { call, sent } = app([{ transitioned: false, event: null }]);
		await call();
		expect(sent[0].source_instance_id).toBe("scout-1");
	});

	it("skip/defer/archive (no event) deliver nothing", async () => {
		const { call } = app([{ transitioned: true, event: null }]);
		await call();
		expect(deliver).not.toHaveBeenCalled();
	});
});

describe("no other write path emits job.lead.apply_requested (#955)", () => {
	it("only the triage route and the lifecycle module name the event — a record edit cannot start an application", () => {
		const root = join(__dirname, "..");
		const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && !/\.test\.ts$/.test(p) ? [p] : []; });
		const naming = walk(root).filter((f) => /JOB_LEAD_APPLY_EVENT|job\.lead\.apply_requested/.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length + 1)).sort();
		// The Application Tailor (#956) CONSUMES the event — it is the payload its connection action
		// receives — so it names it; it never emits it. Each consumer is listed, not pattern-matched.
		// The Applications control surface (#958) names it to FIND the Scout → Tailor connections; its
		// Apply goes through `runJobLeadTriage` in the triage route, which stays the only emitter below.
		const consumers = ["lib/applications/control.ts", "lib/local-artifact/contract.ts", "lib/local-artifact/tailor.ts", "lib/trigger-config.ts", "lib/triggers.ts", "routes/instances-application-tailor.ts"];
		const allowed = ["lib/job-lead-triage.ts", "routes/instances-job-leads.ts", ...consumers];
		expect(naming.filter((f) => !allowed.includes(f)), "a new place names the apply event — only the triage path may").toEqual([]);
		expect(naming).toContain("routes/instances-job-leads.ts");
		// Emitting it — handing it to the outbox — is the triage route's alone.
		const emits = walk(root).filter((f) => /deliverEvent\([^;]*?(JOB_LEAD_APPLY_EVENT|job\.lead\.apply_requested)/s.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length + 1));
		expect(emits).toEqual(["routes/instances-job-leads.ts"]);
		// The generic record routes (Data-tab edits, update_record) never reach the outbox.
		for (const f of ["routes/storage.ts", "agent-do-storage-routes.ts"]) {
			const src = readFileSync(join(root, f), "utf8");
			expect(src, f).not.toMatch(/deliverEvent|enqueueDelivery/);
		}
	});
});
