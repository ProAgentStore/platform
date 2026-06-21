import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalRunner, normalizeJobApplicationInput } from "./runner.js";
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
		expect(runner.capabilities().taskTypes).toContain("job.apply_basic");
		expect(runner.capabilities().approvalRequiredFor).toContain("job.apply_basic");
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

	it("requires approval for basic job application tasks", () => {
		const resumePath = join(dir, "resume.txt");
		writeFileSync(resumePath, "Resume body");
		const task = runner.createTask({
			type: "job.apply_basic",
			input: {
				url: "https://example.com/jobs/1",
				resumePath,
				candidate: {
					fullName: "Sam Candidate",
					email: "sam@example.com",
				},
			},
		});

		expect(task.status).toBe("needs_approval");
		expect(task.requiresApproval).toBe(true);
	});

	it("validates basic job application input", () => {
		const resumePath = join(dir, "resume.txt");
		writeFileSync(resumePath, "Resume body");

		expect(normalizeJobApplicationInput({
			url: "https://example.com/jobs/1",
			resumePath,
			candidate: {
				fullName: " Sam Candidate ",
				email: " sam@example.com ",
				phone: " +1 555 0100 ",
			},
			coverNote: " Interested ",
		})).toMatchObject({
			url: "https://example.com/jobs/1",
			resumePath,
			candidate: {
				fullName: "Sam Candidate",
				email: "sam@example.com",
				phone: "+1 555 0100",
			},
			coverNote: "Interested",
		});

		expect(() => normalizeJobApplicationInput({
			url: "ftp://example.com/jobs/1",
			resumePath,
			candidate: { fullName: "Sam", email: "sam@example.com" },
		})).toThrow("http");
		expect(() => normalizeJobApplicationInput({
			url: "https://example.com/jobs/1",
			resumePath: join(dir, "missing.txt"),
			candidate: { fullName: "Sam", email: "sam@example.com" },
		})).toThrow("resumePath");
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
