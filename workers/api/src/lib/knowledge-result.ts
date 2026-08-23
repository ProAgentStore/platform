/**
 * The four knowledge-base readers whose result IS someone else's text (#747).
 *
 * ── The defect ────────────────────────────────────────────────────────────────────────────────
 *
 * The same corpus reached the model down two paths, 40 lines apart in `lib/retrieval.ts`, and
 * only one of them was fenced:
 *
 *   • the chat turn's automatic RAG block — `ragContextOrNotice` at `retrieval.ts:136`, which
 *     wraps it in `fenceUntrusted(context, "documents/URLs/repos/webhooks")`;
 *   • `search_knowledge` / `read_knowledge` / `list_knowledge` / `read_file` — the TOOL path,
 *     which stringified the same chunks straight into a tool result. `grep -c fenceUntrusted
 *     lib/storage-tools.ts` was 0.
 *
 * Same bytes, same source, same turn, opposite treatment — decided by whether the model happened
 * to call a tool. And the corpus is untrusted by the platform's own account: `agent-think.ts`
 * calls it "documents, ingested URLs, repo files and public webhook payloads, any of which an
 * attacker can author", and `routes/public.ts` says of the unauthenticated ingest route that it
 * "ingests third-party content … straight into an instance's vector store, which is the
 * untrusted-content path (#263)".
 *
 * Why it was missed: `storage-tools.ts` is not a CONNECTOR, so it was outside the vocabulary of
 * both #263 and #308 and outside `security-invariants.test.ts`'s per-module map, which lists
 * connector modules. The split that created the second path (#628, separating "matched nothing"
 * from "could not run") is right; what went with it silently is that the fence lived on only one
 * branch — `buildRAGContext` returns a prose block for the fence to sit on, while
 * `searchKnowledgeFor` returns a typed array its caller stringifies.
 *
 * ── Where the boundary sits, and why prose is allowed outside it ───────────────────────────────
 *
 * Inside the block: everything describing the retrieved document — the chunk JSON, a document's
 * title and content, a file's NAME (a webhook-ingested doc names itself) and its text window.
 * Outside it: the platform's own instructions, which the model must obey — "To read around a
 * file match…", "call read_file again with offset=…". Fencing our own instruction says the
 * opposite of what the block claims and teaches the model the marker carries no information,
 * which is the argument `connectors/gmail.ts` makes for NOT fencing "No messages matched".
 *
 * Trailing prose after a fence is normally a hazard — `unfenceUntrusted`'s regex is ANCHORED at
 * both ends, so "a fence plus a sentence" is not a fence the pipeline binder can unwrap, and any
 * `$ref` off it would resolve to undefined while the transcript still looked right
 * (`confirmation-link-result.ts` records the same trap). It is safe HERE because these results
 * reach a model and nothing else: `executeStorageTool` has exactly one caller,
 * `agent-think.ts`'s chat tool loop. These are not registry connector tools, so they are on no
 * pipeline step, no `POST /v1/instances/:id/tools/:name` call and no MCP proxy path. Verified by
 * grep at the time of writing; if that ever stops being true, the hints move inside or the
 * results stop carrying them.
 *
 * ── What is deliberately NOT fenced ────────────────────────────────────────────────────────────
 *
 * `add_knowledge` / `update_knowledge` confirmations, `RETRIEVAL_EMPTY_MESSAGE`, "The knowledge
 * base is empty." and every `fail(...)`. Those are the platform reporting an outcome about
 * itself. A fence around a confirmation is a fence that marks nothing in particular.
 *
 * Pure string builders, so the placement is testable without D1, R2 or Vectorize — which is the
 * difference between a test that asserts the fence and a test that asserts a mock.
 */
import { fenceUntrusted } from "./untrusted-fence.js";

/**
 * What the corpus IS, rendered into every block so a transcript says where the text came from.
 * One string: four call sites describing the same store four ways is how they drift.
 */
export const KNOWLEDGE_ORIGIN = "documents, URLs, repo files and webhook payloads indexed in this agent's knowledge base";

/** `search_knowledge` — the matched chunks, then OUR hint about how to read around them. */
export function searchKnowledgeResult(results: unknown): string {
	return (
		`${fenceUntrusted(JSON.stringify(results, null, 2), KNOWLEDGE_ORIGIN)}\n\n` +
		`To read around a file match and quote it exactly: read_file with id=sourceId and offset ≈ (the number after "_" in the match id) × 512.`
	);
}

/** `list_knowledge` — ids and titles. A title is authored by whoever supplied the document. */
export function listKnowledgeResult(docs: unknown): string {
	return fenceUntrusted(JSON.stringify(docs, null, 2), KNOWLEDGE_ORIGIN);
}

/** `read_knowledge` — one document, whole. Nothing of ours rides along, so nothing sits outside. */
export function knowledgeDocResult(doc: { id: string; title: string; content: string }): string {
	return fenceUntrusted(JSON.stringify(doc, null, 2), KNOWLEDGE_ORIGIN);
}

/**
 * `read_file` — one window of a stored document.
 *
 * The `File: <name> (chars a–b of n)` header goes INSIDE: the name is part of the untrusted
 * document, and a header carrying it in the platform's own voice is the same defect as the page
 * title on apply's `CURRENT PAGE` line (#749). The continuation hint stays outside — it is the
 * instruction that lets the model page through the rest.
 */
export function fileWindowResult(header: string, body: string, more: string): string {
	return fenceUntrusted(`${header}\n\n${body}`, KNOWLEDGE_ORIGIN) + more;
}
