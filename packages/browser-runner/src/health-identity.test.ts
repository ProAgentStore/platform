/**
 * #896 — the runner says WHO it is and WHAT it is doing, over its own `/health`.
 *
 * Both halves are load-bearing for the single-instance lock. Without the id, a recycled port
 * answering "ok" reads as the live holder, which is how a contender takes a slot it should have
 * refused. Without the work counts, `pags up --replace` silently ends a Codex turn, a research run
 * or an application fill — the F7 failure that made every second `pags up` destructive.
 */
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRunnerServer } from "./server.js";
import { LocalRunner } from "./runner.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dirs: string[] = [];
const runnerFor = (over: Partial<ConstructorParameters<typeof LocalRunner>[0]> = {}) => {
	const dataDir = mkdtempSync(join(tmpdir(), "pags-health-"));
	dirs.push(dataDir);
	// Every request to a runner carries its bearer token (`server.ts` `authorize`) — including a
	// lock contender's, which is why the token lives in the mode-600 lock file beside the nonce.
	return new LocalRunner({ host: "127.0.0.1", port: 0, dataDir, headless: true, token: "runner-token", ...over });
};
async function ask(runner: LocalRunner, path: string, init?: RequestInit) {
	const server = createRunnerServer(runner);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const port = (server.address() as AddressInfo).port;
	try {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: "Bearer runner-token" } });
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
	}
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

describe("/health identifies the process (#896)", () => {
	it("answers with the lock's rsid, its pid and where it was launched", async () => {
		const { status, body } = await ask(runnerFor({ rsid: "rsid-A", launch: "tmux" }), "/health");
		expect(status).toBe(200);
		expect(body).toMatchObject({ ok: true, rsid: "rsid-A", pid: process.pid, launch: "tmux" });
	});

	it("says `rsid: null` when nothing holds a lock, instead of inventing one", async () => {
		// A bare `pags runner start`, or a CLI older than the lock. A contender then cannot prove
		// identity and falls back to the pid, which is the safe direction.
		const { body } = await ask(runnerFor(), "/health");
		expect(body.rsid).toBeNull();
		expect(body.launch).toBeNull();
	});

	it("reports what a restart would destroy — zero when idle, truthfully", async () => {
		const { body } = await ask(runnerFor({ rsid: "r" }), "/health");
		expect(body.work).toEqual({ codingTurns: 0, localRuns: 0, detail: [] });
	});
});

describe("/control/shutdown only stops for the lock holder (#896)", () => {
	const post = (nonce: unknown) => ({ method: "POST" as const, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce }) });

	it("refuses a wrong nonce, a missing one, and any request at all when it holds no lock", async () => {
		const withNonce = await ask(runnerFor({ rsid: "r", controlNonce: "secret" }), "/control/shutdown", post("not-the-secret"));
		expect(withNonce.status).toBe(403);
		expect(String(withNonce.body.error)).toMatch(/its own lock's nonce/);
		expect((await ask(runnerFor({ rsid: "r", controlNonce: "secret" }), "/control/shutdown", post(undefined))).status).toBe(403);
		// No lock: nothing can authorise a stop, so nothing can stop it remotely. `pkill` needed no
		// such proof, which is exactly how it stopped another account's runner and a service's.
		expect((await ask(runnerFor(), "/control/shutdown", post("anything"))).status).toBe(403);
	});

	it("GET is not a way to stop a runner", async () => {
		expect((await ask(runnerFor({ controlNonce: "secret" }), "/control/shutdown")).status).toBe(404);
	});
});
