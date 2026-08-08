import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

	it("advertises PAGS runtime placement, PAGS control plane, and local capabilities", () => {
		expect(runner.capabilities()).toMatchObject({
			runtime: "pags-browser-runtime",
			brainPlacement: "pags",
			controlPlane: "pags",
			runtimePlane: "pags",
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

	it("treats browser.task as agent-driven (running, not auto-run)", () => {
		// The generic browser workflow steers this via /browser/*; the runner must NOT
		// auto-execute it (no runTask) — it lands 'running' like job.apply_agent.
		const task = runner.createTask({
			type: "browser.task",
			input: { url: "https://example.com/x", objective: "do the thing" },
		});
		expect(task.status).toBe("running");
		expect(task.requiresApproval).toBe(false);
		expect(runner.store.getTask(task.id)?.status).toBe("running");
	});

	/**
	 * #425 — the automation browser must never prompt for the microphone, and must never be able
	 * to reach the real one.
	 *
	 * Nothing in this package uses audio: it navigates to job/ATS pages, and the console where
	 * voice actually runs is a different browser. So a media prompt from here is pure noise — a
	 * third-party site asking for something no part of the product needs — and answering it is
	 * policy rather than a workaround.
	 *
	 * The PAIRING is the whole point, and it is why this is asserted rather than left to the
	 * comment beside it: `--use-fake-ui-for-media-stream` ALONE auto-**grants** the real microphone
	 * to whatever page asked, which is strictly worse than the prompt it removes. Read from the
	 * source rather than by launching Chrome, so it costs nothing and still fails if someone tidies
	 * one of the two flags away.
	 */
	it("never lets an automated page prompt for, or reach, the real microphone", () => {
		const src = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
		const args = src.slice(src.indexOf("const baseOpts"), src.indexOf("const preferChrome"));
		expect(args.length, "the launch options moved — this guard is looking at nothing").toBeGreaterThan(0);
		expect(args, "an automated page can still raise a microphone prompt (#425)").toContain("--use-fake-ui-for-media-stream");
		expect(args, "the prompt is auto-answered but the page gets the REAL microphone — strictly worse than prompting (#425)").toContain("--use-fake-device-for-media-stream");
		// The inverse, stated so the pair cannot be half-removed: nothing here may hand out a real
		// media grant. `grantPermissions(['microphone'])` was considered and rejected for exactly
		// the reason above.
		expect(src, "the runner grants a real media permission to pages it drives (#425)").not.toMatch(/grantPermissions\([^)]*(microphone|camera)/);
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
