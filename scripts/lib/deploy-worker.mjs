/**
 * `wrangler deploy` with a bounded retry for Cloudflare's own transient failures (#1046).
 *
 * Four of six API deploys on 2026-10-12 went red with the build uploaded and serving: wrangler
 * uploaded the Worker, deployed every trigger but ONE workflow, and exited 1 on
 * `A request to the Cloudflare API (/accounts/…/workflows/pags-job-apply) failed.` — a different
 * workflow each time — or on `Received a malformed response from the API`. A red run then said
 * nothing about whether anything had shipped.
 *
 * Re-running the whole `wrangler deploy` is the recovery: it re-uploads the same build and
 * re-applies every trigger, and there is no narrower command for one trigger. Only failures that
 * are Cloudflare's to have — the messages below — are retried; anything carrying a Cloudflare
 * error code, an auth refusal or a build error stops at once, exactly as before.
 *
 * Every run ends in ONE status, reported on the step summary, as an annotation and as a step output:
 *
 *   deployed              first attempt succeeded
 *   deployed_after_retry  a transient failure, then success — green, with a warning naming it
 *   failed                a non-transient failure; red, not retried
 *   retryable_failure     transient on every attempt; red, and says a re-run is the fix
 */

export const MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and 3: long enough for a Cloudflare API blip, short enough for a deploy. */
export const BACKOFF_MS = [20_000, 60_000];

const TRANSIENT = [
	/A request to the Cloudflare API \([^)]*\) failed/,
	/Received a malformed response from the API/,
	/\b(?:429|5\d\d)\b[^\n]*(?:Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Origin)/i,
	/\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)\b|socket hang up|fetch failed/,
];

/** Cloudflare's "an internal error occurred" code is the only coded error worth a second try. */
const TRANSIENT_CODES = new Set(["10013"]);

const HARD = [/Authentication error/i, /\bUnauthorized\b/, /\bForbidden\b/, /Build failed/, /Could not resolve/];

/**
 * What a failed `wrangler deploy` was. `transient` only when a known transient message is present
 * AND nothing says otherwise: an auth or build error, or any Cloudflare error code but 10013 — the
 * same "A request to the Cloudflare API … failed" line also introduces a validation refusal, and
 * that one carries its code.
 */
export function classifyFailure(output) {
	if (HARD.some((re) => re.test(output))) return "hard";
	const codes = [...output.matchAll(/\[code: (\d+)\]/g)].map((m) => m[1]);
	if (codes.some((c) => !TRANSIENT_CODES.has(c))) return "hard";
	return TRANSIENT.some((re) => re.test(output)) ? "transient" : "hard";
}

/** The Cloudflare resources a failed attempt names — `workflow pags-job-apply`, or the raw API path. */
export function failedResources(output) {
	const out = [];
	for (const m of output.matchAll(/A request to the Cloudflare API \(([^)]*)\) failed/g)) {
		const wf = /\/workflows\/([^/?]+)/.exec(m[1]);
		const label = wf ? `workflow ${wf[1]}` : m[1];
		if (!out.includes(label)) out.push(label);
	}
	return out;
}

/**
 * Run `attempt()` (→ `{ code, output }`) up to `maxAttempts` times, waiting `backoff[i]` between
 * tries, retrying only a transient failure. Returns the final status and every attempt's record.
 */
export async function deployWithRetry({ attempt, sleep, maxAttempts = MAX_ATTEMPTS, backoff = BACKOFF_MS, log = () => {} }) {
	const attempts = [];
	for (let n = 1; n <= maxAttempts; n++) {
		const { code, output } = await attempt(n);
		if (code === 0) {
			attempts.push({ n, kind: "ok" });
			return { status: n === 1 ? "deployed" : "deployed_after_retry", attempts };
		}
		const kind = classifyFailure(output);
		attempts.push({ n, kind, resources: failedResources(output) });
		if (kind === "hard") return { status: "failed", attempts };
		if (n < maxAttempts) {
			const wait = backoff[Math.min(n - 1, backoff.length - 1)];
			log(`Attempt ${n} hit a transient Cloudflare API failure; retrying in ${wait / 1000}s.`);
			await sleep(wait);
		}
	}
	return { status: "retryable_failure", attempts };
}

/** Exit code for a status: only a deploy that finished is green. */
export const exitCodeFor = (status) => (status === "deployed" || status === "deployed_after_retry" ? 0 : 1);

/** The one line a reader needs, plus the GitHub annotation it goes out as (null when there is none). */
export function describe(worker, result) {
	const tries = result.attempts.length;
	const transient = result.attempts.filter((a) => a.kind === "transient");
	const named = [...new Set(transient.flatMap((a) => a.resources))];
	const what = named.length ? ` (${named.join(", ")})` : "";
	switch (result.status) {
		case "deployed":
			return { line: `${worker}: deployed.`, annotation: null };
		case "deployed_after_retry":
			return {
				line: `${worker}: deployed after ${tries} attempts — earlier attempts hit transient Cloudflare API failures${what}.`,
				annotation: `::warning title=${worker} deployed after retry::Deployed on attempt ${tries}; earlier attempts hit transient Cloudflare API failures${what}.`,
			};
		case "retryable_failure":
			return {
				line: `${worker}: NOT confirmed deployed — transient Cloudflare API failures on all ${tries} attempts${what}. The build is fine; re-run this workflow.`,
				annotation: `::error title=${worker} deploy: retryable_failure::Transient Cloudflare API failures on all ${tries} attempts${what}. Some resources may be updated and others not. Re-run this workflow.`,
			};
		default:
			return {
				line: `${worker}: deploy failed on attempt ${tries} with a non-transient error — not retried. See the wrangler output above.`,
				annotation: `::error title=${worker} deploy: failed::wrangler deploy failed with a non-transient error on attempt ${tries}; not retried.`,
			};
	}
}
