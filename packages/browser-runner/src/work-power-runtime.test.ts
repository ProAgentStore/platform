/** Real HTTP start/health/completion: an asynchronous clone must remain protected after its reply. */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveCloneDeps } from "./coding/repo-clone-job.js";
import { startRunnerServer } from "./server.js";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("./work-power.js", async (original) => {
	const actual = await original<typeof import("./work-power.js")>();
	return { WorkPower: class extends actual.WorkPower {
		constructor(options: import("./work-power.js").WorkPowerOptions) {
			super({ ...options, platform: "darwin", spawn: launch });
		}
	} };
});
afterEach(() => vi.restoreAllMocks());

describe("runtime sleep prevention (#1486)", () => {
	it("acquires before clone execution, holds after the HTTP reply, releases after completion", async () => {
		const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
		launch.mockReset().mockReturnValue(child as unknown as ChildProcess);
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pags-power-")));
		let finish!: () => void;
		vi.spyOn(liveCloneDeps, "clone").mockImplementation(async () => {
			expect(launch).toHaveBeenCalledTimes(1); // must exist BEFORE Git starts, not on the next heartbeat
			await new Promise<void>((resolve) => { finish = resolve; });
		});
		const server = await startRunnerServer({ host: "127.0.0.1", port: 0, dataDir: dir, token: "fixture-token", headless: true });
		const headers = { Authorization: "Bearer fixture-token", "Content-Type": "application/json" };
		try {
			const denied = await fetch(`${server.url}/coding/clone-start`, { method: "POST" });
			expect(denied.status).toBe(401);
			await fetch(`${server.url}/health`, { method: "POST", headers });
			expect(launch).not.toHaveBeenCalled();
			const started = await fetch(`${server.url}/coding/clone-start`, { method: "POST", headers, body: JSON.stringify({ workDir: join(dir, "repos", "owner-folder"), slug: "fixture/repo", protocol: "https" }) });
			expect(started.status, await started.clone().text()).toBe(200);
			expect(launch).toHaveBeenCalledWith("/usr/bin/caffeinate", ["-s", "-w", String(process.pid)]);
			expect(await started.json()).toMatchObject({ state: "cloning" });
			expect(child.kill).not.toHaveBeenCalled();
			finish();
			await vi.waitFor(() => expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM"), { timeout: 2500 });
		} finally {
			finish?.();
			await server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
