/** Closing review takeover must preserve its lease and any previously approved exact grant. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../d1-sqlite.js";
import { getOwnedApplication } from "../local-artifact/store.js";
import { syncApplyRun } from "./apply.js";
import { approveAndContinue } from "./approve-continue.js";
import { getSubmitAuthorization } from "./approval-store.js";
import { ensureFillHandoff, relayFillHandoff } from "./fill-handoff.js";
import { getApplyRun, insertApplyRun, updateApplyRun, getLocalApplyHandoffForRun, type ApplyRun, type ApplyRunPolicy } from "./store.js";
import { listSupervisorCheckpoints, receiveSupervisorCheckpoint } from "./supervision.js";

let d1: RealSchemaD1;
let env: Env;
let checkpoint: NonNullable<NonNullable<ApplyRun["pause"]>["checkpoint"]>;
let active: boolean;
let resumed: boolean;
let sent: Array<{ path: string; body: Record<string, unknown> }>;
const current = async () => (await getApplyRun(env, "ap", "u", "run"))!;

beforeEach(async () => {
	d1 = realSchemaD1(); seedTenant(d1, { userId: "u", instanceIds: ["ap", "t1"] });
	active = false; resumed = false; sent = [];
	const now = Date.now();
	checkpoint = { schemaVersion: 1, checkpointId: "review", facts: { phase: "before_submit", actions: 4, filled: 0, uploaded: 2, blockers: [], reviewWait: { expiresAt: now + 600_000, budgetMs: 600_000 } } };
	d1.exec(`INSERT INTO instance_runtime_nodes(instance_id,user_id,runner_node,endpoint_url,runner_version,status,last_seen_at) VALUES('ap','u','mac','relay://','0.4.231','online',datetime('now'))`);
	env = { DB: d1.DB, RELAY: { idFromName: (n: string) => n, get: () => ({ async fetch(req: Request) {
		if (new URL(req.url).pathname === "/status") return Response.json({ connected: true });
		const cmd = await req.json() as { path: string; body: string | Record<string, unknown> };
		const body = typeof cmd.body === "string" ? JSON.parse(cmd.body) : cmd.body;
		sent.push({ path: cmd.path, body });
		if (cmd.path === "/local-apply/status") return Response.json({ state: resumed ? "running" : "paused", pause: resumed ? null : { reason: "supervisor_checkpoint", checkpoint }, events: [], lastSeq: 0 });
		if (cmd.path === "/local-apply/handoff") active = true;
		if (cmd.path === "/local-apply/handoff/resume") active = false;
		if (cmd.path === "/local-apply/directive") {
			if (active) return Response.json({ error: "Close owner control first" }, { status: 409 });
			resumed = true;
		}
		return Response.json({ ok: true, state: "ready" });
	} }) } } as unknown as Env;
	await env.DB.prepare(`INSERT INTO job_applications(id,instance_id,user_id,source_instance_id,lead_id,lifecycle_version,idempotency_key,status,lead,resume_artifact,cover_letter_artifact,profile_version,created_at,updated_at,state_version,fill_run_id)
	 VALUES('app','t1','u','scout','lead',1,'app-key','awaiting_review',?1,?2,?3,'0123456789abcdef',?4,?4,4,'run')`).bind(JSON.stringify({ leadUrl: "https://jobs.example.com/role", lead: { title: "Engineer" } }), JSON.stringify({ kind: "resume", path: "~/resume.md", sha256: "a".repeat(64) }), JSON.stringify({ kind: "cover_letter", path: "~/cover.md", sha256: "b".repeat(64) }), now).run();
	const policy: ApplyRunPolicy = { engine: "claude", authMode: "auto", browserProfile: "default", mode: "fill_and_review", toolAccess: "full", allowDomains: ["jobs.example.com"], screenshots: false, limits: { maxMinutes: 20, maxPages: 30, maxActions: 200 }, gate: { allowed: false, gateId: null, checks: [] } };
	await insertApplyRun(env, { id: "run", instanceId: "ap", userId: "u", applicationId: "app", requestId: "request", policy, trace: [], now, runnerVersion: "0.4.231" });
	await updateApplyRun(env, await current(), { to: "running" }, now);
	await updateApplyRun(env, await current(), { to: "paused", pause: { reason: "supervisor_checkpoint", checkpoint } }, now);
	await receiveSupervisorCheckpoint(env, await current(), "u", { ...checkpoint, runnerSeq: 0 }, now);
});
afterEach(() => d1.close());

describe("live review takeover return", () => {
	it("opens already-paused review control and returns without ordinary resume or changing its lease", async () => {
		const opened = await ensureFillHandoff(env, "u", "ap", await current(), true);
		expect(opened.ready).toBe(true); expect(active).toBe(true);
		const out = await relayFillHandoff(env, "u", "ap", await current(), opened.handoff, "resume");
		expect(out).toMatchObject({ run: { status: "paused", pause: { checkpoint } } });
		expect(active).toBe(false);
		expect((await getLocalApplyHandoffForRun(env, "run", "ap", "u"))?.state).toBe("closed");
		expect(sent.some(s => ["/local-apply/resume", "/local-apply/owner-pause", "/local-apply/directive"].includes(s.path))).toBe(false);
		expect((await getOwnedApplication(env, "u", "app"))?.status).toBe("awaiting_review");
	});

	it("keeps approval consumed during takeover recoverable after control is returned", async () => {
		const opened = await ensureFillHandoff(env, "u", "ap", await current(), true);
		const approved = await approveAndContinue(env, "u", (await getOwnedApplication(env, "u", "app"))!, await current(), { idempotencyKey: "owner-review" }, Date.now());
		expect(approved.continuation).toMatchObject({ kind: "continued", delivered: false });
		expect(await getSubmitAuthorization(env, "app", "u")).toMatchObject({ id: approved.authorizationId, consumedRunId: "run" });
		const first = sent.find(s => s.path === "/local-apply/directive")!.body;
		await relayFillHandoff(env, "u", "ap", await current(), opened.handoff, "resume");
		expect((await current()).pause?.checkpoint).toEqual(checkpoint);
		expect(resumed).toBe(false);
		await syncApplyRun(env, "u", await current());
		expect((await listSupervisorCheckpoints(env, await current()))[0].directive?.deliveredAt).not.toBeNull();
		expect(sent.filter(s => s.path === "/local-apply/directive").map(s => s.body)).toEqual([first, first]);
		expect(sent.some(s => s.path === "/local-apply/resume")).toBe(false);
		expect(resumed).toBe(true);
	});
});
