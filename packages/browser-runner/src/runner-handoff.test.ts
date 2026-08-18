import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalRunner } from "./runner.js";

/**
 * The wiring half of #641, against a REAL Chrome and a REAL closed page.
 *
 * `handoff-status.test.ts` pins the decision; this pins that `browserHandoffStatus` asks it.
 * The two are separate because a poll that reasons correctly in a pure function and still
 * shortcuts in the method is the bug — the method's own `if (page.isClosed()) return { solved:
 * true }` sat below a comment forbidding exactly that, and no test held the ground.
 */
describe("browserHandoffStatus when the page the human was handed is gone (#641)", () => {
	let dir: string;
	let runner: LocalRunner;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-handoff-"));
		runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: dir, headless: true });
	});

	afterEach(async () => {
		await runner.close();
		rmSync(dir, { recursive: true, force: true });
	}, 30_000);

	/**
	 * Register a real takeover on a real page, then take the browser away underneath it.
	 *
	 * `close()` shuts the browser context, which closes every page in it, and deliberately
	 * leaves `takeovers` alone — so this produces exactly the state the bug is about: a live
	 * handoff session holding a dead page. That is the real shape of it too: the human closes
	 * the tab, the site replaces it in a popup flow, or Chrome dies mid-handoff.
	 */
	async function handoffThenLoseTheBrowser(reason: string, label: string): Promise<string> {
		const task = runner.createTask({ type: "job.apply_agent", input: {} });
		const handoff = await runner.browserHandoff(task.id, label, reason);
		expect(handoff.screenshotBase64).toMatch(/^data:image\/jpeg;base64,/);
		expect(runner.listTakeovers()).toContain(task.id);
		expect(runner.store.getTask(task.id)?.status).toBe("needs_human");
		return task.id;
	}

	it("reports a CAPTCHA handoff unsolved — it is no less unsolved for the tab being shut", async () => {
		const taskId = await handoffThenLoseTheBrowser("challenge", "recaptcha");
		await runner.close();
		// Was `{ solved: true }`, and the workflow acted on it: it recorded the page as a
		// solved challenge, which mutes captcha re-detection there for the rest of the round.
		expect(await runner.browserHandoffStatus(taskId)).toEqual({ solved: false, challenge: null });
	}, 120_000);

	it("reports a STUCK handoff unsolved, even after the human pressed Resume", async () => {
		const taskId = await handoffThenLoseTheBrowser("stuck", "Save and Continue");
		// The human says they did the step — `resumeTakeover` sets humanDone for a
		// workflow-driven task without completing it.
		expect(await runner.resumeTakeover(taskId)).toMatchObject({ resumed: true });
		await runner.close();
		// Still not resumable: the page that step happened in is gone, so the brain would be
		// handed a fresh blank tab. Unsolved times out into "not resolved in time" →
		// `escalated` → "Needs you", which the owner can see and retry.
		expect(await runner.browserHandoffStatus(taskId)).toEqual({ solved: false, challenge: null });
	}, 120_000);

	it("still delivers a NEEDS_INPUT value supplied after the tab was gone", async () => {
		const taskId = await handoffThenLoseTheBrowser("needs_input", "Years of Python experience");
		await runner.close();
		// Nothing has been supplied yet: unsolved, and — the part the old shortcut got wrong
		// in the other direction — carrying no value for the workflow to save.
		expect(await runner.browserHandoffStatus(taskId)).toMatchObject({ solved: false, value: undefined });
		// The value channel never involved the page, so it still works.
		expect(runner.browserSubmitInput(taskId, "3 years")).toEqual({ ok: true });
		expect(await runner.browserHandoffStatus(taskId)).toEqual({ solved: true, challenge: null, value: "3 years" });
	}, 120_000);
});
