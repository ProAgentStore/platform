import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startRunnerServer } from "../server.js";
import { exportArtifactDocuments } from "./documents.js";

it("document export uses the authenticated relay caller, never a body instance id (#1468)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pags-document-route-"));
	const server = await startRunnerServer({ host: "127.0.0.1", port: 0, dataDir: dir, token: "test-token", headless: true });
	const documents = vi.spyOn(server.runner.localArtifact, "documents").mockImplementation((_body, caller) => exportArtifactDocuments({ runId: "run-1", instanceId: "tailor", caller }));
	try {
		const headers = { Authorization: "Bearer test-token", "X-PAGS-Instance-Id": "other-instance", "Content-Type": "application/json" };
		// A body naming another instance is refused at the runner's door, before the handler runs (#1194).
		const named = await fetch(`${server.url}/local-artifact/documents`, { method: "POST", headers, body: JSON.stringify({ runId: "run-1", instanceId: "tailor" }) });
		expect(named.status).toBe(403);
		expect(documents).not.toHaveBeenCalled();
		// Without a body instance id, the handler gets the relay caller and the export still refuses it.
		const request = { method: "POST", headers, body: JSON.stringify({ runId: "run-1" }) };
		const rejected = await fetch(`${server.url}/local-artifact/documents`, request);
		expect(rejected.status).toBe(403);
		expect(documents).toHaveBeenCalledWith({ runId: "run-1" }, "other-instance");
		const unauthenticated = await fetch(`${server.url}/local-artifact/documents`, { ...request, headers: { "Content-Type": "application/json" } });
		expect(unauthenticated.status).toBe(401);
		expect(documents).toHaveBeenCalledTimes(1);
	} finally {
		documents.mockRestore();
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
