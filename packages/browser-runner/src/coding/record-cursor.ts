/**
 * The records an engine session has produced and the cloud has not yet confirmed it holds (#1358): usage rows and consequential acts.
 *
 * A capture used to DRAIN them: take the records and forget them, in one step, before the cloud had written anything. A capture that
 * timed out at the relay but ran lost its batch; a D1 blip while the cloud persisted made the step retry AFTER the drain and lose it
 * too. The acts are the audit trail the merge-authority and write-scope checks read, so "lost" is not a cosmetic failure.
 *
 * Now each record gets a sequence number as it is produced, a capture that names a cursor READS without deleting, and the records go
 * only when a later capture acknowledges them (`ack`). The acknowledgement is the cloud's own journalled proof that it persisted
 * them, so a retry, a timeout or a replay can only cause a re-send, never a loss — and the cloud's inserts are keyed on each record's
 * own id, so a re-send writes nothing twice.
 *
 * The EPOCH names this buffer. Sequence numbers restart when a session is re-created (a runner restart, a new engine process), so an
 * acknowledgement from the previous buffer must never delete records of the new one: an ack whose epoch is not ours is ignored.
 *
 * A caller that names no cursor gets the old behaviour: {@link takeUsage} / {@link takeActs} drain. That is how an older cloud (which
 * sends no `ack`) and the console's own drain keep working against a newer runner.
 */
import { randomUUID } from "node:crypto";

/** What the runner hands back with a capture: the highest sequence number of each kind it included. */
export interface RecordCursor {
	epoch: string;
	usage: number;
	acts: number;
}

/** What the cloud sends with the next capture: the cursor it last persisted. `epoch: null` opts in without acknowledging anything. */
export interface RecordAck {
	epoch: string | null;
	usage: number;
	acts: number;
}

interface Held<T> {
	seq: number;
	record: T;
}

/** A cloud-sent ack, read defensively: anything that is not a well-formed cursor is "no ack" (the legacy drain), not an error. */
export function readRecordAck(v: unknown): RecordAck | undefined {
	if (!v || typeof v !== "object") return undefined;
	const o = v as Record<string, unknown>;
	const num = (x: unknown): number | null => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);
	const usage = num(o.usage);
	const acts = num(o.acts);
	const epoch = o.epoch === null ? null : typeof o.epoch === "string" && o.epoch.length > 0 && o.epoch.length <= 64 ? o.epoch : undefined;
	if (usage === null || acts === null || epoch === undefined) return undefined;
	return { epoch, usage, acts };
}

export class RecordBuffer<U, A> {
	/** Names this buffer; an acknowledgement for another is ignored. */
	readonly epoch = randomUUID();
	private usage: Array<Held<U>> = [];
	private acts: Array<Held<A>> = [];
	private nextUsage = 1;
	private nextAct = 1;

	/** Usage keeps the NEWEST at the cap: a long run's recent spend matters more than its first turns'. */
	pushUsage(record: U, cap: number): void {
		this.usage.push({ seq: this.nextUsage++, record });
		if (this.usage.length > cap) this.usage.shift();
	}

	/** Acts keep the OLDEST at the cap — the opposite way round, because the earliest consequential act is the one an audit starts from. */
	pushAct(record: A, cap: number): boolean {
		if (this.acts.length >= cap) return false;
		this.acts.push({ seq: this.nextAct++, record });
		return true;
	}

	/** The destructive drain: everything pending, forgotten. For a caller that sends no cursor, and for the end of a session. */
	takeUsage(): U[] {
		const out = this.usage.map((h) => h.record);
		this.usage = [];
		return out;
	}

	takeActs(): A[] {
		const out = this.acts.map((h) => h.record);
		this.acts = [];
		return out;
	}

	/** Forget what the cloud has confirmed it holds. Only this buffer's own epoch counts; a stale ack deletes nothing. */
	acknowledge(ack: RecordAck | undefined): void {
		if (!ack || ack.epoch !== this.epoch) return;
		this.usage = this.usage.filter((h) => h.seq > ack.usage);
		this.acts = this.acts.filter((h) => h.seq > ack.acts);
	}

	/** Everything still pending, WITHOUT forgetting it, and the cursor that acknowledges exactly this batch. */
	peek(): { usage: U[]; acts: A[]; cursor: RecordCursor } {
		return {
			usage: this.usage.map((h) => h.record),
			acts: this.acts.map((h) => h.record),
			cursor: { epoch: this.epoch, usage: this.usage.at(-1)?.seq ?? this.nextUsage - 1, acts: this.acts.at(-1)?.seq ?? this.nextAct - 1 },
		};
	}

	/** How many records are held, for tests and diagnostics. */
	pending(): { usage: number; acts: number } {
		return { usage: this.usage.length, acts: this.acts.length };
	}
}
