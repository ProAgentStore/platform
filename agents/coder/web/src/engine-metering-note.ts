// Will this preset's spend show up on the Usage page? — pure, so the sentence is testable (#556).
//
// The engines panel offers Claude Code, Codex and Grok as equals and says nothing about the one
// difference that costs money invisibly: structured engines end each turn with an event carrying
// token counts, which the runner reads and the platform banks as a measured `ai_usage` row. Raw
// engines end a turn with plain stdout, so `takeUsage()` returns nothing and no row is written at
// all — and a missing row on a page of dollars reads as zero dollars, which is the exact confusion
// #348 removed for the tmux driver.
//
// So the choice is made at the moment a user picks an engine, and this is the moment to say it.
//
// ── Why the rule is restated here rather than fetched
//
// Same argument `engine-continuity.ts` and the SDK's `engine-posture.ts` already make, and for a
// sharper reason: the user EDITS the launch command in a text box, so the verdict has to follow
// what they have typed. A server-computed answer keyed by preset id would be stale the instant
// they turn a Claude preset into a codex one — which is precisely the edit whose consequence this
// exists to state — and a hint that needs a round-trip per keystroke is not a hint.
//
// The API's `classifyEngineMetering` ("headless", engine) is the authority, and its
// structured/raw classifier. That is not a coincidence this mirror has to track by hand: the
// runner now drives Claude and `codex exec --json` through structured adapters, and structured
// mode IS what produces the usage record. If another raw engine grows a structured turn-end event,
// the API's set, the runner's mode, and this helper move together.

import { engineInvocationMode } from "@proagentstore/sdk/ui";

export interface EngineMeteringNote {
	/** Can this engine's spend reach the ledger at all? */
	metered: boolean;
	/** The headline answer to "will I see what this costs?". */
	label: string;
	/** What it means for the numbers the user reads elsewhere. */
	detail: string;
}

/**
 * The metering line to show under a preset, or null when there is nothing honest to say.
 *
 * A blank command is a row the user has just added and not yet filled in. `isClaudeEngine("")`
 * answers true (an empty command falls back to Claude at the runner), but "its spend is measured"
 * is a claim about a preset that does not exist yet — and it would be wrong the moment they type
 * `codex`. Same guard, and same reason, as `engineContinuityNote`.
 */
export function engineMeteringNote(command: string): EngineMeteringNote | null {
	if (!command.trim()) return null;
	return engineInvocationMode(command) === "structured"
		? {
				metered: true,
				label: "Spend is measured",
				detail: "This engine reports each turn's tokens, so its spend appears on your Usage page.",
			}
		: {
				metered: false,
				label: "Spend is not measured",
				// States the consequence for the number the user actually looks at, not the mechanism.
				// "Ends a turn with plain stdout" is only alarming once you know what it costs, and
				// the cost is that Usage under-reports rather than that the engine is worse.
				detail: "This engine reports no token counts, so what it spends can't be measured and is missing from your Usage total — it is not free, it is invisible.",
			};
}
