/**
 * The run's objective, delivered VERBATIM to the engine with the run's first turn (#1019).
 *
 * The objective used to reach only the Pilot's own prompt; the engine read whatever the Pilot chose to
 * write, under the Pilot's preamble. Now the first instruction of each run carries the accepted objective
 * as its own field, which the runner renders as a fenced block attributed ONLY as far as the platform
 * verified who wrote it ({@link ObjectiveOrigin}) — never "the owner's" for a supervisor's, a trigger's or
 * an agent tool's composition.
 *
 * Delivery is a FACT the runner reports, not an intention: the turn carries an `inputId`, and the
 * objective counts as delivered only when a capture lists that id in `consumedInputs` (a completed turn
 * read it). Consumption is not completion — it says the engine read the objective, nothing more.
 *
 * Per engine GENERATION, bound to the ACTUAL engine: a runner with {@link ENGINE_IDENTITY_CAPABILITY} names
 * its input ledger and engine process on every snapshot, so a same-process reconnect keeps its receipt and a
 * replacement process (or a different runner) owes the objective again; a reconnect counter alone proves
 * neither. A predecessor's acceptance or late read receipt never counts for its replacement. A runner without
 * {@link RUN_OBJECTIVE_CAPABILITY} is never sent it (an older one would mis-attribute it or drop the constraints
 * in force), and the run says it was not delivered there.
 *
 * Bounded: attached until a consumption is confirmed, to at most {@link MAX_OBJECTIVE_SENDS} turns per
 * generation. Every attempt is recorded before it is sent and settled from the act's journalled receipt
 * (lib/coding-act-send.ts), so a send whose reply was lost, or that never returned, ends `unknown` — never
 * `delivered`, never silently nothing. Receipts carry a digest and byte length, never the objective's text.
 *
 * Pure state, driven by the workflow from journalled values only, so a replay reaches the same verdict.
 */
import { type ActReceipt, actDigest } from "./coding-act-send.js";
import type { EngineInputs } from "./coding-engine-inputs.js";
import type { CodingActionKind } from "./coding-loop.js";
import type { ObjectiveOrigin } from "./coding-objective-origin.js";

/** Advertised by a runner whose `input()` renders `objective` WITH its verified origin and the constraints in force (browser-runner coding/run-objective.ts). */
export const RUN_OBJECTIVE_CAPABILITY = "coding.run-objective.v3";
/** Advertised by a runner that refuses to run an already-accepted inputId twice and lists accepted ids on every snapshot. */
export const INPUT_IDEMPOTENT_CAPABILITY = "coding.input-idempotent";
/** Advertised by a runner whose snapshots name their input ledger and engine process (`engine`), binding receipts to who read what. */
export const ENGINE_IDENTITY_CAPABILITY = "coding.engine-identity";
/** How many turns per runner generation may carry the objective before an unconfirmed delivery is reported as such. */
export const MAX_OBJECTIVE_SENDS = 3;
/**
 * What one envelope carries — mirrored from browser-runner coding/run-objective.ts, which refuses an envelope
 * past them. The constraints travel WHOLE or the objective is not sent and the run says so (`refused`): a
 * partial set would have the engine read the goal without a constraint that binds it.
 */
export const MAX_OBJECTIVE_CONSTRAINTS = 20;
export const MAX_OBJECTIVE_CONSTRAINT_CHARS = 500;
const envelopeFits = (lines: readonly string[]) => lines.length <= MAX_OBJECTIVE_CONSTRAINTS && lines.every((l) => l.length <= MAX_OBJECTIVE_CONSTRAINT_CHARS);

export type { ObjectiveOrigin } from "./coding-objective-origin.js";

export type ObjectiveDeliveryState = "pending" | "delivered" | "unsupported" | "unconfirmed" | "unknown" | "undelivered" | "refused";

/** What a trace or chat line may say about an objective: identity and size, never its bytes. */
export interface ObjectiveReceipt {
	state: ObjectiveDeliveryState;
	runId: string;
	origin: ObjectiveOrigin["kind"];
	generation: number;
	runnerNode: string | null;
	/** `ledger:epoch` of the engine process this generation is bound to, when the runner names it. */
	engine: string | null;
	/** How many constraint lines the envelope carried — or, when `refused`, would have had to carry. Never their text. */
	constraintLines: number;
	chars: number;
	utf8Bytes: number;
	sha256: string;
	consumedInputId: string | null;
	/** An EARLIER verified read of the objective in this run — a past fact a later refusal never retracts. */
	priorRead: { inputId: string; generation: number } | null;
	/** Acts of this run already sent to an engine before this receipt. */
	actsSent: number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class ObjectiveDelivery {
	state: ObjectiveDeliveryState = "pending";
	/** Bumped whenever the engine that must read the objective is (or may be) a different one. */
	generation = 0;
	runnerNode: string | null = null;
	/** Null until the runner's capabilities were read; false means it cannot render the objective with its origin. */
	private supported: boolean | null = null;
	/** The runner names its ledger and engine process: generations follow the ACTUAL engine, not reconnect counts. */
	private identified = false;
	/** `ledger:epoch` this generation is bound to — null until a snapshot named it. */
	private engineKey: string | null = null;
	/** Acts of THIS generation that carried the objective and were accepted by its engine. */
	private issued: string[] = [];
	/** Acts of this generation that carried it but whose fate is unknown (lost reply, conflicting receipt). */
	private uncertain: string[] = [];
	/** Acts of this generation that carry it and have not been settled yet — a send that never returned stays here, and ends `unknown`. */
	private attempted: string[] = [];
	/** The act being sent now, so a generation change mid-send re-records it if its recomposition will carry the objective. */
	private inflight: string | null = null;
	/** The constraint lines the act being sent would carry with the objective. */
	private constraints: readonly string[] = [];
	private consumedId: string | null = null;
	/** The first verified read of the objective in this run, kept across generations: it happened, whatever follows. */
	private priorRead: { inputId: string; generation: number } | null = null;
	/** Every act this run sent (settled from its journalled receipt): what a later refusal must not deny. */
	private actsSent = 0;
	/** Per act id, the digest of the objective-bearing composition THIS run sends under it: a read counts only for that content. */
	private digests = new Map<string, string>();

	private constructor(
		readonly runId: string,
		readonly text: string,
		readonly origin: ObjectiveOrigin,
		readonly utf8Bytes: number,
		readonly sha256: string,
	) {}

	static async create(runId: string, text: string, origin: ObjectiveOrigin | undefined): Promise<ObjectiveDelivery> {
		const bytes = new TextEncoder().encode(text);
		return new ObjectiveDelivery(runId, text, origin ?? { kind: "unverified" }, bytes.length, await sha256Hex(bytes));
	}

	/**
	 * From the runner's `/capabilities` answer. After a `reconnected` relaunch, a runner that names its engine
	 * lets the next snapshot decide whether the engine is new ({@link engine}); one that cannot is assumed new
	 * (owed again, predecessors' sends forgotten). Returns the new state when this settled it.
	 */
	capabilities(answer: unknown, opts: { reconnected?: boolean; runnerNode?: string | null } = {}): ObjectiveDeliveryState | null {
		const list = (answer as { capabilities?: unknown } | null)?.capabilities;
		const wasUnsupported = this.state === "unsupported";
		this.supported = Array.isArray(list) && list.includes(RUN_OBJECTIVE_CAPABILITY);
		this.identified = Array.isArray(list) && list.includes(ENGINE_IDENTITY_CAPABILITY);
		if (opts.runnerNode !== undefined) this.runnerNode = opts.runnerNode;
		if (opts.reconnected && (!this.identified || wasUnsupported)) this.reset();
		if (this.supported || this.state !== "pending") return null;
		this.state = "unsupported";
		return this.state;
	}

	/** The engine was ended and started again (a re-auth restart): whatever it read is gone. */
	replaced(): void {
		this.reset();
	}

	/** Every journalled snapshot: a different ledger or engine process than this generation's is a new engine. */
	engine(e: EngineInputs | undefined): void {
		if (!e?.ledger) return;
		const key = `${e.ledger}:${e.epoch}`;
		if (this.engineKey && this.engineKey !== key) this.reset();
		this.engineKey = key;
	}

	private reset(): void {
		this.generation++;
		this.issued = [];
		this.uncertain = [];
		this.consumedId = null;
		this.engineKey = null;
		this.state = "pending";
		this.attempted = this.inflight && this.owed() && envelopeFits(this.constraints) ? [this.inflight] : [];
	}

	private owed(): boolean {
		return this.state === "pending" && this.supported === true && !!this.text.trim() && this.issued.length + this.uncertain.length + this.attempted.length < MAX_OBJECTIVE_SENDS;
	}

	/**
	 * Before EVERY act, outside its step (#1019): when this runner renders the envelope and the constraints in force now
	 * do not fit it whole, no act may reach the engine — not the objective-bearing one, and not a plain one after the
	 * objective was delivered, since the engine would then work without a constraint that binds it. `settled` is the
	 * receipt to journal when this refusal is new. A runner that cannot render the envelope at all keeps its own
	 * `unsupported` path and is never blocked here.
	 */
	blocks(constraints: readonly string[]): { blocked: boolean; settled: ObjectiveDeliveryState | null } {
		if (this.supported !== true || !this.text.trim() || envelopeFits(constraints)) return { blocked: false, settled: null };
		this.constraints = constraints;
		if (this.state === "refused") return { blocked: true, settled: null };
		this.state = "refused";
		return { blocked: true, settled: this.state };
	}

	/** Why the run stopped at a refused envelope — the receipt line, for the run's own outcome. */
	stopReason(): string {
		return this.describe("refused");
	}

	/**
	 * Before an act is sent, OUTSIDE its step: recorded as attempted if it will carry the objective, so a send that never
	 * returns is not forgotten. Only reached for constraints that fit ({@link blocks} stops every other act first).
	 */
	async attempt(action: CodingActionKind, constraints: readonly string[] = []): Promise<void> {
		this.inflight = action.kind === "message" && action.inputId ? action.inputId : null;
		this.constraints = constraints;
		// The content a read must match — computed even when not owed now, since a new generation may make it owed mid-send.
		if (this.inflight && action.kind === "message") this.digests.set(this.inflight, await actDigest(this.withObjective(action)));
		if (this.inflight && this.owed() && envelopeFits(constraints)) this.attempted.push(this.inflight);
	}

	/** The action to send: the objective — with ALL the constraints {@link attempt} saw — attached while it is owed, else the action unchanged. */
	attach(action: CodingActionKind): CodingActionKind {
		if (action.kind !== "message" || !action.inputId || !(this.attempted.includes(action.inputId) || this.owed())) return action;
		if (this.state !== "pending" || this.supported !== true || !envelopeFits(this.constraints)) return action;
		return this.withObjective(action);
	}

	private withObjective(action: CodingActionKind): CodingActionKind {
		if (action.kind !== "message") return action;
		return { ...action, objective: { runId: this.runId, text: this.text, origin: this.origin, ...(this.constraints.length ? { constraints: [...this.constraints] } : {}) } };
	}

	/** After the act step, from its JOURNALLED receipt. Only this generation's engine accepting it counts; a predecessor's never does. */
	settle(r: ActReceipt): void {
		this.inflight = null;
		this.actsSent++;
		this.attempted = this.attempted.filter((id) => id !== r.inputId);
		if (!r.objective || !r.inputId) return;
		const ours = !this.identified || !r.ledger || `${r.ledger}:${r.epoch}` === this.engineKey;
		if (r.outcome === "accepted" && ours) this.issued.push(r.inputId);
		else if (r.outcome === "unknown" || r.outcome === "conflict") this.uncertain.push(r.inputId);
	}

	/**
	 * Every snapshot the run reads. A read counts only when the runner's OWN ledger shows that id accepted with the
	 * exact content this run sent the objective in, by the engine process of this generation, and read by that same
	 * process — so a predecessor's reading, or older content under the same id (a conflict), is never delivery of
	 * this objective. A runner that cannot name ledger and content cannot confirm it.
	 */
	observe(engine: EngineInputs | undefined): ObjectiveDeliveryState | null {
		if (this.state !== "pending" || !engine?.ledger) return null;
		const mine = (epoch: number) => `${engine.ledger}:${epoch}` === this.engineKey;
		const candidates = new Set([...this.issued, ...this.uncertain, ...this.attempted]);
		const read = engine.consumed.find(
			([id, ep]) => mine(ep) && candidates.has(id) && engine.accepted.some(([aid, digest, aep]) => aid === id && aep === ep && digest === this.digests.get(id)),
		);
		if (!read) return null;
		this.consumedId = read[0];
		this.priorRead ??= { inputId: read[0], generation: this.generation };
		this.state = "delivered";
		return this.state;
	}

	/** At the end of the run, a terminal receipt for whatever is still pending. Never `delivered`. */
	finish(): ObjectiveDeliveryState | null {
		if (this.state !== "pending" || this.supported !== true || !this.text.trim()) return null;
		this.state = this.issued.length ? "unconfirmed" : this.uncertain.length || this.attempted.length ? "unknown" : "undelivered";
		return this.state;
	}

	receipt(state: ObjectiveDeliveryState): ObjectiveReceipt {
		return {
			state,
			runId: this.runId,
			origin: this.origin.kind,
			generation: this.generation,
			runnerNode: this.runnerNode,
			engine: this.engineKey,
			constraintLines: this.constraints.length,
			chars: [...this.text].length,
			utf8Bytes: this.utf8Bytes,
			sha256: this.sha256,
			consumedInputId: state === "delivered" ? this.consumedId : null,
			priorRead: this.priorRead,
			actsSent: this.actsSent,
		};
	}

	/** One line for the trace and the chat. Never the objective's text. */
	describe(state: ObjectiveDeliveryState): string {
		const size = `${[...this.text].length} characters, ${this.utf8Bytes} bytes, sha256 ${this.sha256}`;
		const where = this.runnerNode ? ` on ${this.runnerNode}` : "";
		switch (state) {
			case "delivered":
				return `The run's objective (${size}) was delivered verbatim to the engine${where}, which read it (input ${this.consumedId}).`;
			case "unsupported":
				return `The run's objective (${size}) was NOT delivered to the engine${where}: this machine's runner did not report support for it (update with \`npm i -g @proagentstore/cli\`). The Pilot relays it in its own words.`;
			case "unconfirmed":
				return `The run's objective (${size}) was sent with ${this.issued.length} turn(s)${where}, but the engine never confirmed reading any of them — it is not reported as delivered.`;
			case "unknown":
				return `The run's objective (${size}) was sent${where}, but no runner receipt settled it — a lost reply, a send that never returned, or a runner holding different content under that turn's id — and no read receipt followed: whether the engine has it is unknown.`;
			case "refused": {
				const why = `the owner's constraints in force now (${this.constraints.length} line(s)) do not fit one envelope whole (at most ${MAX_OBJECTIVE_CONSTRAINTS} lines of ${MAX_OBJECTIVE_CONSTRAINT_CHARS} characters), and a partial set is never sent. Shorten or merge the standing rules or directives, then continue the run.`;
				// What already happened stands (#1019): a refusal stops the NEXT act, it never rewrites an earlier delivery.
				if (this.priorRead) {
					return `The run's objective (${size}) was delivered earlier and read by the engine (input ${this.priorRead.inputId}, engine generation ${this.priorRead.generation}), and the ${this.actsSent} act(s) already sent stand. The run was stopped before its next act reached the engine${where}: ${why}`;
				}
				if (this.actsSent) {
					return `The run's objective (${size}) has no confirmed read, but ${this.actsSent} act(s) of this run were already sent to the engine and stand. The run was stopped before its next act reached the engine${where}: ${why}`;
				}
				return `The run's objective (${size}) was NOT delivered to the engine${where}, and the run was stopped before the engine received anything: ${why}`;
			}
			case "undelivered":
				return `The run's objective (${size}) was NOT delivered to the engine${where}: the run ended before any turn carried it to the engine it was owed to.`;
			default:
				return `The run's objective (${size}) has not been delivered yet.`;
		}
	}
}
