/**
 * Retrieval availability (#628) — the read path's half of the promise `indexingEnabled` made
 * on the write path (#22).
 *
 * ── The distinction this module exists to preserve
 *
 * "Your corpus has nothing matching that" and "I could not search your corpus" are different
 * answers, and they demand different things of the user: the first is a legitimate, common,
 * correct result that means *ask differently or add a document*; the second means *nothing is
 * wrong with your data, try again in a minute*. Before this module the second was reported as
 * the first, in the exact words "the knowledge base may be empty" — a fabricated explanation of
 * an infrastructure failure, handed to the model as `success: true`.
 *
 * The stakes are not hypothetical: one live Repo Chat instance holds 3,979 chunks across 315
 * sources reachable ONLY through `search_knowledge`. A single transient embedder error made the
 * agent deny, confidently, that it had ever been given any of it.
 *
 * ── Why it is NOT collapsed into a generic error
 *
 * An empty corpus must stay a plain `ok(...)`. A guard that answered both cases with "something
 * went wrong" would trade one lie for another and train users to ignore it.
 *
 * ── The boundary that is deliberately NOT an error
 *
 * `indexingEnabled === false` (no Vectorize/AI binding — e.g. PLATFORM_AI_ENABLED off) still
 * returns `[]`. That is a static property of the deployment, not an event: nothing was ever
 * embedded, so there is genuinely nothing to find, and #22 already requires the WRITE side to
 * report `vectorized: false` rather than a false green. The dangerous case — the one that makes
 * a populated corpus look empty for one turn — is an embedder failure on a deployment where
 * indexing IS on, and that is what throws.
 */
import type { VectorSearchResult } from "../agent-storage-types.js";
import { logError } from "./error-log.js";
import { fenceUntrusted } from "./untrusted-fence.js";

/**
 * The search could not RUN. Distinct from "the search ran and matched nothing", which is an
 * empty array and a success.
 */
export class RetrievalUnavailableError extends Error {
	constructor(cause?: unknown) {
		super(`knowledge retrieval unavailable: ${cause instanceof Error ? cause.message : String(cause ?? "embedder returned no vector")}`);
		this.name = "RetrievalUnavailableError";
		this.cause = cause;
	}
}

export function isRetrievalUnavailable(err: unknown): err is RetrievalUnavailableError {
	return err instanceof RetrievalUnavailableError;
}

/**
 * What the MODEL is told when the search could not run. It has to do two jobs: state the failure,
 * and explicitly forbid the inference the old message invited — because "no results" is the
 * evidence a model reasons from, and left to itself it will conclude the user uploaded nothing.
 */
export const RETRIEVAL_UNAVAILABLE_TOOL_MESSAGE =
	"Knowledge retrieval is unavailable right now — the search could NOT be run, so this is not a statement about what is stored. Do not tell the user their knowledge base is empty or that they have not added anything; say the search failed and can be retried in a moment.";

/** What the model is told when the search DID run and the corpus genuinely had no match. */
export const RETRIEVAL_EMPTY_MESSAGE =
	"No relevant results found. The search ran successfully and matched nothing — the knowledge base may be empty, or the query didn't match any stored content.";

/** The system-prompt block for a chat turn whose grounding search could not run. */
export const RETRIEVAL_UNAVAILABLE_PROMPT = `## Knowledge Retrieval Unavailable
A search of this agent's stored documents could not be run for this turn (retrieval backend failure). Anything stored is therefore ABSENT from your context right now, and its absence is not evidence that it does not exist. Do not claim the knowledge base is empty, and do not answer from memory as though you had checked it — say you could not search it this turn.`;

/** Everything a failure report needs from whichever surface caught it. */
export interface RetrievalReportCtx {
	env?: { DB: D1Database };
	agentId?: string;
	userId?: string;
}

/**
 * One durable record per failure, so an outage that used to leave NO trace anywhere — not the
 * error log, not the trace, not the console — is answerable afterwards. Best-effort by
 * construction: reporting a retrieval failure must never become a second failure.
 */
async function report(err: unknown, where: string, ctx?: RetrievalReportCtx): Promise<void> {
	if (!ctx?.env) return;
	await logError(ctx.env as never, {
		source: "rag-retrieval",
		message: `${where}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
		context: { agentId: ctx.agentId, surface: where },
		userId: ctx.userId ?? null,
	}).catch(() => undefined);
}

export type SearchOutcome =
	| { ok: true; results: VectorSearchResult[] }
	| { ok: false; message: string };

/**
 * Run the `search_knowledge` vector search, separating "matched nothing" from "could not run".
 * Lives here rather than inline in storage-tools.ts so both the sentence and the failure report
 * have exactly one definition.
 */
export async function searchKnowledgeFor(
	engine: { vectorSearch(query: string, topK?: number, filter?: { sourceType?: VectorSearchResult["sourceType"] }): Promise<VectorSearchResult[]> },
	args: { query: string; topK: number; sourceType?: string },
	ctx?: RetrievalReportCtx,
): Promise<SearchOutcome> {
	try {
		const results = await engine.vectorSearch(args.query, args.topK, {
			sourceType: args.sourceType as VectorSearchResult["sourceType"] | undefined,
		});
		return { ok: true, results };
	} catch (err) {
		if (!isRetrievalUnavailable(err)) throw err;
		await report(err, "search_knowledge", ctx);
		return { ok: false, message: RETRIEVAL_UNAVAILABLE_TOOL_MESSAGE };
	}
}

/**
 * The chat turn's grounding block, already fenced — or, when retrieval could not run, a notice
 * saying so. Returns "" only when the search genuinely ran and there was nothing to add.
 *
 * The notice is deliberately OUTSIDE the untrusted fence: it is a platform statement about the
 * platform, not retrieved text, and a model told to discount everything inside the fence would
 * discount the one instruction here that matters.
 *
 * Known trade-off: a retrieval failure also costs this turn its conversation-summary block,
 * because `buildRAGContext` composes both and the throw unwinds past the summaries. That is a
 * transient-outage path and the notice explains the gap; splitting the two is not worth a second
 * public method on the engine.
 */
export async function ragContextOrNotice(
	engine: { buildRAGContext(query: string): Promise<string> },
	query: string,
	ctx?: RetrievalReportCtx,
): Promise<string> {
	try {
		const context = await engine.buildRAGContext(query);
		return context ? fenceUntrusted(context, "documents/URLs/repos/webhooks") : "";
	} catch (err) {
		if (!isRetrievalUnavailable(err)) throw err;
		await report(err, "chat-rag", ctx);
		return RETRIEVAL_UNAVAILABLE_PROMPT;
	}
}
