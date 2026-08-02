/**
 * Per-user context + the RAG context builder (vector search + summaries).
 */
import type { ConversationSummary, FileMeta, UserContext, VectorMeta, VectorSearchResult } from "../agent-storage-types.js";
import type { KnowledgeDoc } from "../agent-types.js";
import type { AgentStorageBaseCtor } from "./base.js";

/** Sibling methods this group relies on (provided by earlier layers). */
interface ContextDeps {
	vectorSearch(query: string, topK?: number, filter?: { sourceType?: VectorMeta["sourceType"] }): Promise<VectorSearchResult[]>;
	getSummaries(limit?: number): Promise<ConversationSummary[]>;
}

// biome-ignore lint/suspicious/noExplicitAny: mixin constructor helper
type GConstructorWith<T> = new (...args: any[]) => T;

export function withContext<TBase extends AgentStorageBaseCtor & GConstructorWith<ContextDeps>>(Base: TBase) {
	return class extends Base {
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
				// Name each excerpt's source document — without it the model can't tell that
				// its excerpts span several documents and presents one document's spec as
				// THE answer (live bug: "max ambient temp is 25°C" from one of four catalogs).
				const names = new Map<string, string>();
				const nameOf = async (r: VectorSearchResult): Promise<string> => {
					const k = `${r.sourceType}:${r.sourceId}`;
					if (!names.has(k)) {
						let n = r.sourceId;
						if (r.sourceType === "file") n = (await this.doStorage.get<FileMeta>(`file:${r.sourceId}`))?.name || r.sourceId;
						else if (r.sourceType === "knowledge") n = (await this.doStorage.get<KnowledgeDoc>(`kb:${r.sourceId}`))?.title || r.sourceId;
						else if (r.sourceType === "message") n = "conversation";
						names.set(k, n);
					}
					return names.get(k) as string;
				};
				parts.push(
					"## Relevant Knowledge\nExcerpts retrieved by meaning — each is labeled with its source document. Attribute facts to their document; when a question spans documents, answer per document (or use search_knowledge/read_file to check the others) instead of presenting one document's value as the only answer.",
				);
				for (const result of results) {
					if (totalChars + result.text.length > maxChars) break;
					parts.push(`[${result.sourceType}: ${await nameOf(result)}] (score: ${result.score.toFixed(2)})\n${result.text}`);
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
	};
}
