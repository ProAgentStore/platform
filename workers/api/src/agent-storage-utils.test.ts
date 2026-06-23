import { describe, expect, it } from "vitest";
import type { CollectionSchema } from "./agent-storage-types.js";
import {
	bytesFromBase64,
	chunkText,
	encodeIndexValue,
	extractFileText,
	isTextMimeType,
	shortId,
	validateRecord,
} from "./agent-storage-utils.js";

const schema: CollectionSchema = {
	name: "candidates",
	fields: [
		{ name: "name", type: "string", required: true },
		{ name: "score", type: "number" },
		{ name: "active", type: "boolean" },
		{ name: "appliedAt", type: "date" },
		{ name: "metadata", type: "json" },
		{ name: "owner", type: "reference" },
		{ name: "stage", type: "string", default: "new" },
	],
	createdAt: "2026-06-23T00:00:00.000Z",
	updatedAt: "2026-06-23T00:00:00.000Z",
	recordCount: 0,
};

describe("agent storage utility helpers", () => {
	it("chunks text on sentence boundaries and filters tiny fragments", () => {
		const text = [
			"First sentence is long enough to keep.",
			"Second sentence is also long enough to keep.",
			"tiny.",
		].join(" ");

		expect(chunkText(text, 48)).toEqual([
			"First sentence is long enough to keep.",
			"Second sentence is also long enough to keep.",
		]);
	});

	it("hard-splits oversized text chunks and drops tiny tail fragments", () => {
		const text = "x".repeat(75);

		expect(chunkText(text, 30)).toEqual([
			"x".repeat(30),
			"x".repeat(30),
		]);
	});

	it("coerces schema fields, applies defaults, and preserves extra data", () => {
		const record = validateRecord(schema, {
			name: 123,
			score: "42.5",
			active: "yes",
			appliedAt: 1_779_750_000_000,
			metadata: { source: "upload" },
			owner: 99,
			extra: "kept",
		});

		expect(record).toMatchObject({
			name: "123",
			score: 42.5,
			active: true,
			appliedAt: "2026-05-25T23:00:00.000Z",
			metadata: { source: "upload" },
			owner: "99",
			stage: "new",
			extra: "kept",
		});
	});

	it("rejects invalid number fields", () => {
		expect(() => validateRecord(schema, { score: "not-a-number" })).toThrow(
			'Field "score" must be a number',
		);
	});

	it("classifies supported text MIME types", () => {
		expect(isTextMimeType("text/plain")).toBe(true);
		expect(isTextMimeType("application/json")).toBe(true);
		expect(isTextMimeType("application/xml")).toBe(true);
		expect(isTextMimeType("application/javascript")).toBe(true);
		expect(isTextMimeType("image/png")).toBe(false);
	});

	it("decodes base64 file payloads", () => {
		expect(new TextDecoder().decode(bytesFromBase64("aGVsbG8="))).toBe("hello");
		expect(new TextDecoder().decode(bytesFromBase64("data:text/plain;base64,aGVsbG8="))).toBe("hello");
	});

	it("extracts text files for indexing", async () => {
		await expect(
			extractFileText({
				name: "notes.md",
				mimeType: "text/markdown",
				data: "# Notes\nCandidate prefers mobile roles.",
			}),
		).resolves.toMatchObject({
			status: "extracted",
			text: "# Notes\nCandidate prefers mobile roles.",
		});
	});

	it("extracts simple text-layer PDF content", async () => {
		const pdf = `%PDF-1.4
1 0 obj
<< /Length 54 >>
stream
BT
/F1 12 Tf
72 720 Td
(Rafia Sarfaraz Mobile Developer) Tj
ET
endstream
endobj
%%EOF`;

		await expect(
			extractFileText({
				name: "resume.pdf",
				mimeType: "application/pdf",
				data: new TextEncoder().encode(pdf),
			}),
		).resolves.toMatchObject({
			status: "extracted",
			text: "Rafia Sarfaraz Mobile Developer",
		});
	});

	it("escapes index key separators without double-encoding escape markers", () => {
		expect(encodeIndexValue("a:b%c")).toBe("a%3Ab%25c");
	});

	it("generates compact deterministic vector IDs", async () => {
		const first = await shortId("agent-1", "file", "file-1", 0);
		const duplicate = await shortId("agent-1", "file", "file-1", 0);
		const nextChunk = await shortId("agent-1", "file", "file-1", 1);

		expect(first).toBe(duplicate);
		expect(first).toMatch(/^[0-9a-f]{12}_0$/);
		expect(first.length).toBeLessThanOrEqual(64);
		expect(nextChunk).not.toBe(first);
	});
});
