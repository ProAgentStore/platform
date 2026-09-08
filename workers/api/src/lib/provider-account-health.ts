/**
 * Is the owner's AI provider ACCOUNT able to pay for a run right now? (#773)
 *
 * ── Why this is read off the record rather than probed
 *
 * The failure this surfaces — Anthropic's `credit balance is too low` 400 — is a fact about the
 * owner's own account, which this platform neither holds nor can query: the provider has no balance
 * endpoint, and `billing_status` (PAGS billing) was correctly `none` while a run was dying on it. The
 * only way to KNOW is to spend a request, and #773 forbids doing that ahead of every dispatch. So
 * `coding_diagnostics` reports what the platform already OBSERVED, for free: the newest recorded
 * account failure, and whether the same key has succeeded since. A caller who wants a live answer
 * spends one request on purpose, via `POST /v1/keys/anthropic/verify` — named in the report.
 *
 * ── The two clocks
 *
 * `recordCodingFailure` files every run death with its class in `error_log.context.failureClass`,
 * and `runAnthropic` stamps `user_api_keys.last_used_at` after every SUCCESSFUL call. A failure newer
 * than the last success is a state the owner is still in; a success newer than the failure says the
 * top-up already happened. Neither clock alone says that — which is why the old answer ("read
 * `list_errors`") left the reader to work it out.
 *
 * Rows written before #773 classified an empty balance as `provider_credentials`, so the class is
 * re-read from the row's own message rather than trusted from its context: the sentence is what the
 * classifier matches, and it is stored verbatim.
 */
import { classifyCodingFailure, DRIVER_RESUME_POLICY, type CodingFailureClass } from "./coding-failure.js";
import { ERROR_RECENCY } from "./error-log.js";
import type { Env } from "../types.js";

/** Classes that are a statement about the owner's provider ACCOUNT rather than about a run. */
const ACCOUNT_CLASSES: ReadonlySet<CodingFailureClass> = new Set<CodingFailureClass>(["provider_credit", "provider_credentials"]);

export type ProviderAccountState =
	/** Nothing on record. Says nothing about the balance — see `verify` for a live answer. */
	| "no_failure_recorded"
	/** An account failure is on record and the key has not succeeded since. */
	| "failing"
	/** An account failure is on record and the key HAS succeeded since — the owner already acted. */
	| "recovered";

export interface ProviderAccountHealth {
	provider: "anthropic";
	state: ProviderAccountState;
	/** `provider_credit` (top up) or `provider_credentials` (fix the key); null with no failure. */
	failureClass: CodingFailureClass | null;
	/** When the newest account failure was last seen — ISO-ish UTC as D1 stores it. */
	lastFailureAt: string | null;
	/** The provider's own sentence, with the run's framing stripped. */
	lastFailure: string | null;
	/** The newest SUCCESSFUL call on this key, from `user_api_keys.last_used_at`; null if never. */
	lastSuccessAt: string | null;
	/** What the owner does about it — the same sentence a dead run files. */
	remedy: string | null;
	/** How to get a LIVE answer, at the cost of one four-token request. */
	verify: string;
}

interface FailureRow {
	message: string;
	context: string | null;
	last_context: string | null;
	seen_at: string | null;
}

/** `coding run abcd1234 failed (provider_credit) at s6-decide after 3 steps: <raw>` → `<raw>`. */
export function providerSentenceOf(message: string): string {
	const m = /after \d+ steps(?:, resumed)?: ([\s\S]*)$/.exec(message);
	return (m ? m[1] : message).trim();
}

/** D1's `datetime('now')` is `YYYY-MM-DD HH:MM:SS` UTC with no zone; ISO strings also arrive here. */
function epoch(at: string | null | undefined): number | null {
	if (!at) return null;
	const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(at) ? `${at.replace(" ", "T")}Z` : at);
	return Number.isFinite(t) ? t : null;
}

function classOf(row: FailureRow): CodingFailureClass | null {
	// The sentence first: a pre-#773 row says `provider_credentials` in its context for what is
	// really an empty balance, and the message it stores is what the classifier reads today.
	const fromMessage = classifyCodingFailure(new Error(providerSentenceOf(row.message))).class;
	if (ACCOUNT_CLASSES.has(fromMessage)) return fromMessage;
	for (const raw of [row.last_context, row.context]) {
		try {
			const cls = (JSON.parse(raw ?? "null") as { failureClass?: unknown } | null)?.failureClass;
			if (typeof cls === "string" && ACCOUNT_CLASSES.has(cls as CodingFailureClass)) return cls as CodingFailureClass;
		} catch {
			// a corrupt context column must not 500 the diagnostics page — fall through
		}
	}
	return null;
}

export const VERIFY_HINT = "POST /v1/keys/anthropic/verify — one four-token request against the stored key, on demand";

/**
 * Read the record. Never throws: it runs on the page a user opens when everything else is broken.
 */
export async function readProviderAccountHealth(env: Pick<Env, "DB">, userId: string): Promise<ProviderAccountHealth> {
	const none: ProviderAccountHealth = {
		provider: "anthropic",
		state: "no_failure_recorded",
		failureClass: null,
		lastFailureAt: null,
		lastFailure: null,
		lastSuccessAt: null,
		remedy: null,
		verify: VERIFY_HINT,
	};
	const [row, key] = await Promise.all([
		env.DB.prepare(
			`SELECT message, context, last_context, ${ERROR_RECENCY} AS seen_at FROM error_log
			 WHERE user_id = ?1 AND source = 'coding:session'
			   AND json_extract(context, '$.failureClass') IN ('provider_credit', 'provider_credentials')
			 ORDER BY ${ERROR_RECENCY} DESC LIMIT 1`,
		)
			.bind(userId)
			.first<FailureRow>()
			.catch(() => null),
		env.DB.prepare("SELECT last_used_at FROM user_api_keys WHERE user_id = ?1 AND provider = 'anthropic'")
			.bind(userId)
			.first<{ last_used_at: string | null }>()
			.catch(() => null),
	]);
	const lastSuccessAt = key?.last_used_at ?? null;
	if (!row) return { ...none, lastSuccessAt };
	const failureClass = classOf(row);
	if (!failureClass) return { ...none, lastSuccessAt };
	const failedAt = epoch(row.seen_at);
	const succeededAt = epoch(lastSuccessAt);
	const recovered = failedAt !== null && succeededAt !== null && succeededAt > failedAt;
	return {
		provider: "anthropic",
		state: recovered ? "recovered" : "failing",
		failureClass,
		lastFailureAt: row.seen_at,
		lastFailure: providerSentenceOf(row.message),
		lastSuccessAt,
		remedy: DRIVER_RESUME_POLICY[failureClass].why,
		verify: VERIFY_HINT,
	};
}
