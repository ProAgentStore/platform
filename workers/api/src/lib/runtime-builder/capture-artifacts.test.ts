import { describe, expect, it } from "vitest";
import { captureObjectKey, signedCaptureDelivery, storeCaptureArtifact, verifyCaptureDelivery } from "./capture-artifacts.js";
import type { RuntimeBuilderRun } from "./types.js";
import type { Env } from "../../types.js";

const run: RuntimeBuilderRun = {
	id: "run-1", instanceId: "instance-1", userId: "user-1", engine: "codex", status: "drafting",
	evidence: { engine: "codex", fwsTranscript: [], screenshots: [], refinementCount: 0, approvalState: "not_requested", offline: {} }, refinementCount: 0, createdAt: "now", updatedAt: "now",
};

describe("runtime Website Builder capture artifacts (#843)", () => {
	it("stores one bounded FWS image under a job-scoped digest and signs only a short-lived transfer URL", async () => {
		const puts: Array<{ key: string; bytes: Uint8Array }> = [];
		const env = { SESSION_SIGNING_KEY: "test-key", STORAGE: { put: async (key: string, bytes: Uint8Array) => { puts.push({ key, bytes }); } } } as unknown as Env;
		const artifact = await storeCaptureArtifact(env, run, { device: "desktop", viewport: { width: 1440, height: 900 } }, [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
		expect(puts).toHaveLength(1);
		expect(puts[0].key).toBe(captureObjectKey("user-1", "instance-1", "run-1", artifact.id));
		expect(artifact).toMatchObject({ device: "desktop", contentType: "image/png", bytes: 5, width: 1440, height: 900 });
		const transfer = await signedCaptureDelivery(env, run, artifact);
		expect(transfer.url).toContain("/site-builder/run-1/artifacts/");
		expect(JSON.stringify(artifact)).not.toContain("aW1hZ2U=");
		const url = new URL(transfer.url);
		expect(await verifyCaptureDelivery(env, { userId: "user-1", instanceId: "instance-1", runId: "run-1", artifactId: artifact.id, exp: url.searchParams.get("exp")!, token: url.searchParams.get("token")! })).toBe(true);
		expect(await verifyCaptureDelivery(env, { userId: "user-2", instanceId: "instance-1", runId: "run-1", artifactId: artifact.id, exp: url.searchParams.get("exp")!, token: url.searchParams.get("token")! })).toBe(false);
	});

	it("refuses malformed or multi-image capture responses before evidence can be written", async () => {
		const env = { SESSION_SIGNING_KEY: "test-key", STORAGE: { put: async () => undefined } } as unknown as Env;
		await expect(storeCaptureArtifact(env, run, { device: "mobile" }, [{ type: "image", data: "not base64", mimeType: "image/png" }])).rejects.toThrow(/base64/);
		await expect(storeCaptureArtifact(env, run, { device: "mobile" }, [{ type: "image", data: "aA==", mimeType: "image/png" }, { type: "image", data: "aQ==", mimeType: "image/png" }])).rejects.toThrow(/exactly one/);
	});

	it("leaves the caller retryable when artifact storage fails", async () => {
		let attempts = 0;
		const env = { SESSION_SIGNING_KEY: "test-key", STORAGE: { put: async () => { attempts += 1; if (attempts === 1) throw new Error("R2 unavailable"); } } } as unknown as Env;
		const input = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
		await expect(storeCaptureArtifact(env, run, { device: "desktop" }, input)).rejects.toThrow(/retry/i);
		await expect(storeCaptureArtifact(env, run, { device: "desktop" }, input)).resolves.toMatchObject({ device: "desktop", bytes: 5 });
		expect(attempts).toBe(2);
	});
});
