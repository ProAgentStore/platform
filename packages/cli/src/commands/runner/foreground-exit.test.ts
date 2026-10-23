/**
 * #1297 — what `runner start` makes of its runtime's end. Real fixture children (a `pags-browser-runner` first on PATH, in a
 * temp directory with no workspace) exit cleanly, fail with a number, and die by a signal; nothing here reads the source.
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRunnerForeground } from "./process.js";

const posix = process.platform !== "win32";
let dir = "";
const oldPath = process.env.PATH;

function fixture(script: string) {
	writeFileSync(join(dir, "pags-browser-runner"), `#!/bin/sh\n${script}\n`);
	chmodSync(join(dir, "pags-browser-runner"), 0o755);
}

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "pags-1297-")));
	process.env.PATH = `${dir}:${oldPath}`;
	vi.spyOn(process, "cwd").mockReturnValue(dir); // no pnpm-workspace.yaml above a temp dir: the PATH runner is the one used
});
afterEach(() => {
	process.env.PATH = oldPath;
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)("startRunnerForeground's verdict on its child (#1297)", () => {
	it("a clean exit resolves", async () => {
		fixture("exit 0");
		await expect(startRunnerForeground({})).resolves.toBeUndefined();
	});

	it("a numeric failure rejects with the code", async () => {
		fixture("exit 3");
		await expect(startRunnerForeground({})).rejects.toThrow("runner exited with code 3");
	});

	it("death by a signal rejects and names the signal — it used to resolve as success", async () => {
		fixture("kill -TERM $$");
		await expect(startRunnerForeground({})).rejects.toThrow("runner was killed by SIGTERM");
		fixture("kill -KILL $$");
		await expect(startRunnerForeground({})).rejects.toThrow("runner was killed by SIGKILL");
	});

	it("our own stop is a clean end: SIGTERM aimed at this process is forwarded and the child's death by it resolves", async () => {
		fixture('echo ready > "$0.ready"; sleep 30 & wait');
		const done = startRunnerForeground({});
		const deadline = Date.now() + 5000;
		const { existsSync } = await import("node:fs");
		while (!existsSync(join(dir, "pags-browser-runner.ready")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
		process.emit("SIGTERM");
		await expect(done).resolves.toBeUndefined();
		expect(process.listenerCount("SIGTERM")).toBe(0);
	});
});
