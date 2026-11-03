import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { closeFailedBrowserTask, markBrowserTaskResumed } from "./browser-task-close.js";

let d1: RealSchemaD1;
const key = { taskId: "task", instanceId: "instance", userId: "owner" };
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users(id, github_login) VALUES ('owner', 'owner')");
	d1.exec("INSERT INTO agents(id, owner_id, slug, name) VALUES ('agent', 'owner', 'test', 'Test')");
	d1.exec("INSERT INTO agent_instances(id, agent_id, user_id, status) VALUES ('instance', 'agent', 'owner', 'active')");
	d1.exec(`INSERT INTO instance_runtime_tasks(id, instance_id, user_id, type, status, payload, created_at, updated_at) VALUES ('task', 'instance', 'owner', 'job.apply_agent', 'running', '{"status":"running","input":{"url":"https://test.invalid"}}', datetime('now'), datetime('now'))`);
});
afterEach(() => d1.close());
const row = () => d1.DB.prepare("SELECT status, payload FROM instance_runtime_tasks WHERE id = 'task'").first<{ status: string; payload: string }>();

describe("workflow failure releases the durable task without requiring its runner", () => {
	it("closes both the single-flight status and the board payload after a disconnect", async () => {
		await closeFailedBrowserTask({ DB: d1.DB }, key, "Action outcome is unknown; inspect the site.");
		const task = await row();
		expect(task?.status).toBe("failed");
		expect(JSON.parse(task!.payload)).toMatchObject({ status: "failed", completedAt: expect.any(String), input: { url: "https://test.invalid" } });
	});
	it("does not overwrite a concurrent owner cancellation", async () => {
		d1.exec("UPDATE instance_runtime_tasks SET status = 'cancelled', payload = '{\"status\":\"cancelled\"}'");
		await closeFailedBrowserTask({ DB: d1.DB }, key, "failure");
		expect(await row()).toMatchObject({ status: "cancelled", payload: '{"status":"cancelled"}' });
	});
	it("cannot close another owner's task", async () => {
		await closeFailedBrowserTask({ DB: d1.DB }, { ...key, userId: "other" }, "failure");
		expect((await row())?.status).toBe("running");
	});
});


describe("confirmed browser resume updates the mirror without reviving a stopped task", () => {
	it("moves a needs_human mirror and its card payload back to running", async () => {
		d1.exec("UPDATE instance_runtime_tasks SET status = 'needs_human', payload = '{\"status\":\"needs_human\"}'");
		await markBrowserTaskResumed({ DB: d1.DB }, key);
		expect((await row())?.status).toBe("running");
		expect(JSON.parse((await row())!.payload)).toMatchObject({ status: "running" });
	});
	it.each(["cancelled", "completed", "pending_approval"])("does not revive %s", async (status) => {
		d1.DB.prepare("UPDATE instance_runtime_tasks SET status = ?1").bind(status).run();
		await expect(markBrowserTaskResumed({ DB: d1.DB }, key)).rejects.toThrow(/cannot resume/);
		expect((await row())?.status).toBe(status);
	});
});
