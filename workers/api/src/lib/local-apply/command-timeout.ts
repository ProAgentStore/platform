import { cliAtLeast } from "../runner-upgrade.js";

export const BROWSER_COMMAND_TIMEOUT_MIN_CLI = "0.4.225";

/** Old recorded runs lack this field; never reinterpret their frozen policy as a new setting. */
export function browserCommandTimeoutRunnerProblem(config: { browserCommandTimeoutSeconds?: number }, version: string | null | undefined): string | null {
	if (config.browserCommandTimeoutSeconds === undefined) return null;
	if (version && cliAtLeast(version, BROWSER_COMMAND_TIMEOUT_MIN_CLI)) return null;
	return `The configured browser command timeout (${config.browserCommandTimeoutSeconds} seconds) requires CLI ${BROWSER_COMMAND_TIMEOUT_MIN_CLI} or newer; this runner reports ${version || "unknown"}. Update and restart the runner before retrying. Older runners silently use their own timeout.`;
}
