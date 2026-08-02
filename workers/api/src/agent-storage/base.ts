/**
 * AgentStorageEngine base — constructor, shared state, and mixin plumbing.
 *
 * The engine is composed from cohesive mixins (vectors, activity, collections,
 * files, knowledge, summaries, context, rag). Each mixin extends the previous
 * layer so later groups can call earlier groups' methods. The fields are
 * `protected` so mixins can reach them; the public surface is unchanged.
 */

/**
 * Optional metering hook (issue #44): when present, platform-paid Workers-AI calls
 * (embeddings + conversation summaries) run inside this engine are ledgered as
 * provider="platform" so operator spend is visible + attributable. Absent (most
 * call sites) → no ledger, same as before.
 */
export interface EngineMeter {
	db: D1Database;
	userId?: string;
	agentId?: string | null;
	instanceId?: string | null;
}

export const MAX_EVENTS = 500;
export const SUMMARY_THRESHOLD = 20;
// Summarization always runs on the platform Workers AI binding (`this.ai`), never on
// BYOK Anthropic. Flagship agents carry a Claude model id (`claude-sonnet-4-6`), and
// passing that to `env.AI.run(...)` throws — so Claude-agent summaries silently never
// generated (and re-fired every turn). Fall back to a small CF model for any non-`@cf/`
// agent model so summaries actually run.
export const SUMMARY_CF_MODEL = "@cf/meta/llama-3.2-3b-instruct";
export const MAX_COLLECTION_RECORDS = 10_000;
export const MAX_COLLECTIONS = 50;
export const CHUNK_SIZE = 512; // characters per vector chunk

// biome-ignore lint/suspicious/noExplicitAny: mixin constructor helper
export type GConstructor<T = object> = new (...args: any[]) => T;

export class AgentStorageBase {
	constructor(
		protected doStorage: DurableObjectStorage,
		protected r2: R2Bucket | null,
		protected vectorize: VectorizeIndex | null,
		protected ai: Ai | null,
		protected agentId: string,
		protected meter: EngineMeter | null = null,
	) {}
}

export type AgentStorageBaseCtor = GConstructor<AgentStorageBase>;
