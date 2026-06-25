import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalRunner } from "./runner.js";
import { RunnerStore } from "./store.js";

describe("LocalRunner", () => {
	let dir: string;
	let runner: LocalRunner;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-runner-"));
		runner = new LocalRunner({
			host: "127.0.0.1",
			port: 0,
			dataDir: dir,
			headless: true,
		});
	});

	afterEach(async () => {
		await runner.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("advertises FAGS runtime placement, PAGS control plane, and local capabilities", () => {
		expect(runner.capabilities()).toMatchObject({
			runtime: "fags-browser-runtime",
			brainPlacement: "pags",
			controlPlane: "pags",
			runtimePlane: "fags",
			runnerRole: "tool-executor",
		});
		expect(runner.capabilities().capabilities).toContain("browser.playwright");
		expect(runner.capabilities().taskTypes).toContain("job.apply_agent");
	});

	it("runs echo tasks without approval", async () => {
		const task = runner.createTask({
			type: "echo",
			input: { ok: true },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		const saved = runner.store.getTask(task.id);
		expect(saved?.status).toBe("completed");
		expect(saved?.output).toEqual({ ok: true });
	});

	it("records task lifecycle history", async () => {
		const task = runner.createTask({
			type: "echo",
			input: { history: true },
		});
		await new Promise((resolve) => setTimeout(resolve, 20));

		const events = runner.store
			.listEvents()
			.filter((event) => event.taskId === task.id)
			.map((event) => event.type);
		expect(events).toContain("task.created");
		expect(events).toContain("task.running");
		expect(events).toContain("task.completed");
	});

	it("holds approval-gated tasks until approved", async () => {
		const task = runner.createTask({
			type: "echo",
			input: { approved: true },
			requiresApproval: true,
			approvalPrompt: "Approve echo",
		});
		expect(task.status).toBe("needs_approval");
		expect(runner.store.getTask(task.id)?.status).toBe("needs_approval");
		const approved = await runner.approveTask(task.id);
		expect(approved.status).toBe("completed");
		expect(approved.output).toEqual({ approved: true });
	});

	it("requires approval for browser.open tasks", () => {
		const task = runner.createTask({
			type: "browser.open",
			input: { url: "https://example.com" },
		});
		expect(task.status).toBe("needs_approval");
		expect(task.requiresApproval).toBe(true);
	});

	it("does not share empty store arrays across fresh data directories", () => {
		const otherDir = mkdtempSync(join(tmpdir(), "pags-runner-other-"));
		try {
			const first = new RunnerStore(dir);
			const second = new RunnerStore(otherDir);
			first.createSession();
			expect(second.listSessions()).toEqual([]);
		} finally {
			rmSync(otherDir, { recursive: true, force: true });
		}
	});
});
