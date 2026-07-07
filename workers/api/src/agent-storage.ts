/**
 * Agent Storage Engine — manages all persistent data for an agent DO.
 *
 * Layers:
 * - DO storage: structured records, memory, conversations, activity log
 * - R2: binary file storage (resumes, documents, media)
 * - Vectorize: semantic embeddings for RAG retrieval
 */
import type {
	ActivityEvent,
	CollectionField,
	CollectionRecord,
	CollectionSchema,
	ConversationSummary,
	ExtractedFact,
	FileMeta,
	UserContext,
	VectorMeta,
	VectorSearchResult,
} from "./agent-storage-types.js";
import type { AgentMessage, KnowledgeDoc, MemoryEntry } from "./agent-types.js";
import { chunkText, deleteKeysBatched, encodeIndexValue, extractFileText, shortId, validateRecord } from "./agent-storage-utils.js";

const MAX_EVENTS = 500;
const SUMMARY_THRESHOLD = 20;
const MAX_COLLECTION_RECORDS = 10_000;
const MAX_COLLECTIONS = 50;
const CHUNK_SIZE = 512; // characters per vector chunk

export class AgentStorageEngine {
	constructor(
		private doStorage: DurableObjectStorage,
		private r2: R2Bucket | null,
		private vectorize: VectorizeIndex | null,
		private ai: Ai | null,
		private agentId: string,
	) {}

	// ── Vector Storage ────────────────────────────────────────────────────────

	/**
	 * Embed and store text chunks in Vectorize for semantic retrieval.
	 */
	async vectorizeStore(
		sourceType: VectorMeta["sourceType"],
		sourceId: string,
		text: string,
	): Promise<string[]> {
		if (!this.vectorize || !this.ai) return [];

		const chunks = chunkText(text, CHUNK_SIZE);
		// chunkText drops fragments ≤20 chars, so a very short doc yields zero chunks and
		// would be silently unsearchable while reporting success. Keep it as one chunk.
		if (chunks.length === 0 && text.trim()) chunks.push(text.trim());
		const ids: string[] = [];
		let failed = 0;

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			// Vectorize IDs max 64 bytes — use a short hash
			const id = await shortId(this.agentId, sourceType, sourceId, i);
			const embedding = await this.embed(chunk);
			// AI is configured (guarded above), so a null embedding is a real failure —
			// count it and fail loudly at the end. Silently skipping a chunk here is how
			// content ends up persisted but unsearchable with the caller told "success".
			if (!embedding) {
				failed++;
				continue;
			}

			await this.vectorize.upsert([
				{
					id,
					values: embedding,
					metadata: {
						agentId: this.agentId,
						sourceType,
						sourceId,
						chunkIndex: i,
						text: chunk.slice(0, 1000),
					},
				},
			]);

			const meta: VectorMeta = {
				id,
				agentId: this.agentId,
				sourceType,
				sourceId,
				chunkIndex: i,
				text: chunk,
				createdAt: new Date().toISOString(),
			};
			await this.doStorage.put(`vec:${id}`, meta);
			ids.push(id);
		}

		if (failed > 0)
			throw new Error(
				`vectorization incomplete: ${failed}/${chunks.length} chunks could not be embedded — content is not fully searchable`,
			);
		return ids;
	}

	/**
	 * Semantic search across all agent vectors.
	 */
	async vectorSearch(
		query: string,
		topK = 5,
		filter?: { sourceType?: VectorMeta["sourceType"] },
	): Promise<VectorSearchResult[]> {
		if (!this.vectorize || !this.ai) return [];

		const embedding = await this.embed(query);
		if (!embedding) return [];

		const vectorFilter: VectorizeVectorMetadataFilter = {
			agentId: this.agentId,
		};
		if (filter?.sourceType) {
			vectorFilter.sourceType = filter.sourceType;
		}

		const results = await this.vectorize.query(embedding, {
			topK,
			filter: vectorFilter,
			returnMetadata: "all",
		});

		return results.matches.map((match) => ({
			id: match.id,
			score: match.score,
			text: (match.metadata?.text as string) || "",
			sourceType: (match.metadata?.sourceType as VectorMeta["sourceType"]) || "knowledge",
			sourceId: (match.metadata?.sourceId as string) || "",
		}));
	}

	/**
	 * Remove all vectors for a given source.
	 */
	async vectorDelete(sourceType: VectorMeta["sourceType"], sourceId: string): Promise<void> {
		if (!this.vectorize) return;

		// Find vector entries by scanning DO storage for matching metadata
		const all = await this.doStorage.list<VectorMeta>({ prefix: "vec:" });
		const toDelete: string[] = [];
		const keysToDelete: string[] = [];
		for (const [key, meta] of all.entries()) {
			if (meta.agentId === this.agentId && meta.sourceType === sourceType && meta.sourceId === sourceId) {
				toDelete.push(meta.id);
				keysToDelete.push(key);
			}
		}

		if (toDelete.length > 0) {
			await this.vectorize.deleteByIds(toDelete);
			await deleteKeysBatched(this.doStorage, keysToDelete);
		}
	}

	// ── Repo ingestion (read-only code indexing) ───────────────────────────────

	/**
	 * Vectorize one repository file. The repo + file path is prepended to EVERY
	 * chunk so RAG results carry their source location into the chat context (the
	 * LLM can cite "this lives in owner/repo › src/foo.ts") — important once an
	 * instance has more than one repo indexed. The vector sourceId is namespaced
	 * by repo (`${repoKey}::${path}`) so a single repo can be cleared on re-index
	 * without touching the others. Embeds one chunk at a time — the proven path the
	 * knowledge base uses — then upserts the file's vectors in one batch.
	 */
	async vectorizeRepoFile(repoKey: string, path: string, content: string): Promise<number> {
		if (!this.vectorize || !this.ai) return 0;
		const chunks = chunkText(content, CHUNK_SIZE);
		if (chunks.length === 0) return 0;

		const sourceId = `${repoKey}::${path}`;
		const vectors: VectorizeVector[] = [];
		const metas: Array<{ key: string; meta: VectorMeta }> = [];
		for (let i = 0; i < chunks.length; i++) {
			const labeled = `File: ${repoKey}/${path}\n${chunks[i]}`;
			const embedding = await this.embed(labeled);
			if (!embedding) continue;
			const id = await shortId(this.agentId, "repo", sourceId, i);
			vectors.push({
				id,
				values: embedding,
				metadata: { agentId: this.agentId, sourceType: "repo", sourceId, chunkIndex: i, text: labeled.slice(0, 1000) },
			});
			metas.push({ key: `vec:${id}`, meta: { id, agentId: this.agentId, sourceType: "repo", sourceId, chunkIndex: i, text: labeled, createdAt: new Date().toISOString() } });
		}
		if (vectors.length === 0) return 0;
		for (let i = 0; i < vectors.length; i += 100) await this.vectorize.upsert(vectors.slice(i, i + 100));
		for (const { key, meta } of metas) await this.doStorage.put(key, meta);
		return vectors.length;
	}

	/**
	 * Drop repo-ingestion vectors. With `repoKey`, only that repo's vectors
	 * (sourceId `${repoKey}::…`) are removed; without it, every repo's vectors are
	 * removed (full wipe).
	 */
	async clearRepoVectors(repoKey?: string): Promise<void> {
		if (!this.vectorize) return;
		const prefix = repoKey ? `${repoKey}::` : "";
		const all = await this.doStorage.list<VectorMeta>({ prefix: "vec:" });
		const ids: string[] = [];
		const keys: string[] = [];
		for (const [key, meta] of all.entries()) {
			if (meta.agentId === this.agentId && meta.sourceType === "repo" && (!repoKey || meta.sourceId.startsWith(prefix))) {
				ids.push(meta.id);
				keys.push(key);
			}
		}
		if (ids.length === 0) return;
		for (let i = 0; i < ids.length; i += 128) await this.vectorize.deleteByIds(ids.slice(i, i + 128));
		await deleteKeysBatched(this.doStorage, keys);
	}

	// ── Knowledge base (editable via chat) ─────────────────────────────────────

	/** List knowledge documents (id, title, size) — not the full content. */
	async listKnowledge(): Promise<Array<{ id: string; title: string; chars: number; source?: string }>> {
		const all = await this.doStorage.list<KnowledgeDoc>({ prefix: "kb:" });
		return [...all.values()].map((d) => ({ id: d.id, title: d.title, chars: d.content?.length ?? 0, source: d.source }));
	}

	/** Read one knowledge document's full content. */
	async readKnowledge(id: string): Promise<KnowledgeDoc | null> {
		return (await this.doStorage.get<KnowledgeDoc>(`kb:${id}`)) ?? null;
	}

	/** Delete a knowledge document and its vectors. Returns false if not found. */
	async deleteKnowledge(id: string): Promise<KnowledgeDoc | null> {
		const existing = await this.doStorage.get<KnowledgeDoc>(`kb:${id}`);
		if (!existing) return null;
		await this.doStorage.delete(`kb:${id}`);
		await this.vectorDelete("knowledge", id).catch(() => undefined);
		await this.logEvent("knowledge.removed", undefined, { docId: id, title: existing.title }).catch(() => undefined);
		return existing;
	}

	/** Amend a knowledge document's title and/or content, re-vectorizing it. */
	async updateKnowledge(id: string, patch: { title?: string; content?: string }): Promise<KnowledgeDoc | null> {
		const existing = await this.doStorage.get<KnowledgeDoc>(`kb:${id}`);
		if (!existing) return null;
		if (patch.content && patch.content.length > 100_000) throw new Error("Document too large (max 100KB)");
		const updated: KnowledgeDoc = {
			...existing,
			title: patch.title ?? existing.title,
			content: patch.content ?? existing.content,
		};
		await this.doStorage.put(`kb:${id}`, updated);
		// Delete the old vectors first: shortId is deterministic on chunkIndex, so if the
		// edit produces fewer chunks the trailing old chunks would otherwise survive and
		// keep matching RAG queries with stale content.
		await this.vectorDelete("knowledge", id).catch(() => undefined);
		// Not swallowed — a failed re-index must surface (the update_knowledge tool reports it).
		await this.vectorizeStore("knowledge", id, `${updated.title}\n\n${updated.content}`);
		await this.logEvent("knowledge.updated", undefined, { docId: id, title: updated.title }).catch(() => undefined);
		return updated;
	}

	/** Add a new knowledge document (max 20). Returns null if the KB is full. */
	async addKnowledge(title: string, content: string): Promise<KnowledgeDoc | null> {
		if (content.length > 100_000) throw new Error("Document too large (max 100KB)");
		const existing = await this.doStorage.list({ prefix: "kb:" });
		if (existing.size >= 20) return null;
		const doc: KnowledgeDoc = {
			id: crypto.randomUUID(),
			title,
			content,
			source: "paste",
			addedAt: new Date().toISOString(),
		};
		await this.doStorage.put(`kb:${doc.id}`, doc);
		// Not swallowed — if the doc can't be embedded the caller must know it isn't searchable.
		await this.vectorizeStore("knowledge", doc.id, `${doc.title}\n\n${doc.content}`);
		await this.logEvent("knowledge.added", undefined, { docId: doc.id, title }).catch(() => undefined);
		return doc;
	}

	private async embed(text: string): Promise<number[] | null> {
		if (!this.ai) return null;
		try {
			const result = await this.ai.run("@cf/baai/bge-base-en-v1.5", {
				text: [text],
			});
			return (result as { data: number[][] }).data?.[0] || null;
		} catch {
			return null;
		}
	}

	// ── File Storage ──────────────────────────────────────────────────────────

	/**
	 * Upload a file to R2 with metadata tracking in DO.
	 */
	async fileUpload(opts: {
		name: string;
		path?: string;
		mimeType: string;
		data: ArrayBuffer | ReadableStream | string;
		userId?: string;
		tags?: string[];
		extractText?: boolean;
	}): Promise<FileMeta> {
		if (!this.r2) throw new Error("R2 storage not available");

		const id = crypto.randomUUID();
		const r2Key = `agents/${this.agentId}/files/${id}/${opts.name}`;
		const extractableData =
			typeof opts.data === "string" || opts.data instanceof ArrayBuffer
				? opts.data
				: null;
		const extracted = opts.extractText === false || !extractableData
			? { text: "", status: "none" as const }
			: await extractFileText({
				name: opts.name,
				mimeType: opts.mimeType,
				data: extractableData,
			});

		await this.r2.put(r2Key, opts.data, {
			httpMetadata: { contentType: opts.mimeType },
			customMetadata: {
				agentId: this.agentId,
				originalName: opts.name,
				...(opts.userId ? { userId: opts.userId } : {}),
			},
		});

		const obj = await this.r2.head(r2Key);
		const meta: FileMeta = {
			id,
			agentId: this.agentId,
			userId: opts.userId,
			name: opts.name,
			path: opts.path || `/${opts.name}`,
			mimeType: opts.mimeType,
			size: obj?.size || 0,
			tags: opts.tags || [],
			r2Key,
			extractionStatus: extracted.status,
			extractedTextLength: extracted.text.length,
			extractionError: extracted.error,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		await this.doStorage.put(`file:${id}`, meta);

		if (extracted.text) {
			await this.doStorage.put(`filetext:${id}`, extracted.text.slice(0, 100_000));
			// Best-effort: the file + its metadata are already committed to R2/DO, so a
			// vectorization failure must not 500 the upload (that would leave torn state).
			// Log it so it isn't fully invisible; the file text is retained and can be re-indexed.
			try {
				await this.vectorizeStore("file", id, extracted.text.slice(0, 100_000));
			} catch (err) {
				console.error(`[storage] file ${id} stored but not vectorized:`, err);
			}
		}

		await this.logEvent("file.uploaded", undefined, {
			fileId: id,
			name: opts.name,
			size: meta.size,
			mimeType: opts.mimeType,
			extractionStatus: meta.extractionStatus,
			extractedTextLength: meta.extractedTextLength,
		});

		return meta;
	}

	/**
	 * Read a file's contents from R2.
	 */
	async fileGet(id: string): Promise<{ meta: FileMeta; body: ReadableStream } | null> {
		const meta = await this.doStorage.get<FileMeta>(`file:${id}`);
		if (!meta || !this.r2) return null;

		const obj = await this.r2.get(meta.r2Key);
		if (!obj) return null;

		return { meta, body: obj.body };
	}

	/**
	 * List files with optional filters.
	 */
	async fileList(opts?: {
		userId?: string;
		tags?: string[];
		mimeType?: string;
	}): Promise<FileMeta[]> {
		const all = await this.doStorage.list<FileMeta>({ prefix: "file:" });
		let files = [...all.values()];

		if (opts?.userId) files = files.filter((f) => f.userId === opts.userId);
		if (opts?.tags?.length) {
			files = files.filter((f) => opts.tags!.some((t) => f.tags.includes(t)));
		}
		if (opts?.mimeType) {
			files = files.filter((f) => f.mimeType.startsWith(opts.mimeType!));
		}

		return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	/**
	 * Delete a file from R2 and DO.
	 */
	async fileDelete(id: string): Promise<boolean> {
		const meta = await this.doStorage.get<FileMeta>(`file:${id}`);
		if (!meta) return false;

		if (this.r2) await this.r2.delete(meta.r2Key);
		await this.doStorage.delete(`file:${id}`);
		await this.vectorDelete("file", id);
		await this.logEvent("file.deleted", undefined, { fileId: id, name: meta.name });
		return true;
	}

	// ── Collections (Structured Storage) ──────────────────────────────────────

	/**
	 * Define a new collection (like creating a table).
	 * Schemas are stored at `schema:{name}` for fast listing without scanning records.
	 */
	async collectionCreate(name: string, fields: CollectionField[]): Promise<CollectionSchema> {
		const existing = await this.doStorage.get<CollectionSchema>(`schema:${name}`);
		if (existing) throw new Error(`Collection "${name}" already exists`);

		const allSchemas = await this.doStorage.list({ prefix: "schema:" });
		if (allSchemas.size >= MAX_COLLECTIONS) {
			throw new Error(`Maximum ${MAX_COLLECTIONS} collections reached`);
		}

		const schema: CollectionSchema = {
			name,
			fields,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			recordCount: 0,
		};
		await this.doStorage.put(`schema:${name}`, schema);
		await this.logEvent("collection.created", undefined, { collection: name, fields: fields.length });
		return schema;
	}

	/**
	 * Get collection schema.
	 */
	async collectionGet(name: string): Promise<CollectionSchema | null> {
		return (await this.doStorage.get<CollectionSchema>(`schema:${name}`)) || null;
	}

	/**
	 * List all collections (fast — only scans schema keys, not records).
	 */
	async collectionList(): Promise<CollectionSchema[]> {
		const all = await this.doStorage.list<CollectionSchema>({ prefix: "schema:" });
		return [...all.values()];
	}

	/**
	 * Delete a collection and all its records.
	 */
	async collectionDelete(name: string): Promise<boolean> {
		const schema = await this.collectionGet(name);
		if (!schema) return false;

		// Delete schema
		await this.doStorage.delete(`schema:${name}`);

		// Delete all records and indexes
		const records = await this.doStorage.list({ prefix: `col:${name}:` });
		const indexes = await this.doStorage.list({ prefix: `idx:${name}:` });
		const allKeys = [...records.keys(), ...indexes.keys()];
		for (let i = 0; i < allKeys.length; i += 128) {
			await this.doStorage.delete(allKeys.slice(i, i + 128));
		}

		// Delete vectors for collection records
		await this.vectorDelete("collection", name);
		return true;
	}

	/**
	 * Insert a record into a collection.
	 */
	async recordInsert(
		collection: string,
		data: Record<string, unknown>,
		userId?: string,
	): Promise<CollectionRecord> {
		const schema = await this.collectionGet(collection);
		if (!schema) throw new Error(`Collection "${collection}" not found`);
		if (schema.recordCount >= MAX_COLLECTION_RECORDS) {
			throw new Error(`Collection "${collection}" is full (max ${MAX_COLLECTION_RECORDS} records)`);
		}

		const validated = validateRecord(schema, data);

		// Enforce unique constraints
		for (const field of schema.fields) {
			if (field.unique && validated[field.name] !== undefined) {
				const encoded = encodeIndexValue(String(validated[field.name]));
				const existing = await this.doStorage.list({
					prefix: `idx:${collection}:${field.name}:${encoded}:`,
					limit: 1,
				});
				if (existing.size > 0) {
					throw new Error(`Duplicate value for unique field "${field.name}": ${String(validated[field.name])}`);
				}
			}
		}

		// Dedup guard: reject if a record with the same indexed field values
		// was inserted in the last 60 seconds (prevents model calling insert_record multiple times)
		const indexedFields = schema.fields.filter((f) => f.indexed);
		if (indexedFields.length > 0) {
			const all = await this.doStorage.list<CollectionRecord>({ prefix: `col:${collection}:` });
			const cutoff = new Date(Date.now() - 60_000).toISOString();
			for (const [, existing] of all) {
				if (existing.createdAt < cutoff) continue;
				const match = indexedFields.every((f) =>
					validated[f.name] !== undefined &&
					existing.data[f.name] !== undefined &&
					String(validated[f.name]) === String(existing.data[f.name]),
				);
				if (match) {
					throw new Error(`Duplicate: a record with the same values was just created (${existing.id.slice(0, 8)})`);
				}
			}
		}

		const id = crypto.randomUUID();
		const now = new Date().toISOString();

		const record: CollectionRecord = {
			id,
			collection,
			data: validated,
			createdAt: now,
			updatedAt: now,
		};

		await this.doStorage.put(`col:${collection}:${id}`, record);

		// Build indexes for indexed + unique fields
		for (const field of schema.fields) {
			if ((field.indexed || field.unique) && validated[field.name] !== undefined) {
				const value = encodeIndexValue(String(validated[field.name]));
				await this.doStorage.put(`idx:${collection}:${field.name}:${value}:${id}`, id);
			}
		}

		// Update record count
		schema.recordCount++;
		await this.doStorage.put(`schema:${collection}`, schema);

		await this.logEvent("collection.record.created", userId, {
			collection,
			recordId: id,
		});

		return record;
	}

	/**
	 * Get a record by ID.
	 */
	async recordGet(collection: string, id: string): Promise<CollectionRecord | null> {
		return (await this.doStorage.get<CollectionRecord>(`col:${collection}:${id}`)) || null;
	}

	/**
	 * Update a record.
	 */
	async recordUpdate(
		collection: string,
		id: string,
		data: Record<string, unknown>,
		userId?: string,
	): Promise<CollectionRecord | null> {
		const existing = await this.doStorage.get<CollectionRecord>(`col:${collection}:${id}`);
		if (!existing) return null;

		const schema = await this.collectionGet(collection);
		if (!schema) return null;

		const merged = { ...existing.data, ...data };
		const validated = validateRecord(schema, merged);

		// Enforce unique constraints on the NEW values — recordInsert does this, but the
		// update path skipped it entirely, so a PUT could set a duplicate value on a
		// `unique` field. Exclude THIS record's own index entry (key ends in `:${id}`).
		for (const field of schema.fields) {
			if (field.unique && validated[field.name] !== undefined) {
				const encoded = encodeIndexValue(String(validated[field.name]));
				const matches = await this.doStorage.list({ prefix: `idx:${collection}:${field.name}:${encoded}:` });
				for (const key of matches.keys()) {
					if (!key.endsWith(`:${id}`)) {
						throw new Error(`Duplicate value for unique field "${field.name}": ${String(validated[field.name])}`);
					}
				}
			}
		}

		// Remove old indexes for indexed OR unique fields. Must match recordInsert's
		// predicate (`indexed || unique`): a `unique`-only field's index was created on
		// insert but never cleaned up here, orphaning it (blocking re-insert forever).
		for (const field of schema.fields) {
			if ((field.indexed || field.unique) && existing.data[field.name] !== undefined) {
				const oldValue = encodeIndexValue(String(existing.data[field.name]));
				await this.doStorage.delete(`idx:${collection}:${field.name}:${oldValue}:${id}`);
			}
		}

		existing.data = validated;
		existing.updatedAt = new Date().toISOString();
		await this.doStorage.put(`col:${collection}:${id}`, existing);

		// Rebuild indexes for indexed OR unique fields.
		for (const field of schema.fields) {
			if ((field.indexed || field.unique) && validated[field.name] !== undefined) {
				const value = encodeIndexValue(String(validated[field.name]));
				await this.doStorage.put(`idx:${collection}:${field.name}:${value}:${id}`, id);
			}
		}

		await this.logEvent("collection.record.updated", userId, {
			collection,
			recordId: id,
		});

		return existing;
	}

	/**
	 * Delete a record.
	 */
	async recordDelete(collection: string, id: string, userId?: string): Promise<boolean> {
		const existing = await this.doStorage.get<CollectionRecord>(`col:${collection}:${id}`);
		if (!existing) return false;

		const schema = await this.collectionGet(collection);

		// Remove indexes for indexed OR unique fields (match recordInsert's predicate —
		// a `unique`-only field's index was orphaned on delete, permanently blocking
		// re-insert of that value with a phantom "Duplicate value" error).
		if (schema) {
			for (const field of schema.fields) {
				if ((field.indexed || field.unique) && existing.data[field.name] !== undefined) {
					const value = encodeIndexValue(String(existing.data[field.name]));
					await this.doStorage.delete(`idx:${collection}:${field.name}:${value}:${id}`);
				}
			}
			schema.recordCount = Math.max(0, schema.recordCount - 1);
			await this.doStorage.put(`schema:${collection}`, schema);
		}

		await this.doStorage.delete(`col:${collection}:${id}`);
		await this.logEvent("collection.record.deleted", userId, { collection, recordId: id });
		return true;
	}

	/**
	 * Query records in a collection with filtering.
	 */
	async recordQuery(
		collection: string,
		opts?: {
			where?: Record<string, unknown>;
			limit?: number;
			offset?: number;
			orderBy?: string;
			orderDir?: "asc" | "desc";
		},
	): Promise<{ records: CollectionRecord[]; total: number }> {
		const schema = await this.collectionGet(collection);
		if (!schema) throw new Error(`Collection "${collection}" not found`);

		const limit = Math.min(opts?.limit || 50, 200);
		const offset = opts?.offset || 0;

		// If filtering on an indexed field, use the index — but ONLY when no explicit
		// ordering is asked for. The index returns ids in UUID order; honouring `orderBy`
		// needs the full result set sorted before the page slice, so fall through to the
		// scanning path (which sorts) rather than silently returning UUID order.
		if (opts?.where && Object.keys(opts.where).length === 1 && !opts?.orderBy) {
			const [field, value] = Object.entries(opts.where)[0];
			const fieldDef = schema.fields.find((f) => f.name === field);
			if (fieldDef?.indexed) {
				const encodedValue = encodeIndexValue(String(value));
				const indexPrefix = `idx:${collection}:${field}:${encodedValue}:`;
				const indexed = await this.doStorage.list<string>({ prefix: indexPrefix });
				const ids = [...indexed.values()];
				const records: CollectionRecord[] = [];
				for (const id of ids.slice(offset, offset + limit)) {
					const rec = await this.doStorage.get<CollectionRecord>(`col:${collection}:${id}`);
					if (rec) records.push(rec);
				}
				return { records, total: ids.length };
			}
		}

		// Full scan with filtering (schemas are stored at `schema:` prefix, not here)
		const all = await this.doStorage.list<CollectionRecord>({ prefix: `col:${collection}:` });
		let records = [...all.values()];

		// Apply where filter
		if (opts?.where) {
			records = records.filter((r) =>
				Object.entries(opts.where!).every(([k, v]) => r.data[k] === v),
			);
		}

		const total = records.length;

		// Sort
		if (opts?.orderBy) {
			const dir = opts.orderDir === "desc" ? -1 : 1;
			records.sort((a, b) => {
				const av = String(a.data[opts.orderBy!] ?? a[opts.orderBy as keyof CollectionRecord] ?? "");
				const bv = String(b.data[opts.orderBy!] ?? b[opts.orderBy as keyof CollectionRecord] ?? "");
				return av.localeCompare(bv) * dir;
			});
		}

		return { records: records.slice(offset, offset + limit), total };
	}

	// ── Activity Log ──────────────────────────────────────────────────────────

	/**
	 * Append an activity event.
	 * Pruning is amortized: only runs every ~50 events (probabilistic).
	 */
	async logEvent(
		type: ActivityEvent["type"],
		userId?: string,
		data?: Record<string, unknown>,
		channel?: string,
	): Promise<ActivityEvent> {
		const event: ActivityEvent = {
			id: crypto.randomUUID(),
			type,
			agentId: this.agentId,
			userId,
			channel,
			data,
			createdAt: new Date().toISOString(),
		};
		await this.doStorage.put(`evt:${event.createdAt}:${event.id}`, event);

		// Amortized pruning: ~2% chance per write (roughly every 50 events)
		if (Math.random() < 0.02) {
			const all = await this.doStorage.list({ prefix: "evt:" });
			if (all.size > MAX_EVENTS) {
				const keys = [...all.keys()];
				const toDelete = keys.slice(0, keys.length - MAX_EVENTS);
				for (let i = 0; i < toDelete.length; i += 128) {
					await this.doStorage.delete(toDelete.slice(i, i + 128));
				}
			}
		}

		return event;
	}

	/**
	 * Get recent activity events.
	 */
	async getEvents(opts?: {
		limit?: number;
		type?: ActivityEvent["type"];
		userId?: string;
	}): Promise<ActivityEvent[]> {
		const limit = opts?.limit || 50;
		const all = await this.doStorage.list<ActivityEvent>({
			prefix: "evt:",
			reverse: true,
			limit: limit * 2, // Over-fetch for filtering
		});
		let events = [...all.values()];

		if (opts?.type) events = events.filter((e) => e.type === opts.type);
		if (opts?.userId) events = events.filter((e) => e.userId === opts.userId);

		return events.slice(0, limit);
	}

	// ── Conversation Summarization ────────────────────────────────────────────

	/**
	 * Check if conversation needs summarization and generate if so.
	 * Returns the summary if generated, null otherwise.
	 */
	async maybeSummarize(model: string): Promise<ConversationSummary | null> {
		if (!this.ai) return null;

		// Count messages since last summary
		const summaries = await this.doStorage.list<ConversationSummary>({
			prefix: "sum:",
			reverse: true,
			limit: 1,
		});
		const lastSummary = [...summaries.values()][0];
		const lastTimestamp = lastSummary?.messageRange.to || "0";

		// Get messages since last summary
		const messages = await this.doStorage.list<AgentMessage>({
			prefix: "msg:",
			startAfter: `msg:${lastTimestamp}`,
		});

		if (messages.size < SUMMARY_THRESHOLD) return null;

		const msgList = [...messages.values()];
		return this.generateSummary(msgList, model);
	}

	/**
	 * Force generate a summary for given messages.
	 */
	async generateSummary(
		messages: AgentMessage[],
		model: string,
	): Promise<ConversationSummary | null> {
		if (!this.ai || messages.length === 0) return null;

		const transcript = messages
			.map((m) => `[${m.role}]: ${m.content}`)
			.join("\n")
			.slice(0, 8_000);

		try {
			const result = (await this.ai.run(model as Parameters<Ai["run"]>[0], {
				messages: [
					{
						role: "system",
						content: `Summarize this conversation segment. Output JSON:
{
  "summary": "2-3 sentence summary of what was discussed and decided",
  "facts": [{"subject":"...", "predicate":"...", "object":"...", "confidence": 0.9}]
}
Extract key facts about the user, their preferences, decisions made, and information shared. Only include facts with high confidence.`,
					},
					{ role: "user", content: transcript },
				],
			})) as { response?: string };

			const text = result.response || "";
			const jsonMatch = text.match(/\{[\s\S]*\}/);
			if (!jsonMatch) return null;

			const parsed = JSON.parse(jsonMatch[0]) as {
				summary: string;
				facts: ExtractedFact[];
			};

			const sessionId = crypto.randomUUID();
			const summary: ConversationSummary = {
				id: sessionId,
				sessionId,
				messageRange: {
					from: messages[0].createdAt,
					to: messages[messages.length - 1].createdAt,
					count: messages.length,
				},
				summary: parsed.summary || "",
				facts: Array.isArray(parsed.facts) ? parsed.facts.slice(0, 20) : [],
				createdAt: new Date().toISOString(),
			};

			await this.doStorage.put(`sum:${sessionId}`, summary);

			// Store extracted facts as memory entries
			for (const fact of summary.facts) {
				if (fact.confidence >= 0.8) {
					const key = `fact:${fact.subject}:${fact.predicate}`.slice(0, 100);
					const entry: MemoryEntry = {
						key,
						type: "knowledge",
						content: `${fact.subject} ${fact.predicate} ${fact.object}`,
						updatedAt: new Date().toISOString(),
					};
					await this.doStorage.put(`mem:${key}`, entry);
				}
			}

			// Vectorize the summary for future retrieval (best-effort — a failure here must
			// not abort summarization; the summary itself is already persisted).
			try {
				await this.vectorizeStore("message", sessionId, summary.summary);
			} catch (err) {
				console.error(`[storage] summary ${sessionId} stored but not vectorized:`, err);
			}

			await this.logEvent("summary.generated", undefined, {
				sessionId,
				messageCount: messages.length,
				factsExtracted: summary.facts.length,
			});

			return summary;
		} catch {
			return null;
		}
	}

	/**
	 * Get all conversation summaries.
	 */
	async getSummaries(limit = 20): Promise<ConversationSummary[]> {
		const all = await this.doStorage.list<ConversationSummary>({
			prefix: "sum:",
			reverse: true,
			limit,
		});
		return [...all.values()];
	}

	// ── Per-User Context ──────────────────────────────────────────────────────

	/**
	 * Get or create user context for this agent.
	 */
	async getUserContext(userId: string): Promise<UserContext> {
		const key = `uctx:${userId}`;
		const existing = await this.doStorage.get<UserContext>(key);
		if (existing) return existing;

		const ctx: UserContext = {
			userId,
			agentId: this.agentId,
			preferences: {},
			lastSeen: new Date().toISOString(),
			messageCount: 0,
		};
		await this.doStorage.put(key, ctx);
		return ctx;
	}

	/**
	 * Update user context (called on each interaction).
	 */
	async touchUserContext(userId: string): Promise<UserContext> {
		const ctx = await this.getUserContext(userId);
		ctx.lastSeen = new Date().toISOString();
		ctx.messageCount++;
		await this.doStorage.put(`uctx:${userId}`, ctx);
		return ctx;
	}

	/**
	 * Set a user preference.
	 */
	async setUserPreference(userId: string, key: string, value: string): Promise<void> {
		const ctx = await this.getUserContext(userId);
		ctx.preferences[key] = value;
		await this.doStorage.put(`uctx:${userId}`, ctx);
	}

	// ── RAG Context Builder ───────────────────────────────────────────────────

	/**
	 * Build relevant context for a chat message using vector search + summaries.
	 * Returns empty string if no relevant context is found.
	 */
	async buildRAGContext(query: string): Promise<string> {
		const maxChars = 6_000;
		const parts: string[] = [];
		let totalChars = 0;

		const results = await this.vectorSearch(query, 8);
		if (results.length > 0) {
			parts.push("## Relevant Knowledge");
			for (const result of results) {
				if (totalChars + result.text.length > maxChars) break;
				parts.push(`[${result.sourceType}] (score: ${result.score.toFixed(2)})\n${result.text}`);
				totalChars += result.text.length;
			}
		}

		const summaries = await this.getSummaries(5);
		if (summaries.length > 0 && totalChars < maxChars) {
			parts.push("\n## Conversation History");
			for (const sum of summaries) {
				if (totalChars + sum.summary.length > maxChars) break;
				parts.push(`[${sum.messageRange.from.split("T")[0]}] ${sum.summary}`);
				totalChars += sum.summary.length;
			}
		}

		return parts.join("\n\n");
	}
}
