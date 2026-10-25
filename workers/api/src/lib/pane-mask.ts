/**
 * The cloud's own redactor for terminal text (#1195).
 *
 * #1166 made the RUNNER redact a pane before it leaves the machine. That protects nothing from a runner older than 0.4.158, which
 * still answers with the pane as it is, and nothing already stored. So the platform masks a pane itself, at every point it takes
 * one in or writes one down: the terminal connectors' results, what is stored in `terminal_history` and the coding timeline, a
 * coding capture shown to a client, and the sign-in relay's pane. Masking twice is harmless.
 *
 * The patterns are the runner's `maskSecrets` (packages/cli/src/crash-reports.ts, vendored in the runner), the one redactor
 * everything shares; `pane-mask.test.ts` runs both over the same corpus so they cannot drift. Conservative by design: it masks what
 * has the SHAPE of a credential (a bearer header, a provider key, a JWT or two-part session, `password=…`), and cannot know a
 * password somebody typed by hand at a prompt that echoed it.
 */
export function maskPaneText(text: string): string {
	if (!text) return text;
	return text
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
		.replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abp]-[A-Za-z0-9-]{8,}|pags_runner_[A-Za-z0-9-]{8,})/g, "[redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{8,})?/g, "[redacted-jwt]")
		.replace(/\b((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)("?)[^\s"&]{4,}\2/gi, "$1[redacted]");
}

/** A tmux / terminal connector result with its text masked; any other connector's result is returned as it is. */
export function maskConnectorResult<R extends { content: string }>(connector: string | undefined, result: R): R {
	return connector === "tmux" || connector === "terminal" ? { ...result, content: maskPaneText(result.content) } : result;
}
