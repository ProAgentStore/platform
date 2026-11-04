import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types.js";
import { realSchemaD1, type RealSchemaD1 } from "../d1-sqlite.js";
import { getOwnedApplication } from "../local-artifact/store.js";

const { runtimeCall } = vi.hoisted(() => ({ runtimeCall: vi.fn() }));
vi.mock("../../routes/instances-runtime.js", () => ({
	getLiveRuntime: async () => ({ runner_node: "mac", runner_version: "0.6.0", instance_id: "apply" }),
	callRuntime: runtimeCall,
	runtimeJson: (res: Response) => res.json(),
}));
const { ownerFillEvent, retryFill, startApplicationFill, syncActiveApplyRuns } = await import("./apply.js");

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
	gate(true);
});
afterEach(() => d1.close());

describe("application admission retry receipts (#1520)", () => {
	it.each(["owner", "connection"] as const)("%s overload explains who must retry without creating a run", async (source) => {
		const error = await startApplicationFill(env(), "apply", "owner", readyEvent, source).catch((e: unknown) => e);
		expect(error).toMatchObject({ status: 503 });
		const message = (error as Error).message;
		if (source === "owner") {
			expect(message).toContain("start it again once it has");
			expect(message).not.toContain("will retry automatically");
		} else expect(message).toContain("will retry automatically");
		expect((await runRows()).results).toEqual([]);
		expect((await application()).status).toBe("materials_ready");
		expect(runtimeCall).not.toHaveBeenCalled();
	});

	it("a refused owner retry stays ready until a new review request after recovery", async () => {
		gate(false);
		const first = await startApplicationFill(env(), "apply", "owner", readyEvent, "owner", { review: true });
		const firstId = first.run?.id;
		if (!firstId) throw new Error("Expected the initial fill run to start");
		d1.sqlite.prepare("UPDATE local_apply_runs SET status = 'blocked' WHERE id = ?").run(firstId);
		d1.exec("UPDATE job_applications SET status = 'blocked', block_reason = 'incomplete' WHERE id = 'application'");
		gate(true);
		runtimeCall.mockClear();
		await expect(retryFill(env(), "apply", "owner", await application())).rejects.toThrow("start it again once it has");
		const refused = await application();
		expect(refused).toMatchObject({ status: "materials_ready", fillRunId: firstId });
		expect((await runRows()).results).toEqual([{ id: firstId, status: "blocked" }]);
		gate(false);
		await syncActiveApplyRuns(env());
		expect(runtimeCall).not.toHaveBeenCalled();
		expect((await application()).status).toBe("materials_ready");
		const reviewed = await startApplicationFill(env(), "apply", "owner", ownerFillEvent(refused), "owner", { review: true });
		expect(reviewed.kind).toBe("started");
		expect(reviewed.run?.id).not.toBe(firstId);
		expect(reviewed.run?.policy.mode).toBe("fill_and_review");
		expect((await application()).status).toBe("filling");
		expect(runtimeCall).toHaveBeenCalledTimes(1);
	});
});
