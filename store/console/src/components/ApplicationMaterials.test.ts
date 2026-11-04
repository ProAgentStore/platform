import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApplicationArtifactHandle } from "../lib/types";
import ApplicationMaterials, { storedApplicationMaterial } from "./ApplicationMaterials";

const legacy: ApplicationArtifactHandle = { kind: "resume", path: "~/jobs/old/resume.md", sha256: "a".repeat(64), bytes: 123 };
const stored: ApplicationArtifactHandle = { ...legacy, cloud: { instanceId: "tailor-1", fileId: "file-1", name: "AFCA résumé.md", version: "v1", sha256: legacy.sha256, bytes: legacy.bytes } };
const render = (resume: ApplicationArtifactHandle) => renderToStaticMarkup(createElement(ApplicationMaterials, { artifacts: { resume, coverLetter: null }, profileVersion: "profile-1" }));

describe("application document storage receipts", () => {
	it("shows a verified cloud document by filename without presenting its legacy path as the download", () => {
		const html = render(stored);
		expect(html).toContain("AFCA résumé.md");
		expect(html).toContain("Stored in PAGS");
		expect(html).toContain("Preview / download");
		expect(html).toContain("Availability is checked again before each run");
		expect(html).not.toContain(legacy.path);
		expect(storedApplicationMaterial(stored)).toMatchObject({ instanceId: "tailor-1", fileId: "file-1" });
	});
	it("keeps old local artifacts understandable and explains the cloud recovery", () => {
		const html = render(legacy);
		expect(html).toContain(legacy.path);
		expect(html).toContain("Upload your source documents to Application Tailor");
		expect(html).not.toContain("Stored in PAGS");
		expect(html).not.toContain("Preview / download");
	});
	it.each([{ sha256: "b".repeat(64) }, { bytes: 456 }, { version: "" }, { fileId: "" }])("does not offer another or unverifiable file as this reviewed material: %j", (change) => {
		const artifact = { ...stored, cloud: { ...stored.cloud!, ...change } };
		expect(storedApplicationMaterial(artifact)).toBeNull();
		expect(render(artifact)).not.toContain("Stored in PAGS");
		expect(render(artifact)).toContain("receipt does not match");
	});
});
