import { describe, expect, it, vi } from "vitest";
import { shortHash, uploadedTailorReadinessMessage, uploadedTailorSourcesApi, type ApiRequest, type UploadedTailorReadiness } from "./uploadedTailorSources";

function readiness(overrides: Partial<UploadedTailorReadiness> = {}): UploadedTailorReadiness {
	return {
		mode: "uploaded",
		runner: { available: true },
		ready: false,
		blockers: ["resume:materialization_unsupported"],
		sources: [{
			role: "resume", selected: null, uploaded: false, extracted: false,
			availableToRunner: false, ready: false, isStale: false,
			provenance: null, blockers: ["not_selected", "materialization_unsupported"],
		}],
		...overrides,
	};
}

describe("uploaded Tailor source Console contract", () => {
	it("uses the owner-scoped Files and source-selection endpoints with an exact file id", async () => {
		const request = vi.fn(async () => ({}));
		const transport = request as unknown as ApiRequest;
		await uploadedTailorSourcesApi.listFiles(transport, "tailor/one");
		await uploadedTailorSourcesApi.listSelections(transport, "tailor/one");
		await uploadedTailorSourcesApi.readiness(transport, "tailor/one");
		await uploadedTailorSourcesApi.select(transport, "tailor/one", "resume", "file_123");
		await uploadedTailorSourcesApi.clear(transport, "tailor/one", "profile");

		expect(request.mock.calls).toEqual([
			["/v1/instances/tailor%2Fone/files"],
			["/v1/instances/tailor%2Fone/application-tailor/uploaded-sources"],
			["/v1/instances/tailor%2Fone/application-tailor/uploaded-sources/readiness"],
			["/v1/instances/tailor%2Fone/application-tailor/uploaded-sources/resume", { method: "PUT", body: JSON.stringify({ fileId: "file_123" }) }],
			["/v1/instances/tailor%2Fone/application-tailor/uploaded-sources/profile", { method: "DELETE" }],
		]);
	});

	it("reports server readiness truthfully and does not present a selected file as usable", () => {
		expect(uploadedTailorReadinessMessage(readiness())).toContain("not yet transferable");
		expect(uploadedTailorReadinessMessage(readiness({ blockers: ["runner_unavailable"], sources: [] }))).toContain("offline");
		expect(uploadedTailorReadinessMessage(readiness({ sources: [{ ...readiness().sources[0], isStale: true }] }))).toContain("changed or was deleted");
		expect(uploadedTailorReadinessMessage(readiness({ ready: true, blockers: [], sources: [] }))).toContain("ready for the runner");
		expect(shortHash("a".repeat(64))).toBe("aaaaaaaaaaaa…");
		expect(shortHash(null)).toBe("unavailable");
	});
});
