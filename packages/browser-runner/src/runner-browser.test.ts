import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalRunner } from "./runner.js";
import { startTestJobServer, type TestJobServer } from "./test-job-server.js";

/**
 * The brain-driven path: drive the real LocalRunner ENTIRELY through the
 * selector-free browser endpoints — browserSnapshot() (what the remote LLM
 * "sees") and browserAct() (ref-targeted actions) — and assert the application
 * is actually submitted. Every action runs through the STANDARD @playwright/mcp
 * tools attached over CDP to the runner's own Chrome. This is the loop a
 * Cloudflare Workflow runs remotely.
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

	/** Pull an element's [ref=eNN] out of a snapshot by role + accessible name. */
	function ref(snapshot: string, role: string, name: string): string {
		const m = snapshot.match(new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`));
		if (!m) throw new Error(`no ref for ${role} "${name}" in snapshot:\n${snapshot}`);
		return m[1];
	}

	it("snapshot → act fills + uploads + submits, all by ref (standard tools)", async () => {
		// 1. Navigate.
		await runner.browserAct({ action: "navigate", url: server.jobUrl });

		// 2. Snapshot = what the brain reads. It must expose the form semantically,
		//    with a stable ref on each element (the standard @playwright/mcp format).
		const snap = await runner.browserSnapshot();
		expect(snap.snapshot).toContain("Full name");
		expect(snap.snapshot).toContain("Submit application");
		expect(snap.snapshot).toMatch(/\[ref=e\d+\]/);
		expect(snap.challenge).toBeNull();
		const s = snap.snapshot;

		// 3. Act on each field purely by its snapshot ref.
		await runner.browserAct({ action: "type", ref: ref(s, "textbox", "Full name"), name: "Full name", text: "Sergey Ivochkin" });
		await runner.browserAct({ action: "type", ref: ref(s, "textbox", "Email"), name: "Email", text: "sergey@example.com" });
		await runner.browserAct({ action: "type", ref: ref(s, "textbox", "Phone"), name: "Phone", text: "+61404453580" });
		await runner.browserAct({ action: "select", ref: ref(s, "combobox", "Work authorization"), name: "Work authorization", text: "Authorized to work in the United States" });
		await runner.browserAct({ action: "upload", ref: ref(s, "button", "Resume"), name: "Resume" }, resume());
		await runner.browserAct({ action: "type", ref: ref(s, "textbox", "Cover note"), name: "Cover note", text: "Excited to apply." });

		// 4. Submit.
		const result = await runner.browserAct({ action: "click", ref: ref(s, "button", "Submit application"), name: "Submit application" });

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

	it("auto-handles a native dialog so the brain isn't wedged (real ATS: alert after résumé upload)", async () => {
		// A page that pops a native alert — exactly what Coles does after résumé upload.
		// @playwright/mcp traps the dialog as a modal state that blocks every tool; the
		// runner must clear it transparently (the brain has no dialog vocabulary).
		await runner.browserAct({ action: "navigate", url: "data:text/html,<button onclick=\"alert('Your resume has been uploaded and processed')\">Go</button>" });
		const snap = await runner.browserSnapshot();
		// Clicking opens the alert (the click itself may succeed; the dialog blocks the NEXT tool).
		await runner.browserAct({ action: "click", ref: ref(snap.snapshot, "button", "Go"), name: "Go" });
		// Any follow-up action hits the modal state — the runner accepts the dialog and
		// reports it as a successful, informative step instead of throwing.
		const after = await runner.browserAct({ action: "key", key: "Enter" });
		expect(after.ok).toBe(true);
		expect(after.feedback ?? "").toMatch(/dialog was accepted/i);
	}, 60_000);

	it("reads back a masked field's real value so the brain doesn't oscillate", async () => {
		// A phone field that transforms input like a real intl mask: "0404…" → "+61404…".
		// Without read-back the brain can't tell the value took and re-types forever.
		await runner.browserAct({ action: "navigate", url: "data:text/html,<input aria-label=Phone oninput=\"this.value=this.value.replace(/^0/,'+61')\">" });
		const snap = await runner.browserSnapshot();
		const res = await runner.browserAct({ action: "type", ref: ref(snap.snapshot, "textbox", "Phone"), name: "Phone", text: "0404453580" });
		// The runner reports what the field ACTUALLY holds now (the transformed value).
		expect(res.feedback ?? "").toMatch(/now reads/i);
		expect(res.feedback ?? "").toContain("+61404453580");
	}, 60_000);

	it("a failed action (bad ref) throws so the workflow surfaces it to the brain", async () => {
		await runner.browserAct({ action: "navigate", url: server.jobUrl });
		await runner.browserSnapshot();
		// A ref that doesn't exist must not silently succeed — it throws (→ the
		// workflow maps it to `error`, driving the brain's self-correction).
		await expect(runner.browserAct({ action: "click", ref: "e99999", name: "ghost" })).rejects.toThrow();
	}, 60_000);
});
