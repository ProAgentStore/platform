import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitGuardSpec } from "../../../workers/api/src/lib/commit-guard.js";
import { runApplyLoop, type ApplyDecision, type BrowserAction, type PageSnapshot } from "../../../workers/api/src/lib/apply-loop.js";
import { LocalRunner } from "./runner.js";
import { startTestJobServer, type TestJobServer } from "./test-job-server.js";

/**
 * A deterministic rehearsal through the deployed pipeline's essential seam:
 * apply loop (the Workflow's brain) → LocalRunner → mock ATS.
 *
 * The fixture records actual POSTs, so this proves real fields are filled on a page that can
 * submit and that the terminal POST never reaches it. The runner receives the same guard the
 * durable JobApplyWorkflow puts on every dry-run action.
 */
describe("dry-run job application pipeline", () => {
	let dir: string;
	let runner: LocalRunner;
	let server: TestJobServer;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "pags-dry-run-pipeline-"));
		runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: dir, headless: true });
		server = await startTestJobServer(0);
	});

	afterEach(async () => {
		await runner.close();
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}, 120_000);

	function ref(snapshot: string, role: string, name: string): string {
		const match = snapshot.match(new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`));
		if (!match) throw new Error(`no ref for ${role} "${name}" in snapshot:\n${snapshot}`);
		return match[1];
	}

	function resume(): string {
		const path = join(dir, "fixture-resume.pdf");
		writeFileSync(path, "%PDF-1.4\\nfixture resume");
		return path;
	}

	it("fills the mock ATS but stops at its final POST in dry-run", async () => {
		const actions: Array<(snapshot: PageSnapshot) => BrowserAction> = [
			() => ({ action: "navigate", url: server.jobUrl }),
			(snapshot) => ({ action: "type", ref: ref(snapshot.snapshot, "textbox", "Full name"), name: "Full name", text: "Test Candidate" }),
			(snapshot) => ({ action: "type", ref: ref(snapshot.snapshot, "textbox", "Email"), name: "Email", text: "candidate@example.test" }),
			(snapshot) => ({ action: "select", ref: ref(snapshot.snapshot, "combobox", "Work authorization"), name: "Work authorization", text: "Authorized to work in the United States" }),
			(snapshot) => ({ action: "upload", ref: ref(snapshot.snapshot, "button", "Resume"), name: "Resume" }),
			(snapshot) => ({ action: "type", ref: ref(snapshot.snapshot, "textbox", "Cover note"), name: "Cover note", text: "I build careful browser automation." }),
			// Deliberately mislabel the control. The runner must inspect the real element,
			// rather than trust this model-written name, if this reaches its act boundary.
			(snapshot) => ({ action: "click", ref: ref(snapshot.snapshot, "button", "Submit application"), name: "Continue" }),
		];
		let next = 0;
		const feedback: string[] = [];
		const result = await runApplyLoop(
			{
				snapshot: async () => runner.browserSnapshot(),
				decide: async ({ snapshot }): Promise<ApplyDecision> => ({ action: actions[next++](snapshot) }),
				act: async (action) => {
					try {
						const response = await runner.browserAct(action, action.action === "upload" ? resume() : undefined, commitGuardSpec("apply_dry_run"));
						if (response.feedback) feedback.push(response.feedback);
						return { url: response.url, challenge: response.challenge, feedback: response.feedback };
					} catch (error) {
						return { url: "", challenge: null, error: error instanceof Error ? error.message : String(error) };
					}
				},
			},
			{
				url: server.jobUrl,
				resumePath: resume(),
				candidate: { fullName: "Test Candidate", email: "candidate@example.test" },
				dryRun: true,
			},
			{ maxSteps: 9 },
		);

		// The cloud loop recognizes the final submit control from the snapshot and does not
		// forward it. The runner's DOM-level backstop is exercised in runner-commit-guard.test.ts.
		expect(result.outcome).toBe("ready");
		expect(result.detail).toMatch(/test mode, not submitted/i);
		expect(next).toBe(7);
		expect(server.submissions).toHaveLength(0);

		// The runner read the live DOM values back after writes; this is not merely a
		// decision trace claiming that it intended to fill them.
		expect(feedback.join("\n")).toContain("Test Candidate");
		expect(feedback.join("\n")).toContain("candidate@example.test");
		expect(feedback.join("\n")).toContain("Authorized to work in the United States");
	}, 120_000);
});
