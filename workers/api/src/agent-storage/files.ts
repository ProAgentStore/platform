/**
 * File storage — R2 binary storage with DO-tracked metadata, text extraction,
 * and auto-vectorization of extracted text.
 */
import type { ActivityEvent, FileMeta, VectorMeta } from "../agent-storage-types.js";
import { extractFileText } from "../agent-storage-utils.js";
import type { AgentStorageBaseCtor } from "./base.js";

/** Sibling methods this group relies on (provided by earlier layers). */
interface FileDeps {
	logEvent(type: ActivityEvent["type"], userId?: string, data?: Record<string, unknown>, channel?: string): Promise<ActivityEvent>;
	vectorizeStore(sourceType: VectorMeta["sourceType"], sourceId: string, text: string): Promise<string[]>;
	vectorDelete(sourceType: VectorMeta["sourceType"], sourceId: string): Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: mixin constructor helper
type GConstructorWith<T> = new (...args: any[]) => T;

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

			// Bounded extraction read: PDFs/text under the cap get read fully (Workers
			// memory comfortably handles this); bigger objects skip extraction.
			const MAX_EXTRACT_BYTES = 32 * 1024 * 1024;
			let extracted: { text: string; status: FileMeta["extractionStatus"]; error?: string } = { text: "", status: "unsupported" };
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
				extractedTextLength: extracted.text.length,
				extractionError: extracted.error,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			await this.doStorage.put(`file:${opts.id}`, meta);

			if (extracted.text) {
				await this.doStorage.put(`filetext:${opts.id}`, extracted.text.slice(0, 100_000));
				try {
					await this.vectorizeStore("file", opts.id, extracted.text.slice(0, 100_000));
				} catch (err) {
					console.error(`[storage] file ${opts.id} stored but not vectorized:`, err);
				}
			}

			await this.logEvent("file.uploaded", undefined, {
				fileId: opts.id,
				name: opts.name,
				size: meta.size,
				mimeType: opts.mimeType,
				extractionStatus: meta.extractionStatus,
				extractedTextLength: meta.extractedTextLength,
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
			await this.vectorDelete("file", id);
			await this.logEvent("file.deleted", undefined, { fileId: id, name: meta.name });
			return true;
		}
	};
}
