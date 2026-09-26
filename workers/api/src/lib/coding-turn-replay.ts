/**
 * Per-turn replay: the platform's record delivered with EVERY turn to an engine that cannot remember
 * the last one (#693 slice 2, ADR 0005).
 *
 * ── The boundary this file formalises
 *
 *   The platform's conversation (`coding_timeline`) is the SOURCE OF TRUTH for what a run knows.
 *   An engine's own memory — Claude's live process and `--resume`, Codex's explicit thread id
 *   (#848) — is an OPTIMISATION, preferred whenever it is actually there.
 *
 * Slice 1 applied that at the START of a session (`seedBriefForRepo`, spent once by the first turn).
 * It left raw engines with memory for one turn: a raw CLI is a fresh process per turn, so turn two
 * began cold again. This closes that: every message turn to an engine that holds no conversation of
 * its own carries a replay composed from the same record, with the same bounds and the same honesty
 * preamble ("reconstruction, not restoration").
 *
 * ── Who decides, split exactly as slice 1 split it
 *
 * The CLOUD composes, because only it holds the record. The RUNNER spends or drops, because only
 * the machine knows whether this turn's engine is carrying its own conversation: a Codex session with
 * a live thread id drops the replay, the same session after the CLI fell back to raw output spends
 * it. The cloud skips only what it can know for certain — a Claude session, whose persistent process
 * holds the conversation for as long as the session lives — so the common case costs no D1 read.
 *
 * ── Never a missing turn
 *
 * A replay that cannot be composed is an absent replay: the turn is sent exactly as it was before
 * this existed. A missing memory must never become a missing instruction.
 */
import { seedBriefForRepo } from "./coding-seed-brief.js";
import type { Env } from "../types.js";

/** Engines whose runner session holds its own conversation between turns, always. */
const HOLDS_OWN_CONVERSATION = new Set(["claude"]);

/** Whether the cloud should compose a replay for a turn to this engine at all. Pure. */
export function wantsTurnReplay(clientType: string | null | undefined): boolean {
	return !HOLDS_OWN_CONVERSATION.has((clientType || "claude").toLowerCase());
}

/**
 * The action to send, with `replay` attached when this engine may need it. Only `message` actions
 * carry one; an interrupt is not a turn. Never throws.
 */
export async function withTurnReplay<A extends { kind: string; text?: string }>(
	env: Env,
	s: { instanceId: string; userId: string; repoId: string; repoName?: string; clientType: string | null | undefined },
	action: A,
): Promise<A & { replay?: string }> {
	if (action.kind !== "message" || !action.text || !wantsTurnReplay(s.clientType)) return action;
	const replay = await seedBriefForRepo(env, { instanceId: s.instanceId, userId: s.userId, repoId: s.repoId, repoName: s.repoName, instruction: action.text }).catch(() => "");
	return replay ? { ...action, replay } : action;
}
