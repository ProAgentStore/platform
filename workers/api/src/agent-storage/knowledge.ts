/**
 * Knowledge base — editable documents (via chat/console) backed by vectors.
 */
import type { ActivityEvent, VectorMeta } from "../agent-storage-types.js";
import type { KnowledgeDoc } from "../agent-types.js";
import type { AgentStorageBaseCtor } from "./base.js";

/** Sibling methods this group relies on (provided by earlier layers). */
interface KnowledgeDeps {
	logEvent(type: ActivityEvent["type"], userId?: string, data?: Record<string, unknown>, channel?: string): Promise<ActivityEvent>;
	vectorizeStore(sourceType: VectorMeta["sourceType"], sourceId: string, text: string): Promise<string[]>;
	vectorDelete(sourceType: VectorMeta["sourceType"], sourceId: string): Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: mixin constructor helper
type GConstructorWith<T> = new (...args: any[]) => T;

export function withKnowledge<TBase extends AgentStorageBaseCtor & GConstructorWith<KnowledgeDeps>>(Base: TBase) {
	return class extends Base {
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

		/**
		 * Delete a knowledge document and its vectors. Returns null if not found; THROWS if the
		 * vectors could not be removed.
		 *
		 * Order matters, and it used to be the other way round (#242). Deleting the record first
		 * and swallowing the vector failure meant: the doc vanished from Knowledge → Documents,
		 * its chunks stayed in Vectorize, and there was nothing left to retry against — the id was
		 * gone, no sweeper reconciles the two stores, so RAG kept retrieving and the agent kept
		 * citing a document the user deleted. Permanently, and reported as success.
		 *
		 * Deleting a KB doc is what a user does when a document is WRONG or shouldn't be there
		 * (stale instructions, a mistakenly uploaded client file). "It's deleted but the agent
		 * still knows it" is the one outcome that must not happen quietly. Vectors first, then the
		 * record: a failure now leaves the document visible and the delete retryable, and the
		 * caller is told rather than congratulated.
		 */
		async deleteKnowledge(id: string): Promise<KnowledgeDoc | null> {
			const existing = await this.doStorage.get<KnowledgeDoc>(`kb:${id}`);
			if (!existing) return null;
			try {
				await this.vectorDelete("knowledge", id);
			} catch (err) {
				throw new Error(
					`Couldn't remove this document's indexed content, so it was NOT deleted — it would keep answering searches. Try again. (${err instanceof Error ? err.message : String(err)})`,
				);
			}
			await this.doStorage.delete(`kb:${id}`);
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
	};
}
