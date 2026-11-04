import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalRunner } from "./runner.js";

describe("generic uploads keep the exact chooser and task binding (#1490)", () => {
	let runner: LocalRunner;
	let server: ReturnType<typeof createServer>;
	let directory: string;
	let path: string;
	let url: string;
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "pags-upload-binding-"));
		path = join(directory, "resume.txt");
		writeFileSync(path, "Approved synthetic resume.");
		vi.stubEnv("PAGS_RUNNER_CHROMIUM", "1");
		server = createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end('<title>Upload fixture</title><input type="file" id="unrelated" hidden><input type="file" id="resume" hidden accept=".txt"><button id="missing">Upload wrapper</button><button id="choose" onclick="document.querySelector(\'#resume\').click()">Choose resume</button>'); });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No fixture address");
		url = `http://127.0.0.1:${address.port}/`;
		runner = new LocalRunner({ host: "127.0.0.1", port: 0, dataDir: directory, headless: true });
		await runner.browserAct({ action: "navigate", url, screenshot: false });
	}, 60_000);
	afterEach(async () => {
		await runner.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	}, 30_000);
	async function ref(name: string) {
		const snapshot = await runner.browserSnapshot();
		const found = snapshot.snapshot.match(new RegExp(`button "${name}"[^\\n]*\\[ref=(\\w+)\\]`))?.[1];
		if (!found) throw new Error(`No button ${name}`);
		return found;
	}
	const selections = () => runner.browsers.current.activePage!.locator('input[type="file"]').evaluateAll((inputs) => inputs.map((input) => Array.from((input as HTMLInputElement).files ?? [], (file) => file.name)));

	it("refuses an upload without a chooser instead of attaching to the first unrelated input", async () => {
		await expect(runner.browserAct({ action: "upload", ref: await ref("Upload wrapper"), name: "Upload wrapper", screenshot: false }, path)).rejects.toThrow(/chooser/i);
		expect(await selections()).toEqual([[], []]);
	}, 60_000);

	it("a styled upload click autoattaches only to its exact compatible input", async () => {
		await runner.browserAct({ action: "click", ref: await ref("Choose resume"), name: "Choose resume", screenshot: false }, path);
		await expect.poll(selections).toEqual([[], ["resume.txt"]]);
	}, 60_000);

	it("automatic attachment respects the exact input's accepted document types", async () => {
		await runner.browsers.current.activePage!.locator("#resume").evaluate((input) => input.setAttribute("accept", ".pdf"));
		await runner.browserAct({ action: "click", ref: await ref("Choose resume"), name: "Choose resume", screenshot: false }, path);
		expect(await selections()).toEqual([[], []]);
	}, 60_000);
});
