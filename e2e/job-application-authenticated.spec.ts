import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { LocalRunner } from "../packages/browser-runner/src/runner.js";
import { startTestJobServerAuth } from "../packages/browser-runner/src/test-job-server-auth.js";

test("FAGS runtime registers, logs in, and submits application on auth-required site", async () => {
	const oldSkipInstall = process.env.PAGS_SKIP_PLAYWRIGHT_INSTALL;
	process.env.PAGS_SKIP_PLAYWRIGHT_INSTALL = "1";
	const dataDir = mkdtempSync(join(tmpdir(), "pags-auth-job-e2e-"));
	const resumePath = join(dataDir, "test-resume.txt");
	writeFileSync(resumePath, "Test Candidate resume - 5 years TypeScript");
	const fixture = await startTestJobServerAuth();
	const runner = new LocalRunner({
		host: "127.0.0.1",
		port: 0,
		dataDir,
		headless: true,
	});

	try {
		// Test 1: Apply with registration (new account)
		const task = runner.createTask({
			type: "job.apply_authenticated",
			input: {
				url: fixture.jobUrl,
				resumePath,
				candidate: {
					fullName: "Test Candidate",
					email: "candidate@example.com",
					phone: "+1 555 0100",
					location: "Remote",
					workAuthorization: "Authorized to work in the United States",
				},
				coverNote: "I am interested in building browser agents.",
				registration: {
					fullName: "Test Candidate",
					email: "candidate@example.com",
					password: "secret123",
				},
			},
		});

		expect(task.status).toBe("needs_approval");
		const approved = await runner.approveTask(task.id);
		expect(approved.status).toBe("completed");
		expect(approved.output).toMatchObject({
			taskType: "job.apply_authenticated",
			submitted: true,
			authenticated: true,
			resumeFile: "test-resume.txt",
		});

		expect(fixture.submissions).toHaveLength(1);
		expect(fixture.submissions[0].fields).toMatchObject({
			fullName: "Test Candidate",
			email: "candidate@example.com",
			coverNote: "I am interested in building browser agents.",
		});
		expect(fixture.users).toHaveLength(1);
		expect(fixture.users[0].email).toBe("candidate@example.com");

		// Test 2: Apply with existing credentials (login)
		await runner.close();
		const runner2 = new LocalRunner({
			host: "127.0.0.1",
			port: 0,
			dataDir,
			headless: true,
		});

		const task2 = runner2.createTask({
			type: "job.apply_authenticated",
			input: {
				url: fixture.jobUrl,
				resumePath,
				candidate: {
					fullName: "Test Candidate",
					email: "candidate@example.com",
					workAuthorization: "Authorized to work in the United States",
				},
				coverNote: "Second application with existing account.",
				credentials: {
					email: "candidate@example.com",
					password: "secret123",
				},
				accountExists: true,
			},
		});

		expect(task2.status).toBe("needs_approval");
		const approved2 = await runner2.approveTask(task2.id);
		expect(approved2.status).toBe("completed");
		expect(approved2.output).toMatchObject({
			taskType: "job.apply_authenticated",
			submitted: true,
			authenticated: true,
		});

		expect(fixture.submissions).toHaveLength(2);
		await runner2.close();
	} finally {
		await runner.close().catch(() => {});
		await fixture.close();
		rmSync(dataDir, { recursive: true, force: true });
		if (oldSkipInstall === undefined) delete process.env.PAGS_SKIP_PLAYWRIGHT_INSTALL;
		else process.env.PAGS_SKIP_PLAYWRIGHT_INSTALL = oldSkipInstall;
	}
});
