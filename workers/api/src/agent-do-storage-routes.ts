/**
 * The DO routes that are nothing but the storage engine — collections, records, files,
 * vector search, activity, summaries, user context.
 *
 * Each one is a pure function of (engine, input) → Response: it reads no DO state, holds
 * none of its own, and never touches the conversation, the in-flight turn markers or the
 * WebSockets. That is why it can live outside AgentDO — the caller resolves the engine (and
 * answers 404 for an uninitialised DO), these decide the request shape, the status codes and
 * the response body. Each takes the NARROWEST slice of the engine it uses (`Pick<…>`), so a
 * test can hand it a two-line fake instead of a Durable Object.
 *
 * The `https://agent/*` route contract is unchanged: the paths and methods still live in the
 * one routing table in `agent-do.ts`.
 */
import type { AgentStorageEngine } from "./agent-storage.js";
import { bytesFromBase64 } from "./agent-storage-utils.js";
import type { ActivityEvent, CollectionField } from "./agent-storage-types.js";
import { json } from "./lib/do-json.js";

// ── Collections ─────────────────────────────────────────────────────────────

export async function listCollections(
	engine: Pick<AgentStorageEngine, "collectionList">,
): Promise<Response> {
	const collections = await engine.collectionList();
	return json({ collections });
}

export async function createCollection(
	engine: Pick<AgentStorageEngine, "collectionCreate">,
	request: Request,
): Promise<Response> {
	const { name, fields } = await request.json<{ name: string; fields: unknown[] }>();
	if (!name || !fields) return json({ error: "name and fields required" }, 400);
	const schema = await engine.collectionCreate(name, fields as CollectionField[]);
	return json(schema, 201);
}

export async function getCollection(
	engine: Pick<AgentStorageEngine, "collectionGet">,
	name: string,
): Promise<Response> {
	const schema = await engine.collectionGet(decodeURIComponent(name));
	return schema ? json(schema) : json({ error: "Not found" }, 404);
}

export async function deleteCollection(
	engine: Pick<AgentStorageEngine, "collectionDelete">,
	name: string,
): Promise<Response> {
	await engine.collectionDelete(decodeURIComponent(name));
	return json({ success: true });
}

// ── Records ─────────────────────────────────────────────────────────────────

export async function queryRecords(
	engine: Pick<AgentStorageEngine, "recordQuery">,
	collection: string,
	url: URL,
): Promise<Response> {
	const where = url.searchParams.get("where");
	const result = await engine.recordQuery(decodeURIComponent(collection), {
		where: where ? JSON.parse(where) : undefined,
		orderBy: url.searchParams.get("order_by") || undefined,
		orderDir: (url.searchParams.get("order_dir") as "asc" | "desc") || undefined,
		limit: Number(url.searchParams.get("limit")) || 50,
		offset: Number(url.searchParams.get("offset")) || 0,
	});
	return json(result);
}

export async function insertRecord(
	engine: Pick<AgentStorageEngine, "recordInsert">,
	collection: string,
	request: Request,
): Promise<Response> {
	const { data } = await request.json<{ data: Record<string, unknown> }>();
	if (!data) return json({ error: "data required" }, 400);
	const record = await engine.recordInsert(decodeURIComponent(collection), data);
	return json(record, 201);
}

export async function getRecord(
	engine: Pick<AgentStorageEngine, "recordGet">,
	collection: string,
	id: string,
): Promise<Response> {
	const record = await engine.recordGet(decodeURIComponent(collection), decodeURIComponent(id));
	return record ? json(record) : json({ error: "Not found" }, 404);
}

export async function updateRecord(
	engine: Pick<AgentStorageEngine, "recordUpdate">,
	collection: string,
	id: string,
	request: Request,
): Promise<Response> {
	const { data } = await request.json<{ data: Record<string, unknown> }>();
	if (!data) return json({ error: "data required" }, 400);
	const record = await engine.recordUpdate(
		decodeURIComponent(collection),
		decodeURIComponent(id),
		data,
	);
	return record ? json(record) : json({ error: "Not found" }, 404);
}

export async function deleteRecord(
	engine: Pick<AgentStorageEngine, "recordDelete">,
	collection: string,
	id: string,
): Promise<Response> {
	const deleted = await engine.recordDelete(
		decodeURIComponent(collection),
		decodeURIComponent(id),
	);
	return deleted ? json({ success: true }) : json({ error: "Not found" }, 404);
}

// ── Files ───────────────────────────────────────────────────────────────────

export async function listFiles(
	engine: Pick<AgentStorageEngine, "fileList">,
	url: URL,
): Promise<Response> {
	const tags = url.searchParams.get("tags")?.split(",").filter(Boolean);
	const files = await engine.fileList({
		userId: url.searchParams.get("user_id") || undefined,
		tags: tags?.length ? tags : undefined,
		mimeType: url.searchParams.get("mime_type") || undefined,
	});
	return json({ files });
}

export async function uploadFile(
	engine: Pick<AgentStorageEngine, "fileUpload">,
	request: Request,
): Promise<Response> {
	const body = await request.json<{
		name: string;
		content: string;
		contentBase64?: string;
		mime_type?: string;
		path?: string;
		tags?: string[];
		user_id?: string;
		extract_text?: boolean;
	}>();
	if (!body.name || (!body.content && !body.contentBase64))
		return json({ error: "name and content or contentBase64 required" }, 400);
	const data = body.contentBase64
		? bytesFromBase64(body.contentBase64).slice().buffer
		: body.content;
	const meta = await engine.fileUpload({
		name: body.name,
		path: body.path,
		mimeType: body.mime_type || "text/plain",
		data,
		userId: body.user_id,
		tags: body.tags,
		extractText: body.extract_text !== false,
	});
	return json(meta, 201);
}

/** Register an object the multipart upload already placed in R2 (see fileRegister). */
export async function registerFile(
	engine: Pick<AgentStorageEngine, "fileRegister">,
	request: Request,
): Promise<Response> {
	const body = await request.json<{
		id: string;
		name: string;
		r2_key: string;
		mime_type?: string;
		user_id?: string;
	}>();
	if (!body.id || !body.name || !body.r2_key)
		return json({ error: "id, name, r2_key required" }, 400);
	const meta = await engine.fileRegister({
		id: body.id,
		name: body.name,
		r2Key: body.r2_key,
		mimeType: body.mime_type || "application/octet-stream",
		userId: body.user_id,
	});
	if (!meta) return json({ error: "Object not found in storage" }, 404);
	return json(meta, 201);
}

export async function getFile(
	engine: Pick<AgentStorageEngine, "fileGet">,
	id: string,
): Promise<Response> {
	const file = await engine.fileGet(decodeURIComponent(id));
	if (!file) return json({ error: "Not found" }, 404);
	return new Response(file.body, {
		headers: {
			"Content-Type": file.meta.mimeType,
			"Content-Disposition": `inline; filename="${file.meta.name}"`,
			"X-File-Meta": JSON.stringify({
				id: file.meta.id,
				name: file.meta.name,
				size: file.meta.size,
				tags: file.meta.tags,
			}),
		},
	});
}

export async function deleteFile(
	engine: Pick<AgentStorageEngine, "fileDelete">,
	id: string,
): Promise<Response> {
	const deleted = await engine.fileDelete(decodeURIComponent(id));
	return deleted ? json({ success: true }) : json({ error: "Not found" }, 404);
}

// ── Vector search ───────────────────────────────────────────────────────────

export async function vectorSearch(
	engine: Pick<AgentStorageEngine, "vectorSearch">,
	request: Request,
): Promise<Response> {
	const { query, top_k, source_type } = await request.json<{
		query: string;
		top_k?: number;
		source_type?: string;
	}>();
	if (!query) return json({ error: "query required" }, 400);
	const results = await engine.vectorSearch(query, top_k || 5, {
		sourceType: source_type as "knowledge" | "message" | "file" | "collection" | undefined,
	});
	return json({ results });
}

/** What's in the vector store, grouped by source — the Knowledge → Index panel. */
export async function vectorStats(
	engine: Pick<AgentStorageEngine, "vectorStats">,
): Promise<Response> {
	return json(await engine.vectorStats());
}

// ── Activity log ────────────────────────────────────────────────────────────

export async function getActivity(
	engine: Pick<AgentStorageEngine, "getEvents">,
	url: URL,
): Promise<Response> {
	const events = await engine.getEvents({
		limit: Number(url.searchParams.get("limit")) || 50,
		type: url.searchParams.get("type") as ActivityEvent["type"] | undefined,
		userId: url.searchParams.get("user_id") || undefined,
	});
	return json({ events });
}

// ── Summaries ───────────────────────────────────────────────────────────────

export async function getSummaries(
	engine: Pick<AgentStorageEngine, "getSummaries">,
	url: URL,
): Promise<Response> {
	const limit = Number(url.searchParams.get("limit")) || 20;
	const summaries = await engine.getSummaries(limit);
	return json({ summaries });
}

export async function forceSummarize(
	engine: Pick<AgentStorageEngine, "maybeSummarize">,
	model: string,
): Promise<Response> {
	const summary = await engine.maybeSummarize(model);
	return summary
		? json({ summary })
		: json({ message: "Not enough messages to summarize" });
}

// ── User context ────────────────────────────────────────────────────────────

export async function getUserContext(
	engine: Pick<AgentStorageEngine, "getUserContext">,
	userId: string,
): Promise<Response> {
	const ctx = await engine.getUserContext(decodeURIComponent(userId));
	return json(ctx);
}
