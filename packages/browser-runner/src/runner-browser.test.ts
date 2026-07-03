import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalRunner } from "./runner.js";
import { startTestJobServer, type TestJobServer } from "./test-job-server.js";

/**
 * The brain-driven path: drive the real LocalRunner ENTIRELY through the
 * selector-free browser endpoints — browserSnapshot() (what the remote LLM
 * "sees") and browserAct() (role+name actions) — and assert the application is
 * actually submitted. This is the loop a Cloudflare Workflow runs remotely.
 */
describe("LocalRunner brain-driven browser endpoints", () => {
	let dir: string;
	let runner: LocalRunner;
	let server: TestJobServer;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "pags-brain-"));
		runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: dir, headless: true });
		server = await startTestJobServer(0);
	});

	afterEach(async () => {
		await runner.close();
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function resume(): string {
		const p = join(dir, "resume.pdf");
		writeFileSync(p, "%PDF-1.4\nfake resume body");
		return p;
	}

	it("snapshot → act fills + uploads + submits, all by role+name (no selectors)", async () => {
		// 1. Navigate.
		await runner.browserAct({ action: "navigate", url: server.jobUrl });

		// 2. Snapshot = what the brain reads. It must expose the form semantically.
		const snap = await runner.browserSnapshot();
		expect(snap.snapshot).toContain("Full name");
		expect(snap.snapshot).toContain("Submit application");
		expect(snap.challenge).toBeNull();

		// 3. Act on each field purely by ARIA role + accessible name.
		await runner.browserAct({ action: "type", role: "textbox", name: "Full name", text: "Sergey Ivochkin" });
		await runner.browserAct({ action: "type", role: "textbox", name: "Email", text: "sergey@example.com" });
		await runner.browserAct({ action: "type", role: "textbox", name: "Phone", text: "+61404453580" });
		await runner.browserAct({ action: "select", role: "combobox", name: "Work authorization", text: "Authorized to work in the United States" });
		await runner.browserAct({ action: "upload", name: "Resume", file: resume() });
		await runner.browserAct({ action: "type", role: "textbox", name: "Cover note", text: "Excited to apply." });

		// 4. Submit.
		const result = await runner.browserAct({ action: "click", role: "button", name: "Submit application" });

		// 5. The server actually recorded the submission with the right data.
		expect(server.submissions.length).toBe(1);
		const sub = server.submissions[0];
		expect(sub.fields.fullName).toBe("Sergey Ivochkin");
		expect(sub.fields.email).toBe("sergey@example.com");
		expect(sub.fields.workAuthorization).toBe("Authorized to work in the United States");
		expect(sub.resume?.filename).toContain("resume");
		expect(sub.resume?.size).toBeGreaterThan(0);
		expect(result.url).toContain("/success/");
	}, 60_000);

	it("snapshot reports a CAPTCHA challenge so the brain can hand off", async () => {
		await runner.browserAct({ action: "navigate", url: `${server.jobUrl}?challenge=1` });
		const snap = await runner.browserSnapshot();
		expect(snap.challenge).toBe("cloudflare-turnstile");
	}, 60_000);

	it("does NOT hand off for an invisible reCAPTCHA badge, but DOES for a visible checkbox", async () => {
		// The Dayforce false-positive: an invisible v3 badge must be ignored.
		await runner.browserAct({ action: "navigate", url: `${server.jobUrl}?invisible_recaptcha=1` });
		expect((await runner.browserSnapshot()).challenge).toBeNull();
		// A visible "I'm not a robot" checkbox IS a real challenge.
		await runner.browserAct({ action: "navigate", url: `${server.jobUrl}?recaptcha=1` });
		expect((await runner.browserSnapshot()).challenge).toBe("recaptcha");
	}, 60_000);

	it("agent handoff lifecycle: same-session pause → solved → resume → complete", async () => {
		// Agent-driven task: created running, never auto-executed by the runner.
		const task = runner.createTask({ type: "job.apply_agent", input: { url: server.jobUrl } });
		expect(task.status).toBe("running");

		// Brain drives onto a CAPTCHA page, then hands off.
		await runner.browserAct({ action: "navigate", url: `${server.jobUrl}?challenge=1` });
		const handoff = await runner.browserHandoff(task.id, "cloudflare-turnstile");
		expect(handoff.screenshotBase64).toMatch(/^data:image\/jpeg;base64,/);
		// Same-session takeover is registered on the live page; task waits for a human.
		expect(runner.listTakeovers()).toContain(task.id);
		expect(runner.store.getTask(task.id)?.status).toBe("needs_human");

		// Still blocked while the challenge is unsolved.
		expect(await runner.browserHandoffStatus(task.id)).toEqual({ solved: false, challenge: "cloudflare-turnstile" });

		// Human solves it (the same live page advances past the challenge).
		await runner.browserAct({ action: "navigate", url: server.jobUrl });
		expect((await runner.browserHandoffStatus(task.id)).solved).toBe(true);

		// Brain resumes on the same session, then finishes.
		await runner.browserResume(task.id);
		expect(runner.store.getTask(task.id)?.status).toBe("running");
		expect(runner.listTakeovers()).not.toContain(task.id);

		await runner.browserComplete(task.id, "submitted", "Application received");
		expect(runner.store.getTask(task.id)?.status).toBe("completed");
	}, 60_000);

	it("snapshot exposes [ref=] and actions target by ref (Playwright-MCP parity)", async () => {
		await runner.browserAct({ action: "navigate", url: server.jobUrl });
		const snap = await runner.browserSnapshot();
		// _snapshotForAI annotates interactive elements with a stable [ref=eNN].
		expect(snap.snapshot).toMatch(/\[ref=e\d+\]/);
		// Pull the Full name textbox's ref straight from the snapshot and type by ref.
		const m = snap.snapshot.match(/textbox "Full name"[^\n]*\[ref=(e\d+)\]/);
		expect(m).toBeTruthy();
		const res = await runner.browserAct({ action: "type", ref: (m as RegExpMatchArray)[1], text: "Sergey Ivochkin" });
		expect(res.feedback ?? "").not.toContain("REJECTED");
		expect((await runner.browserSnapshot()).snapshot).toContain("Sergey Ivochkin");
	}, 60_000);
});
