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
import type { ActReceipt } from "./coding-act-send.js";
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

export type { ObjectiveOrigin } from "./coding-objective-origin.js";

export type ObjectiveDeliveryState = "pending" | "delivered" | "unsupported" | "unconfirmed" | "unknown" | "undelivered";

/** What a trace or chat line may say about an objective: identity and size, never its bytes. */
export interface ObjectiveReceipt {
	state: ObjectiveDeliveryState;
	runId: string;
	origin: ObjectiveOrigin["kind"];
	generation: number;
	runnerNode: string | null;
	/** `ledger:epoch` of the engine process this generation is bound to, when the runner names it. */
	engine: string | null;
	chars: number;
	utf8Bytes: number;
	sha256: string;
	consumedInputId: string | null;
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
	private consumedId: string | null = null;

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
		this.attempted = this.inflight && this.owed() ? [this.inflight] : [];
	}

	private owed(): boolean {
		return this.state === "pending" && this.supported === true && !!this.text.trim() && this.issued.length + this.uncertain.length + this.attempted.length < MAX_OBJECTIVE_SENDS;
	}

	/** Before an act is sent: recorded as attempted if it will carry the objective, so a send that never returns is not forgotten. */
	attempt(action: CodingActionKind): void {
		this.inflight = action.kind === "message" && action.inputId ? action.inputId : null;
		if (this.inflight && this.owed()) this.attempted.push(this.inflight);
	}

	/** The action to send: the objective — with the constraints in force now — attached while it is owed, else the action unchanged. */
	attach(action: CodingActionKind, constraints: readonly string[] = []): CodingActionKind {
		if (action.kind !== "message" || !action.inputId || !(this.attempted.includes(action.inputId) || this.owed())) return action;
		if (this.state !== "pending" || this.supported !== true) return action;
		return { ...action, objective: { runId: this.runId, text: this.text, origin: this.origin, ...(constraints.length ? { constraints: [...constraints] } : {}) } };
	}

	/** After the act step, from its JOURNALLED receipt. Only this generation's engine accepting it counts; a predecessor's never does. */
	settle(r: ActReceipt): void {
		this.inflight = null;
		this.attempted = this.attempted.filter((id) => id !== r.inputId);
		if (!r.objective || !r.inputId) return;
		const ours = !this.identified || !r.ledger || `${r.ledger}:${r.epoch}` === this.engineKey;
		if (r.outcome === "accepted" && ours) this.issued.push(r.inputId);
		else if (r.outcome === "unknown" || r.outcome === "conflict") this.uncertain.push(r.inputId);
	}

	/** Every snapshot the run reads. Only THIS generation's sends, read by THIS generation's engine, count. */
	observe(consumedInputs: readonly string[] | undefined, engine?: EngineInputs): ObjectiveDeliveryState | null {
		if (this.state !== "pending") return null;
		const read = engine?.consumed ? engine.consumed.filter(([, ep]) => `${engine.ledger}:${ep}` === this.engineKey).map(([id]) => id) : consumedInputs;
		const id = read?.find((c) => this.issued.includes(c) || this.uncertain.includes(c) || this.attempted.includes(c));
		if (!id) return null;
		this.consumedId = id;
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
			chars: [...this.text].length,
			utf8Bytes: this.utf8Bytes,
			sha256: this.sha256,
			consumedInputId: state === "delivered" ? this.consumedId : null,
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
			case "undelivered":
				return `The run's objective (${size}) was NOT delivered to the engine${where}: the run ended before any turn carried it to the engine it was owed to.`;
			default:
				return `The run's objective (${size}) has not been delivered yet.`;
		}
	}
}
