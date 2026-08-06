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

	const d = diagnoseAttachment({
		hasRuntimeRow: input.hasRuntimeRow,
		relayConnected: input.relayConnected,
		lastSeenAt,
		now: input.now,
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
			: `${d.message}${node ? ` (machine: ${node})` : ""}`,
		remedy: d.remedy,
	};
}
