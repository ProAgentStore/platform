/**
 * File storage — R2 binary storage with DO-tracked metadata, text extraction,
 * and auto-vectorization of extracted text.
 */
import type { ActivityEvent, FileMeta, VectorMeta } from "../agent-storage-types.js";
import { extractFileText } from "../agent-storage-utils.js";
import type { AgentStorageBaseCtor } from "./base.js";

/** Sibling methods this group relies on (provided by earlier layers). */
interface FileDeps {
	/** #22: vectorizeStore no-ops (does not throw) when indexing is off, so a green try/catch
	 *  is not evidence the file is searchable — this is. */
	readonly indexingEnabled: boolean;
	logEvent(type: ActivityEvent["type"], userId?: string, data?: Record<string, unknown>, channel?: string): Promise<ActivityEvent>;
	vectorizeStore(sourceType: VectorMeta["sourceType"], sourceId: string, text: string): Promise<string[]>;
	vectorDelete(sourceType: VectorMeta["sourceType"], sourceId: string): Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: mixin constructor helper
type GConstructorWith<T> = new (...args: any[]) => T;

/**
 * How much of a document's extracted text is kept. Everything past this is dropped — it is not
 * written to `filetext:` (so `read_file` cannot reach it) and not vectorized (so RAG cannot).
 */
const MAX_INDEXED_TEXT = 100_000;

/**
 * The bounded text to store, together with the metadata that admits it IS bounded (#637).
 *
 * The cap itself is fine — it is the silence that was not. A capped file used to be recorded with
 * `extractionStatus: "extracted"` and `extractedTextLength` set to the FULL length, so nothing
 * anywhere distinguished a 90k document that is entirely searchable from a 400k document that is
 * a quarter searchable. Same shape as #503/#581: a bound that keeps the first N owes the caller a
 * statement that it did.
 */
function boundedText(text: string): Pick<FileMeta, "extractedTextLength" | "indexedTextLength" | "textTruncated"> & { text: string } {
	const kept = text.slice(0, MAX_INDEXED_TEXT);
	return { text: kept, extractedTextLength: text.length, indexedTextLength: kept.length, textTruncated: kept.length < text.length };
}

export function withFiles<TBase extends AgentStorageBaseCtor & GConstructorWith<FileDeps>>(Base: TBase) {
	return class extends Base {
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
			const bounded = boundedText(extracted.text);
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
				extractedTextLength: bounded.extractedTextLength,
				indexedTextLength: bounded.indexedTextLength,
				textTruncated: bounded.textTruncated,
				extractionError: extracted.error,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};

			// Written BEFORE vectorization, then re-written with `vectorized` once it is known: the
			// bytes are already in R2, so a throw between the two must never leave a file with no
			// metadata at all.
			await this.doStorage.put(`file:${id}`, meta);

			if (bounded.text) {
				await this.doStorage.put(`filetext:${id}`, bounded.text);
				// Best-effort: the file + its metadata are already committed to R2/DO, so a
				// vectorization failure must not 500 the upload (that would leave torn state).
				// The file text is retained and can be re-indexed.
				//
				// `vectorized: false` is what makes that survivable. A console.error in a Worker is
				// not persisted, so "uploaded fine, invisible to search" used to be a state with no
				// record anywhere — the flag is the same admission #22 gave a knowledge doc.
				try {
					await this.vectorizeStore("file", id, bounded.text);
					meta.vectorized = this.indexingEnabled;
				} catch (err) {
					meta.vectorized = false;
					console.error(`[storage] file ${id} stored but not vectorized:`, err);
				}
				await this.doStorage.put(`file:${id}`, meta);
			}

			await this.logEvent("file.uploaded", undefined, {
				fileId: id,
				name: opts.name,
				size: meta.size,
				mimeType: opts.mimeType,
				extractionStatus: meta.extractionStatus,
				extractedTextLength: meta.extractedTextLength,
				indexedTextLength: meta.indexedTextLength,
				textTruncated: meta.textTruncated,
				vectorized: meta.vectorized,
			});

			return meta;
		}

		/**
		 * Register a file whose bytes are ALREADY in R2 — the resumable multipart
		 * upload path puts the object directly (worker → R2 parts), then calls this to
		 * create the metadata + extraction + vectorization the normal upload does
		 * inline. Extraction reads the object back, bounded: very large files skip
		 * extraction (the cap on extracted text is 100KB anyway).
		 */
		async fileRegister(opts: {
			id: string;
			name: string;
			r2Key: string;
			mimeType: string;
			userId?: string;
			tags?: string[];
		}): Promise<FileMeta | null> {
			if (!this.r2) throw new Error("R2 storage not available");
			const head = await this.r2.head(opts.r2Key);
			if (!head) return null; // multipart not completed / wrong key

			// Never let a registration REPLACE a different file's metadata (#217). The write
			// below is an unconditional put on `file:{id}`, so registering an id that already
			// belongs to another R2 object silently repoints that file's entry — the previous
			// object is then orphaned in R2 with nothing referencing it, and delete/download for
			// the original id start operating on someone else's bytes.
			//
			// Re-registering the SAME (id, key) is allowed: that is a retried or resumed
			// completion of the same upload, which must stay idempotent.
			const prior = await this.doStorage.get<FileMeta>(`file:${opts.id}`);
			if (prior && prior.r2Key !== opts.r2Key) return null;

			// Bounded extraction read: PDFs/text under the cap get read fully (Workers
			// memory comfortably handles this); bigger objects skip extraction.
			//
			// The skip carries its REASON (#637). "unsupported" on its own is a statement about the
			// file's FORMAT, and a 40 MB PDF — well inside the documented 2 GB upload cap — was
			// getting it with `extractionError` left undefined, so the one field that exists to
			// explain the skip explained nothing and the user was told their PDF was not a PDF.
			const MAX_EXTRACT_BYTES = 32 * 1024 * 1024;
			let extracted: { text: string; status: FileMeta["extractionStatus"]; error?: string } =
				head.size > MAX_EXTRACT_BYTES
					? { text: "", status: "unsupported", error: `File is ${Math.round(head.size / (1024 * 1024))} MB; text extraction is capped at ${MAX_EXTRACT_BYTES / (1024 * 1024)} MB. The file is stored and downloadable, but its text is not searchable.` }
					: { text: "", status: "unsupported" };
			if (head.size <= MAX_EXTRACT_BYTES) {
				const obj = await this.r2.get(opts.r2Key);
				if (obj) {
					extracted = await extractFileText({
						name: opts.name,
						mimeType: opts.mimeType,
						data: await obj.arrayBuffer(),
					});
				}
			}

			const bounded = boundedText(extracted.text);
			const meta: FileMeta = {
				id: opts.id,
				agentId: this.agentId,
				userId: opts.userId,
				name: opts.name,
				path: `/${opts.name}`,
				mimeType: opts.mimeType,
				size: head.size,
				tags: opts.tags || [],
				r2Key: opts.r2Key,
				extractionStatus: extracted.status,
				extractedTextLength: bounded.extractedTextLength,
				indexedTextLength: bounded.indexedTextLength,
				textTruncated: bounded.textTruncated,
				extractionError: extracted.error,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			await this.doStorage.put(`file:${opts.id}`, meta);

			if (bounded.text) {
				await this.doStorage.put(`filetext:${opts.id}`, bounded.text);
				try {
					await this.vectorizeStore("file", opts.id, bounded.text);
					meta.vectorized = this.indexingEnabled;
				} catch (err) {
					meta.vectorized = false;
					console.error(`[storage] file ${opts.id} stored but not vectorized:`, err);
				}
				await this.doStorage.put(`file:${opts.id}`, meta);
			}

			await this.logEvent("file.uploaded", undefined, {
				fileId: opts.id,
				name: opts.name,
				size: meta.size,
				mimeType: opts.mimeType,
				extractionStatus: meta.extractionStatus,
				extractedTextLength: meta.extractedTextLength,
				indexedTextLength: meta.indexedTextLength,
				textTruncated: meta.textTruncated,
				vectorized: meta.vectorized,
				multipart: true,
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
		 * A file's extracted text (what got vectorized) with its metadata — how the
		 * chat's read_file tool "goes into" a PDF: raw bytes are useless to an LLM,
		 * the extraction is the readable document.
		 */
		async fileGetText(id: string): Promise<{ meta: FileMeta; text: string | null } | null> {
			const meta = await this.doStorage.get<FileMeta>(`file:${id}`);
			if (!meta) return null;
			const text = (await this.doStorage.get<string>(`filetext:${id}`)) ?? null;
			return { meta, text };
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
			// The extracted text too — up to 100KB of the document body is written at
			// `filetext:{id}` on upload and was never removed, so deleting a 5MB PDF left its
			// extracted résumé/contract text in the DO forever: unreadable (fileGetText needs
			// `file:{id}`), unreclaimable, and growing on every upload/delete cycle.
			await this.doStorage.delete(`filetext:${id}`);
			await this.vectorDelete("file", id);
			await this.logEvent("file.deleted", undefined, { fileId: id, name: meta.name });
			return true;
		}
	};
}
