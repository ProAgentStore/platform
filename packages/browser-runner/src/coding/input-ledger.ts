// What a coding session accepted and consumed, bound to CONTENT and to the engine PROCESS (#1019).
import { createHash, randomUUID } from "node:crypto";

/** Bound on each list, as before: enough to reconcile the latest acts, never a growing history. */
export const MAX_LEDGER_INPUTS = 50;
/** How many of the newest entries ride every snapshot — a retry reconciles the act it just sent. */
export const REPORTED_LEDGER_INPUTS = 16;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * sha256 of an act's EXECUTABLE content — text, author and objective — as received, never its delivery
 * metadata (id, replay). The same id with different content is a conflict, not a retry. Mirrored by the
 * cloud's `actDigest` (workers/api/src/lib/coding-act-send.ts); the two must agree byte for byte.
 */
export function actDigest(a: { text?: unknown; author?: unknown; objective?: unknown }): string {
	const o = a.objective as { runId?: unknown; text?: unknown; origin?: { kind?: unknown; by?: unknown }; constraints?: unknown } | null | undefined;
	const objective = o && typeof o === "object" ? [str(o.runId), str(o.text), str(o.origin?.kind), str(o.origin?.by), Array.isArray(o.constraints) ? o.constraints.filter((c) => typeof c === "string") : []] : null;
	return createHash("sha256").update(JSON.stringify([str(a.text), str(a.author), objective])).digest("hex");
}

/** What a snapshot reports: whose ledger this is, which engine process is current, and the newest entries with their process. */
export interface EngineInputs {
	ledger: string;
	epoch: number;
	/** `[inputId, contentDigest, epoch that accepted it]`, newest last. */
	accepted: Array<[string, string, number]>;
	/** `[inputId, epoch whose completed turn read it]`, newest last. */
	consumed: Array<[string, number]>;
}

/**
 * One session's input record. `ledger` names THIS record: an id absent from it proves only that this
 * ledger never accepted it — a different runner, or this session re-created after a runner restart, starts
 * empty and cannot speak for its predecessor. `epoch` names the engine process: a replacement process has
 * read nothing its predecessor read, so consumption is credited to the process that did the reading.
 * Ids are never forgotten across a process change, so a retried id is still refused rather than run twice.
 */
export class InputLedger {
	readonly ledger = randomUUID();
	epoch = 0;
	private accepted: Array<{ id: string; digest: string; epoch: number }> = [];
	private consumed: Array<{ id: string; epoch: number }> = [];

	/** `duplicate`: this id with this content was already accepted. `conflict`: this id, different content. */
	check(id: string, digest: string): "new" | "duplicate" | "conflict" {
		const hit = this.accepted.find((a) => a.id === id);
		return !hit ? "new" : hit.digest === digest ? "duplicate" : "conflict";
	}

	accept(id: string, digest: string): void {
		this.accepted.push({ id, digest, epoch: this.epoch });
		if (this.accepted.length > MAX_LEDGER_INPUTS) this.accepted.shift();
	}

	consume(id: string | null): void {
		if (!id) return;
		this.consumed.push({ id, epoch: this.epoch });
		if (this.consumed.length > MAX_LEDGER_INPUTS) this.consumed.shift();
	}

	/** A new engine process replaced the old one. */
	newEngine(): void {
		this.epoch++;
	}

	get acceptedIds(): string[] {
		return this.accepted.map((a) => a.id);
	}

	get consumedIds(): string[] {
		return this.consumed.map((c) => c.id);
	}

	report(): EngineInputs {
		return {
			ledger: this.ledger,
			epoch: this.epoch,
			accepted: this.accepted.slice(-REPORTED_LEDGER_INPUTS).map((a) => [a.id, a.digest, a.epoch]),
			consumed: this.consumed.slice(-REPORTED_LEDGER_INPUTS).map((c) => [c.id, c.epoch]),
		};
	}
}
