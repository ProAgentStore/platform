/**
 * The run's objective, delivered VERBATIM to the engine with the run's first turn (#1019).
 *
 * The objective used to reach only the Pilot's own prompt; the engine read whatever the Pilot chose to
 * write, under the Pilot's preamble. So the engine of a run that was told "read-only, quote lines …"
 * saw only a paraphrase. Now the first instruction of each run carries the accepted objective as its own
 * field, which the runner renders as a fenced block attributed to the platform, ahead of the instruction.
 *
 * Delivery is a FACT the runner reports, not an intention: the turn carries an `inputId`, and the
 * objective counts as delivered only when a capture lists that id in `consumedInputs` (a completed turn
 * read it). Consumption is not completion — it says the engine read the objective, nothing more.
 *
 * Bounded: attached to message turns only until a consumption is confirmed, and to at most
 * {@link MAX_OBJECTIVE_SENDS} of them — never every turn of a run. A runner that does not advertise
 * {@link RUN_OBJECTIVE_CAPABILITY} is never sent it, and the run says it was not delivered.
 *
 * Pure state, driven by the workflow from journalled values only, so a replay reaches the same verdict.
 */
import type { CodingActionKind } from "./coding-loop.js";

/** Advertised by a runner whose `input()` renders `objective` (packages/browser-runner coding/runtime.ts). */
export const RUN_OBJECTIVE_CAPABILITY = "coding.run-objective";
/** How many turns may carry the objective before an unconfirmed delivery is reported as such. */
export const MAX_OBJECTIVE_SENDS = 3;

export type ObjectiveDeliveryState = "pending" | "delivered" | "unsupported" | "unconfirmed";

export class ObjectiveDelivery {
	state: ObjectiveDeliveryState = "pending";
	/** Null until the runner's capabilities were read; false means it cannot render the objective. */
	private supported: boolean | null = null;
	private readonly issued: string[] = [];

	constructor(
		readonly runId: string,
		readonly text: string,
	) {}

	/** From the runner's `/capabilities` answer. Returns the new state when this settled it. */
	capabilities(answer: unknown): ObjectiveDeliveryState | null {
		const list = (answer as { capabilities?: unknown } | null)?.capabilities;
		this.supported = Array.isArray(list) && list.includes(RUN_OBJECTIVE_CAPABILITY);
		if (this.supported || this.state !== "pending") return null;
		this.state = "unsupported";
		return this.state;
	}

	/** The action to send: the objective attached while it is owed, else the action unchanged. */
	attach(action: CodingActionKind): CodingActionKind {
		if (action.kind !== "message" || this.state !== "pending" || this.supported !== true || !this.text.trim()) return action;
		if (this.issued.length >= MAX_OBJECTIVE_SENDS) return action;
		const inputId = `objective:${this.runId}:${this.issued.length + 1}`;
		return { ...action, inputId, objective: { runId: this.runId, text: this.text } };
	}

	/** After the act step resolved: that turn reached the runner (a failed act did not, so it stays owed). */
	sent(action: CodingActionKind): void {
		if (action.kind === "message" && action.objective && action.inputId) this.issued.push(action.inputId);
	}

	/** Every snapshot the run reads. Returns the new state when this one settled delivery. */
	observe(consumedInputs: readonly string[] | undefined): ObjectiveDeliveryState | null {
		if (this.state !== "pending") return null;
		if (!consumedInputs?.some((id) => this.issued.includes(id))) return null;
		this.state = "delivered";
		return this.state;
	}

	/** At the end of the run: sent but never confirmed read is `unconfirmed`, never `delivered`. */
	finish(): ObjectiveDeliveryState | null {
		if (this.state !== "pending" || !this.issued.length) return null;
		this.state = "unconfirmed";
		return this.state;
	}

	/** One line for the trace and the chat. Never the objective's text. */
	describe(state: ObjectiveDeliveryState): string {
		const n = `${this.text.length} characters`;
		switch (state) {
			case "delivered":
				return `The run's objective (${n}) was delivered verbatim to the engine, which read it.`;
			case "unsupported":
				return `The run's objective (${n}) was NOT delivered to the engine: this machine's runner does not support it (update with \`npm i -g @proagentstore/cli\`). The Pilot relays it in its own words.`;
			case "unconfirmed":
				return `The run's objective (${n}) was sent with ${this.issued.length} turns, but the engine never confirmed reading any of them — it is not reported as delivered.`;
			default:
				return `The run's objective (${n}) has not been delivered yet.`;
		}
	}
}
