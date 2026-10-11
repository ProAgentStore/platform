/**
 * Send one Pilot act and say truthfully what became of it (#1019).
 *
 * One fact, bound together: WHICH composition of the act was accepted, by WHICH input ledger and engine
 * process, and with what outcome. The outcome is returned from the durable step, so a replay reads the
 * journalled verdict rather than re-deriving it from nothing.
 *
 * - The act is COMPOSED inside each attempt, from the run's state at that moment: a reconnect that
 *   moved to a runner which cannot render the objective gets the act without it, never the cached payload.
 * - A first attempt that may have reached a runner is never blindly repeated. The runner's own ledger is
 *   read first, and its silence counts as "not accepted" only from the SAME ledger, on the same machine,
 *   that every earlier attempt was dispatched to. A different runner — or the session re-created after a
 *   runner restart — starts empty and cannot speak for its predecessor: that is `unknown`, not a re-send.
 * - An id accepted with content other than any composition this send dispatched is a `conflict`.
 * - An id accepted by an earlier engine process of the same session is `predecessor`: not re-run, and
 *   not credited to the process that replaced it.
 */
import { RunnerUnreachableError } from "./runner-unreachable.js";
import type { CodingActionKind, CodingPaneSnapshot } from "./coding-loop.js";

export type ActOutcome = "accepted" | "predecessor" | "unknown" | "conflict";

/** The journalled verdict of one act. `objective`: whether the composition this verdict is about carried the run objective. */
export interface ActReceipt {
	inputId: string | null;
	outcome: ActOutcome;
	objective: boolean;
	ledger: string | null;
	epoch: number | null;
}

/** One composition dispatched by this send: its content, and where it went. */
interface Dispatch {
	digest: string;
	objective: boolean;
	node: string | null;
	ledger: string | null;
}

export interface ActSendDeps {
	sessionId: string;
	/** One guarded durable step (the runner guard around the retrying step). */
	step: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
	/** Dispatch to whichever runner the run points at NOW. */
	call: <T>(path: string, body: unknown) => Promise<T>;
	node: () => string | null;
	/** The last input ledger a journalled snapshot reported — what a dispatch is scoped to. */
	engine: () => CodingPaneSnapshot["engine"] | null;
	/** Per-turn additions composed inside the step (the #693 replay); not part of the act's identity. */
	prepare: (a: CodingActionKind) => Promise<CodingActionKind>;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** sha256 of an act's executable content. MUST match browser-runner coding/input-ledger.ts `actDigest` byte for byte. */
export async function actDigest(a: CodingActionKind): Promise<string> {
	if (a.kind !== "message") return "";
	const o = a.objective;
	const objective = o ? [str(o.runId), str(o.text), str(o.origin?.kind), str(o.origin?.by), (o.constraints ?? []).filter((c) => typeof c === "string")] : null;
	const bytes = new TextEncoder().encode(JSON.stringify([str(a.text), str(a.author), objective]));
	const d = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a runner's snapshot says about `id`, judged against what this send dispatched. `absent` is the only answer that permits a re-send. */
export function reconcileAct(seen: CodingPaneSnapshot, id: string, sent: readonly Dispatch[], node: string | null): Omit<ActReceipt, "inputId"> | "absent" {
	const maybeObjective = sent.some((s) => s.objective);
	const e = seen.engine;
	if (!e) {
		// A runner without a ledger identity: its receipt is believed, its silence proves nothing.
		const known = [...(seen.acceptedInputs ?? []), ...(seen.consumedInputs ?? [])].includes(id);
		return { outcome: known ? "accepted" : "unknown", objective: known ? (sent.at(-1)?.objective ?? false) : maybeObjective, ledger: null, epoch: null };
	}
	const hit = e.accepted.find(([x]) => x === id);
	if (hit) {
		const match = sent.find((s) => s.digest === hit[1]);
		if (!match) return { outcome: "conflict", objective: maybeObjective, ledger: e.ledger, epoch: hit[2] };
		return { outcome: hit[2] === e.epoch ? "accepted" : "predecessor", objective: match.objective, ledger: e.ledger, epoch: hit[2] };
	}
	// Older than the reported window, or this ledger never saw it: only the second, from the ledger every attempt went to, is proof.
	const sameLedger = !(seen.acceptedInputs ?? []).includes(id) && sent.every((s) => s.ledger === e.ledger && s.node === node);
	return sameLedger ? "absent" : { outcome: "unknown", objective: maybeObjective, ledger: e.ledger, epoch: e.epoch };
}

export async function sendAct(deps: ActSendDeps, label: string, compose: () => CodingActionKind): Promise<{ pane: CodingPaneSnapshot; receipt: ActReceipt }> {
	const sent: Dispatch[] = [];
	const done = await deps.step(label, async () => {
		const action = compose();
		const id = action.kind === "message" ? (action.inputId ?? null) : null;
		if (sent.length && id) {
			const seen = await deps.call<CodingPaneSnapshot>("/coding/capture", { sessionId: deps.sessionId });
			const verdict = reconcileAct(seen, id, sent, deps.node());
			if (verdict !== "absent") return { pane: seen, receipt: { inputId: id, ...verdict } };
		}
		const dispatch: Dispatch = { digest: await actDigest(action), objective: action.kind === "message" && !!action.objective, node: deps.node(), ledger: deps.engine()?.ledger ?? null };
		sent.push(dispatch);
		let pane: CodingPaneSnapshot;
		try {
			pane = await deps.call<CodingPaneSnapshot>("/coding/act", { sessionId: deps.sessionId, action: await deps.prepare(action) });
		} catch (e) {
			// Never reached a runner: this composition is not a candidate for what was accepted.
			if (e instanceof RunnerUnreachableError && !e.dispatched) sent.pop();
			throw e;
		}
		const verdict = id && pane.engine ? reconcileAct(pane, id, sent, deps.node()) : null;
		const receipt: ActReceipt =
			verdict && verdict !== "absent"
				? { inputId: id, ...verdict }
				: { inputId: id, outcome: verdict === "absent" ? "unknown" : "accepted", objective: dispatch.objective, ledger: pane.engine?.ledger ?? null, epoch: pane.engine?.epoch ?? null };
		return { pane, receipt };
	});
	// A step journalled before this shape existed held the bare pane: it was accepted, with what was composed.
	if (!(done && typeof done === "object" && "receipt" in done)) {
		const a = compose();
		return { pane: done as CodingPaneSnapshot, receipt: { inputId: a.kind === "message" ? (a.inputId ?? null) : null, outcome: "accepted", objective: a.kind === "message" && !!a.objective, ledger: null, epoch: null } };
	}
	return done as { pane: CodingPaneSnapshot; receipt: ActReceipt };
}
