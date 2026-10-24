/**
 * The answer of `POST /v1/keys/:provider/verify` (routes/keys.ts) — one minimal provider request against the stored key.
 * A leaf that imports nothing, so the console's type test can compare its copy against it (#1326).
 */
export interface KeyVerifyResponse {
	ok: boolean;
	provider: string;
	checkedAt: string;
	/** On a refusal: the provider's own message, with its error type and request id. */
	error?: string;
	upstreamStatus?: number;
	details?: unknown;
	/** The class a dead run would file (`provider_credentials`, `provider_credit`, …). */
	failureClass?: string;
	/** The same remedy sentence `DRIVER_RESUME_POLICY` gives for that class. */
	remedy?: string;
}
