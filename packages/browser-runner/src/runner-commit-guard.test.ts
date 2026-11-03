import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalRunner } from "./runner.js";
import { startTestJobServer, type TestJobServer } from "./test-job-server.js";

/**
 * The commit guard, exercised through the code path that ACTUALLY CLICKS (#627, #629).
 *
 * Every guard that existed before this ran in the cloud and tested `action.name` — a string the
 * model wrote — while this process clicks by `ref` and never reads `name`. So the only test that
 * can prove anything about the guard is one that drives a real browser at a real form and then
 * asks the SERVER whether an application arrived. `server.submissions.length` is that question.
 *
 * Each guarded case is paired with the same action UNGUARDED, which submits for real. Without the
 * pair, a fixture that could not submit anyway would produce the same green tick (ADR 0002 G1: the
 * denominator is asserted, not assumed).
 */
describe("LocalRunner commit guard — enforced where the click happens", () => {
	let dir: string;
	let runner: LocalRunner;
	let server: TestJobServer;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "pags-guard-"));
		runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: dir, headless: true });
		server = await startTestJobServer(0);
	});

	afterEach(async () => {
		// Keep ownership even if a failing hook outlives its test. Never close the
		// next case's server after awaiting this case's bounded browser teardown.
		const owned = { runner, server, dir };
		try { await owned.runner.close(); } finally {
			await owned.server.close();
			rmSync(owned.dir, { recursive: true, force: true });
		}
	});

	function ref(snapshot: string, role: string, name: string): string {
		const m = snapshot.match(new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`));
		if (!m) throw new Error(`no ref for ${role} "${name}" in snapshot:\n${snapshot}`);
		return m[1];
	}

	async function submitRef(): Promise<string> {
		await runner.browserAct({ action: "navigate", url: server.quickApplyUrl });
		const snap = await runner.browserSnapshot();
		return ref(snap.snapshot, "button", "Envoyer ma candidature");
	}

	it("UNGUARDED, one click really submits — the fixture is a live application", async () => {
		const r = await submitRef();
		await runner.browserAct({ action: "click", ref: r, name: "Continue" });
		expect(server.submissions.length).toBe(1);
	}, 120_000);

	it("a rehearsal refuses the submit even when the model MISLABELS it 'Continue'", async () => {
		// The exact hole: the cloud's guard sees "Continue" and allows it; the runner resolves the
		// ref, reads the element's real accessible name off the page — "Envoyer ma candidature",
		// which is also in no English vocabulary — and the click never reaches the DOM.
		const r = await submitRef();
		await expect(runner.browserAct({ action: "click", ref: r, name: "Continue" }, undefined, { mode: "dry_run" })).rejects.toThrow(/BLOCKED by the runner/);
		expect(server.submissions.length).toBe(0);
	}, 120_000);

	it("a rehearsal refuses a NAMELESS click on the same button", async () => {
		const r = await submitRef();
		await expect(runner.browserAct({ action: "click", ref: r }, undefined, { mode: "dry_run" })).rejects.toThrow(/BLOCKED by the runner/);
		expect(server.submissions.length).toBe(0);
	}, 120_000);

	it.each(["check", "upload"] as const)("a rehearsal cannot disguise the submit as %s", async (action) => {
		const target = await submitRef();
		const resume = join(dir, "resume.txt");
		writeFileSync(resume, "Synthetic fixture only");
		await expect(runner.browserAct({ action, ref: target, name: "Continue" }, action === "upload" ? resume : undefined, { mode: "dry_run" })).rejects.toThrow(/REHEARSAL/);
		expect(server.submissions).toHaveLength(0);
	}, 120_000);

	it("Stop between snapshot and act refuses before opening or touching the browser", async () => {
		const task = runner.createTask({ type: "browser.task", input: { url: server.quickApplyUrl, objective: "Synthetic rehearsal" } });
		task.status = "cancelled";
		runner.store.putTask(task);
		await expect(runner.browserAct({ action: "navigate", url: server.quickApplyUrl }, undefined, undefined, task.id)).rejects.toThrow(/stopped/);
		expect(runner.browsers.current.context).toBeNull();
	});

	it("a rehearsal leaves alert() open because dismissing it would continue the POST", async () => {
		await runner.browserAct({ action: "navigate", url: server.quickApplyUrl });
		await runner.browsers.current.activePage!.setContent('<form method="post" action="/apply" enctype="multipart/form-data"><button type="button" onclick="alert(\'Continue?\');this.form.submit()">Go</button></form>');
		const snapshot = await runner.browserSnapshot();
		await expect(runner.browserAct({ action: "click", ref: ref(snapshot.snapshot, "button", "Go"), name: "Go" }, undefined, { mode: "dry_run" })).rejects.toThrow(/left it open/);
		expect(server.submissions).toHaveLength(0);
		const mcp = runner.browsers.current.mcp!;
		expect((await mcp.callTool("browser_handle_dialog", { accept: false }, { internal: true })).isError).toBe(true);
		expect(server.submissions).toHaveLength(0);
		// The exact same dismiss WOULD submit; only the synthetic test lifts the policy.
		mcp.setCallPolicy({});
		expect((await mcp.callTool("browser_handle_dialog", { accept: false }, { internal: true })).isError).not.toBe(true);
		await expect.poll(() => server.submissions.length, { timeout: 5_000 }).toBe(1);
	}, 120_000);

	it("a read-only agent cannot submit by pressing Enter in the form", async () => {
		// #629: the commit guard only ever looked at clicks, so Enter — which submits a focused
		// form — went straight through for an agent whose declaration is that it can never change
		// anything. The runner refuses on the FORM'S METHOD, not on any label.
		await runner.browserAct({ action: "navigate", url: server.quickApplyUrl });
		const snap = await runner.browserSnapshot();
		const box = ref(snap.snapshot, "textbox", "Recherche");
		await runner.browserAct({ action: "click", ref: box, name: "Recherche" }, undefined, { mode: "read_only" });
		await expect(runner.browserAct({ action: "key", key: "Enter" }, undefined, { mode: "read_only" })).rejects.toThrow(/READ-ONLY/);
		expect(server.submissions.length).toBe(0);
	}, 120_000);

	it("UNGUARDED, that same Enter really submits", async () => {
		await runner.browserAct({ action: "navigate", url: server.quickApplyUrl });
		const snap = await runner.browserSnapshot();
		await runner.browserAct({ action: "type", ref: ref(snap.snapshot, "textbox", "Recherche"), name: "Recherche", text: "hello" });
		await runner.browserAct({ action: "key", key: "Enter" });
		expect(server.submissions.length).toBe(1);
	}, 120_000);

	it("a read-only agent CAN still search — Enter on a GET form is a read, and is allowed", async () => {
		// The guard has to tell a query from a mutation, or "read-only" quietly means "useless":
		// the read-only prompt explicitly permits typing into a search or filter box.
		await runner.browserAct({ action: "navigate", url: server.searchUrl });
		const snap = await runner.browserSnapshot();
		await runner.browserAct({ action: "type", ref: ref(snap.snapshot, "textbox", "Search"), name: "Search", text: "balance" }, undefined, { mode: "read_only" });
		const res = await runner.browserAct({ action: "key", key: "Enter" }, undefined, { mode: "read_only" });
		expect(res.ok).toBe(true);
		expect(server.searches).toContain("balance");
		expect(server.submissions.length).toBe(0);
	}, 120_000);

	it("every reply carries the acknowledgement the cloud measures the guard's existence from", async () => {
		const res = await runner.browserAct({ action: "navigate", url: server.quickApplyUrl });
		expect(res.commitGuard.supported).toBe(true);
	}, 120_000);
});
