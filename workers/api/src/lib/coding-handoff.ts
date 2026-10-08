/**
 * May the next objective start in this session and checkout? (#984) — the decision, pure.
 *
 * ── The incident
 *
 * A run for #978 stopped heartbeating and was closed `needs_human / interrupted` by the sweeper.
 * Three facts then disagreed about one repo:
 *
 *   the RUN RECORD said   #982 was running (the queue had drained the next entry into the session)
 *   the ENGINE was        still executing #978's instruction — finish the Board work, run the
 *                         gates, commit, push and close #978
 *   the CHECKOUT held     eight uncommitted files belonging to #978
 *
 * Every one of those is load-bearing. An engine told to "commit and close #978" in a tree that
 * also contains the start of #982 commits both under one issue; a Board that says #982 is working
 * is authoritative and false; and the human who has to recover the #978 work cannot tell which
 * changes are whose.
 *
 * ── Why nothing stopped it
 *
 * Three separate guards each answer a NARROWER question than "is this handover safe":
 *
 *   `claimSessionDriver`  "may I drive?" — and a claim whose heartbeat is older than
 *                         `STALE_DRIVER_MS` (15 min) is deliberately TAKEABLE, so a dead Pilot
 *                         cannot lock a repo for the three hours the run sweeper needs.
 *   the one-run check     "is a row `running`?" — and the sweeper had already moved #978's row to
 *                         `needs_human`, so it was not.
 *   `admitRepoForRun`     "is there a checkout at that path?" — a dirty tree is a healthy one.
 *
 * None of them looks at the ENGINE, and none of them knows that what is in the tree belongs to
 * somebody. That is this module: the fourth question, asked of the machine, with an owner attached.
 *
 * ── The policy, which is the opposite of cleaning up
 *
 * `repo-state.ts` already states the standing rule for a tree between runs: "report it everywhere,
 * refuse nothing, discard nothing", because git cannot tell leftover junk from a fix somebody still
 * wants. This does not weaken it — it refuses the HANDOVER, never the work. Nothing here resets,
 * stashes, checks out or commits anything, and the two ways out both preserve what is there:
 *
 *   continue it     a run for the claimed issue is admitted, and told it is recovering.
 *   repair it       `repair_checkout` is admitted: a repair run's whole brief is to get a checkout
 *                   back in order without discarding anything (work in the way is parked on a
 *                   `wip/` branch its report names).
 *
 * PURE — no D1, no Env, no fetch. `coding-handoff-store.ts` brings the claim and the probe.
 */

/**
 * What one repo's handover is, in four words that a queue, a board and an MCP reader can all
 * publish. The two middle members are the states that had no name before, which is why a stalled
 * run and a recoverable one both read as "not running" and the queue drained anyway.
 *
 * `working`                        a run owns it and its orchestrator is alive. Not this module's
 *                                  verdict — the existing busy refusal already says it — but part
 *                                  of the same scale, so a reader has one vocabulary.
 * `stalled`                        the orchestrator's heartbeat is gone and the ENGINE is still
 *                                  live (or could not be confirmed stopped). Nobody may take the
 *                                  session: a second Pilot would interleave with a live CLI.
 * `interrupted_awaiting_recovery`  the engine is stopped and the checkout holds work owned by the
 *                                  closed run. A different issue must not start here.
 * `safe_to_start_next`             engine stopped, tree clean, nothing owned. The ordinary case.
 */
export const HANDOFF_STATES = ["working", "stalled", "interrupted_awaiting_recovery", "safe_to_start_next"] as const;

export type HandoffState = (typeof HANDOFF_STATES)[number];

/** One phrase per state, for a surface that shows a label rather than the whole sentence. */
export const HANDOFF_LABELS: Record<HandoffState, string> = {
	working: "working",
	stalled: "stalled — the engine is still running the previous run's work",
	interrupted_awaiting_recovery: "interrupted, awaiting recovery of uncommitted work",
	safe_to_start_next: "safe to start next",
};

/** Why a run stopped owning its session without finishing. A closed vocabulary. */
export const RECOVERY_REASONS = ["interrupted", "cancelled", "stalled", "heartbeat_lost"] as const;
export type RecoveryReason = (typeof RECOVERY_REASONS)[number];

/** Who owns the unfinished work in a session/checkout. */
export interface RecoveryClaim {
	sessionId: string;
	/** The run that was working when the platform (or the loss of its heartbeat) ended its watch. */
	runId: string;
	/** The GitHub issue that run was linked to, when it had one — the attribution a commit needs. */
	issue: number | null;
	/** That run's objective, bounded. Shown so a human can tell whose work is in the tree. */
	objective: string;
	reason: RecoveryReason;
	at: number;
}

/**
 * Is the engine process still there?
 *
 * `unknown` is first-class and is NOT "terminal": the requirement is that a prior engine has been
 * CONFIRMED stopped, and an unanswered probe confirms nothing. Reading it as stopped is the exact
 * collapse `coding-run-state.ts` exists to prevent.
 */
export type EngineLiveness = "live" | "terminal" | "unknown";

export interface HandoffProbe {
	engine: EngineLiveness;
	/** Uncommitted paths in the checkout, or null when the machine did not say. */
	changedFiles: number | null;
}

/** What is being asked to start. */
export interface IncomingWork {
	/** The issue this objective is for — explicit, or read off the objective. */
	issue: number | null;
	/** A repair run (`repair_checkout`): its brief IS to put a checkout right without discarding. */
	repair?: boolean;
	/** `POST /loop/:runId/continue` — the owner named the run they are continuing. */
	continueFromRunId?: string | null;
}

export interface HandoffVerdict {
	state: HandoffState;
	/** May the run start? */
	admit: boolean;
	/** Admitted as a RECOVERY of the claim — the run inherits the work and its attribution. */
	recovering: boolean;
	/** The claim is answered and may be cleared. Only ever true for a confirmed-clean handover. */
	release: boolean;
	/** One sentence, written to be relayed to whoever is blocked. Empty when there is nothing to say. */
	detail: string;
}

const SAFE: HandoffVerdict = { state: "safe_to_start_next", admit: true, recovering: false, release: false, detail: "" };

/** `run <id> on issue #N`, the attribution every sentence below leads with. */
function who(claim: RecoveryClaim): string {
	return claim.issue != null ? `run ${claim.runId} (issue #${claim.issue})` : `run ${claim.runId}`;
}

/** The ways out, named in the refusal so the reader does not have to know the API. */
function remedies(claim: RecoveryClaim): string {
	const continueIt =
		claim.issue != null
			? `start a run for issue #${claim.issue} (it is admitted as a recovery and told what is in the tree)`
			: `continue that run (POST /loop/${claim.runId}/continue)`;
	return `${continueIt}, start a repair run (\`repair_checkout\`), or commit or set the work aside yourself`;
}

/**
 * Does this objective legitimately inherit the claim?
 *
 * Three ways, and all three are a statement by somebody about THIS work rather than a coincidence:
 * the same issue, an explicit continue of the claimed run, or a repair run — whose objective is
 * written by the platform and may do nothing but put the checkout back in order.
 *
 * Deliberately NOT "the objectives look similar". A fuzzy match here would hand #982 a tree full of
 * #978 and call it a recovery, which is the defect wearing the fix's clothes.
 */
export function continuesClaim(claim: RecoveryClaim, incoming: IncomingWork): boolean {
	if (incoming.repair === true) return true;
	if (incoming.continueFromRunId && incoming.continueFromRunId === claim.runId) return true;
	return claim.issue != null && incoming.issue === claim.issue;
}

/**
 * The verdict for one handover.
 *
 * Order is the specification, by what is KNOWN: a live engine settles it whatever the tree looks
 * like (a second Pilot must never share a CLI), then an unconfirmed engine, then the tree.
 *
 * No claim at all → `safe_to_start_next` with no probe needed, which is every ordinary start.
 */
export function handoffVerdict(claim: RecoveryClaim | null, probe: HandoffProbe | null, incoming: IncomingWork): HandoffVerdict {
	if (!claim) return SAFE;
	const p = probe ?? { engine: "unknown" as EngineLiveness, changedFiles: null };

	if (p.engine === "live") {
		return {
			state: "stalled",
			admit: false,
			recovering: false,
			release: false,
			// Not "busy": the orchestrator that was watching it is GONE, which is a different problem
			// with a different remedy, and calling it busy is what made the queue wait on nothing.
			detail:
				`The engine in session ${claim.sessionId} is STILL RUNNING the work of ${who(claim)}, whose orchestrator stopped reporting ` +
				`(${claim.reason}). Nothing may be started in it: a second run would interleave instructions with a live CLI, and its commits ` +
				`would carry the wrong issue. Watch it with coding_session_capture, or end it with coding_session_end — this objective keeps its ` +
				`place in the queue and starts once the engine is confirmed stopped.`,
		};
	}

	if (p.engine === "unknown") {
		return {
			state: "stalled",
			admit: false,
			recovering: false,
			release: false,
			detail:
				`The machine did not say whether the engine for ${who(claim)} has stopped, so this objective is not being started in its session. ` +
				`An unanswered probe is not a confirmation. Check the machine (coding_diagnostics), then this objective starts by itself.`,
		};
	}

	// The engine is confirmed stopped. Now the tree.
	if (p.changedFiles === null) {
		return {
			state: "interrupted_awaiting_recovery",
			admit: false,
			recovering: false,
			release: false,
			detail:
				`The engine for ${who(claim)} has stopped, but the state of the checkout could not be read, so it is not known whether that run ` +
				`left uncommitted work behind. Nothing is being started here and nothing has been discarded — ${remedies(claim)}.`,
		};
	}

	if (p.changedFiles > 0) {
		const files = `${p.changedFiles} uncommitted file${p.changedFiles === 1 ? "" : "s"}`;
		if (continuesClaim(claim, incoming)) {
			return {
				state: "interrupted_awaiting_recovery",
				admit: true,
				recovering: true,
				release: false,
				detail:
					`Recovering ${who(claim)}: ${files} from it are still in this checkout, and the engine has stopped. Inspect the diff before ` +
					`changing anything, and attribute what you commit to that issue — this run continues its work, it did not start clean.`,
			};
		}
		return {
			state: "interrupted_awaiting_recovery",
			admit: false,
			recovering: false,
			release: false,
			detail:
				`This checkout holds ${files} belonging to ${who(claim)}, which the platform closed as ${claim.reason} — nothing has been discarded. ` +
				`A different objective must not start on top of it, or one commit carries two issues. To clear the way: ${remedies(claim)}.`,
		};
	}

	// Stopped engine, clean tree: the run was closed without leaving anything behind, so the claim
	// has nothing left to protect. Released rather than remembered — a claim that outlives its
	// reason blocks real work and teaches people to ignore it.
	return { ...SAFE, release: true };
}

/** The claim reason a platform-closed run leaves behind, by the `stop_reason` it was closed with. */
export function recoveryReasonForStop(stopReason: string): RecoveryReason {
	if (stopReason === "cancelled") return "cancelled";
	if (stopReason === "interrupted") return "interrupted";
	return "stalled";
}
