import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startRunnerServer } from "../server.js";
import { RunnerInputError } from "../errors.js";
import { APPLY_START_UNCERTAIN } from "./start-claim.js";

it("the cloud receives a typed uncertain-start refusal, not an ordinary busy response (#1444)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pags-start-refusal-"));
	const server = await startRunnerServer({ host: "127.0.0.1", port: 0, dataDir: dir, token: "test-token", instanceId: "instance", headless: true });
	const start = vi.spyOn(server.runner.localApply, "start").mockImplementation(() => { throw new RunnerInputError("Previous execution is uncertain", 409, APPLY_START_UNCERTAIN); });
	try {
		const response = await fetch(`${server.url}/local-apply/run`, { method: "POST", headers: { Authorization: "Bearer test-token", "X-PAGS-Instance-Id": "instance", "Content-Type": "application/json" }, body: "{}" });
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({ error: "Previous execution is uncertain", code: APPLY_START_UNCERTAIN });
		expect(start).toHaveBeenCalledOnce();
	} finally {
		start.mockRestore();
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
