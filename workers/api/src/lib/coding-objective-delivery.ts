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
 * Per runner GENERATION: a reconnect or relaunch re-reads the runner's capabilities, and a new engine has
 * not read the objective, so it is owed again — and a late receipt from the predecessor does not count
 * for it. A runner without {@link RUN_OBJECTIVE_CAPABILITY} is never sent it (an older one would label it
 * the owner's), and the run says it was not delivered there.
 *
 * Bounded: attached until a consumption is confirmed, to at most {@link MAX_OBJECTIVE_SENDS} turns per
 * generation. A send whose reply was lost is `unknown` until a receipt settles it, never `delivered`.
 * Receipts carry a digest and byte length, never the objective's text.
 *
 * Pure state, driven by the workflow from journalled values only, so a replay reaches the same verdict.
 */
import type { CodingActionKind } from "./coding-loop.js";

/** Advertised by a runner whose `input()` renders `objective` WITH its verified origin (browser-runner coding/run-objective.ts). */
export const RUN_OBJECTIVE_CAPABILITY = "coding.run-objective.v2";
/** Advertised by a runner that refuses to run an already-accepted inputId twice and lists accepted ids on every snapshot. */
export const INPUT_IDEMPOTENT_CAPABILITY = "coding.input-idempotent";
/** How many turns per runner generation may carry the objective before an unconfirmed delivery is reported as such. */
export const MAX_OBJECTIVE_SENDS = 3;

/**
 * What the platform VERIFIED about where the objective came from — never who typed it (mirrors the runner's
 * type). `account`: submitted through the owner's authenticated account, which may be an assistant on an
 * MCP client. There is no "owner wrote it" kind, because nothing verifies human authorship.
 */
export type ObjectiveOrigin = { kind: "account" | "supervisor" | "trigger" | "unverified"; by?: string };

export type ObjectiveDeliveryState = "pending" | "delivered" | "unsupported" | "unconfirmed" | "unknown";

/** What a trace or chat line may say about an objective: identity and size, never its bytes. */
export interface ObjectiveReceipt {
	state: ObjectiveDeliveryState;
	runId: string;
	origin: ObjectiveOrigin["kind"];
	generation: number;
	runnerNode: string | null;
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
	/** Bumped by every reconnect/relaunch: the engine reading the objective is a fact about ONE engine. */
	generation = 0;
	runnerNode: string | null = null;
	/** Null until the runner's capabilities were read; false means it cannot render the objective with its origin. */
	private supported: boolean | null = null;
	/** Acts of THIS generation that carried the objective and were accepted by the runner. */
	private issued: string[] = [];
	/** Acts of this generation that carried it but whose reply was lost: maybe delivered, maybe not. */
	private uncertain: string[] = [];
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
	 * From the runner's `/capabilities` answer. `newGeneration` (a reconnect or relaunch) starts the
	 * engine's reading over: owed again, predecessors' sends forgotten. Returns the new state when this
	 * settled it.
	 */
	capabilities(answer: unknown, opts: { newGeneration?: boolean; runnerNode?: string | null } = {}): ObjectiveDeliveryState | null {
		const list = (answer as { capabilities?: unknown } | null)?.capabilities;
		this.supported = Array.isArray(list) && list.includes(RUN_OBJECTIVE_CAPABILITY);
		if (opts.runnerNode !== undefined) this.runnerNode = opts.runnerNode;
		if (opts.newGeneration) {
			this.generation++;
			this.issued = [];
			this.uncertain = [];
			this.consumedId = null;
			this.state = "pending";
		}
		if (this.supported || this.state !== "pending") return null;
		this.state = "unsupported";
		return this.state;
	}

	/** The action to send: the objective attached while it is owed, else the action unchanged. */
	attach(action: CodingActionKind): CodingActionKind {
		if (action.kind !== "message" || !action.inputId || this.state !== "pending" || this.supported !== true || !this.text.trim()) return action;
		if (this.issued.length + this.uncertain.length >= MAX_OBJECTIVE_SENDS) return action;
		return { ...action, objective: { runId: this.runId, text: this.text, origin: this.origin } };
	}

	/** After the act step: `accepted` reached this generation's engine; `unknown` lost its reply. A refused send stays owed. */
	sent(action: CodingActionKind, outcome: "accepted" | "unknown"): void {
		if (action.kind !== "message" || !action.objective || !action.inputId) return;
		(outcome === "accepted" ? this.issued : this.uncertain).push(action.inputId);
	}

	/** Every snapshot the run reads. Only THIS generation's sends count. Returns the new state when one settled delivery. */
	observe(consumedInputs: readonly string[] | undefined): ObjectiveDeliveryState | null {
		if (this.state !== "pending") return null;
		const id = consumedInputs?.find((c) => this.issued.includes(c) || this.uncertain.includes(c));
		if (!id) return null;
		this.consumedId = id;
		this.state = "delivered";
		return this.state;
	}

	/** At the end of the run: accepted but never read is `unconfirmed`; only lost replies is `unknown`. Never `delivered`. */
	finish(): ObjectiveDeliveryState | null {
		if (this.state !== "pending") return null;
		if (this.issued.length) this.state = "unconfirmed";
		else if (this.uncertain.length) this.state = "unknown";
		else return null;
		return this.state;
	}

	receipt(state: ObjectiveDeliveryState): ObjectiveReceipt {
		return {
			state,
			runId: this.runId,
			origin: this.origin.kind,
			generation: this.generation,
			runnerNode: this.runnerNode,
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
				return `The run's objective (${size}) was sent${where}, but every reply was lost before the runner confirmed it, and no read receipt followed — whether the engine has it is unknown.`;
			default:
				return `The run's objective (${size}) has not been delivered yet.`;
		}
	}
}
