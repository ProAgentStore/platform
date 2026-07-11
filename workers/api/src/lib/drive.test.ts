import { describe, expect, it } from "vitest";
import { driveFileIdFromUrl } from "./drive.js";

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

	it("returns null for empty or non-url inputs", () => {
		expect(driveFileIdFromUrl("")).toBeNull();
		expect(driveFileIdFromUrl("not a url with spaces")).toBeNull();
	});
});
