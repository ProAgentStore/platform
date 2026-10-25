import { describe, expect, it } from "vitest";
import { RecordBuffer, readRecordAck } from "./record-cursor.js";

// #1358 — records leave the runner only when the cloud has acknowledged them.
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);
const rec = (id: string) => ({ id });

describe("a capture reads records without losing them", () => {
	it("peek returns everything pending and deletes nothing: a capture that timed out but ran loses no batch", () => {
		const b = new RecordBuffer<{ id: string }, { id: string }>();
		b.pushUsage(rec("u1"), 200);
		b.pushAct(rec("a1"), 100);
		const first = b.peek();
		const again = b.peek(); // the cloud never saw the first reply
		expect(ids(first.usage)).toEqual(["u1"]);
		expect(ids(again.usage)).toEqual(["u1"]);
		expect(ids(again.acts)).toEqual(["a1"]);
		expect(b.pending()).toEqual({ usage: 1, acts: 1 });
	});

	it("an ack deletes exactly what it covers; records produced after the peek survive it", () => {
		const b = new RecordBuffer<{ id: string }, { id: string }>();
		b.pushUsage(rec("u1"), 200);
		b.pushAct(rec("a1"), 100);
		const cursor = b.peek().cursor;
		b.pushUsage(rec("u2"), 200); // arrives while the cloud is persisting the first batch
		b.pushAct(rec("a2"), 100);
		b.acknowledge({ ...cursor });
		const next = b.peek();
		expect(ids(next.usage)).toEqual(["u2"]);
		expect(ids(next.acts)).toEqual(["a2"]);
	});

	it("the two streams are acknowledged independently: persisted usage with failed acts frees the usage and keeps the acts", () => {
		const b = new RecordBuffer<{ id: string }, { id: string }>();
		b.pushUsage(rec("u1"), 200);
		b.pushAct(rec("a1"), 100);
		const c = b.peek().cursor;
		b.acknowledge({ epoch: c.epoch, usage: c.usage, acts: 0 }); // the act insert failed
		expect(b.pending()).toEqual({ usage: 0, acts: 1 });
	});

	it("acknowledging twice, or acknowledging less, is harmless", () => {
		const b = new RecordBuffer<{ id: string }, { id: string }>();
		b.pushUsage(rec("u1"), 200);
		b.pushUsage(rec("u2"), 200);
		const c = b.peek().cursor;
		b.acknowledge(c);
		b.acknowledge(c);
		b.acknowledge({ epoch: c.epoch, usage: 0, acts: 0 });
		expect(b.pending()).toEqual({ usage: 0, acts: 0 });
		b.pushUsage(rec("u3"), 200);
		b.acknowledge(c); // an old cursor does not reach the new record
		expect(ids(b.peek().usage)).toEqual(["u3"]);
	});

	it("an empty buffer's cursor is the high-water mark, so a later record is never covered by it", () => {
		const b = new RecordBuffer<{ id: string }, { id: string }>();
		b.pushUsage(rec("u1"), 200);
		b.acknowledge(b.peek().cursor);
		const idle = b.peek().cursor;
		expect(idle.usage).toBe(1);
		b.pushUsage(rec("u2"), 200);
		b.acknowledge(idle);
		expect(ids(b.peek().usage)).toEqual(["u2"]);
	});
});

describe("the epoch keeps one buffer's acknowledgement away from another's records", () => {
	it("an ack from a previous session's buffer deletes nothing — sequence numbers restart with a new buffer", () => {
		const old = new RecordBuffer<{ id: string }, { id: string }>();
		for (let i = 0; i < 5; i++) old.pushUsage(rec(`old${i}`), 200);
		const staleAck = old.peek().cursor; // usage: 5

		const fresh = new RecordBuffer<{ id: string }, { id: string }>(); // the runner restarted
		fresh.pushUsage(rec("new1"), 200);
		fresh.pushUsage(rec("new2"), 200);
		expect(fresh.epoch).not.toBe(old.epoch);
		fresh.acknowledge(staleAck); // numerically covers seq 1 and 2 — and must not
		expect(ids(fresh.peek().usage)).toEqual(["new1", "new2"]);
	});

	it("the opt-in ack (epoch null) acknowledges nothing", () => {
		const b = new RecordBuffer<{ id: string }, { id: string }>();
		b.pushUsage(rec("u1"), 200);
		b.acknowledge({ epoch: null, usage: 999, acts: 999 });
		expect(b.pending().usage).toBe(1);
	});
});

describe("the old drain still works for a caller that sends no cursor", () => {
	it("takeUsage / takeActs hand over everything and forget it", () => {
		const b = new RecordBuffer<{ id: string }, { id: string }>();
		b.pushUsage(rec("u1"), 200);
		b.pushAct(rec("a1"), 100);
		expect(ids(b.takeUsage())).toEqual(["u1"]);
		expect(ids(b.takeActs())).toEqual(["a1"]);
		expect(b.pending()).toEqual({ usage: 0, acts: 0 });
		expect(b.takeUsage()).toEqual([]);
	});
});

describe("the caps are the ones the arrays had", () => {
	it("usage keeps the newest; acts keep the oldest and refuse the rest", () => {
		const b = new RecordBuffer<{ id: string }, { id: string }>();
		for (let i = 1; i <= 5; i++) b.pushUsage(rec(`u${i}`), 3);
		expect(ids(b.peek().usage)).toEqual(["u3", "u4", "u5"]);
		expect(b.pushAct(rec("a1"), 2)).toBe(true);
		expect(b.pushAct(rec("a2"), 2)).toBe(true);
		expect(b.pushAct(rec("a3"), 2)).toBe(false);
		expect(ids(b.peek().acts)).toEqual(["a1", "a2"]);
	});
});

describe("readRecordAck treats anything malformed as 'no cursor', never as an error", () => {
	it("accepts a well-formed ack, with or without an epoch", () => {
		expect(readRecordAck({ epoch: "e1", usage: 3, acts: 0 })).toEqual({ epoch: "e1", usage: 3, acts: 0 });
		expect(readRecordAck({ epoch: null, usage: 0, acts: 0 })).toEqual({ epoch: null, usage: 0, acts: 0 });
	});

	it("rejects the rest", () => {
		for (const bad of [undefined, null, 5, "x", {}, { epoch: "e", usage: -1, acts: 0 }, { epoch: "e", usage: 1.5, acts: 0 }, { epoch: "e", usage: 1 }, { epoch: 7, usage: 1, acts: 1 }, { epoch: "", usage: 1, acts: 1 }, { epoch: "x".repeat(65), usage: 1, acts: 1 }]) {
			expect(readRecordAck(bad), JSON.stringify(bad)).toBeUndefined();
		}
	});
});
