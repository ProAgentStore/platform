import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runApplyLoop } from "./apply-loop.js";
import type { Env } from "../types.js";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { BrowserActionUncertainError, dispatchBrowserActionOnce, requireSafeBrowserDispatch } from "./browser-action-dispatch.js";

let d1: RealSchemaD1;
let env: Pick<Env, "DB">;
const key = { taskId: "task", instanceId: "instance", userId: "owner", step: "s3-act" };
describe("browser action dispatch is never replayed after an uncertain workflow step", () => {
	beforeEach(() => {
	d1 = realSchemaD1();
	env = { DB: d1.DB };
	d1.exec("INSERT INTO users(id, github_login) VALUES ('owner', 'owner')");
	d1.exec("INSERT INTO agents(id, owner_id, slug, name) VALUES ('agent', 'owner', 'test', 'Test')");
	d1.exec("INSERT INTO agent_instances(id, agent_id, user_id, status) VALUES ('instance', 'agent', 'owner', 'active')");
	d1.exec("INSERT INTO instance_runtime_tasks(id, instance_id, user_id, type, status, payload, created_at, updated_at) VALUES ('task', 'instance', 'owner', 'job.apply_agent', 'running', '{}', datetime('now'), datetime('now'))");
});
afterEach(() => d1.close());

	it("claims before the click; loss of its response cannot click again on a workflow retry", async () => {
		const click = vi.fn(async () => { throw new Error("response lost after Submit"); });
		await expect(dispatchBrowserActionOnce(env, key, click)).rejects.toBeInstanceOf(BrowserActionUncertainError);
		await expect(dispatchBrowserActionOnce(env, key, click)).rejects.toBeInstanceOf(BrowserActionUncertainError);
		expect(click).toHaveBeenCalledTimes(1);
	});

	it("does not repeat a completed click if the isolate died before its workflow journal write", async () => {
		const click = vi.fn(async () => ({ url: "https://test.invalid/thanks" }));
		await expect(dispatchBrowserActionOnce(env, key, click)).resolves.toMatchObject({ url: "https://test.invalid/thanks" });
		await expect(dispatchBrowserActionOnce(env, key, click)).rejects.toBeInstanceOf(BrowserActionUncertainError);
		expect(click).toHaveBeenCalledTimes(1);
	});

	it("an uncertain Submit ends the real loop before the model can select it again under a new step", async () => {
		const decide = vi.fn(async () => ({ action: { action: "click" as const, name: "Submit", ref: "e1" } }));
		const click = vi.fn(async () => { throw new Error("response lost after click"); });
		await expect(runApplyLoop({
			snapshot: async () => ({ url: "https://test.invalid/apply", title: "Apply", snapshot: '- button "Submit" [ref=e1]', challenge: null }),
			decide,
			act: () => dispatchBrowserActionOnce(env, key, click),
		}, { url: "https://test.invalid/apply", resumePath: "resume.pdf", candidate: { fullName: "Test User", email: "test@example.invalid" } })).rejects.toBeInstanceOf(BrowserActionUncertainError);
		expect(decide).toHaveBeenCalledTimes(1);
		expect(click).toHaveBeenCalledTimes(1);
	});

	it("only one simultaneous dispatcher reaches the browser", async () => {
		const click = vi.fn(async () => "clicked");
		const outcomes = await Promise.allSettled([dispatchBrowserActionOnce(env, key, click), dispatchBrowserActionOnce(env, key, click)]);
		expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(click).toHaveBeenCalledTimes(1);
	});

	it.each([{ userId: "wrong" }, { instanceId: "wrong" }, { taskId: "missing" }])("refuses a foreign or missing task %j", async (override) => {
		const click = vi.fn();
		await expect(dispatchBrowserActionOnce(env, { ...key, ...override }, click)).rejects.toThrow(/no action was dispatched/);
		expect(click).not.toHaveBeenCalled();
	});

	it("refuses an already cancelled task before any browser action", async () => {
		d1.exec("UPDATE instance_runtime_tasks SET status = 'cancelled'");
		const click = vi.fn();
		await expect(dispatchBrowserActionOnce(env, key, click)).rejects.toThrow(/no action was dispatched/);
		expect(click).not.toHaveBeenCalled();
	});
});


describe("runner dispatch capability receipt", () => {
	it.each([undefined, {}, { commitGuard: {} }, { commitGuard: { supported: true, dispatchSafe: undefined } }, { commitGuard: { dispatchSafe: false } }])("refuses an absent or old dispatch gate %j", (receipt) => {
		expect(() => requireSafeBrowserDispatch(receipt)).toThrow(/0.4.200/);
	});
	it("accepts the runner's explicit dispatch-time safety receipt", () => {
		expect(() => requireSafeBrowserDispatch({ commitGuard: { dispatchSafe: true } })).not.toThrow();
	});
});
