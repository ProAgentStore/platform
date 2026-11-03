import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayMutationAdmission } from "../../cli/src/commands/runner/auto-update-controller.js";
import { readWorkLook } from "../../cli/src/commands/runner/runner-work-observation.js";
import { planRunnerRestart, planRunnerUpdate } from "../../cli/src/commands/runner/self-update.js";
import { createInstallBridge, PolicyCell } from "../../cli/src/commands/runner/update-bridge.js";
import { CloneJobs, liveCloneDeps } from "./coding/repo-clone-job.js";
import { startRunnerServer } from "./server.js";

const headers = { Authorization: "Bearer fixture-token", "X-PAGS-Instance-Id": "inst-clone", "Content-Type": "application/json" };
afterEach(() => vi.restoreAllMocks());

describe("background clones remain visible to safe restart admission (#1458)", () => {
	it.each(["done", "failed"] as const)("a replied clone-start blocks health/update/restart until the clone is %s", async (terminal) => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pags-clone-work-")));
		let finish!: () => void;
		let fail!: (error: Error) => void;
		vi.spyOn(liveCloneDeps, "clone").mockImplementation(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
		const server = await startRunnerServer({ host: "127.0.0.1", port: 0, dataDir: dir, token: "fixture-token", instanceId: "inst-clone", headless: true });
		const path = join(dir, "repos", "private-owner-folder");
		const read = async (route: string) => {
			const response = await fetch(`${server.url}${route}`, { headers });
			expect(response.status).toBe(200);
			return response.json();
		};
		const facts = async () => {
			const sessions = await read("/coding/sessions"), health = await read("/health");
			return { current: "0.4.90", latest: "0.4.91", fromSource: false, restarter: "pags-up" as const, ...readWorkLook({ status: "fulfilled", value: sessions }, { status: "fulfilled", value: health }, Date.now()) };
		};
		try {
			// Installation can have been admitted before the clone started; its final work check must still hold.
			const before = planRunnerUpdate(await facts());
			expect(before.action).toBe("update");
			if (before.action !== "update") throw new Error("fixture was not idle");
			const started = await fetch(`${server.url}/coding/clone-start`, { method: "POST", headers, body: JSON.stringify({ workDir: path, slug: "private-owner/private-repo", protocol: "https" }) });
			expect(started.status).toBe(200);
			expect(await started.json()).toMatchObject({ state: "cloning" });
			// The request is fully answered, but the async transport has not completed.
			const { work } = await read("/health");
			expect(work).toEqual({ codingTurns: 0, localRuns: 1, detail: ["repository-clone-1"] });
			expect(JSON.stringify(work)).not.toContain(path);
			expect(JSON.stringify(work)).not.toContain("private-owner");
			const active = await facts();
			expect(planRunnerUpdate(active)).toMatchObject({ action: "wait", waitingFor: ["repository-clone-1"] });
			expect(planRunnerRestart({ ...active, force: false })).toMatchObject({ action: "refused", waitingFor: ["repository-clone-1"] });
			expect(planRunnerRestart({ ...active, force: true }).action).toBe("restart");
			const install = vi.fn(async () => undefined), activate = vi.fn(), detachAll = vi.fn();
			const bridge = createInstallBridge({ cell: new PolicyCell({ autoUpdate: false }, () => undefined), refresh: async () => false, facts, install, activate, detachAll, admission: new RelayMutationAdmission(), leaseActive: () => true, log: () => undefined, settle: async () => undefined });
			expect(await bridge.run(before)).toMatchObject({ kind: "work-active", waitingFor: ["repository-clone-1"] });
			expect(activate).not.toHaveBeenCalled();
			expect(detachAll).not.toHaveBeenCalled();
			if (terminal === "done") finish(); else fail(new Error("fixture clone rejected"));
			await vi.waitFor(() => expect(server.runner.coding.cloneStatus({ workDir: path }).state).toBe(terminal));
			expect((await read("/health")).work).toEqual({ codingTurns: 0, localRuns: 0, detail: [] });
			expect((await facts()).busy).toEqual([]);
			expect(await bridge.run(before)).toEqual({ kind: "restarting" });
			expect(install).toHaveBeenCalledTimes(1);
			expect(activate).toHaveBeenCalledTimes(1);
		} finally {
			finish?.();
			await server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("joining a clone counts it once and completing one job leaves other active clones visible", async () => {
		const finishes: Array<() => void> = [];
		const jobs = new CloneJobs({ clone: () => new Promise<void>((resolve) => finishes.push(resolve)), sshIdentity: () => null, now: () => 1 });
		jobs.start("/private/one", "fixture/one", "https");
		jobs.start("/private/one", "fixture/one", "https");
		jobs.start("/private/two", "fixture/two", "https");
		expect(jobs.liveWork()).toEqual(["repository-clone-1", "repository-clone-2"]);
		finishes[0]();
		await vi.waitFor(() => expect(jobs.liveWork()).toEqual(["repository-clone-1"]));
		finishes[1]();
		await vi.waitFor(() => expect(jobs.liveWork()).toEqual([]));
	});
});
