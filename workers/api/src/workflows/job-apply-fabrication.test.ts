/** #643/#915: exercise the actual workflow action closure, not its TypeScript spelling. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ApplyDeps, ApplyJob } from "../lib/apply-loop.js";
import type { Env } from "../types.js";

const { callRunner, driveLoop } = vi.hoisted(() => ({ callRunner: vi.fn(), driveLoop: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class { constructor(_ctx: unknown, public env: unknown) {} } }));
vi.mock("../lib/runner-client.js", async (original) => ({ ...await original<typeof import("../lib/runner-client.js")>(), callRunner, getBoundRunnerConn: async () => ({ instanceId: "instance", userId: "owner" }) }));
vi.mock("../lib/apply-loop.js", async (original) => ({ ...await original<typeof import("../lib/apply-loop.js")>(), runApplyLoop: driveLoop }));

import { JobApplyWorkflow, type JobApplyParams } from "./job-apply.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";

let db: RealSchemaD1;
const job: ApplyJob = { url: "https://jobs.example.com/apply", candidate: { fullName: "Candidate", email: "candidate@example.com", phone: "+61 412 345 678" } };
beforeEach(() => {
	vi.clearAllMocks();
	db = realSchemaD1();
	seedTenant(db, { userId: "owner", instanceIds: ["instance"] });
	db.exec("INSERT INTO instance_runtime_tasks(id,instance_id,user_id,type,status,payload,created_at,updated_at) VALUES ('task','instance','owner','job.apply_agent','running','{}',datetime('now'),datetime('now'))");
	callRunner.mockImplementation(async (_conn, path) => path === "/browser/snapshot" ? { url: job.url, snapshot: '- textbox "Phone" [ref=e1]', challenge: null } : { url: job.url, challenge: null, commitGuard: { supported: true, dispatchSafe: true } });
});
afterEach(() => db.close());

async function run(dryRun: boolean) {
	const env = { DB: db.DB } as Env;
	const workflow = new JobApplyWorkflow({} as ExecutionContext, env);
	const step = { do: async (_name: string, a: unknown, b?: unknown) => ((typeof a === "function" ? a : b) as () => Promise<unknown>)(), sleep: async () => undefined } as unknown as WorkflowStep;
	return workflow.run({ payload: { instanceId: "instance", userId: "owner", taskId: "task", job: { ...job, dryRun }, screenshots: false } } as WorkflowEvent<JobApplyParams>, step);
}

describe("job application guard before runner dispatch", () => {
	it.each([false, true])("refuses and logs a fabricated phone without correcting or dispatching it (dryRun=%s)", async (dryRun) => {
		const action = { action: "type" as const, role: "textbox", name: "Question", ref: "e1", text: "0498765432" };
		let receipt: unknown;
		driveLoop.mockImplementation(async (deps: ApplyDeps) => {
			await deps.snapshot();
			receipt = await deps.act(action);
			return { outcome: "ready", detail: "Guard checked", steps: 1 };
		});
		expect(await run(dryRun)).toMatchObject({ outcome: "ready" });
		expect(receipt).toMatchObject({ error: expect.stringMatching(/REFUSED/) });
		expect(action.text).toBe("0498765432");
		expect(callRunner.mock.calls.filter(([, path, body]) => path === "/browser/act" && body.action !== "navigate")).toHaveLength(0);
		expect(await db.DB.prepare("SELECT event,level FROM agent_events WHERE event='apply.unsourced_value'").all()).toMatchObject({ results: [{ event: "apply.unsourced_value", level: "warn" }] });
	});
	it("passes an owner-sourced phone through unchanged in a real application", async () => {
		const action = { action: "type" as const, role: "textbox", name: "Phone", ref: "e1", text: "0412345678" };
		driveLoop.mockImplementation(async (deps: ApplyDeps) => {
			await deps.snapshot();
			await deps.act(action);
			return { outcome: "ready", detail: "Guard checked", steps: 1 };
		});
		expect(await run(false)).toMatchObject({ outcome: "ready" });
		const dispatched = callRunner.mock.calls.filter(([, path, body]) => path === "/browser/act" && body.action === "type");
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0][2]).toMatchObject(action);
		expect(await db.DB.prepare("SELECT count(*) AS n FROM agent_events WHERE event='apply.unsourced_value'").first()).toEqual({ n: 0 });
	});
});
