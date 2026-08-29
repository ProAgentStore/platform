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

// ── .docx test helpers ────────────────────────────────────────────────────────
//
// Build a minimal ZIP archive with one stored (method=0) entry so the
// extractDocxText path can be exercised without a real Word file on disk.

function u16le(n: number): Uint8Array {
	return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}
function u32le(n: number): Uint8Array {
	return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}
function concat(...arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((s, a) => s + a.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const a of arrays) { out.set(a, off); off += a.length; }
	return out;
}

/**
 * Build a minimal ZIP that contains one stored entry at the given path with
 * the given content bytes. Enough structure for our local-file-header walker.
 */
function buildStoredZip(entryName: string, content: Uint8Array): Uint8Array {
	const enc = new TextEncoder();
	const nameBytes = enc.encode(entryName);
	const crc = 0; // We skip CRC — the extractor doesn't validate it.

	// Local file header
	const localHeader = concat(
		new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // signature
		u16le(20),             // version needed
		u16le(0),              // general purpose bit flag
		u16le(0),              // compression method: stored
		u16le(0),              // last mod time
		u16le(0),              // last mod date
		u32le(crc),            // crc-32
		u32le(content.length), // compressed size
		u32le(content.length), // uncompressed size
		u16le(nameBytes.length),
		u16le(0),              // extra field length
		nameBytes,
		content,
	);

	// Central directory entry
	const cdEntry = concat(
		new Uint8Array([0x50, 0x4b, 0x01, 0x02]), // signature
		u16le(20),             // version made by
		u16le(20),             // version needed
		u16le(0),              // flag
		u16le(0),              // method: stored
		u16le(0),              // last mod time
		u16le(0),              // last mod date
		u32le(crc),            // crc-32
		u32le(content.length), // compressed size
		u32le(content.length), // uncompressed size
		u16le(nameBytes.length),
		u16le(0),              // extra length
		u16le(0),              // comment length
		u16le(0),              // disk start
		u16le(0),              // internal attr
		u32le(0),              // external attr
		u32le(0),              // local header offset
		nameBytes,
	);

	const cdOffset = localHeader.length;

	// End of central directory
	const eocd = concat(
		new Uint8Array([0x50, 0x4b, 0x05, 0x06]), // signature
		u16le(0),              // disk number
		u16le(0),              // disk with start of CD
		u16le(1),              // entries on this disk
		u16le(1),              // total entries
		u32le(cdEntry.length), // CD size
		u32le(cdOffset),       // CD offset
		u16le(0),              // comment length
	);

	return concat(localHeader, cdEntry, eocd);
}

/** Wrap paragraph text in minimal OOXML word/document.xml markup. */
function makeDocumentXml(paragraphs: string[]): string {
	const enc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const ps = paragraphs.map((p) => `<w:p><w:r><w:t>${enc(p)}</w:t></w:r></w:p>`).join("");
	return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${ps}</w:body></w:document>`;
}

/** Build a minimal .docx (stored ZIP) with the given paragraphs. */
function makeDocx(paragraphs: string[]): Uint8Array {
	const xml = makeDocumentXml(paragraphs);
	return buildStoredZip("word/document.xml", new TextEncoder().encode(xml));
}

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

	it("hard-splits oversized text and folds a tiny trailing remainder into the previous piece (no content loss)", () => {
		const text = "x".repeat(75);

		// 75 @ size 30 → 30 / 30 / 15; the 15-char tail is REAL content, so it's merged into
		// the previous piece rather than dropped by the >20 sentence-fragment filter.
		expect(chunkText(text, 30)).toEqual([
			"x".repeat(30),
			"x".repeat(45),
		]);
	});

	it("still drops a trivial standalone sentence fragment", () => {
		// "Hi." is forced into its own chunk (the next 30-char run overflows size 25) and,
		// standing alone at ≤20 chars, is filtered as noise — while the 30-char run's 5-char
		// hard-split tail is folded back in (so that content survives).
		expect(chunkText(`Hi. ${"y".repeat(30)}`, 25)).toEqual(["y".repeat(30)]);
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
(Test Candidate Software Engineer) Tj
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
			text: "Test Candidate Software Engineer",
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

	// ── .docx extraction ─────────────────────────────────────────────────────

	it("extracts text from a three-paragraph .docx", async () => {
		const paragraphs = [
			"First paragraph of the test document.",
			"Second paragraph with more content here.",
			"Third paragraph concludes the document.",
		];
		const docx = makeDocx(paragraphs);
		const result = await extractFileText({
			name: "report.docx",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			data: docx,
		});
		expect(result.status).toBe("extracted");
		expect(result.text).toContain("First paragraph of the test document.");
		expect(result.text).toContain("Second paragraph with more content here.");
		expect(result.text).toContain("Third paragraph concludes the document.");
		// Paragraphs appear in order.
		const idx1 = result.text.indexOf("First paragraph");
		const idx2 = result.text.indexOf("Second paragraph");
		const idx3 = result.text.indexOf("Third paragraph");
		expect(idx1).toBeLessThan(idx2);
		expect(idx2).toBeLessThan(idx3);
	});

	it("also extracts a .docx matched by file extension only (generic mime type)", async () => {
		const docx = makeDocx(["Hello from the extension-matched path."]);
		const result = await extractFileText({
			name: "notes.docx",
			mimeType: "application/octet-stream",
			data: docx,
		});
		expect(result.status).toBe("extracted");
		expect(result.text).toContain("Hello from the extension-matched path.");
	});

	it("extracts cell text from a .docx containing a table", async () => {
		// A table is represented as <w:tbl><w:tr><w:tc><w:p>…; our <w:t> scan
		// collects cell text just like paragraph text — order is row-major.
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:tbl>
<w:tr>
<w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>Score</w:t></w:r></w:p></w:tc>
</w:tr>
<w:tr>
<w:tc><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>95</w:t></w:r></w:p></w:tc>
</w:tr>
</w:tbl>
</w:body>
</w:document>`;
		const docx = buildStoredZip("word/document.xml", new TextEncoder().encode(xml));
		const result = await extractFileText({
			name: "table.docx",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			data: docx,
		});
		expect(result.status).toBe("extracted");
		expect(result.text).toContain("Name");
		expect(result.text).toContain("Score");
		expect(result.text).toContain("Alice");
		expect(result.text).toContain("95");
	});

	it("returns status:failed with an error for a truncated .docx ZIP", async () => {
		// Truncated after the local file header signature — the ZIP walker hits an
		// incomplete entry, finds no word/document.xml, and throws.
		const truncated = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
		const result = await extractFileText({
			name: "corrupt.docx",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			data: truncated,
		});
		// Corrupt ZIP: either failed (threw) or failed to find document.xml (also throws).
		expect(result.status).toBe("failed");
		expect(result.error).toBeTruthy();
	});

	it("returns status:failed for a file that has no ZIP signature", async () => {
		const garbage = new TextEncoder().encode("not a zip at all");
		const result = await extractFileText({
			name: "bad.docx",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			data: garbage,
		});
		expect(result.status).toBe("failed");
		expect(result.error).toContain("ZIP signature");
	});

	it("returns status:unsupported with a named-format error for a legacy .doc file", async () => {
		const result = await extractFileText({
			name: "old.doc",
			mimeType: "application/msword",
			data: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), // OLE2 magic
		});
		expect(result.status).toBe("unsupported");
		expect(result.error).toMatch(/\.doc/);
		expect(result.error).toMatch(/not supported/i);
	});
});
