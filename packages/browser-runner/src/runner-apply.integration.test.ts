import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalRunner } from "./runner.js";
import { startTestJobServer, type TestJobServer } from "./test-job-server.js";

/**
 * End-to-end apply path: drive the real LocalRunner (headless Chromium) against
 * the local test job server and assert the form was filled, the résumé uploaded,
 * and the application actually submitted (server recorded it). Guards the
 * fill → upload → submit success path that real ATS forms depend on.
 */
describe("LocalRunner job.apply_basic e2e", () => {
	let dir: string;
	let runner: LocalRunner;
	let server: TestJobServer;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "pags-apply-"));
		runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: dir, headless: true });
		server = await startTestJobServer(0);
	});

	afterEach(async () => {
		await runner.close();
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function resume(): string {
		const resumePath = join(dir, "resume.pdf");
		writeFileSync(resumePath, "%PDF-1.4\nfake resume body");
		return resumePath;
	}

	it("fills the form, uploads the résumé, and actually submits", async () => {
		const task = runner.createTask({
			type: "job.apply_basic",
			input: {
				url: server.jobUrl,
				resumePath: resume(),
				candidate: {
					fullName: "Test Candidate",
					email: "test@example.com",
					phone: "+61400000000",
					// must match one of the fixture's required <select> options
					workAuthorization: "Authorized to work in the United States",
				},
				coverNote: "Excited to apply.",
			},
		});

		const done = await runner.approveTask(task.id);

		expect(done.status).toBe("completed");
		expect(server.submissions.length).toBe(1);
		const sub = server.submissions[0];
		expect(sub.fields.fullName).toBe("Test Candidate");
		expect(sub.fields.email).toBe("test@example.com");
		expect(sub.resume?.filename).toContain("resume");
		expect(sub.resume?.size).toBeGreaterThan(0);
	}, 60_000);

	it("fails honestly (no false success) when a required field can't be filled", async () => {
		const task = runner.createTask({
			type: "job.apply_basic",
			input: {
				url: server.jobUrl,
				resumePath: resume(),
				// workAuthorization (required select) is omitted, and coverNote too
				candidate: { fullName: "Test Candidate", email: "test@example.com" },
			},
		});

		const done = await runner.approveTask(task.id);

		expect(done.status).toBe("failed");
		expect(done.error).toMatch(/required fields/i);
		expect(server.submissions.length).toBe(0);
	}, 60_000);
});
