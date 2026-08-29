import type { CollectionField, CollectionSchema } from "./agent-storage-types.js";
import { extractText as extractPdfTextWithPdfJs } from "unpdf";

// ── Helpers ─────────────────────────────────────────────────────────────────

export function chunkText(text: string, size: number): string[] {
	const chunks: string[] = [];
	// Split on sentence boundaries when possible
	const sentences = text.split(/(?<=[.!?])\s+/);
	let current = "";

	for (const sentence of sentences) {
		if (current.length + sentence.length > size && current.length > 0) {
			chunks.push(current.trim());
			current = "";
		}
		current += `${sentence} `;
	}
	if (current.trim()) chunks.push(current.trim());

	// If any chunk is still too large, hard-split
	const result: string[] = [];
	for (const chunk of chunks) {
		if (chunk.length <= size) {
			result.push(chunk);
		} else {
			for (let i = 0; i < chunk.length; i += size) {
				const piece = chunk.slice(i, i + size);
				// A hard split can leave a short trailing remainder (e.g. a 1044-char run at
				// size 512 → 512/512/20). The `> 20` filter below is meant to drop trivial
				// SENTENCE fragments, but it would also silently discard this real tail — so
				// fold a tiny remainder back into the previous piece instead of losing content.
				if (piece.length <= 20 && result.length > 0) result[result.length - 1] += piece;
				else result.push(piece);
			}
		}
	}

	return result.filter((c) => c.length > 20); // Skip tiny (sentence-split) fragments
}

export function validateRecord(
	schema: CollectionSchema,
	data: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const field of schema.fields) {
		const value = data[field.name];

		if (value === undefined || value === null) {
			// Required is soft — log but don't crash (AI tools often omit fields)
			if (field.default !== undefined) {
				result[field.name] = field.default;
			}
			continue;
		}

		// Type coercion/validation
		switch (field.type) {
			case "string":
				result[field.name] = String(value).slice(0, 10_000);
				break;
			case "number": {
				const num = Number(value);
				if (Number.isNaN(num)) throw new Error(`Field "${field.name}" must be a number`);
				result[field.name] = num;
				break;
			}
			case "boolean":
				result[field.name] = Boolean(value);
				break;
			case "date":
				result[field.name] = typeof value === "string" ? value : new Date(value as number).toISOString();
				break;
			case "json":
				result[field.name] = value;
				break;
			case "reference":
				result[field.name] = String(value);
				break;
		}
	}

	// Allow extra fields not in schema (flexible mode)
	for (const [key, value] of Object.entries(data)) {
		if (!(key in result)) {
			result[key] = value;
		}
	}

	return result;
}

/**
 * Infer a collection schema from a record's data, so `insert_record` into a
 * not-yet-created collection can auto-create one instead of failing (issue #140).
 * Types are best-effort; no field is indexed/unique/required (a forgiving default).
 */
export function inferCollectionFields(data: Record<string, unknown>): CollectionField[] {
	return Object.entries(data).map(([name, value]): CollectionField => {
		let type: CollectionField["type"] = "string";
		if (typeof value === "number") type = "number";
		else if (typeof value === "boolean") type = "boolean";
		else if (value !== null && typeof value === "object") type = "json";
		return { name, type };
	});
}

export function isTextMimeType(mimeType: string): boolean {
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml" ||
		mimeType === "application/javascript"
	);
}

export function bytesFromBase64(value: string): Uint8Array {
	const clean = value.replace(/^data:[^,]+,/, "").replace(/\s/g, "");
	const binary = atob(clean);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export interface ExtractedFileText {
	text: string;
	status: "none" | "extracted" | "unsupported" | "failed";
	error?: string;
}

export async function extractFileText(input: {
	name: string;
	mimeType: string;
	data: string | ArrayBuffer | Uint8Array;
}): Promise<ExtractedFileText> {
	try {
		const bytes = fileBytes(input.data);
		const mimeType = input.mimeType.toLowerCase();
		const name = input.name.toLowerCase();
		if (isTextMimeType(mimeType) || /\.(txt|md|csv|json|html?|xml|js|ts|css)$/i.test(name)) {
			const text = new TextDecoder("utf-8").decode(bytes).trim();
			return text ? { text, status: "extracted" } : { text: "", status: "none" };
		}
		if (mimeType === "application/pdf" || name.endsWith(".pdf")) {
			const text = await extractPdfText(bytes);
			return text ? { text, status: "extracted" } : { text: "", status: "unsupported" };
		}
		if (
			mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
			name.endsWith(".docx")
		) {
			const text = await extractDocxText(bytes);
			return text ? { text, status: "extracted" } : { text: "", status: "none" };
		}
		if (
			mimeType === "application/msword" ||
			mimeType === "application/vnd.ms-word" ||
			name.endsWith(".doc")
		) {
			return {
				text: "",
				status: "unsupported",
				error: "This is a legacy Word (.doc) document. The .doc format is not supported — upload a .docx file instead.",
			};
		}
		return { text: "", status: "unsupported" };
	} catch (error) {
		return {
			text: "",
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function fileBytes(data: string | ArrayBuffer | Uint8Array): Uint8Array {
	if (typeof data === "string") return new TextEncoder().encode(data);
	if (data instanceof Uint8Array) return data;
	return new Uint8Array(data);
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
	const pdfJsText = await extractPdfTextViaPdfJs(bytes);
	if (pdfJsText) return pdfJsText;
	const raw = latin1(bytes);
	const parts: string[] = [];
	const streamRegex = /<<(.*?)>>\s*stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
	for (const match of raw.matchAll(streamRegex)) {
		const dict = match[1] || "";
		const body = match[2] || "";
		let stream = body;
		if (/\/FlateDecode\b/.test(dict)) {
			const decompressed = await inflatePdfStream(latin1Bytes(body));
			if (!decompressed) continue;
			stream = latin1(decompressed);
		}
		parts.push(...pdfTextStrings(stream));
	}
	if (parts.length === 0) parts.push(...pdfTextStrings(raw));
	const text = normalizeExtractedText(parts.join(" "));
	return isReadableExtractedText(text) ? text : "";
}

async function extractPdfTextViaPdfJs(bytes: Uint8Array): Promise<string> {
	try {
		const result = await extractPdfTextWithPdfJs(new Uint8Array(bytes), { mergePages: true });
		const text = normalizeExtractedText(result.text);
		return isReadableExtractedText(text) ? text : "";
	} catch {
		return "";
	}
}

async function inflatePdfStream(bytes: Uint8Array): Promise<Uint8Array | null> {
	try {
		const ds = new DecompressionStream("deflate");
		const writer = ds.writable.getWriter();
		await writer.write(bytes);
		await writer.close();
		return new Uint8Array(await new Response(ds.readable).arrayBuffer());
	} catch {
		return null;
	}
}

// ── .docx extraction ─────────────────────────────────────────────────────────
//
// A .docx is a ZIP archive. Text lives in `word/document.xml` as `<w:t>` runs
// separated by paragraph (`<w:p>`) boundaries.
//
// We walk the ZIP local-file-header chain (same sequential approach as readTar
// in repo-ingest.ts — no central-directory seek required). Method 0 = stored,
// method 8 = deflate-raw. Both are represented; real Word output always uses
// deflate for document.xml.
//
// Size caps match the repo-ingest discipline: the decompressed document.xml is
// capped at DOCX_MAX_XML_BYTES before parsing. The whole input is already
// bounded upstream by the 12 MB fileUpload limit.

const DOCX_MAX_XML_BYTES = 4 * 1024 * 1024; // 4 MB decompressed
const DOCX_MAX_MEMBERS = 512; // ZIP member iteration guard

function u16le(b: Uint8Array, o: number): number {
	return b[o] | (b[o + 1] << 8);
}
function u32le(b: Uint8Array, o: number): number {
	return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

async function extractDocxText(bytes: Uint8Array): Promise<string> {
	// Validate ZIP signature.
	if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
		throw new Error("Not a valid .docx file (missing ZIP signature)");
	}

	const dec = new TextDecoder();
	let offset = 0;
	let members = 0;

	while (offset + 30 <= bytes.length) {
		const sig = u32le(bytes, offset);
		// 0x04034b50 = local file header
		// 0x02014b50 = central directory header (end of local entries)
		// 0x06054b50 = end of central directory
		if (sig === 0x02014b50 || sig === 0x06054b50) break;
		if (sig !== 0x04034b50) {
			// Unknown signature — skip one byte and try again (handles alignment issues).
			offset++;
			continue;
		}
		if (++members > DOCX_MAX_MEMBERS) break;

		const method = u16le(bytes, offset + 8);
		const compressedSize = u32le(bytes, offset + 18);
		const fileNameLen = u16le(bytes, offset + 26);
		const extraLen = u16le(bytes, offset + 28);

		const nameStart = offset + 30;
		const nameEnd = nameStart + fileNameLen;
		if (nameEnd > bytes.length) break;

		const entryName = dec.decode(bytes.subarray(nameStart, nameEnd));
		const dataStart = nameEnd + extraLen;
		const dataEnd = dataStart + compressedSize;
		if (dataEnd > bytes.length) break;
		offset = dataEnd;

		if (entryName !== "word/document.xml") continue;

		const compressed = bytes.subarray(dataStart, dataEnd);
		let xml: Uint8Array;
		if (method === 0) {
			// Stored — no compression.
			xml = compressed;
		} else if (method === 8) {
			// Deflate-raw — same primitive used by inflatePdfStream.
			const ds = new DecompressionStream("deflate-raw");
			const writer = ds.writable.getWriter();
			await writer.write(compressed);
			await writer.close();
			const chunks: Uint8Array[] = [];
			let total = 0;
			const reader = ds.readable.getReader();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (!value) continue;
				total += value.byteLength;
				if (total > DOCX_MAX_XML_BYTES) {
					await reader.cancel().catch(() => undefined);
					throw new Error("word/document.xml exceeds the extraction size limit");
				}
				chunks.push(value);
			}
			const out = new Uint8Array(total);
			let off = 0;
			for (const c of chunks) { out.set(c, off); off += c.byteLength; }
			xml = out;
		} else {
			// Unsupported compression method — return empty, not an error.
			return "";
		}

		return extractDocxXmlText(dec.decode(xml));
	}

	// word/document.xml not found — truncated or not a Word file.
	throw new Error("word/document.xml not found in .docx archive");
}

/**
 * Extract readable text from a OOXML word/document.xml string.
 * - `<w:p>` elements become paragraph breaks.
 * - `<w:t>` runs contribute their text content.
 * - All other markup is ignored.
 */
function extractDocxXmlText(xml: string): string {
	// Split on paragraph boundaries first.
	const paraRe = /<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g;
	const paragraphs: string[] = [];
	let hasParagraphs = false;

	for (const pMatch of xml.matchAll(paraRe)) {
		hasParagraphs = true;
		const paraXml = pMatch[0];
		const runs: string[] = [];
		for (const tMatch of paraXml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) {
			const t = tMatch[1];
			if (t) runs.push(t);
		}
		const line = runs.join("").trimEnd();
		if (line) paragraphs.push(line);
	}

	if (hasParagraphs) {
		return paragraphs.join("\n").trim();
	}

	// Fallback: no <w:p> structure — just collect all <w:t> content.
	const runs: string[] = [];
	for (const tMatch of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) {
		if (tMatch[1]) runs.push(tMatch[1]);
	}
	return runs.join(" ").trim();
}

function pdfTextStrings(value: string): string[] {
	const chunks: string[] = [];
	for (const match of value.matchAll(/\((?:\\.|[^\\)])*\)|<([0-9a-fA-F\s]{4,})>/g)) {
		const token = match[0];
		if (token.startsWith("(")) chunks.push(decodePdfLiteral(token.slice(1, -1)));
		else chunks.push(decodePdfHex(match[1] || ""));
	}
	return chunks.filter((chunk) => /[A-Za-z0-9]/.test(chunk));
}

function decodePdfLiteral(value: string): string {
	return value
		.replace(/\\([nrtbf()\\])/g, (_, ch: string) => {
			if (ch === "n") return "\n";
			if (ch === "r") return "\r";
			if (ch === "t") return "\t";
			if (ch === "b") return "\b";
			if (ch === "f") return "\f";
			return ch;
		})
		.replace(/\\([0-7]{1,3})/g, (_, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));
}

function decodePdfHex(value: string): string {
	const hex = value.replace(/\s/g, "");
	if (!hex) return "";
	const evenHex = hex.length % 2 === 0 ? hex : `${hex}0`;
	const bytes = new Uint8Array(evenHex.length / 2);
	for (let i = 0; i < evenHex.length; i += 2) {
		bytes[i / 2] = Number.parseInt(evenHex.slice(i, i + 2), 16);
	}
	if (bytes[0] === 0xfe && bytes[1] === 0xff) {
		let out = "";
		for (let i = 2; i + 1 < bytes.length; i += 2) {
			out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
		}
		return out;
	}
	return new TextDecoder("utf-8").decode(bytes);
}

function latin1(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return out;
}

function latin1Bytes(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length);
	for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
	return bytes;
}

function normalizeExtractedText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function isReadableExtractedText(value: string): boolean {
	if (value.length < 4) return false;
	const sample = value.slice(0, 4000);
	const printable = [...sample].filter((char) => {
		const code = char.charCodeAt(0);
		return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
	}).length;
	const letters = (sample.match(/[A-Za-z]/g) || []).length;
	return printable / sample.length > 0.9 && letters >= Math.min(8, sample.length / 4);
}

/**
 * Encode a value for use in index keys. Replaces `:` with `%3A` to avoid
 * key structure ambiguity (index format: `idx:{col}:{field}:{value}:{id}`).
 */
export function encodeIndexValue(value: string): string {
	return value.replace(/%/g, "%25").replace(/:/g, "%3A");
}

/**
 * Generate a short (<= 64 byte) deterministic ID for Vectorize.
 * Uses first 12 chars of a SHA-256 hash + chunk index.
 */
/** Delete many DO storage keys, batched under the 128-keys-per-delete limit. */
export async function deleteKeysBatched(store: DurableObjectStorage, keys: string[]): Promise<void> {
	for (let i = 0; i < keys.length; i += 128) await store.delete(keys.slice(i, i + 128));
}

export async function shortId(
	agentId: string,
	sourceType: string,
	sourceId: string,
	chunkIndex: number,
): Promise<string> {
	const input = `${agentId}:${sourceType}:${sourceId}`;
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest("SHA-256", data);
	const hex = [...new Uint8Array(hash)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	// 12 hex chars (48 bits) + separator + chunk index = well under 64 bytes
	return `${hex.slice(0, 12)}_${chunkIndex}`;
}
