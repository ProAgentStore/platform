// Can this subordinate be given work RIGHT NOW? (#259/#484)
//
// PURE — no D1, no Env, no relay. The I/O that feeds it lives in `connectors/supervision.ts`;
// the judgement lives here so it is testable without a database stub, matching
// `subordinate-observation.ts` and `supervision-graph.ts`.
//
// Why this exists: `subordinate_status` gave a supervisor a roster, board cards and loop runs and
// NOTHING about connectivity. Asked to delegate a typecheck, the Coder Lead read "no work in
// flight" and reported "No active runner" for four subordinates whose runners were connected,
// then told the user to run `pags up` — which was already running. It was not hallucinating; it
// was inferring the only way it could, from the nearest available signal.
//
// "Idle" and "unreachable" are INDEPENDENT. An agent with an empty board is the normal, healthy,
// ready-for-work case. Conflating them makes a supervisor under-report capability, which is worse
// than no supervisor: the human now has to verify every refusal.
//
// It deliberately reuses `diagnoseAttachment` rather than inventing a fourth notion of
// connectivity (the console dot, the runtime-status route and the coding driver already share
// it), and adds the one case that diagnosis cannot see: an agent that needs no runner at all.
//
// #484: a second dimension — account budget. Runner connectivity says nothing about whether the
// account's 24h rolling spend ceiling has been hit. A supervisor that sees `canWork:true` and
// then delegates immediately hits the ceiling on the first loop iteration, with no prior warning.
// The budget field surfaces what the ceiling check would say RIGHT NOW, including the remaining
// headroom and when the oldest usage will age out. `canWork` is only lowered when enforcement is
// actually on (`budgetEnforced: true`) — by default the ceiling is observe-only (#485), so the
// field is informational and delegation is never blocked by budget alone.
import { diagnoseAttachment, type AttachmentState } from "./runtime-attachment.js";

export type SubordinateConnectivityState =
	/** `capabilities.runtime` is null — cloud-only. There is no machine to be offline. */
	| "not-required"
	| AttachmentState;

/**
 * Account-level budget picture (#484) — what the 24h rolling circuit breakers say right now.
 *
 * Separate from `canWork` unless enforcement is on: the ceiling is observe-only by default (#485),
 * so a supervisor may see a tripped ceiling here while `canWork` is still true and delegation
 * proceeds. When enforcement IS on, `ceilingTripped` becoming true also lowers `canWork`.
 *
 * Absent from the output when the I/O caller did not supply it — older call sites are unaffected.
 */
export interface SubordinateBudget {
	/** Charged micros ($1 = 1_000_000) consumed in the last 24h across ALL this user's runs. */
	chargedMicros: number;
	/** Ceiling in the same unit ($). */
	chargedMicrosCeiling: number;
	/** All tokens (charged or not) consumed in the last 24h. */
	tokens: number;
	/** Token ceiling. */
	tokenCeiling: number;
	/**
	 * TRUE when either ceiling is met or exceeded.
	 *
	 * When `budgetEnforced` is false this is informational only and `canWork` is not lowered.
	 * When `budgetEnforced` is true this is a hard gate and `canWork` becomes false.
	 */
	ceilingTripped: boolean;
	/** Whether BUDGET_ENFORCE is on — tells the model whether `ceilingTripped` blocks or warns. */
	budgetEnforced: boolean;
	/**
	 * ISO timestamp of the oldest entry in the usage window.
	 *
	 * When `ceilingTripped` the window will be fully clear once entries age past this point.
	 * Null when no usage was found in the window.
	 */
	windowOldestAt: string | null;
}

export interface SubordinateConnectivity {
	/** Does this agent's work need a machine running `pags up` at all? */
	requiresRunner: boolean;
	state: SubordinateConnectivityState;
	/**
	 * The single field a supervisor should branch on. TRUE means "you may delegate to it now" —
	 * it says nothing about whether the agent is currently busy, which `work` and `runs` answer.
	 *
	 * When `budget.ceilingTripped` is true AND `budget.budgetEnforced` is true, this is false even
	 * when the runner is fully connected — enforce and observe are the two budget regimes (#485).
	 */
	canWork: boolean;
	/** The machine holding it, when one is known. Named in refusals so the human knows where to look. */
	node: string | null;
	runnerVersion: string | null;
	lastSeenAt: string | null;
	/** One sentence a supervisor can relay verbatim to the human. */
	message: string;
	/** The single command that fixes it, when one exists. Null when nothing is wrong. */
	remedy: string | null;
	/**
	 * Account budget picture — present when the caller supplied usage/ceiling data (#484).
	 *
	 * Absent (undefined) when not supplied, so old call sites are unaffected.
	 */
	budget?: SubordinateBudget;
}

/**
 * Budget facts for the account-level circuit breakers (#484).
 *
 * Passed in from the I/O layer (supervision connector) so this function stays pure. Absent (not
 * supplied) when the caller did not read account usage — old call sites are unaffected.
 */
export interface BudgetFacts {
	/** Charged micros consumed in the 24h window. */
	chargedMicros: number;
	/** Effective ceiling for charged micros. */
	chargedMicrosCeiling: number;
	/** All tokens consumed in the 24h window. */
	tokens: number;
	/** Effective token ceiling. */
	tokenCeiling: number;
	/** Whether BUDGET_ENFORCE is active — only when true does `ceilingTripped` lower `canWork`. */
	budgetEnforced: boolean;
	/** ISO string of the oldest usage row in the window — when the window will clear. */
	windowOldestAt: string | null;
}

export function classifySubordinateConnectivity(input: {
	/** From `agentCapabilities(...).runtime != null`. */
	requiresRunner: boolean;
	/** Is there any `instance_runtimes` / `instance_runtime_nodes` registration for it? */
	hasRuntimeRow: boolean;
	/** LIVE relay socket, resolved the same way delegation resolves it (`getBoundRunnerConn`). */
	relayConnected: boolean;
	node?: string | null;
	runnerVersion?: string | null;
	lastSeenAt?: string | null;
	/**
	 * The machine this instance is pinned to (`config.runnerNode`); null/"" = automatic.
	 *
	 * These two exist ONLY to be forwarded to `diagnoseAttachment`, and they are named exactly as
	 * `RuntimeFacts` names them so every caller can spread its facts in rather than enumerate
	 * them (#468). Without them a pinned-to-an-offline-machine agent diagnoses
	 * `machine-online-agent-detached` and this adapter tells the human to run `pags up --force`
	 * on the machine that is already up — the #259/#271 failure, at three surfaces.
	 */
	pinnedNode?: string | null;
	/** A machine holding a live socket for this instance which the PIN excludes. Description only. */
	liveNodeExcludedByPin?: string | null;
	now?: number;
	/**
	 * Account-level budget facts (#484). Optional — absent means "not checked", not "clear".
	 *
	 * When supplied, a `budget` field is added to the result. When `budgetEnforced` is true and
	 * `ceilingTripped` is true, `canWork` is also lowered to false regardless of runner state.
	 */
	budgetFacts?: BudgetFacts;
}): SubordinateConnectivity {
	const node = input.node?.trim() || null;
	const runnerVersion = input.runnerVersion?.trim() || null;
	const lastSeenAt = input.lastSeenAt ?? null;

	// Resolve budget once — shared by all branches.
	const bf = input.budgetFacts;
	let budget: SubordinateBudget | undefined;
	if (bf) {
		const ceilingTripped = bf.chargedMicros >= bf.chargedMicrosCeiling || bf.tokens >= bf.tokenCeiling;
		budget = {
			chargedMicros: bf.chargedMicros,
			chargedMicrosCeiling: bf.chargedMicrosCeiling,
			tokens: bf.tokens,
			tokenCeiling: bf.tokenCeiling,
			ceilingTripped,
			budgetEnforced: bf.budgetEnforced,
			windowOldestAt: bf.windowOldestAt,
		};
	}

	// Budget blocks only when enforcement is on (#485).
	const budgetBlocks = !!budget?.ceilingTripped && !!budget?.budgetEnforced;

	if (!input.requiresRunner) {
		// A cloud-only agent (pipelines, RAG, connectors) has no local hands. Running it through
		// `diagnoseAttachment` would report "never-registered → pags up", which is not merely
		// unhelpful: it is a refusal reason for a subordinate that has nothing stopping it.
		const canWork = !budgetBlocks;
		const message = budgetBlocks
			? `Runs in the cloud — no runner needed, but the account's daily spend ceiling has been reached. Delegation will be refused until usage ages out (oldest entry: ${budget?.windowOldestAt ?? "unknown"}).`
			: "Runs in the cloud — it needs no runner and is always reachable.";
		return {
			requiresRunner: false,
			state: "not-required",
			canWork,
			node: null,
			runnerVersion: null,
			lastSeenAt: null,
			message,
			remedy: null,
			...(budget ? { budget } : {}),
		};
	}

	// Forward everything the diagnosis takes. An input it grows and this adapter does not pass is
	// the same bug a third time (3 fields in #237 → 5 in #380 → this, #468) — and it cannot be
	// caught by the compiler, because every added field has to be optional.
	const d = diagnoseAttachment({
		hasRuntimeRow: input.hasRuntimeRow,
		relayConnected: input.relayConnected,
		lastSeenAt,
		now: input.now,
		pinnedNode: input.pinnedNode,
		liveNodeExcludedByPin: input.liveNodeExcludedByPin,
	});
	const attached = d.state === "attached";
	// Runner connectivity gates first; budget gates only on top when enforcement is active.
	const canWork = attached && !budgetBlocks;
	// Build the connectivity sentence, then append a budget note when the ceiling is tripped.
	const connectivityMsg = attached
		? `Runner connected${node ? ` on ${node}` : ""} — you can delegate work to it now, whether or not it is currently busy.`
		: // `pinned-machine-offline` already names BOTH machines (the dead pin and the live one),
			// and `node` here is the freshest heartbeat — which in that state is usually the machine
			// the pin EXCLUDES. Appending "(machine: …)" would suffix the sentence with the one
			// machine the agent is deliberately not allowed to run on.
			`${d.message}${node && d.state !== "pinned-machine-offline" ? ` (machine: ${node})` : ""}`;
	const message =
		budget?.ceilingTripped
			? `${connectivityMsg} The account's daily ${budget.budgetEnforced ? "spend ceiling has been reached — delegation is blocked" : "spend ceiling is approaching"} (oldest usage entry: ${budget.windowOldestAt ?? "unknown"}).`
			: connectivityMsg;
	return {
		requiresRunner: true,
		state: d.state,
		canWork,
		node,
		runnerVersion,
		lastSeenAt,
		message,
		remedy: d.remedy,
		...(budget ? { budget } : {}),
	};
}
