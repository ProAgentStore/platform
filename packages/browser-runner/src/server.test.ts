import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRunnerServer } from "./server.js";

describe("runner server", () => {
	let dir: string;
	let close: () => Promise<void>;
	let url: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "pags-runner-server-"));
		const started = await startRunnerServer({
			host: "127.0.0.1",
			port: 0,
			dataDir: dir,
			token: "secret",
			instanceId: "inst-1",
			headless: true,
		});
		close = started.close;
		url = started.url;
	});

	afterEach(async () => {
		await close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("requires auth when token is configured", async () => {
		const res = await fetch(`${url}/health`);
		expect(res.status).toBe(401);
	});

	it("reports FAGS runtime identity when healthy", async () => {
		const res = await fetch(`${url}/health`, {
			headers: {
				Authorization: "Bearer secret",
				"X-PAGS-Instance-Id": "inst-1",
			},
		});
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			service: "freeagentstore-browser-runtime",
			controlPlane: "pags",
			runtimePlane: "fags",
			brainPlacement: "pags",
		});
	});


	it("creates and reads tasks", async () => {
		const created = await fetch(`${url}/tasks`, {
			method: "POST",
			headers: {
				Authorization: "Bearer secret",
				"X-PAGS-Instance-Id": "inst-1",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ type: "echo", input: { value: 1 } }),
		});
		expect(created.status).toBe(202);
		const task = (await created.json()) as { id: string };
		await new Promise((resolve) => setTimeout(resolve, 20));
		const read = await fetch(`${url}/tasks/${task.id}`, {
			headers: {
				Authorization: "Bearer secret",
				"X-PAGS-Instance-Id": "inst-1",
			},
		});
		const saved = (await read.json()) as { status: string; output: unknown };
		expect(saved.status).toBe("completed");
		expect(saved.output).toEqual({ value: 1 });
	});

	it("lists tasks for console runtime boards", async () => {
		await fetch(`${url}/tasks`, {
			method: "POST",
			headers: {
				Authorization: "Bearer secret",
				"X-PAGS-Instance-Id": "inst-1",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				type: "echo",
				input: { board: true },
				requiresApproval: true,
				approvalPrompt: "Show on board",
			}),
		});

		const list = await fetch(`${url}/tasks`, {
			headers: {
				Authorization: "Bearer secret",
				"X-PAGS-Instance-Id": "inst-1",
			},
		});
		expect(list.status).toBe(200);
		await expect(list.json()).resolves.toMatchObject({
			tasks: [{ type: "echo", status: "needs_approval" }],
		});
	});

	it("returns 400 for invalid JSON request bodies", async () => {
		const res = await fetch(`${url}/tasks`, {
			method: "POST",
			headers: {
				Authorization: "Bearer secret",
				"X-PAGS-Instance-Id": "inst-1",
				"Content-Type": "application/json",
			},
			body: "{",
		});
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			error: "Request body must be valid JSON",
		});
	});

	it("returns 400 for malformed task requests", async () => {
		const res = await fetch(`${url}/tasks`, {
			method: "POST",
			headers: {
				Authorization: "Bearer secret",
				"X-PAGS-Instance-Id": "inst-1",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ input: { value: 1 } }),
		});
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			error: "task type required",
		});
	});

	it("rejects the wrong PAGS instance id when bound", async () => {
		const res = await fetch(`${url}/health`, {
			headers: {
				Authorization: "Bearer secret",
				"X-PAGS-Instance-Id": "inst-2",
			},
		});
		expect(res.status).toBe(401);
	});
});
