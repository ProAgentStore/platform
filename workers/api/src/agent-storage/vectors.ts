/**
 * Vector storage + RAG index management (Vectorize) and conversation-derived
 * cleanup. Also the private `embed` helper every group's vectorization uses.
 */
import type {
	ConversationSummary,
	FileMeta,
	VectorMeta,
	VectorSearchResult,
	VectorStatsResult,
	VectorStatsSource,
} from "../agent-storage-types.js";
import { chunkText, deleteKeysBatched, shortId } from "../agent-storage-utils.js";
import type { KnowledgeDoc, MemoryEntry } from "../agent-types.js";
import { approxTokens } from "../lib/ai-pricing.js";
import { recordPlatformUsage } from "../lib/usage.js";
import { type AgentStorageBaseCtor, CHUNK_SIZE } from "./base.js";

export function withVectors<TBase extends AgentStorageBaseCtor>(Base: TBase) {
	return class extends Base {
		// ── Vector Storage ────────────────────────────────────────────────────────

		/**
		 * Whether embedding/RAG is actually available (both the Vectorize index and the platform
		 * AI binding present). When false — e.g. PLATFORM_AI_ENABLED is off — vectorizeStore /
		 * vectorSearch / vectorizeRepoFile no-op instead of throwing, so callers MUST check this
		 * before reporting a KB add / repo index as "indexed" — otherwise ingest looks green while
		 * RAG is dead (#22). See handleAddKnowledge + the repo-ingest runner.
		 */
		get indexingEnabled(): boolean {
			return !!(this.vectorize && this.ai);
		}

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

		/**
		 * Inventory of everything in the vector store, grouped by source — what the
		 * Knowledge → Index panel (and MCP vector_stats) shows so users can see what
		 * is actually searchable. Built from the vec:* bookkeeping entries; names are
		 * resolved from the source records (file meta / KB doc title).
		 */
		async vectorStats(): Promise<VectorStatsResult> {
			const all = await this.doStorage.list<VectorMeta>({ prefix: "vec:" });
			const groups = new Map<string, VectorStatsSource>();
			for (const meta of all.values()) {
				if (meta.agentId !== this.agentId) continue;
				const key = `${meta.sourceType}:${meta.sourceId}`;
				let g = groups.get(key);
				if (!g) {
					g = { sourceType: meta.sourceType, sourceId: meta.sourceId, name: "", chunks: 0, chars: 0, lastIndexed: "", preview: "" };
					groups.set(key, g);
				}
				g.chunks++;
				g.chars += meta.text.length;
				if (meta.createdAt > g.lastIndexed) g.lastIndexed = meta.createdAt;
				if (meta.chunkIndex === 0 || !g.preview) g.preview = meta.text.slice(0, 240);
			}
			for (const g of groups.values()) {
				if (g.sourceType === "file") {
					const meta = await this.doStorage.get<FileMeta>(`file:${g.sourceId}`);
					g.name = meta?.name || g.sourceId;
				} else if (g.sourceType === "knowledge") {
					const doc = await this.doStorage.get<KnowledgeDoc>(`kb:${g.sourceId}`);
					g.name = doc?.title || g.sourceId;
				} else if (g.sourceType === "message") {
					g.name = "Conversation summary";
				} else {
					// repo sourceIds are self-describing ("owner/repo::path"); collections use their name
					g.name = g.sourceId;
				}
			}
			const sources = [...groups.values()].sort((a, b) => (a.lastIndexed < b.lastIndexed ? 1 : -1));
			return {
				totalSources: sources.length,
				totalChunks: sources.reduce((n, s) => n + s.chunks, 0),
				totalChars: sources.reduce((n, s) => n + s.chars, 0),
				sources,
			};
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
			// Short files (every chunk below chunkText's min length) yield none — index the whole
			// trimmed content as one chunk instead of silently dropping the file. Matches the
			// knowledge path (vectorizeStore), which otherwise indexes small files this one skipped.
			if (chunks.length === 0) {
				if (content.trim()) chunks.push(content.trim());
				else return 0; // genuinely empty → nothing to do (not a failure)
			}

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
			// We had chunks to embed but produced zero vectors → every embed() returned null
			// (a swallowed Workers-AI provider error). Signal failure (-1) so the ingest alarm
			// retries this file on a later tick (REPO_FILE_MAX_RETRY) before giving up — rather
			// than marking the file done-but-empty and advertising "Ready (N files)" while RAG
			// returns nothing for it and no error is ever surfaced.
			if (vectors.length === 0) return -1;
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

		/**
		 * Clear everything DERIVED from the conversation: summaries, the facts extracted
		 * from them, and message vectors. Called when the user clears the chat — otherwise
		 * "cleared" content still leaks back via RAG (summaries + `sourceType:"message"`
		 * vectors are searched) and the extracted `fact:*` memories survive. User- and
		 * agent-authored memory is preserved (only `source:"summary"` facts are removed).
		 */
		async clearConversationDerived(): Promise<void> {
			// Summaries.
			const summaries = await this.doStorage.list<ConversationSummary>({ prefix: "sum:" });
			await deleteKeysBatched(this.doStorage, [...summaries.keys()]);

			// Facts extracted by summarization (never touch user/agent memory).
			const mem = await this.doStorage.list<MemoryEntry>({ prefix: "mem:" });
			const factKeys = [...mem.entries()].filter(([, v]) => v?.source === "summary").map(([k]) => k);
			await deleteKeysBatched(this.doStorage, factKeys);

			// Message vectors (both the Vectorize index and the `vec:` metadata mirror).
			if (this.vectorize) {
				const all = await this.doStorage.list<VectorMeta>({ prefix: "vec:" });
				const ids: string[] = [];
				const keys: string[] = [];
				for (const [key, meta] of all.entries()) {
					if (meta.agentId === this.agentId && meta.sourceType === "message") {
						ids.push(meta.id);
						keys.push(key);
					}
				}
				for (let i = 0; i < ids.length; i += 128) await this.vectorize.deleteByIds(ids.slice(i, i + 128));
				await deleteKeysBatched(this.doStorage, keys);
			}
		}

		protected async embed(text: string): Promise<number[] | null> {
			if (!this.ai) return null;
			try {
				const result = await this.ai.run("@cf/baai/bge-base-en-v1.5", {
					text: [text],
				});
				// Platform-paid: ledger the embedding (issue #44). Embeddings have no output
				// tokens; input is estimated from text length (Workers AI returns no usage).
				if (this.meter?.userId) {
					await recordPlatformUsage(
						{ DB: this.meter.db },
						{ userId: this.meter.userId, agentId: this.meter.agentId, instanceId: this.meter.instanceId, model: "@cf/baai/bge-base-en-v1.5", kind: "embedding" },
						{ input: approxTokens(text.length), output: 0 },
					);
				}
				return (result as { data: number[][] }).data?.[0] || null;
			} catch {
				return null;
			}
		}
	};
}
