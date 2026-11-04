/** Internal exact-byte Files read for application document transport (#1468). */
import type { AgentStorageEngine } from "./agent-storage.js";
import { sha256Hex } from "./agent-storage-utils.js";
import { PORTABLE_DOCUMENT_BYTES } from "./lib/local-artifact/document-contract.js";

export async function materializeApplicationDocument(engine: Pick<AgentStorageEngine, "fileGet">, id: string, request: Request): Promise<Response> {
	const input = await request.json<{ user_id?: string; version?: string; sha256?: string; bytes?: number }>().catch(() => null);
	if (!input?.user_id || !input.version || !input.sha256 || typeof input.bytes !== "number" || !Number.isInteger(input.bytes) || input.bytes <= 0 || input.bytes > PORTABLE_DOCUMENT_BYTES) return Response.json({ error: "Exact document provenance is required." }, { status: 400 });
	const file = await engine.fileGet(decodeURIComponent(id));
	if (!file || file.meta.userId !== input.user_id) return Response.json({ error: "Document unavailable." }, { status: 404 });
	if (file.meta.r2Version !== input.version || file.meta.originalSha256 !== input.sha256 || file.meta.size !== input.bytes) return Response.json({ error: "Document version changed." }, { status: 409 });
	const reader = new Response(file.body).body?.getReader();
	if (!reader) return Response.json({ error: "Document unavailable." }, { status: 404 });
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		length += chunk.value.byteLength;
		if (length > input.bytes) { await reader.cancel(); return Response.json({ error: "Document bytes changed." }, { status: 409 }); }
		chunks.push(chunk.value);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	if (bytes.byteLength !== input.bytes || await sha256Hex(bytes.buffer) !== input.sha256) return Response.json({ error: "Document bytes changed." }, { status: 409 });
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return Response.json({ contentBase64: btoa(binary) });
}
