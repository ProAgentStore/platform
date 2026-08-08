// Can this subordinate be given work RIGHT NOW? (#259)
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
import { diagnoseAttachment, type AttachmentState } from "./runtime-attachment.js";

export type SubordinateConnectivityState =
	/** `capabilities.runtime` is null — cloud-only. There is no machine to be offline. */
	| "not-required"
	| AttachmentState;

export interface SubordinateConnectivity {
	/** Does this agent's work need a machine running `pags up` at all? */
	requiresRunner: boolean;
	state: SubordinateConnectivityState;
	/**
	 * The single field a supervisor should branch on. TRUE means "you may delegate to it now" —
	 * it says nothing about whether the agent is currently busy, which `work` and `runs` answer.
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
}): SubordinateConnectivity {
	const node = input.node?.trim() || null;
	const runnerVersion = input.runnerVersion?.trim() || null;
	const lastSeenAt = input.lastSeenAt ?? null;

	if (!input.requiresRunner) {
		// A cloud-only agent (pipelines, RAG, connectors) has no local hands. Running it through
		// `diagnoseAttachment` would report "never-registered → pags up", which is not merely
		// unhelpful: it is a refusal reason for a subordinate that has nothing stopping it.
		return {
			requiresRunner: false,
			state: "not-required",
			canWork: true,
			node: null,
			runnerVersion: null,
			lastSeenAt: null,
			message: "Runs in the cloud — it needs no runner and is always reachable.",
			remedy: null,
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
	return {
		requiresRunner: true,
		state: d.state,
		canWork: attached,
		node,
		runnerVersion,
		lastSeenAt,
		// The attached wording is expanded from `diagnoseAttachment`'s bare "Connected." — that
		// string was written for a console tooltip sitting next to a green dot, and a model
		// reading it in JSON has no dot. Say what it licenses instead: delegation.
		message: attached
			? `Runner connected${node ? ` on ${node}` : ""} — you can delegate work to it now, whether or not it is currently busy.`
			: // `pinned-machine-offline` already names BOTH machines (the dead pin and the live one),
				// and `node` here is the freshest heartbeat — which in that state is usually the machine
				// the pin EXCLUDES. Appending "(machine: …)" would suffix the sentence with the one
				// machine the agent is deliberately not allowed to run on.
				`${d.message}${node && d.state !== "pinned-machine-offline" ? ` (machine: ${node})` : ""}`,
		remedy: d.remedy,
	};
}
