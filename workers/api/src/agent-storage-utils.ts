import type { CollectionSchema } from "./agent-storage-types.js";

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
				result.push(chunk.slice(i, i + size));
			}
		}
	}

	return result.filter((c) => c.length > 20); // Skip tiny fragments
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

