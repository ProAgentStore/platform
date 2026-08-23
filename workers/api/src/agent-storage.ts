/**
 * Agent Storage Engine — manages all persistent data for an agent DO.
 *
 * Layers:
 * - DO storage: structured records, memory, conversations, activity log
 * - R2: binary file storage (resumes, documents, media)
 * - Vectorize: semantic embeddings for RAG retrieval
 *
 * The implementation is split into cohesive mixins under `./agent-storage/`
 * (vectors, activity, collections, files, knowledge, summaries, context). This
 * file is the public entry point: it composes them into `AgentStorageEngine`
 * and re-exports the engine + its metering hook so every existing
 * `import … from "./agent-storage.js"` keeps working unchanged.
 */
import type { Env } from "./types.js";
import { AgentStorageBase, type EngineMeter } from "./agent-storage/base.js";
import { withActivity } from "./agent-storage/activity.js";
import { withCollections } from "./agent-storage/collections.js";
import { withContext } from "./agent-storage/context.js";
import { withFiles } from "./agent-storage/files.js";
import { withKnowledge } from "./agent-storage/knowledge.js";
import { withSummaries } from "./agent-storage/summaries.js";
import { withVectors } from "./agent-storage/vectors.js";

export type { EngineMeter } from "./agent-storage/base.js";

// Compose in dependency order: each layer may call methods from the layers below
// it. Vectors + Activity are the shared primitives; the rest build on them.
const ComposedStorageEngine = withContext(
	withSummaries(withKnowledge(withFiles(withCollections(withActivity(withVectors(AgentStorageBase)))))),
);

export class AgentStorageEngine extends ComposedStorageEngine {
	constructor(
		doStorage: DurableObjectStorage,
		r2: R2Bucket | null,
		vectorize: VectorizeIndex | null,
		ai: Ai | null,
		agentId: string,
		/**
		 * D1, for the durable error log (#637) — REQUIRED, deliberately.
		 *
		 * The engine's only channel out of a background failure used to be `console.error`, which a
		 * Worker does not persist: a file that uploaded but never reached the index appeared in no
		 * `error_log`, no `list_errors` and no admin Errors tile. Making this a seventh OPTIONAL
		 * argument would have recreated that silence for the next construction site that forgot it,
		 * so it has no default and the compiler names every caller. Pass `null` only where there
		 * genuinely is no database (unit tests), which is then a written decision rather than an
		 * omission.
		 */
		db: Pick<Env, "DB"> | null,
		meter: EngineMeter | null = null,
	) {
		super(doStorage, r2, vectorize, ai, agentId, db, meter);
	}
}
