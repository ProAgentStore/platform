import type { CollectionSchema } from "./agent-storage-types.js";
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
