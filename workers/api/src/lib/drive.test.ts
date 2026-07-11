import { afterEach, describe, expect, it, vi } from "vitest";
import { driveFileDescendsFrom, driveFileIdFromUrl } from "./drive.js";

describe("driveFileIdFromUrl", () => {
	it("accepts a raw Drive file id", () => {
		expect(driveFileIdFromUrl("1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms")).toBe(
			"1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
		);
	});

	it("extracts Google Docs, Sheets, Slides, and binary file ids", () => {
		expect(driveFileIdFromUrl("https://docs.google.com/document/d/doc123/edit")).toBe("doc123");
		expect(driveFileIdFromUrl("https://docs.google.com/spreadsheets/d/sheet123/edit#gid=0")).toBe("sheet123");
		expect(driveFileIdFromUrl("https://docs.google.com/presentation/d/deck123/edit")).toBe("deck123");
		expect(driveFileIdFromUrl("https://drive.google.com/file/d/file123/view")).toBe("file123");
	});

	it("extracts open?id links", () => {
		expect(driveFileIdFromUrl("https://drive.google.com/open?id=file_456")).toBe("file_456");
	});

	it("extracts folder ids", () => {
		expect(driveFileIdFromUrl("https://drive.google.com/drive/folders/folder_789?usp=sharing")).toBe("folder_789");
	});

	it("returns null for empty or non-url inputs", () => {
		expect(driveFileIdFromUrl("")).toBeNull();
		expect(driveFileIdFromUrl("not a url with spaces")).toBeNull();
	});
});

describe("driveFileDescendsFrom", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("walks Drive parents to verify a file is under a granted folder", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				id: "file123456789",
				name: "notes.md",
				mimeType: "text/markdown",
				parents: ["childFolder123"],
			}), { status: 200, headers: { "content-type": "application/json" } }))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				id: "childFolder123",
				name: "Child",
				mimeType: "application/vnd.google-apps.folder",
				parents: ["rootFolder123"],
			}), { status: 200, headers: { "content-type": "application/json" } }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(driveFileDescendsFrom("token", "file123456789", "rootFolder123")).resolves.toBe(true);
	});
});
