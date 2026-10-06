/**
 * The runner's local browser routes over real HTTP (#944): the runner-token routes, and the bridge
 * path that accepts a run's own token and nothing else. No CLI is started — a run that can't launch
 * its engine still answers `status`, which is the point: the API reads why.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRunnerServer } from "../server.js";
import { postToRunner } from "./bridge-stdio.js";

let dir: string;
let close: () => Promise<void>;
let url: string;
const H = { Authorization: "Bearer secret", "X-PAGS-Instance-Id": "inst-1", "Content-Type": "application/json" };
const post = (path: string, body: unknown, headers: Record<string, string> = H) => fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pags-lb-server-"));
	const started = await startRunnerServer({ host: "127.0.0.1", port: 0, dataDir: dir, token: "secret", instanceId: "inst-1", headless: true });
	close = started.close;
	url = started.url;
});
afterEach(async () => {
	await close();
	rmSync(dir, { recursive: true, force: true });
});

describe("runner local browser routes", () => {
	it("advertises the task type", async () => {
		const caps = (await (await fetch(`${url}/capabilities`, { headers: H })).json()) as { taskTypes: string[] };
		expect(caps.taskTypes).toContain("local_browser.research");
	});

	it("refuses an invalid envelope, and answers 404 for a run it does not hold", async () => {
		expect((await post("/local-browser/run", { type: "local_browser.research" })).status).toBe(400);
		expect((await post("/local-browser/status", { runId: "nope" })).status).toBe(404);
		expect((await post("/local-browser/cancel", { runId: "nope" })).status).toBe(404);
	});

	it("needs the runner token for everything but the bridge", async () => {
		expect((await post("/local-browser/status", { runId: "x" }, { "Content-Type": "application/json" })).status).toBe(401);
	});

	it("refuses the bridge path without the run's own token — the runner token is not it", async () => {
		await expect(postToRunner({ url, runId: "nope", token: "secret" }, { op: "list" })).rejects.toThrow(/Unauthorized/);
		const fromBrowser = await fetch(`${url}/local-browser/bridge`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", "X-Pags-Bridge-Token": "x" }, body: "{}" });
		expect(fromBrowser.status).toBe(401);
	});
});
