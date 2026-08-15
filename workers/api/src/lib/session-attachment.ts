/**
 * Why can't we reach THIS SESSION's machine? (#537)
 *
 * ── The sentence a boolean cannot carry
 *
 * A coding session is stamped with the machine it was opened on (`coding_sessions.runner_node`).
 * With machine A off and machine B running `pags up`, three readings are each truthful about the
 * question they answer and disagree with each other:
 *
 *   /runtime/status  -> connected      (B holds a live socket for this instance)
 *   /capture         -> offline        (the SESSION is stamped to A, which is gone)
 *   resolveRunnerOnline -> offline     (a live session's capture outranks the relay, by design)
 *
 * The Coding banner then rendered the only remedy a boolean can carry — *run `pags up`* — to an
 * owner who was already running it, on B. Same shape as #530 (the chat prompt), #524 (a remedy
 * naming no machine) and #531 (a tile claiming attachment it never verified); this was the last
 * surface in the family.
 *
 * The honest sentence is per-SESSION and needs both machines in it: *"this session is on A, which
 * isn't connected; B is connected — open it again to move it to B."*
 *
 * ── Why this is a separate function and not a sixth `AttachmentState`
 *
 * `diagnoseAttachment` answers an INSTANCE-scoped question and its state table is enumerated as a
 * `Record<AttachmentState, …>` by `prompt-claims.test.ts` over `describeFacts` — an adapter that
 * has no session and could never produce a session-scoped state. Widening that union would force
 * two instance-scoped adapters to invent inputs for a state they cannot reach.
 *
 * So the SPLIT is on scope, not on vocabulary: every case where nothing routes anywhere is handed
 * straight to `diagnoseAttachment`, unchanged, so "no machine at all", "pinned to a machine that
 * is off" and "the machine is up but this agent is detached" keep exactly one wording across the
 * whole platform. The one thing added here is the case that only exists once a session has a node.
 *
 * ── The invariant worth keeping
 *
 * **`pags up` is never the remedy while a machine is connected.** `remedy` is null on every branch
 * below, and `relayConnected` is `getBoundRunnerConn` — the resolver that actually routes — so
 * "connected" here means "work would really go there", not "a `status` column says registered"
 * (#238/#532). `session-attachment.test.ts` asserts it over the whole input space.
 */

import { runtimeConnectivity, type RuntimeFacts } from "./instance-connectivity.js";
import { diagnoseAttachment, type AttachmentDiagnosis, type AttachmentState } from "./runtime-attachment.js";
import { liveAliasForPin } from "./runner-client.js";
import { normalizeRunnerNode } from "./runtime-nodes.js";
import type { Env } from "../types.js";

/**
 * The instance vocabulary plus the one case that needs a session to exist.
 *
 * One state rather than three, because a state is what the reader must DO and the action is
 * identical in all of them: open the session again, and `startSessionOnRunner`'s machine-switch
 * reclaim relocates it onto the machine that is up (`coding-session-open.ts:139-146`). Only the
 * explanation differs, and that lives in the message.
 */
export type SessionAttachmentState = AttachmentState | "session-machine-offline";

export interface SessionAttachmentDiagnosis extends Omit<AttachmentDiagnosis, "state"> {
	state: SessionAttachmentState;
}

export interface SessionAttachmentFacts extends RuntimeFacts {
	/** The machine this session was opened on (`coding_sessions.runner_node`); null when it was
	 *  created with no runner registered at all. */
	sessionNode: string | null;
	/**
	 * A live node PROVEN to be the same machine as `sessionNode` (#379), or null.
	 *
	 * A hostname is not a machine — `os.hostname()` moves under one laptop (DHCP, VPN, the `.local`
	 * mDNS form), and the relay is keyed per NAME, so a session stamped `RLs-MacBook-Air` genuinely
	 * has no socket while the same laptop is connected as `RLs-MacBook-Air.local`. Naming those as
	 * two machines is the defect #531 had to fix one surface over, so the renamed case gets its own
	 * sentence rather than being reported as a machine that is off.
	 */
	sessionMachineLiveAs?: string | null;
}

/**
 * The diagnosis, pure — so the sentence can be asserted without a relay, a session or a machine.
 *
 * Only ever called on the path where the session's own node could NOT be resolved to a live
 * connection; a reachable session has nothing to explain.
 */
export function diagnoseSessionAttachment(f: SessionAttachmentFacts): SessionAttachmentDiagnosis {
	// Nothing routes to any machine for this agent. That is not a fact about the session, and the
	// instance diagnosis already distinguishes all four of its causes — including the pinned one,
	// which must NOT be answered with "open the session again": a reopen resolves through
	// `getBoundRunnerConn`, which honours the pin and will not fall through to the machine that is
	// up. There the fix is the "Runs on" setting, and `diagnoseAttachment` says exactly that.
	if (!f.relayConnected) return diagnoseAttachment(f);

	const routed = normalizeRunnerNode(f.node);
	const session = normalizeRunnerNode(f.sessionNode);
	const alias = normalizeRunnerNode(f.sessionMachineLiveAs);
	// Defensive: `relayConnected` true without a node name should be impossible (the connection
	// carries the node it resolved on), but a message that names no machine is the #524 defect, so
	// fall back to the instance sentence rather than emit "` ` is connected".
	if (!routed) return diagnoseAttachment(f);

	if (alias) {
		return {
			state: "session-machine-offline",
			message: `This session was opened on ${session}; that machine is connected as ${alias} now. Open the session again to reattach it.`,
			remedy: null,
		};
	}
	if (!session) {
		return {
			state: "session-machine-offline",
			message: `${routed} is connected, but this session isn't attached to any machine. Open it again to attach it to ${routed}.`,
			remedy: null,
		};
	}
	if (session === routed) {
		// The machine work routes to IS the session's machine, and the session still could not be
		// resolved on it — a reconnect that landed between the two reads, or a runner restarted
		// under this session. Not "your machine is offline", which is the thing it is not.
		return {
			state: "session-machine-offline",
			message: `${routed} is connected, but this session isn't attached to it. Open the session again to reattach.`,
			remedy: null,
		};
	}
	return {
		state: "session-machine-offline",
		message: `This session is running on ${session}, which isn't connected. ${routed} is connected — open the session again to move it to ${routed}, or start the runner on ${session}.`,
		remedy: null,
	};
}

/**
 * Read the facts and diagnose, for a session whose runner connection came back null.
 *
 * Cost is paid ONLY on that path: `runtimeConnectivity` is two batched D1 reads plus the
 * `getBoundRunnerConn` probe every status surface already makes, and the alias lookup is skipped
 * unless a machine is up under a DIFFERENT name from the one the session carries — which is the
 * only shape it can change the answer for.
 */
export async function sessionAttachment(
	env: Env,
	instanceId: string,
	userId: string,
	sessionNode: string | null | undefined,
): Promise<SessionAttachmentDiagnosis> {
	const facts = await runtimeConnectivity(env, instanceId, userId);
	const session = normalizeRunnerNode(sessionNode);
	const routed = normalizeRunnerNode(facts.node);
	const alias =
		facts.relayConnected && session && routed && session !== routed
			? await liveAliasForPin(env, instanceId, userId, session).catch(() => null)
			: null;
	return diagnoseSessionAttachment({ ...facts, sessionNode: session || null, sessionMachineLiveAs: alias });
}
