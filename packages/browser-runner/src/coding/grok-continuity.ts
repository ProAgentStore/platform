/**
 * Grok keeps ITS OWN conversation across one-shot turns (#1156) — by an id the runner chooses.
 *
 * Every Grok turn is a new `grok … -p "<turn>"` process, so without this each turn started with no memory of the last
 * one but the platform's replay. `-c/--continue` was the CLI's only offer when the preset was written, and it picks the
 * MOST RECENT session in the directory — another `grok` run in the same checkout (the owner's own) would answer instead
 * (`coding-engines.ts`, "NO PRESET RESUMES"). xAI's Grok CLI now takes an explicit id, so continuity is exact:
 *
 *   first turn    `-s <uuid>`   a NEW conversation under an id the runner made up (1.x: must be a UUID, must not exist);
 *   later turns   `-r <uuid>`   resume exactly that one (errors if it does not exist — never "the most recent").
 *
 * Checked against `grok --help` of xAI's Grok CLI 1.0.62 (2026-10-18). 0.2.x also accepts both: there `-s` creates-or-
 * resumes and `-r` errors on an unknown id. NOT yet exercised end to end — the CLI refuses every turn until it is signed
 * in, and it was not on the machine this was written on — so the runner treats it as unproven: a turn whose flags are
 * rejected is retried once without them and the session runs without continuity, and the platform's replay is still
 * sent with every turn (`holdsConversationThisTurn` stays false for Grok) until a signed-in run proves it.
 */
import { randomUUID } from "node:crypto";

export interface GrokConversation {
	/** The id the runner gave the conversation. */
	id: string;
	/** A turn under it has completed, so the CLI holds it: resume it rather than create it. */
	started: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Only a UUID ever reaches argv — anything else read back from the state file is discarded. */
export function isGrokConversationId(value: unknown): value is string {
	return typeof value === "string" && UUID_RE.test(value);
}

export function newGrokConversation(makeId: () => string = randomUUID): GrokConversation {
	return { id: makeId(), started: false };
}

/** The turn's argv: the continuity flag first (any order parses), then the preset, then the turn as `-p`'s value. */
export function grokTurnArgs(userArgs: string[], turnText: string, conversation: GrokConversation | null): string[] {
	if (!conversation) return [...userArgs, turnText];
	return [conversation.started ? "-r" : "-s", conversation.id, ...userArgs, turnText];
}

/**
 * The CLI refused the continuity flags themselves — an argument error, printed before it signs in or runs anything (the
 * argument parser runs first). Narrow on purpose: retrying any other failure could run a real instruction twice.
 */
// Only a line that BEGINS with the CLI's own `error:` (clap's argument errors), and only about these flags or the id —
// a tool's output in a failed turn that merely mentions a session must never cause a same-turn retry.
const REJECTED_RE = /^\s*error:\s(?:.*unexpected argument '?-(?:s|r)\b|.*(?:--session-id|--resume)\b|.*must be a valid uuid|.*session\b.*\b(?:not found|already exists|does not exist))/i;

export function grokRejectedContinuity(lines: readonly string[]): boolean {
	return lines.some((l) => REJECTED_RE.test(l));
}

/**
 * The session id Grok's `end` event reports, if it is one the CLI could be resumed by (#1197). Checked, not trusted: it reaches
 * argv on the next turn, so only a UUID passes.
 */
export function reportedGrokSession(end: unknown): string | null {
	const id = end && typeof end === "object" ? (end as { sessionId?: unknown }).sessionId : undefined;
	return isGrokConversationId(id) ? id : null;
}

/**
 * What a finished turn means for the conversation. Pure.
 *
 * `reported` is the session id the CLI's own `end` event named. The runner asks for one by id (`-s`), so on a CLI that honours it the
 * two are the same and nothing changes. When they differ, the CLI holds the conversation under ITS id — resuming ours would
 * error ("session not found") and lose the thread — so the next turn resumes the one it reported (`adopted`).
 */
export function afterGrokTurn(
	conversation: GrokConversation,
	outcome: { code: number | null; rejected: boolean; reported?: string | null },
): { next: GrokConversation | null; persist: string | null; disable: boolean; adopted?: string } {
	// The flags themselves were refused before anything ran: run without continuity from now on.
	if (outcome.code && outcome.rejected) return { next: null, persist: null, disable: true };
	// Done: the CLI holds the conversation now. Remember it, so the next turn — and the next runner start — resume it.
	if (outcome.code === 0 && outcome.reported && outcome.reported !== conversation.id) {
		return { next: { id: outcome.reported, started: true }, persist: outcome.reported, disable: false, adopted: outcome.reported };
	}
	if (outcome.code === 0) return { next: { ...conversation, started: true }, persist: conversation.id, disable: false };
	// Any other failure: the conversation may be half-made or unknown. Forget it, so the next turn starts a clean one.
	return { next: null, persist: null, disable: false };
}
