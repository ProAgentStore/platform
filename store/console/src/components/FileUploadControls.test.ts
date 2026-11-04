import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import FileUploadControls, { uploadSelectedFiles } from "./FileUploadControls";

describe("shared resumable Files picker", () => {
	it("passes every selected document into the Files uploader without treating small Markdown as knowledge", () => {
		const resume = new File(["resume"], "resume.pdf", { type: "application/pdf" });
		const profile = new File(["profile"], "profile.md", { type: "text/markdown" });
		const input = { files: [resume, profile], value: "selected" };
		const upload = vi.fn();
		uploadSelectedFiles(input, upload);
		expect(upload.mock.calls).toEqual([[resume], [profile]]);
		expect(input.value).toBe("");
	});
	it("shows multi-file selection and the existing resumable state controls", () => {
		const html = renderToStaticMarkup(createElement(FileUploadControls, {
			title: "Upload source documents", onUpload: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), onCancel: vi.fn(),
			jobs: [{ localId: "one", fileName: "profile.md", size: 1024, uploaded: 512, status: "paused" }],
		}));
		expect(html).toContain('type="file" multiple=""');
		expect(html).toContain("Upload source documents");
		expect(html).toContain("profile.md");
		expect(html).toContain("Resume");
		expect(html).toContain("Cancel");
	});
});
