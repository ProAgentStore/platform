// What a dead engine session said before it died (#882).
//
// Two Codex runs on pink-laptop failed ~35s in with "coding session is not running" and an empty
// terminal, and the investigation had to start from nothing. The runner had not been silent: a
// missing binary makes `spawn` fail with ENOENT, and the runner writes
// `[codex] failed to start: spawn codex ENOENT` into the session's pane and reports the session dead.
// The platform then dropped that pane on the floor — `runCodingLoop`'s dead-session branch returned
// a constant, and an autonomous run persists no terminal snapshots, so `coding_terminal` read empty.
//
// So the dead-session ending now carries the engine's own last words, and names the one cause that
// has a single remedy: the engine binary is not on the runner's PATH. Pure — the loop calls it with
// the snapshot it already holds.

/** The runner's two phrasings of "the engine binary could not be spawned" (headless.ts). */
const SPAWN_FAILED_RE = /\[([\w.-]+)\] failed to start: (spawn (\S+) (ENOENT|EACCES)[^\n\]]*)|\[cannot run `([^`]+)`: (spawn \S+ (ENOENT|EACCES)[^\n\]]*)/;

/** How many of the pane's last lines are carried — enough for an error and its exit code. */
const TAIL_LINES = 6;
const TAIL_CHARS = 600;

/** The pane's last non-empty lines, trimmed and capped — what the engine said last. */
export function lastEngineWords(pane: string): string {
	const lines = (pane || "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(-TAIL_LINES);
	const text = lines.join(" | ");
	return text.length > TAIL_CHARS ? `…${text.slice(-TAIL_CHARS)}` : text;
}

/**
 * The `failed` detail for a session that is not alive. Keeps the historical prefix, so anything
 * matching on "coding session is not running" still matches.
 */
export function deadSessionDetail(pane: string): string {
	const spawn = SPAWN_FAILED_RE.exec(pane || "");
	if (spawn) {
		const bin = spawn[3] ?? spawn[5]?.split("/").pop() ?? "the engine";
		const code = spawn[4] ?? spawn[7];
		const why =
			code === "EACCES"
				? `\`${bin}\` exists on the runner but is not executable`
				: `\`${bin}\` is not installed on the runner, or not on the PATH of the process running \`pags up\``;
		return `coding session is not running: the engine could not be started — ${why} (${(spawn[2] ?? spawn[6]).trim()}). Install it on that machine (for Codex: \`npm install -g @openai/codex\`, then \`codex login\`), restart \`pags up\`, and run again — or switch this instance to an engine that is installed (coding_engine_set).`;
	}
	const said = lastEngineWords(pane);
	return said ? `coding session is not running. The engine's last output: ${said}` : "coding session is not running (the engine produced no output)";
}
