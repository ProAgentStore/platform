/**
 * #1295 — a second `pags up` beside a healthy runner. Real HTTP servers stand in for the runtime on its port, so what is
 * tested is how the port is judged, not how the source reads.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alreadyRunningLines, identifyPortOccupant, portCollisionLines, RUNNER_ALREADY_RUNNING_EXIT_CODE } from "./existing-runner.js";

const servers: Server[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});

function serve(handler: (req: { headers: Record<string, string | string[] | undefined> }) => { status: number; body: unknown }): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const r = handler(req);
			res.writeHead(r.status, { "content-type": "application/json" });
			res.end(JSON.stringify(r.body));
		});
		servers.push(server);
		server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
	});
}

describe("identifyPortOccupant (#1295)", () => {
	it("a ProAgentStore runtime on the port is a healthy runner of ours", async () => {
		const port = await serve(() => ({ status: 200, body: { ok: true, service: "proagentstore-browser-runtime", rsid: "r1" } }));
		expect(await identifyPortOccupant(port, { lockFiles: () => [] })).toEqual({ kind: "pags-runner" });
	});

	it("a runtime that insists on its token is still ours when a live lock names that port and answers with its rsid", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pags-1295-"));
		mkdirSync(dir, { recursive: true });
		const port = await serve((req) => (req.headers.authorization === "Bearer tok" ? { status: 200, body: { ok: true, rsid: "held" } } : { status: 401, body: { error: "Unauthorized" } }));
		const file = join(dir, "up-abc123.lock");
		writeFileSync(file, JSON.stringify({ v: 1, rsid: "held", pid: process.pid, pidStartedAt: "", port, runnerToken: "tok", startedAt: Date.now() }));
		expect(await identifyPortOccupant(port, { lockFiles: () => [file] })).toEqual({ kind: "pags-runner" });
	});

	it("an unrelated program on the port is a collision, described — never assumed to be ours", async () => {
		const port = await serve(() => ({ status: 401, body: { error: "Unauthorized" } }));
		expect(await identifyPortOccupant(port, { lockFiles: () => [] })).toEqual({ kind: "other", detail: "it answered HTTP 401" });
		const web = await serve(() => ({ status: 200, body: { hello: "world" } }));
		expect((await identifyPortOccupant(web, { lockFiles: () => [] })).kind).toBe("other");
	});

	it("a lock whose holder is gone does not make an unrelated listener ours", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pags-1295-"));
		const port = await serve(() => ({ status: 401, body: {} }));
		const file = join(dir, "up-abc123.lock");
		writeFileSync(file, JSON.stringify({ v: 1, rsid: "gone", pid: 2_147_483_000, port, runnerToken: "tok", startedAt: Date.now() }));
		expect((await identifyPortOccupant(port, { lockFiles: () => [file] })).kind).toBe("other");
	});

	it("nothing listening is also `other`, with a reason", async () => {
		const port = await serve(() => ({ status: 200, body: {} }));
		servers.pop()?.close();
		const result = await identifyPortOccupant(port, { lockFiles: () => [], timeoutMs: 500 });
		expect(result).toMatchObject({ kind: "other" });
	});
});

describe("what is said (#1295)", () => {
	it("already running: says connected, no manual start needed, how to look, and the explicit takeover — and no error words", () => {
		const text = alreadyRunningLines(49171).join("\n");
		expect(text).toMatch(/already connected/);
		expect(text).toMatch(/No manual start is needed/);
		expect(text).toMatch(/pags status/);
		expect(text).toMatch(/pags up --replace/);
		expect(text).not.toMatch(/EADDRINUSE|crash|exited|retry/i);
	});

	it("a collision names the port and what answered, and does not call a connected runner offline", () => {
		const text = portCollisionLines(49171, "it answered HTTP 401").join("\n");
		expect(text).toMatch(/49171/);
		expect(text).toMatch(/HTTP 401/);
		expect(text).toMatch(/lsof/);
		expect(text).toMatch(/not an offline runner/);
	});

	it("uses a code of its own", () => {
		expect(RUNNER_ALREADY_RUNNING_EXIT_CODE).toBe(78);
	});
});
