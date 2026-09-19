/**
 * Does a Workflow's subrequest counter reset across a `step.sleep`? (refs #814, #523)
 *
 * ── Why this exists
 *
 * `workers/api/src/lib/coding-idle-poll.ts` rejected #814's fix — chunk the Pilot's idle poll
 * across `step.sleep` boundaries — on the grounds that Cloudflare counts subrequests "per
 * Workflow instance", so "a `step.sleep` does NOT reset the counter". The first half is quoted
 * from the limits page. The second half is an INFERENCE from it: the page does not say what a
 * sleep or a step boundary does to the count, and nobody measured it. This measures it.
 *
 * ── Why it cannot be a vitest test
 *
 * The counter lives in Cloudflare's runtime. A test with a mocked `fetch` can only tell us what
 * our own loop does, which was never in question.
 *
 * ── The three modes, and why `control` is not optional
 *
 *   control  ONE step, 2 × BURST fetches, no boundary. With the limit at 100 this MUST fail near
 *            the 100th fetch. If it does not, the `[limits]` value was not honoured and the other
 *            two modes prove nothing — they would "succeed" with or without a reset.
 *   sleep    BURST fetches → `step.sleep` → BURST fetches. The question #814 turns on.
 *   step     BURST fetches → a new `step.do`, no sleep → BURST fetches. The repo's comment claims
 *            a step boundary does not reset it either; this is the same run for the price of a flag.
 *
 * Each burst is below the limit and two together are above it, so the second burst succeeds in
 * full ONLY if the boundary reset the count.
 *
 * ── Why the ceiling is caught rather than allowed to throw
 *
 * A throw inside `step.do` is a step failure, which Cloudflare retries — and every retry would
 * spend more of the very budget being measured. So each burst stops at its first error and
 * RETURNS what happened; the step succeeds, its result is journalled, and the verdict is read off
 * the instance's output instead of reverse-engineered from an error log.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

/** Must match `[limits] subrequests` in wrangler.toml — reported back so a mismatch is visible. */
const CONFIGURED_LIMIT = 100;
/** Below the limit alone, above it twice over. */
const BURST = 60;
/** A hostname, not an IP (Workers refuse direct-IP fetches), and ~200 bytes of plain text. */
const TARGET = "https://cloudflare.com/cdn-cgi/trace";

type Mode = "control" | "sleep" | "step";

interface Params {
	mode?: Mode;
	/**
	 * How long the `sleep` mode sleeps. A short sleep may be served without the instance ever
	 * leaving memory; a long one makes hibernation — a genuinely new invocation — far more likely.
	 * If `"1 second"` and `"2 minutes"` disagree, that difference IS the finding.
	 */
	sleep?: string;
}

interface Burst {
	attempted: number;
	succeeded: number;
	/** The first error's message, verbatim — expected to be Cloudflare's "Too many subrequests". */
	error: string | null;
}

async function burst(count: number): Promise<Burst> {
	let succeeded = 0;
	for (let i = 0; i < count; i++) {
		try {
			const res = await fetch(TARGET);
			// Release the connection; an unread body holds one of the six simultaneous slots.
			await res.body?.cancel();
			succeeded++;
		} catch (e) {
			return { attempted: i + 1, succeeded, error: e instanceof Error ? e.message : String(e) };
		}
	}
	return { attempted: count, succeeded, error: null };
}

/** One attempt, no retries: a retry would re-spend the budget under measurement. */
const ONCE = { retries: { limit: 0, delay: "1 second" as const }, timeout: "5 minutes" as const };

export class SubrequestResetProbe extends WorkflowEntrypoint<unknown, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		const mode: Mode = event.payload?.mode ?? "sleep";
		const sleep = event.payload?.sleep ?? "1 second";
		const base = { mode, configuredLimit: CONFIGURED_LIMIT, burst: BURST, target: TARGET };

		if (mode === "control") {
			const only = await step.do("control-single-step", ONCE, () => burst(BURST * 2));
			return {
				...base,
				bursts: [only],
				verdict:
					only.error === null
						? `LIMIT NOT HONOURED — ${only.succeeded} fetches passed a configured limit of ${CONFIGURED_LIMIT}. The sleep/step runs prove NOTHING at this setting.`
						: `LIMIT HONOURED — cut off after ${only.succeeded} fetches. The sleep/step runs are meaningful.`,
			};
		}

		const first = await step.do("burst-1", ONCE, () => burst(BURST));
		if (mode === "sleep") await step.sleep("reset-boundary", sleep);
		const second = await step.do("burst-2", ONCE, () => burst(BURST));

		const boundary = mode === "sleep" ? `step.sleep("${sleep}")` : "a step.do boundary";
		return {
			...base,
			...(mode === "sleep" ? { sleep } : {}),
			bursts: [first, second],
			verdict:
				first.error !== null
					? `INCONCLUSIVE — the FIRST burst failed after ${first.succeeded}, below the limit. Something else is wrong; read the error.`
					: second.error === null
						? `RESETS (only if the control run said LIMIT HONOURED) — ${first.succeeded + second.succeeded} fetches succeeded across ${boundary} against a limit of ${CONFIGURED_LIMIT}.`
						: `DOES NOT RESET — the count carried across ${boundary}: cut off after ${first.succeeded + second.succeeded} fetches in total.`,
		};
	}
}

export default {
	// Unreachable by design (no route, no workers.dev) — present because a module Worker needs a
	// default export. The probe is driven by `wrangler workflows trigger`, never over HTTP.
	fetch: () => new Response("subrequest-reset-probe: trigger it with `wrangler workflows trigger`; see README.md\n", { status: 404 }),
};
