/**
 * What a provider adapter is (#1356): the one seam between `runUserWorkersAi`'s routing and a provider's wire.
 *
 * `user-ai.ts` used to hold both providers' request building, sending, error handling and result shaping in one file, and so decided the
 * same questions — is this credit or credentials, what does the owner do about it, what did it cost — in more than one place. An adapter
 * answers them for ITS provider, once. The shared driver (`completeWith` in `user-ai.ts`) asks:
 *
 *   buildRequest   the provider's request for a brain's body, or a refusal thrown BEFORE any network call
 *   send           the request, under the provider's deadlines; transport failures arrive as `UserAiProviderError`
 *   parseError     a refusal, read once into a {@link ProviderErrorWire} — its `kind` is the only classification anyone else sees
 *   readSuccess    the whole reply (Anthropic assembles a stream; Workers AI reads JSON)
 *   usage          the ledger row's tokens
 *   toResult       the one result shape every brain reads
 *   remedy         the sentence that tells the owner which page fixes a refusal of this kind
 *
 * The driver does the rest in one place: it observes the account (holds) from the `kind`, records `last_used_at` once, and writes the ledger.
 */
import type { ProviderErrorKind } from "./provider-error-kind.js";

export type AiProvider = "anthropic" | "cloudflare";

/** A refusal as the adapter read it: what the driver needs to throw it and to record the account's state. */
export interface ProviderErrorWire {
	kind: ProviderErrorKind;
	/** The provider's own words plus its facts and remedy, WITHOUT the kind tag (the driver appends it). */
	message: string;
	/** The status this platform reports the failure with (a refused key is 400, everything else 502). */
	status: number;
	upstreamStatus: number;
	details: unknown;
	/** Could an IDENTICAL immediate retry plausibly succeed? (#518) */
	retryable: boolean;
}

/** Tokens for the usage ledger. `toolCalls` rides with them so the ledger counts calls as it always did. */
export interface ProviderUsage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
	toolCalls?: number;
}

export interface ProviderAdapter<Cred, Req extends { model: string }, Raw> {
	readonly id: AiProvider;
	buildRequest(body: unknown, model: string, ctx?: { kind?: string }): Req;
	send(req: Req, credential: Cred): Promise<Response>;
	parseError(res: Response, req: Req, credential: Cred): Promise<ProviderErrorWire>;
	readSuccess(res: Response, req: Req): Promise<Raw>;
	usage(raw: Raw): ProviderUsage;
	toResult(raw: Raw, req: Req): unknown;
	remedy(kind: ProviderErrorKind, facts: { status: number; keyHint: string | null }): string;
	/** What identifies the credential to the hold table: the Anthropic key, or the Cloudflare envelope. */
	credentialRef(credential: Cred): string | { accountId: string; token: string };
}

/**
 * The provider's own error type and request id, as a bracketed suffix (#1326). In the MESSAGE, not
 * only `details`, because a Workflow step boundary keeps an error's message and drops its fields —
 * and without these a refusal could not be told apart from a dead key, or traced with the provider.
 */
export function providerFacts(type: string | null | undefined, requestId: string | null | undefined): string {
	const facts = [type, requestId ? `request-id ${requestId}` : null].filter(Boolean);
	return facts.length ? ` [${facts.join("; ")}]` : "";
}
