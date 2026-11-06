import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types.js";
import { realSchemaD1, type RealSchemaD1 } from "../d1-sqlite.js";
import { pdfDocumentRunnerProblem } from "./pdf-document-runner.js";
import { getOwnedApplication } from "../local-artifact/store.js";

const { runtimeCall, runtimeState } = vi.hoisted(() => ({ runtimeCall: vi.fn(), runtimeState: { version: "0.4.228" as string | null | undefined } }));
vi.mock("../../routes/instances-runtime.js", () => ({
	getLiveRuntime: async () => ({ runner_node: "mac", runner_version: runtimeState.version, instance_id: "apply" }),
	callRuntime: runtimeCall,
	runtimeJson: (res: Response) => res.json(),
}));
const { startApplicationFill, dispatchNextQueuedFill } = await import("./apply.js");

let d1: RealSchemaD1;
const readyEvent = { eventId: "ready-event", applicationId: "application", tailorInstanceId: "tailor" };
const env = () => ({
	DB: d1.DB,
	AGENT: { idFromName: (id: string) => id, get: () => ({ fetch: async () => Response.json({ memory: [] }) }) },
}) as unknown as Env;
const application = async () => {
	const app = await getOwnedApplication(env(), "owner", "application");
	if (!app) throw new Error("Missing test application");
	return app;
};
const runRows = () => d1.DB.prepare("SELECT id, status FROM local_apply_runs").all();
function gate(reject: boolean) {
	const state = reject ? { state: "rejecting", metric: "cpu", value: 3.1, threshold: 2.5, streak: 0, since: 1 } : { state: "accepting", streak: 2 };
	d1.sqlite.prepare("UPDATE instance_runtime_nodes SET gate_state = ? WHERE instance_id = 'apply'").run(JSON.stringify(state));
}

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users(id, github_login) VALUES ('owner', 'owner');
	INSERT INTO agents(id, owner_id, slug, name, config) VALUES
	 ('tailor-agent','owner','tailor','Tailor','{"capabilities":{"runtime":"local_artifact","surfaces":[]}}'),
	 ('apply-agent','owner','apply','Apply','{"capabilities":{"runtime":"local_apply","surfaces":[]}}');
	INSERT INTO agent_instances(id, agent_id, user_id, status, config) VALUES
	 ('tailor','tailor-agent','owner','active','{}'), ('apply','apply-agent','owner','active','{}');
	INSERT INTO instance_runtime_nodes(instance_id,user_id,runner_node,endpoint_url,runner_version,status,last_seen_at)
	 VALUES ('apply','owner','mac','relay://','0.6.0','online',datetime('now'));
	INSERT INTO job_applications(id,instance_id,user_id,source_instance_id,lead_id,lifecycle_version,idempotency_key,status,lead,resume_artifact,cover_letter_artifact,profile_version,ready_event,created_at,updated_at)
	 VALUES ('application','tailor','owner','scout','lead',1,'request','materials_ready',
	 '{"leadUrl":"https://jobs.example.test/job","lead":{"title":"Engineer"}}',
	 '{"kind":"resume","path":"~/jobs/resume.md","sha256":"${"a".repeat(64)}","bytes":9}',
	 '{"kind":"cover_letter","path":"~/jobs/cover-letter.md","sha256":"${"b".repeat(64)}","bytes":9}',
	 'profile-version','${JSON.stringify(readyEvent)}',1,1);`);
	runtimeCall.mockReset();
	runtimeCall.mockImplementation(async () => Response.json({ status: "running" }, { status: 202 }));
	runtimeState.version = "0.4.228";
	gate(false);
});
afterEach(() => d1.close());

describe("PDF upload runner compatibility (#1570)", () => {
	it.each([null, undefined, "", "invalid", "0.4.227", "0.4.228garbage", "0.4.228.1", "0.4.228-beta"])("refuses unsupported or malformed version %s before any application/browser dispatch", async version => {
		expect(pdfDocumentRunnerProblem(version)).toContain("0.4.228");
		runtimeState.version = version;
		await expect(startApplicationFill(env(), "apply", "owner", readyEvent, "owner")).rejects.toMatchObject({ status: 409 });
		expect((await application()).status).toBe("materials_ready");
		expect((await runRows()).results).toEqual([]);
		expect(runtimeCall).not.toHaveBeenCalled();
	});

	it.each(["0.4.228", "0.4.229", "0.5.0"])("accepts PDF-capable CLI %s without granting submission permission", async version => {
		expect(pdfDocumentRunnerProblem(version)).toBeNull();
		runtimeState.version = version;
		const started = await startApplicationFill(env(), "apply", "owner", readyEvent, "owner");
		expect(started.kind).toBe("started");
		expect(started.run?.policy.mode).toBe("fill_and_review");
		expect(runtimeCall).toHaveBeenCalledTimes(1);
	});

	it.each(["0.4.227", null, "0.4.228garbage"])("holds queued work on %s until a supporting runner returns", async version => {
		runtimeCall.mockImplementationOnce(async () => Response.json({ error: "This machine is already filling 1 application(s) for this agent (limit 1)." }, { status: 409 }));
		const started = await startApplicationFill(env(), "apply", "owner", readyEvent, "owner");
		expect(started.run?.status).toBe("queued");
		runtimeCall.mockClear();
		runtimeState.version = version;
		d1.exec("UPDATE local_apply_runs SET next_attempt_at = 0 WHERE status = 'queued'");
		expect(await dispatchNextQueuedFill(env(), "apply", "owner")).toBe("queued");
		expect(runtimeCall).not.toHaveBeenCalled();
		expect((await runRows()).results).toEqual([{ id: started.run?.id, status: "queued" }]);
		if (version) expect((await d1.DB.prepare("SELECT queued_reason FROM local_apply_runs").first<{ queued_reason: string }>())?.queued_reason).toContain("PDF");
		runtimeState.version = "0.4.228";
		d1.exec("UPDATE local_apply_runs SET next_attempt_at = 0 WHERE status = 'queued'");
		expect(await dispatchNextQueuedFill(env(), "apply", "owner")).toBe("dispatched");
		expect(runtimeCall).toHaveBeenCalledTimes(1);
		expect((await runRows()).results).toEqual([{ id: started.run?.id, status: "running" }]);
	});
});
