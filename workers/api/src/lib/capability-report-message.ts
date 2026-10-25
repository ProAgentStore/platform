/**
 * What `get_machine_capabilities` says when a machine has not reported (#1321).
 *
 * The old answer was always "update the runner (`pags update`)". That is wrong in two cases this question exists to separate:
 * when the machine ALREADY runs the newest published release and that release has no capability reporting (no update can help
 * until a release with it is published — which is how #1312 sat for a day), and when the machine runs a release that does report
 * but has not yet (a different cause: it reports at startup, so it is not running, or not connected).
 */
import type { PublishedCli } from "./auto-update-stuck.js";
import { compareCliVersions } from "./machine-identity.js";

/** Is `a` at least `b`? An unreadable version is not "at least" anything: the caller falls back to the plain advice. */
const atLeast = (a: string, b: string): boolean => {
	const c = compareCliVersions(a, b);
	return c !== null && c >= 0;
};

/** The first CLI release that reports a machine's capabilities (#1312, shipped in 0.4.177). */
export const CAPABILITY_REPORT_MIN_CLI = "0.4.177";

export function capabilityNotReportedMessage(input: { runnerVersion: string | null | undefined; published: PublishedCli | null }): string {
	const v = input.runnerVersion?.trim() || null;
	const latest = input.published?.latest ?? null;
	const generic = "This machine has not reported its capabilities yet. Update the runner (`pags update`) and keep `pags up` running; it reports at startup.";
	if (!v || compareCliVersions(v, CAPABILITY_REPORT_MIN_CLI) === null) return generic;
	if (atLeast(v, CAPABILITY_REPORT_MIN_CLI)) {
		return `This machine has not reported its capabilities yet. It runs ${v}, which reports at startup, but none has arrived. Check that \`pags up\` is running and connected on it; its next heartbeat reports.`;
	}
	if (latest && !atLeast(latest, CAPABILITY_REPORT_MIN_CLI)) {
		return `This machine has not reported its capabilities, and cannot yet: it runs ${v}, the newest published runner (${latest}), and that release does not report capabilities (reporting began in ${CAPABILITY_REPORT_MIN_CLI}). Updating will not help: a release with it has to be published first.`;
	}
	if (latest) return `This machine has not reported its capabilities: it runs ${v}, which predates capability reporting (${CAPABILITY_REPORT_MIN_CLI}); ${latest} is published. Update the runner (\`pags update\`, or runner_update) and keep \`pags up\` running; it reports at startup.`;
	return `This machine has not reported its capabilities: it runs ${v}, which predates capability reporting (${CAPABILITY_REPORT_MIN_CLI}). Update the runner (\`pags update\`, or runner_update) and keep \`pags up\` running; it reports at startup.`;
}
