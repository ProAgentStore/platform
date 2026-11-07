/**
 * A verification run that failed on the engine (`engine_failed`) carries the CLI's raw output tail - for Codex, JSONL events
 * (#1598). The owner reads a sentence instead: the engine's name, why it stopped and, for a limit, when it reopens. The raw text
 * stays on the run. The classification is `engineProviderError`; there is no second table here. Pure.
 */
import { formatLocal, resetInstantFromHint } from "./coding-wait.js";
import { engineProviderError, resetHintFromLine } from "./engine-provider-error.js";

/** What `outcomeFromRun` (and so every stored row) puts in front of an `engine_failed` run's error. */
const STORED_PREFIX = /^The verification run ended \S+ \(engine_failed\): /;
const ANY_PREFIX = /^The verification run ended \S+(?: \(\S+\))?: /;
const EXIT = /The (\S+) CLI exited with code (\d+)/;

const engineName = (engine: string): string => engine.charAt(0).toUpperCase() + engine.slice(1).toLowerCase();

/**
 * The sentence for a failed run's `error` (the runner's own text, or a stored row's whole `The verification run ended ...` sentence).
 * `at` is when the run ended and the instant a relative reset hint counts from; `now` is given only when reading a stored row back,
 * where a reset that has already passed is left out.
 */
export function engineFailureSentence(error: string, at: number, zone: string | undefined, now?: number): string {
	const text = error.replace(ANY_PREFIX, "");
	const exit = EXIT.exec(text);
	if (!exit) return "The CLI stopped with an error.";
	const engine = engineName(exit[1]);
	const lines = text.split("\n");
	const found = engineProviderError(undefined, lines);
	if (!found) return `The ${engine} CLI stopped (exit code ${exit[2]}).`;
	if (found.kind === "billing") return `${engine} account has no quota left.`;
	if (found.kind === "transient") return `${engine} was unavailable.`;
	let resets = "";
	for (const line of [...lines].reverse()) {
		const hint = resetHintFromLine(line);
		if (!hint) continue;
		const instant = resetInstantFromHint(hint, at, zone);
		if (instant !== null && (now === undefined || instant >= now)) resets = ` Resets at ${formatLocal(instant, zone)}.`;
		break;
	}
	return `${engine} usage limit reached.${resets}`;
}

/**
 * A detail as the owner should read it: a stored `engine_failed` sentence becomes the human one; every other value (success details,
 * guidance, sentences already mapped) is returned unchanged.
 */
export function readableVerificationDetail(detail: string | null, at: number | null, zone: string | undefined, now?: number): string | null {
	if (detail === null || !STORED_PREFIX.test(detail)) return detail;
	return engineFailureSentence(detail, at ?? 0, zone, now);
}
