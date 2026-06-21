import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { LocalRunner } from "../packages/browser-runner/src/runner.js";
import { startTestJobServer } from "../packages/browser-runner/src/test-job-server.js";

test("FAGS runtime submits the fixture job application after approval", async () => {
	const oldSkipInstall = process.env.PAGS_SKIP_PLAYWRIGHT_INSTALL;
	process.env.PAGS_SKIP_PLAYWRIGHT_INSTALL = "1";
	const dataDir = mkdtempSync(join(tmpdir(), "pags-job-runner-e2e-"));
	const resumePath = join(dataDir, "sam-resume.txt");
	writeFileSync(resumePath, "Sam Candidate resume");
	const fixture = await startTestJobServer();
	const runner = new LocalRunner({
		host: "127.0.0.1",
		port: 0,
		dataDir,
		headless: true,
	});

	try {
		const task = runner.createTask({
			type: "job.apply_basic",
			input: {
				url: fixture.jobUrl,
				resumePath,
				candidate: {
					fullName: "Sam Candidate",
					email: "sam@example.com",
					phone: "+1 555 0100",
					location: "Remote",
					linkedin: "https://linkedin.com/in/sam",
					portfolio: "https://sam.dev",
					workAuthorization: "Authorized to work in the United States",
				},
				coverNote: "I am interested in building safe browser agents.",
			},
		});

		expect(task.status).toBe("needs_approval");
		const approved = await runner.approveTask(task.id);
		expect(approved.status).toBe("completed");
		expect(approved.output).toMatchObject({
			taskType: "job.apply_basic",
			submitted: true,
			resumeFile: "sam-resume.txt",
		});

		expect(fixture.submissions).toHaveLength(1);
		expect(fixture.submissions[0].fields).toMatchObject({
			fullName: "Sam Candidate",
			email: "sam@example.com",
			coverNote: "I am interested in building safe browser agents.",
		});
		expect(fixture.submissions[0].resume).toMatchObject({
			filename: "sam-resume.txt",
			contentType: "text/plain",
			size: 20,
		});
	} finally {
		await runner.close();
		await fixture.close();
		rmSync(dataDir, { recursive: true, force: true });
		if (oldSkipInstall === undefined) delete process.env.PAGS_SKIP_PLAYWRIGHT_INSTALL;
		else process.env.PAGS_SKIP_PLAYWRIGHT_INSTALL = oldSkipInstall;
	}
});
