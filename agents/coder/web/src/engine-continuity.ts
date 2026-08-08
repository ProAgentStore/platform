// Does this engine preset remember the previous turn? — pure, so the sentence is testable (#449).
//
// Claude is the one PERSISTENT engine: the runner keeps a single process alive and speaks
// structured stream-json to it across turns. Every other engine is spawned ONE-SHOT PER TURN
// (`packages/browser-runner/src/coding/headless.ts` — `oneShot` is `mode === "raw"`, and
// `runOneShot` spawns `[...presetArgs, turnText]` fresh each time). So the Pilot's step 7 runs in
// a process that has never seen steps 1-6: the working tree carries state, the conversation does
// not, and a step that says "now do the same for the other two files" has no antecedent.
//
// That is the design, not a defect — a non-interactive binary has nothing to keep alive, which is
// why the persistent path produced an instant "exited with code 1" for raw engines. The gap #449
// is about is that the platform never SAID so, at exactly the moment a user picks an engine.
//
// Derived, never hardcoded per engine. `isClaudeEngine` is the SDK's mirror of the API's
// `deriveClientType` (`workers/api/src/lib/coding-engines.ts`) — same launcher list, same
// `FOO=bar`/`npx` skipping, same claude-or-raw answer — so a preset the runner will drive as
// Claude is exactly the one this reports as persistent. A per-engine lookup table here would be a
// second opinion about the same question, and would go stale the first time someone writes
// `npx claude` or points a preset at a wrapper script.

import { isClaudeEngine } from "@proagentstore/sdk/ui";

export type EngineContinuity = "persistent" | "one-shot";

export interface EngineContinuityNote {
	continuity: EngineContinuity;
	/** The headline answer to "will it remember what it just did?". */
	label: string;
	/** Why, in the terms the user can act on — they own the command field. */
	detail: string;
}

/** Whether the runner drives this command as one persistent process or respawns it per turn. */
export function engineContinuity(command: string): EngineContinuity {
	return isClaudeEngine(command) ? "persistent" : "one-shot";
}

/**
 * The line to show under a preset, or null when there is nothing honest to say.
 *
 * A blank command means a row the user has just added and not yet filled in. `isClaudeEngine("")`
 * answers `true` (an empty command falls back to Claude at the runner), but asserting "keeps its
 * session between turns" against an empty text box is a claim about a preset that does not exist
 * yet — and it would be wrong the moment they type `codex`.
 */
export function engineContinuityNote(command: string): EngineContinuityNote | null {
	if (!command.trim()) return null;
	const continuity = engineContinuity(command);
	return continuity === "persistent"
		? {
				continuity,
				label: "Keeps its session between turns",
				detail: "One process stays alive, so a later instruction can refer to what an earlier one did.",
			}
		: {
				continuity,
				label: "One-shot — no memory of previous turns",
				// States the consequence rather than the mechanism: "fresh process" is only alarming
				// once you know what it costs. The working-tree half matters as much as the warning —
				// the engine is not amnesiac about the REPO, only about the conversation.
				detail: "Each turn is a fresh process. Edits it made survive in the repo, but nothing it said or decided does.",
			};
}
