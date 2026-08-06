/**
 * The knowledge-base routes — the `kb:` documents an instance owns and their vectors.
 *
 * Extracted from AgentDO so the invariants below can be tested against an in-memory store
 * instead of a Durable Object. It owns no Cloudflare types: the DO injects a thin storage
 * interface and a `resolve()` that hands back the agent id + its storage engine at exactly
 * the point the DO used to call `getState()` (lazily, AFTER the document write — the order
 * matters, an uninitialised DO still stores the doc, it just can't index it).
 *
 * The rules this file exists to keep:
 * - a doc is saved even when it can't be indexed, but the reply says `vectorized:false`
 *   rather than an unqualified success — indexing off (#22) counts as not searchable;
 * - a delete removes the VECTORS FIRST and refuses (503) if that fails (#242), because the
 *   other order strands chunks in the index with nothing left to retry against;
 * - both write paths share one 20-document ceiling, so Import URL is not a way past it.
 */
import type { KnowledgeDoc } from "./agent-types.js";
import type { AgentStorageEngine } from "./agent-storage.js";
import { logError } from "./lib/error-log.js";
import { json } from "./lib/do-json.js";
import { safeFetch, SsrfError } from "./lib/ssrf.js";
import type { Env } from "./types.js";

/** Minimal DO-storage surface these routes need (satisfied by DurableObjectStorage). */
export interface KnowledgeStore {
	get<T = unknown>(key: string): Promise<T | null | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(keyOrKeys: string | string[]): Promise<unknown>;
	list<T = unknown>(opts?: { prefix?: string }): Promise<Map<string, T>>;
}

/** Minimal storage-engine surface these routes need. */
export type KnowledgeEngine = Pick<
	AgentStorageEngine,
	"indexingEnabled" | "vectorizeStore" | "vectorDelete" | "logEvent"
>;

export interface KnowledgeCtx {
	storage: KnowledgeStore;
	env: Env;
	/** The agent id + its storage engine, or null when this DO was never initialised. */
	resolve(): Promise<{ agentId: string; engine: KnowledgeEngine } | null>;
}

async function getAllKnowledge(storage: KnowledgeStore): Promise<KnowledgeDoc[]> {
	const all = await storage.list<KnowledgeDoc>({ prefix: "kb:" });
	return [...all.values()];
}

export async function getKnowledge(ctx: KnowledgeCtx): Promise<Response> {
	return json({ documents: await getAllKnowledge(ctx.storage) });
}

export async function addKnowledge(ctx: KnowledgeCtx, request: Request): Promise<Response> {
	const body = await request.json<{
		title: string;
		content: string;
		source?: KnowledgeDoc["source"];
		sourceUrl?: string;
	}>();
	// Content may be empty — a document can be created title-first and filled in
	// later (in the editor or by the agent via update_knowledge).
	const content = typeof body.content === "string" ? body.content : "";
	if (!body.title)
		return json({ error: "title required" }, 400);
	if (content.length > 100_000)
		return json({ error: "Document too large (max 100KB)" }, 400);

	// Limit total knowledge base size (max 20 docs)
	const existing = await ctx.storage.list({ prefix: "kb:" });
	if (existing.size >= 20)
		return json({ error: "Knowledge base full (max 20 documents)" }, 400);

	const doc: KnowledgeDoc = {
		id: crypto.randomUUID(),
		title: body.title.slice(0, 500),
		content,
		source: body.source || "paste",
		sourceUrl: body.sourceUrl,
		addedAt: new Date().toISOString(),
	};
	await ctx.storage.put(`kb:${doc.id}`, doc);

	// Vectorize the document for semantic retrieval. The doc is saved either way, but we
	// must NOT report an unqualified success if it isn't searchable — surface it via a
	// `vectorized` flag + the error log so callers (résumé parse, MCP) can tell the user.
	let vectorized = true;
	const resolved = await ctx.resolve();
	if (resolved) {
		const { agentId, engine } = resolved;
		// Indexing off (no Vectorize/AI binding, e.g. PLATFORM_AI_ENABLED=false): vectorizeStore
		// no-ops WITHOUT throwing, so report vectorized:false rather than a false green (#22).
		if (!engine.indexingEnabled) {
			vectorized = false;
		} else {
			try {
				await engine.vectorizeStore("knowledge", doc.id, `${doc.title}\n\n${doc.content}`);
			} catch (err) {
				vectorized = false;
				await logError(ctx.env, {
					source: "knowledge-vectorize",
					message: `knowledge doc saved but not searchable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
					context: { agentId, docId: doc.id },
				}).catch(() => undefined);
			}
		}
		await engine.logEvent("knowledge.added", undefined, {
			docId: doc.id,
			title: doc.title,
			size: doc.content.length,
			vectorized,
		}).catch(() => {});
	}

	return json({ ...doc, vectorized }, 201);
}

/** Read one document's full content (for the console viewer/editor). */
export async function readKnowledge(ctx: KnowledgeCtx, id: string): Promise<Response> {
	const doc = await ctx.storage.get<KnowledgeDoc>(`kb:${decodeURIComponent(id)}`);
	if (!doc) return json({ error: "not found" }, 404);
	return json({ document: doc });
}

/** Amend a document's title/content from the console editor, re-vectorizing it. */
export async function updateKnowledge(
	ctx: KnowledgeCtx,
	id: string,
	request: Request,
): Promise<Response> {
	const decodedId = decodeURIComponent(id);
	const existing = await ctx.storage.get<KnowledgeDoc>(`kb:${decodedId}`);
	if (!existing) return json({ error: "not found" }, 404);
	const body = await request.json<{ title?: string; content?: string }>();
	if (typeof body.content === "string" && body.content.length > 100_000)
		return json({ error: "Document too large (max 100KB)" }, 400);
	const updated: KnowledgeDoc = {
		...existing,
		title: (typeof body.title === "string" && body.title.trim() ? body.title.trim() : existing.title).slice(0, 500),
		content: typeof body.content === "string" ? body.content : existing.content,
		updatedAt: new Date().toISOString(),
	};
	await ctx.storage.put(`kb:${decodedId}`, updated);

	let vectorized = true;
	const resolved = await ctx.resolve();
	if (resolved) {
		const { agentId, engine } = resolved;
		if (!engine.indexingEnabled) {
			vectorized = false; // indexing off (#22) — don't claim a searchable update
		} else try {
			await engine.vectorDelete("knowledge", decodedId).catch(() => undefined);
			await engine.vectorizeStore("knowledge", decodedId, `${updated.title}\n\n${updated.content}`);
		} catch (err) {
			vectorized = false;
			await logError(ctx.env, {
				source: "knowledge-vectorize",
				message: `knowledge doc updated but not searchable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
				context: { agentId, docId: decodedId },
			}).catch(() => undefined);
		}
		await engine.logEvent("knowledge.updated", undefined, { docId: decodedId, title: updated.title, vectorized }).catch(() => undefined);
	}
	return json({ ...updated, vectorized });
}

export async function deleteKnowledge(ctx: KnowledgeCtx, id: string): Promise<Response> {
	const decodedId = decodeURIComponent(id);

	// Vectors FIRST, then the record (#242). The other order deletes the doc from the console
	// and, if Vectorize then errors, strands its chunks in the index with nothing left to
	// retry against — RAG keeps citing a document the user deleted, permanently. Failing here
	// leaves the document listed, so the user can simply delete it again.
	const resolved = await ctx.resolve();
	if (resolved) {
		const { agentId, engine } = resolved;
		try {
			await engine.vectorDelete("knowledge", decodedId);
		} catch (err) {
			await logError(ctx.env, {
				source: "knowledge-vectorize",
				message: `knowledge doc NOT deleted — its indexed content could not be removed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
				context: { agentId, docId: decodedId },
			}).catch(() => undefined);
			return json({ error: "Couldn't remove this document's indexed content, so it was not deleted — it would keep answering searches. Try again." }, 503);
		}
		await ctx.storage.delete(`kb:${decodedId}`);
		await engine.logEvent("knowledge.removed", undefined, { docId: decodedId });
		return json({ success: true });
	}

	// No state (an uninitialised DO) — there is no vector index to reconcile against.
	await ctx.storage.delete(`kb:${decodedId}`);
	return json({ success: true });
}

export async function ingestUrl(ctx: KnowledgeCtx, request: Request): Promise<Response> {
	const { url, title } = await request.json<{
		url: string;
		title?: string;
	}>();
	if (!url) return json({ error: "url required" }, 400);

	// Same 20-doc ceiling as addKnowledge — Import URL must not be a backdoor
	// past the cap (a prompt-injected agent could otherwise ingest-url in a loop).
	const existingUrlDocs = await ctx.storage.list({ prefix: "kb:" });
	if (existingUrlDocs.size >= 20)
		return json({ error: "Knowledge base full (max 20 documents)" }, 400);

	try {
		// SSRF protection: https-only + reject non-public hosts, re-validated on EVERY
		// redirect hop (default follow would let a public host 302 us to a private one).
		let res: Response;
		try {
			res = await safeFetch(url, { headers: { "User-Agent": "ProAgentStore-Ingest" } });
		} catch (e) {
			return json({ error: e instanceof SsrfError ? e.message : `Failed to fetch: ${e instanceof Error ? e.message : String(e)}` }, 400);
		}
		if (!res.ok)
			return json({ error: `Failed to fetch: ${res.status}` }, 400);

		const contentType = res.headers.get("content-type") || "";
		let text = await res.text();

		// Strip HTML tags for web pages
		if (contentType.includes("html")) {
			text = text
				.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
				.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim();
		}

		// Truncate to 50KB per doc
		if (text.length > 50_000)
			text = `${text.slice(0, 50_000)}\n...[truncated]`;

		const doc: KnowledgeDoc = {
			id: crypto.randomUUID(),
			title: title || new URL(url).hostname,
			content: text,
			source: "url",
			sourceUrl: url,
			addedAt: new Date().toISOString(),
		};
		await ctx.storage.put(`kb:${doc.id}`, doc);

		// Vectorize so the imported page is actually RETRIEVABLE. The agent only surfaces
		// knowledge via RAG (buildRAGContext → vectorSearch) — a doc with no vectors is
		// invisible forever. addKnowledge/updateKnowledge already do this; without
		// it, Import URL silently succeeded but the agent could never answer about the page.
		let vectorized = true;
		const resolved = await ctx.resolve();
		if (resolved) {
			const { agentId, engine } = resolved;
			try {
				await engine.vectorizeStore("knowledge", doc.id, `${doc.title}\n\n${text}`);
			} catch (e) {
				vectorized = false;
				await logError(ctx.env, {
					source: "knowledge-vectorize",
					message: `ingested URL saved but not searchable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300),
					context: { agentId, docId: doc.id, url },
				}).catch(() => undefined);
			}
			await engine.logEvent("knowledge.added", undefined, { docId: doc.id, title: doc.title, size: text.length, source: "url", vectorized }).catch(() => {});
		}
		return json({ ...doc, vectorized }, 201);
	} catch (err) {
		return json(
			{
				error: `Ingest failed: ${err instanceof Error ? err.message : String(err)}`,
			},
			400,
		);
	}
}
