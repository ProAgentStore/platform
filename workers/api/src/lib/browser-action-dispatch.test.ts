import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { runApplyLoop } from "./apply-loop.js";
import type { Env } from "../types.js";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { BrowserActionUncertainError, dispatchBrowserActionOnce, requireSafeBrowserDispatch } from "./browser-action-dispatch.js";
import { mirroredRuntimeEvents, mirroredTaskEvents } from "../routes/instances-runtime.js";

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

	it("publishes a complete event envelope before dispatch without claiming the action succeeded", async () => {
		const expected = {
			id: "browser-action:task:s3-act",
			taskId: "task",
			type: "browser.action.claimed",
			message: "Browser action reserved; execution result is unverified.",
			data: { step: "s3-act", result: "unverified" },
			createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
		};
		await dispatchBrowserActionOnce(env, key, async () => {
			expect(await mirroredRuntimeEvents(env as Env, "instance", "owner")).toEqual([expected]);
			expect(await mirroredTaskEvents(env as Env, "instance", "owner", "task")).toEqual([expected]);
			return "clicked";
		});
		expect(await mirroredTaskEvents(env as Env, "instance", "owner", "task")).toEqual([expected]);
	});

	it.each(["dispatched", "unverified"])("repairs legacy %s claims without changing replay protection or unrelated events", async (result) => {
		const id = "browser-action:task:s3-act";
		const legacy = JSON.stringify({ step: key.step, result });
		const insert = d1.sqlite.prepare("INSERT INTO instance_runtime_task_events (id, instance_id, user_id, task_id, type, payload, created_at) VALUES (?, 'instance', 'owner', 'task', ?, ?, '2026-11-03 10:11:12')");
		insert.run(id, "browser.action.claimed", legacy);
		insert.run("unrelated", "agent.decision", legacy);
		insert.run("browser-action:malformed", "browser.action.claimed", "invalid JSON");
		await dispatchBrowserActionOnce(env, { ...key, step: "s4-act" }, async () => "ok");
		const stored = (eventId: string) => d1.sqlite.prepare("SELECT * FROM instance_runtime_task_events WHERE id = ?").get(eventId);
		const validBefore = stored("browser-action:task:s4-act");
		const migration = readFileSync(new URL("../../migrations/0316_browser_action_claim_envelopes.sql", import.meta.url), "utf8");
		d1.exec(migration);
		const repaired = (await mirroredTaskEvents(env as Env, "instance", "owner", "task")).find((event) => (event as { id?: string } | null)?.id === id);
		expect(repaired).toEqual({ id, taskId: "task", type: "browser.action.claimed", message: "Browser action reserved; execution result is unverified.", data: { step: key.step, result: "unverified" }, createdAt: "2026-11-03T10:11:12.000Z" });
		expect(stored("unrelated")).toMatchObject({ payload: legacy });
		expect(stored("browser-action:malformed")).toMatchObject({ payload: "invalid JSON" });
		expect(stored("browser-action:task:s4-act")).toEqual(validBefore);
		const once = stored(id);
		d1.exec(migration);
		expect(stored(id)).toEqual(once);
		const click = vi.fn();
		await expect(dispatchBrowserActionOnce(env, key, click)).rejects.toBeInstanceOf(BrowserActionUncertainError);
		expect(click).not.toHaveBeenCalled();
	});

	it("an uncertain Submit ends the real loop before the model can select it again under a new step", async () => {
		const decide = vi.fn(async () => ({ action: { action: "click" as const, name: "Submit", ref: "e1" } }));
		const click = vi.fn(async () => { throw new Error("response lost after click"); });
		await expect(runApplyLoop({
			snapshot: async () => ({ url: "https://test.invalid/apply", title: "Apply", snapshot: '- button "Submit" [ref=e1]', challenge: null }),
			decide,
			act: () => dispatchBrowserActionOnce(env, key, click),
		}, {})).rejects.toBeInstanceOf(BrowserActionUncertainError);
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
