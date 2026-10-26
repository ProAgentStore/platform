/**
 * The errors the user-ai layer throws (#1356). A leaf, so the provider adapters and `user-ai.ts` can all name them without importing each other.
 * `user-ai.ts` re-exports them: every existing importer is unchanged.
 */
import { type ProviderErrorKind, providerErrorTag } from "./provider-error-kind.js";
import type { StreamPhase } from "./stream-phase.js";

export class UserAiCredentialsError extends Error {
	/** No stored credential is a credentials failure by construction (#1355): readers ask the kind, not the wording. */
	readonly kind: ProviderErrorKind = "credentials";
	constructor(
		message = "Add your Cloudflare Workers AI account ID and API token before running this agent.",
		public readonly status = 402,
	) {
		super(`${message}${providerErrorTag("credentials")}`);
		this.name = "UserAiCredentialsError";
	}
}

export class UserAiProviderError extends Error {
	/**
	 * How many SSE events the assembler accepted before the stall deadline fired.
	 *
	 * Set only on a stall or first-token deadline, where the stream had opened. Absent on every
	 * other kind of failure. Recorded by `recordCodingFailure` into `error_log.context` so a reader
	 * can tell whether the silence began before or after the first content byte (#734).
	 */
	eventsSeen?: number;
	/** The `type` of the last SSE event accepted before silence — companion to `eventsSeen`. */
	lastEventType?: string;
	/**
	 * What the stream was doing when it went silent (#907) — measured, never inferred. Also written
	 * into the message as a `[stream: …]` suffix, because a Workflow step boundary keeps an error's
	 * message but not its own properties, which is why #734's fields never reached `error_log`.
	 */
	streamPhase?: StreamPhase;
	/** The provider and model THIS request ran on, for telemetry (#907). */
	provider?: string;
	model?: string;

	constructor(
		message: string,
		public readonly status = 502,
		public readonly upstreamStatus?: number,
		public readonly details?: unknown,
		/**
		 * Could an IDENTICAL immediate retry plausibly succeed? (#518)
		 *
		 * Set at the site that knows WHICH failure this is, because by the time it reaches a caller
		 * the only things left are a message and a 502/504 — and the three deadlines all report 504
		 * while disagreeing completely about whether retrying helps. Read by
		 * `autoResumableRoundOf`, which is what decides whether the platform performs the retry its
		 * own error message recommends. Defaults to false: a failure nobody classified is one
		 * nobody has established is transient, and the cost of guessing wrong is the user's own
		 * provider credit.
		 */
		public readonly retryable = false,
		/**
		 * What KIND of refusal this is (#1356) — decided once, by the adapter that built the error (`provider-error-kind.ts`), and
		 * also written into the message as a tag because a Workflow step boundary drops this field but keeps the message. Absent on an
		 * error that is not a provider's refusal (a deadline, an empty reply).
		 */
		public readonly kind?: ProviderErrorKind,
	) {
		super(message);
		this.name = "UserAiProviderError";
	}
}

/** A request this provider cannot carry, refused before any network call (#853). */
export class UserAiUnsupportedInputError extends UserAiProviderError {}
