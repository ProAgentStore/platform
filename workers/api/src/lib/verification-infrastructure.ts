/**
 * A browser verification run that failed because the ENGINE refused (usage or quota limit) or the RUNNER refused
 * (`runner_overloaded`) never looked at the posting (#1611). That is not a verification attempt: it must not spend
 * one of the lead's attempts or move the lead to `unverifiable`. Pure; the dispatcher defers the lead, the repair
 * reopens the ones already closed by it.
 */
import { engineProviderError, resetHintFromLine } from "./engine-provider-error.js";

export type InfrastructureKind = "engine_quota" | "runner_overloaded";
export interface InfrastructureFailure {
	kind: InfrastructureKind;
	/** The engine's stated reset instant, when its words gave one. */
	resetAt: number | null;
	/** The provider the refusal was written for, e.g. `openai (codex)`. */
	provider?: string;
}

/** Wait when the engine did not say when it reopens (or said a time already past). */
export const ENGINE_QUOTA_BACKOFF_MS = 30 * 60_000;
/** Wait after the runner refused as overloaded. */
export const RUNNER_OVERLOADED_BACKOFF_MS = 10 * 60_000;
/** A stated reset further out than this is looked at again at this point, not trusted blindly. */
export const MAX_DEFER_MS = 7 * 24 * 60 * 60_000;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When the limit lifts, as the engine printed it: Codex "try again at Nov 11th, 2026 5:38 PM" (read as UTC: the
 * runner's zone is not known, and a wrong zone only moves the next look by hours), or "try again in 2 hours".
 */
export function engineResetAt(text: string, now: number): number | null {
	const abs = /\btry again at\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)\b/i.exec(text);
	if (abs) {
		const month = MONTHS.findIndex((m) => abs[1].toLowerCase().startsWith(m));
		const hour = (Number(abs[4]) % 12) + (abs[6].toUpperCase() === "PM" ? 12 : 0);
		if (month >= 0) return Date.UTC(Number(abs[3]), month, Number(abs[2]), hour, Number(abs[5]));
	}
	for (const line of text.split("\n")) {
		const hint = resetHintFromLine(line);
		if (hint && "inMs" in hint) return now + hint.inMs;
	}
	return null;
}

/** Is this failed run the engine's or the runner's refusal rather than a read of the posting? */
export function infrastructureFailure(errorCode: string | null | undefined, error: string | null | undefined, now = Date.now()): InfrastructureFailure | null {
	if (errorCode === "runner_overloaded") return { kind: "runner_overloaded", resetAt: null };
	if (errorCode !== "engine_failed" || !error) return null;
	const e = engineProviderError(error, undefined);
	if (!e || (e.kind !== "limit" && e.kind !== "billing")) return null;
	return { kind: "engine_quota", resetAt: engineResetAt(error, now), provider: e.provider };
}

/** The instant to look at the lead again: the engine's reset when it is ahead, else a bounded backoff. */
export function deferUntil(f: InfrastructureFailure, now: number): number {
	const backoff = f.kind === "runner_overloaded" ? RUNNER_OVERLOADED_BACKOFF_MS : ENGINE_QUOTA_BACKOFF_MS;
	if (!f.resetAt || f.resetAt <= now) return now + backoff;
	return Math.min(f.resetAt, now + MAX_DEFER_MS);
}

/** An attempt's stored detail (`The verification run ended failed (CODE): ERROR`), read back as an infrastructure failure. */
export function infrastructureFailureOfDetail(detail: string | null | undefined): InfrastructureFailure | null {
	const m = /ended failed \(([a-z_]+)\)(?::\s*([\s\S]*))?$/.exec(detail ?? "");
	return m ? infrastructureFailure(m[1], m[2]) : null;
}
