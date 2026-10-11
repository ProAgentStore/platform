/**
 * The ONE way an instruction that is not the Pilot's own reaches a coding engine (#1015).
 *
 * #1015's first slice gated `POST …/message`. Two other doors still wrote to `/coding/act` with no
 * gate at all — the Co-pilot's `driveClaude` and the chat tool `send_to_cli` — and the gated door had
 * a gap of its own: it decided ownership, then did more async work (rules, replay, a probe), then sent
 * and on failure re-sent. A run that ended in that gap, or a queued successor admitted in it, met an
 * instruction that was decided under an owner that no longer held the checkout.
 *
 * So every one of those doors goes through {@link dispatchOwnedTurn}, which:
 *
 *   1. ADMITS and RESERVES in one conditional write (`admitDirectTurn`). A steer reserves too, so a
 *      successor's own admission sees the reservation and waits — the gap is closed in the database.
 *   2. FENCES immediately before every send: the reservation must still be the one this call took,
 *      and no other session may own the repo. A lost reservation is a refusal and nothing is sent.
 *      A steer whose run ended meanwhile is not sent to that run — it continues as this caller's OWN
 *      direct turn, under the reservation it already holds; the ended run stays ended.
 *   3. CLASSIFIES a failed send instead of reading every failure as "not delivered". No socket at
 *      dispatch, or a runner that answered with an error, delivered nothing: the reservation is
 *      released. A runner that lost the session is reattached and the send repeated once, fenced
 *      again. Anything else — a socket dropped with the command in flight, a timeout — proves nothing:
 *      it is NOT re-sent (that would be a duplicate instruction) and the reservation is KEPT, recorded
 *      as possibly delivered (`accepted`, unconfirmed) so the engine's own state decides its release.
 *   4. Records a delivery only for the OWNER's words. A controller-composed instruction (the Co-pilot
 *      or the chat brain) is not an owner directive, and recording it as one would hand controller
 *      text the authority the Pilot gives the owner's corrections.
 *
 * The Pilot's own sends are not here: a running Pilot IS the owner of its session, and its workflow
 * holds the driver claim every admission already respects.
 */
import type { Env } from "../types.js";
import type { CodingActionKind } from "./coding-loop.js";
import {
	admitDirectTurn,
	deliveryFor,
	type DirectiveDelivery,
	type EngineProbe,
	type ProbeEngine,
	recordDirective,
	releaseReservation,
	type RepoOwner,
	repoOwners,
} from "./coding-ownership.js";
import { isRunnerUnreachable } from "./runner-unreachable.js";

export interface DispatchScope {
	instanceId: string;
	userId: string;
	repoId: string;
	sessionId: string;
}

export interface DispatchInput {
	scope: DispatchScope;
	/** Who wrote the instruction: the owner's own words, or text a controller composed. */
	author: "owner" | "controller";
	/** The owner's text as written (before rules/replay are added) — recorded only for the owner. */
	ownerText: string;
	/** A persistent stream-json engine (Claude) queues a message behind a turn; a one-shot is interrupted. */
	persistent: boolean;
	probe: ProbeEngine;
	/** Compose what is sent (rules, replay). Runs AFTER admission, which is why the fence exists. */
	prepare: () => Promise<CodingActionKind>;
	/** The transport. */
	send: (action: CodingActionKind) => Promise<unknown>;
	/** Re-open a session the runner lost; returns a send bound to the live machine, or null. */
	reattach?: () => Promise<((action: CodingActionKind) => Promise<unknown>) | null>;
	now?: () => number;
}

export type DispatchResult =
	| {
			ok: true;
			/** `direct`, or `steer` of `runId` — `direct` too when the steered run ended before the send. */
			kind: "direct" | "steer";
			runId: string | null;
			turnId: string;
			delivery: DirectiveDelivery;
			/** The runner acknowledged the send. False: it may or may not have arrived, and was not re-sent. */
			confirmed: boolean;
			snap: unknown | null;
			engineBefore: EngineProbe;
			directiveId: string | null;
	  }
	| { ok: false; reason: "owned" | "superseded" | "not_delivered"; owner?: RepoOwner; detail: string };

type SendFailure = "session_lost" | "not_delivered" | "ambiguous";

/** What a failed send proves. Only the first two are evidence the instruction never arrived. */
export function classifySendFailure(e: unknown): SendFailure {
	const msg = e instanceof Error ? e.message : String(e);
	if (/no coding session/i.test(msg)) return "session_lost";
	if (isRunnerUnreachable(e)) return (e as { dispatched?: unknown }).dispatched === false ? "not_delivered" : "ambiguous";
	// The runner answered with a client error: it received the command and refused it.
	if (/^Runner \/coding\/act → 4\d\d/.test(msg)) return "not_delivered";
	return "ambiguous";
}

export async function dispatchOwnedTurn(env: Env, input: DispatchInput): Promise<DispatchResult> {
	const { scope } = input;
	const now = input.now ?? Date.now;
	const admission = await admitDirectTurn(env, scope, input.probe, now());
	if (!admission.ok) return { ok: false, reason: "owned", owner: admission.owner, detail: "Another session owns this checkout." };
	const turnId = admission.turnId;
	let kind: "direct" | "steer" = admission.kind;
	let runId = admission.kind === "steer" ? admission.runId : null;

	const engineBefore = await input.probe(scope.sessionId).catch((): EngineProbe => "unknown");
	const action = await input.prepare();

	/** The fence: still this call's reservation, no other owner, and — for a steer — its run still running. */
	const fence = async (): Promise<DispatchResult | null> => {
		const row = await env.DB.prepare("SELECT direct_turn_id FROM coding_sessions WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
			.bind(scope.sessionId, scope.instanceId, scope.userId)
			.first<{ direct_turn_id: string | null }>();
		if (row?.direct_turn_id !== turnId) {
			return { ok: false, reason: "superseded", detail: "A newer instruction on this session replaced this one before it was sent; nothing was sent." };
		}
		const foreign = (await repoOwners(env, scope)).find((o) => o.sessionId !== scope.sessionId);
		if (foreign) {
			await releaseReservation(env, scope.sessionId, turnId);
			return { ok: false, reason: "superseded", owner: foreign, detail: "Another session took this checkout before the instruction was sent; nothing was sent." };
		}
		if (kind === "steer" && runId) {
			const run = await env.DB.prepare("SELECT status FROM agent_loop_runs WHERE run_id = ?1 AND user_id = ?2").bind(runId, scope.userId).first<{ status: string }>();
			if (run?.status !== "running") {
				// The steered run ended. Its row stays ended; this instruction goes on as the caller's own
				// direct turn, under the reservation it already holds — never as a revival of that run.
				kind = "direct";
				runId = null;
			}
		}
		return null;
	};

	let send = input.send;
	for (let attempt = 0; attempt < 2; attempt++) {
		const refused = await fence();
		if (refused) return refused;
		let failure: SendFailure | null = null;
		let snap: unknown = null;
		try {
			snap = await send(action);
		} catch (e) {
			failure = classifySendFailure(e);
		}
		if (!failure || failure === "ambiguous") {
			// Delivered, or possibly delivered: either way the engine's own state now decides the release.
			await env.DB.prepare("UPDATE coding_sessions SET direct_turn_delivered_at = ?3 WHERE id = ?1 AND direct_turn_id = ?2").bind(scope.sessionId, turnId, now()).run();
			const delivery: DirectiveDelivery = failure ? "accepted" : deliveryFor(engineBefore, input.persistent);
			const directive =
				input.author === "owner"
					? await recordDirective(env, { ...scope, runId: kind === "steer" ? runId : null, kind, delivery, content: input.ownerText }).catch(() => null)
					: null;
			return { ok: true, kind, runId: kind === "steer" ? runId : null, turnId, delivery, confirmed: !failure, snap: failure ? null : snap, engineBefore, directiveId: directive?.id ?? null };
		}
		if (failure === "session_lost" && attempt === 0 && input.reattach) {
			const again = await input.reattach().catch(() => null);
			if (again) {
				send = again;
				continue;
			}
		}
		break;
	}
	await releaseReservation(env, scope.sessionId, turnId);
	return { ok: false, reason: "not_delivered", detail: "The session isn't live on the runner, so nothing was delivered — open it again (or run pags up)." };
}
