/**
 * The account session `runner connect` signs in with — held in memory, never in the environment (#1163).
 *
 * `pags up` used to hand the session to `runner connect` as `PAGS_TOKEN`, and from there it reached the
 * runtime and every coding engine it spawned: a 30-day account session in the environment of a CLI that
 * runs with its permission prompts off on untrusted repos and issues. Now `pags up` passes nothing — this
 * process reads `session.json` itself, as every `pags` command does — and a `PAGS_TOKEN` it was started
 * with anyway (an explicit caller) is taken OUT of the environment before anything is spawned, and kept
 * here. The session refresher (#1157) updates it here too, not in `process.env`.
 */
import { loadSession } from "../login.js";

let held: string | null = null;

function clean(value: string | undefined | null): string {
	return (value ?? "").trim();
}

/** Move `PAGS_TOKEN` from the environment into this process's memory. Call before spawning anything. */
export function takeSessionTokenFromEnv(env: NodeJS.ProcessEnv = process.env): void {
	const token = clean(env.PAGS_TOKEN);
	if (token) held = token;
	delete env.PAGS_TOKEN;
}

/** A refreshed session replaces the held one (#1157). */
export function holdSessionToken(token: string): void {
	held = clean(token) || held;
}

/** The session to sign in with: an explicit `--pags-token`, then the held one, then `PAGS_TOKEN`, then `session.json`. */
export function sessionToken(explicit?: string | null): string {
	return clean(explicit) || clean(held) || clean(process.env.PAGS_TOKEN) || clean(loadSession()?.token);
}

/** For tests: forget the held session. */
export function resetHeldSessionToken(): void {
	held = null;
}
