/**
 * Card identity (#1698, first slice): one card per actual execution, never per job URL, issue or applicant.
 *
 * Pure, so no database: the module reads and writes nothing. What it reuses is pinned against the existing writers' own ids
 * (`codingCardId`, `scanCardId`, `objectiveJobKey`), so a card the board already writes keeps the id this function names.
 *
 * NOT COVERED (the cutover, see the module header): `buildInstanceBoard` still groups by `jobKeyForTask`, the application card is
 * still one row per application, and the queue read still lists only `pending` entries, so none of this changes what a board shows yet.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { objectiveJobKey } from "./board-order.js";
import { codingSessionIdFromCardId } from "./board-runs.js";
import {
	applicationAttemptCardId,
	cardIdentityForRecord,
	queuedToSessionTransition,
	type ApplicationAttemptRecord,
	type BoardIdentityRecord,
	type BoardIdentityScope,
	type CodingSessionRecord,
	type QueuedObjectiveRecord,
	type ScanRecord,
} from "./board-identity.js";
import { codingCardId } from "./coding-board.js";
import { scanCardId } from "./local-browser/scan-board.js";

const SCOPE: BoardIdentityScope = { instanceId: "inst-1", userId: "u1" };
const coding = (over: Partial<CodingSessionRecord> = {}): CodingSessionRecord => ({ kind: "coding-session", instanceId: "inst-1", userId: "u1", sessionId: "sess-1", status: "active", ...over });
const scan = (over: Partial<ScanRecord> = {}): ScanRecord => ({ kind: "scan", instanceId: "inst-1", userId: "u1", runId: "scan-run-1", status: "running", ...over });
const attempt = (over: Partial<ApplicationAttemptRecord> = {}): ApplicationAttemptRecord => ({ kind: "application-attempt", instanceId: "inst-1", userId: "u1", applicationId: "app-1", runKind: "fill", runId: "fill-1", status: "running", ...over });
const queued = (over: Partial<QueuedObjectiveRecord> = {}): QueuedObjectiveRecord => ({ kind: "queued-objective", instanceId: "inst-1", userId: "u1", entryId: "q-1", status: "pending", ...over });
const id = (r: BoardIdentityRecord, scope = SCOPE) => cardIdentityForRecord(r, scope).cardId;

describe("a resumed coding session keeps one card", () => {
	it("the same session gives the same card id across calls, however its status moves (park, resume, end)", () => {
		const ids = ["active", "needs_human", "active", "ended"].map((status) => id(coding({ status })));
		expect(new Set(ids)).toEqual(new Set([codingCardId("sess-1")]));
		expect(ids[0]).toBe("csess-sess-1");
	});

	it("is exactly the id the coding writer already uses, and reads back to its session id", () => {
		const cardId = id(coding({ sessionId: "abc-123" }));
		expect(cardId).toBe(codingCardId("abc-123"));
		expect(codingSessionIdFromCardId(cardId)).toBe("abc-123");
	});

	it("a different session is a different card, and the runs behind a session are its attempts, not its identity", () => {
		const a = cardIdentityForRecord(coding({ runIds: ["run-2", "run-1"] }), SCOPE);
		const b = cardIdentityForRecord(coding({ runIds: ["run-3"] }), SCOPE);
		expect(a.cardId).toBe(b.cardId); // a new run in the same session is the same card
		expect(a.attempts).toEqual(["run-2", "run-1"]);
		expect(id(coding({ sessionId: "sess-2" }))).not.toBe(a.cardId);
	});

	it("passes the native status through untouched and carries no lane", () => {
		const r = cardIdentityForRecord(coding({ status: "needs_human" }), SCOPE);
		expect(r.nativeStatus).toBe("needs_human");
		expect(Object.keys(r).sort()).toEqual(["cardId", "instanceId", "kind", "nativeStatus"]);
	});
});

describe("distinct attempts are distinct cards, whatever the application, job or issue", () => {
	it("two attempts at the same application get two card ids", () => {
		const first = id(attempt({ runId: "fill-1" }));
		const second = id(attempt({ runId: "fill-2" }));
		expect(first).not.toBe(second);
		expect(first).toBe(applicationAttemptCardId("fill", "fill-1"));
	});

	it("the same attempt is the same card on every call, whatever its status", () => {
		expect(id(attempt({ status: "running" }))).toBe(id(attempt({ status: "failed" })));
	});

	it("the application id is metadata: it is not part of the card id", () => {
		expect(id(attempt({ applicationId: "app-1" }))).toBe(id(attempt({ applicationId: "app-2" })));
		expect(id(attempt({ runId: "fill-9" }))).not.toContain("app-1");
	});

	it("a fill run and a tailor run with the same run id cannot collide", () => {
		expect(id(attempt({ runKind: "fill", runId: "x" }))).not.toBe(id(attempt({ runKind: "tailor", runId: "x" })));
	});

	it("each attempt names its own execution as its attempt", () => {
		expect(cardIdentityForRecord(attempt({ runId: "fill-7" }), SCOPE).attempts).toEqual(["fill-7"]);
	});

	it("two scan runs of the same objective are two cards, and a scan card is the id the scan writer uses", () => {
		expect(id(scan({ runId: "a" }))).not.toBe(id(scan({ runId: "b" })));
		expect(id(scan({ runId: "a" }))).toBe(scanCardId("a"));
	});

	it("refuses an unknown run kind or a missing run id rather than guessing one", () => {
		expect(() => id({ ...attempt(), runKind: "other" as never })).toThrow(/runKind/);
		expect(() => id(attempt({ runId: "" }))).toThrow(/runId/);
		expect(() => id(attempt({ applicationId: "" }))).toThrow(/applicationId/);
	});
});

describe("a queued objective is distinct from a session, and reconciles once a session exists", () => {
	it("a pre-session objective has its own card id, pending, with no session link", () => {
		const r = cardIdentityForRecord(queued(), SCOPE);
		expect(r.cardId).toBe(objectiveJobKey("q-1"));
		expect(r.kind).toBe("queued-objective");
		expect(r.nativeStatus).toBe("pending");
		expect(r.linkedSessionCardId).toBeUndefined();
		expect(r.cardId).not.toBe(id(coding())); // never confused with a created session
	});

	it("once its session is known the entry names the session card, and the transition maps one to the other", () => {
		const linked = cardIdentityForRecord(queued({ status: "started", runId: "run-1", sessionId: "sess-9" }), SCOPE);
		expect(linked.cardId).toBe("objective:q-1"); // the entry keeps its own id; the link says where it went
		expect(linked.linkedSessionCardId).toBe("csess-sess-9");
		expect(queuedToSessionTransition({ id: "q-1" }, linked.linkedSessionCardId as string)).toEqual({ from: "objective:q-1", to: "csess-sess-9" });
		// ...and the target is exactly the card the session itself is given:
		expect(linked.linkedSessionCardId).toBe(id(coding({ sessionId: "sess-9" })));
	});

	it("started with no session (a non-coding run, or not yet resolved) stays a queued objective with no link: the documented gap", () => {
		const r = cardIdentityForRecord(queued({ status: "started", runId: "run-1", sessionId: null }), SCOPE);
		expect(r.linkedSessionCardId).toBeUndefined();
		expect(cardIdentityForRecord(queued({ status: "running" }), SCOPE).nativeStatus).toBe("running");
	});

	it("the transition refuses an id that is not a session card, and an entry with no id", () => {
		expect(() => queuedToSessionTransition({ id: "q-1" }, "scan-1")).toThrow(/coding session card/);
		expect(() => queuedToSessionTransition({ id: "q-1" }, "")).toThrow(/coding session card/);
		expect(() => queuedToSessionTransition({ id: "" }, "csess-1")).toThrow(/queueEntry\.id/);
	});

	it("two entries are two cards, and the same entry is the same card on every call", () => {
		expect(id(queued({ entryId: "a" }))).not.toBe(id(queued({ entryId: "b" })));
		expect(id(queued({ status: "pending" }))).toBe(id(queued({ status: "running" })));
	});
});

describe("owner and instance isolation", () => {
	it("an empty instance or owner is refused", () => {
		expect(() => cardIdentityForRecord(coding(), { instanceId: "", userId: "u1" })).toThrow(/instanceId/);
		expect(() => cardIdentityForRecord(coding(), { instanceId: "inst-1", userId: "" })).toThrow(/userId/);
		expect(() => cardIdentityForRecord(coding(), { instanceId: "  ", userId: "u1" })).toThrow(/instanceId/);
	});

	it("the card is named for the instance of the scope it was asked in", () => {
		expect(cardIdentityForRecord(coding(), SCOPE).instanceId).toBe("inst-1");
		const other = cardIdentityForRecord(coding({ instanceId: "inst-2" }), { instanceId: "inst-2", userId: "u1" });
		expect(other.instanceId).toBe("inst-2");
	});

	it("a record from another instance is refused for every kind: it gets no card in this scope", () => {
		for (const r of [coding({ instanceId: "inst-2" }), scan({ instanceId: "inst-2" }), attempt({ instanceId: "inst-2" }), queued({ instanceId: "inst-2" })]) {
			expect(() => cardIdentityForRecord(r, SCOPE)).toThrow(/different instance/);
		}
	});

	it("a record owned by someone else is refused for every kind", () => {
		for (const r of [coding({ userId: "u2" }), scan({ userId: "u2" }), attempt({ userId: "u2" }), queued({ userId: "u2" })]) {
			expect(() => cardIdentityForRecord(r, SCOPE)).toThrow(/different owner/);
		}
	});

	it("a record that carries no owner is judged by its instance alone", () => {
		const { userId: _u, ...noOwner } = coding();
		expect(id(noOwner as CodingSessionRecord)).toBe("csess-sess-1");
	});
});

describe("mixed coding, application, scan and queued records", () => {
	it("every card id is distinct, even when the underlying ids are all the same string", () => {
		const records: BoardIdentityRecord[] = [
			coding({ sessionId: "x" }),
			scan({ runId: "x" }),
			attempt({ runKind: "fill", runId: "x" }),
			attempt({ runKind: "tailor", runId: "x" }),
			queued({ entryId: "x" }),
		];
		const ids = records.map((r) => id(r));
		expect(new Set(ids).size).toBe(records.length);
		expect(ids).toEqual(["csess-x", "scan-x", "app-attempt-fill-x", "app-attempt-tailor-x", "objective:x"]);
	});

	it("a realistic board: one resumed session, three attempts at one application, two scans and a queued objective give no duplicates", () => {
		const records: BoardIdentityRecord[] = [
			coding({ sessionId: "s1", status: "active" }),
			coding({ sessionId: "s1", status: "needs_human" }), // the same session, parked: the same card, listed twice by a reader
			attempt({ runId: "f1" }),
			attempt({ runId: "f2" }),
			attempt({ runKind: "tailor", runId: "t1" }),
			scan({ runId: "r1" }),
			scan({ runId: "r2" }),
			queued({ entryId: "q1" }),
		];
		const ids = records.map((r) => id(r));
		expect(ids[0]).toBe(ids[1]); // the resumed session collapses to one card
		expect(new Set(ids).size).toBe(records.length - 1);
	});
});

describe("unstarted tickets and generic runtime tasks (#1698 approved design)", () => {
	const ticket = (over: Partial<{ ticketId: string; status: string; instanceId: string; userId: string }> = {}): BoardIdentityRecord => ({ kind: "queued-ticket", instanceId: "inst-1", userId: "u1", ticketId: "t-1", status: "unstarted", ...over });
	const taskRec = (over: Partial<{ taskId: string; status: string; instanceId: string; userId: string }> = {}): BoardIdentityRecord => ({ kind: "task", instanceId: "inst-1", userId: "u1", taskId: "task-1", status: "running", ...over });

	it("a ticket is ticket:<id>, the same card on every call, distinct from any run or session", () => {
		expect(id(ticket())).toBe("ticket:t-1");
		expect(id(ticket({ status: "budget_closed" }))).toBe("ticket:t-1");
		expect(id(ticket({ ticketId: "t-2" }))).not.toBe(id(ticket()));
	});

	it("a runtime task is task:<id>: a retry is a new task, so a new card, however alike the two are", () => {
		expect(id(taskRec({ taskId: "a" }))).toBe("task:a");
		expect(id(taskRec({ taskId: "a" }))).not.toBe(id(taskRec({ taskId: "b" })));
		expect(cardIdentityForRecord(taskRec({ taskId: "a" }), SCOPE).attempts).toEqual(["a"]);
	});

	it("both kinds are owner- and instance-scoped like the rest, and refuse an empty id", () => {
		for (const r of [ticket({ instanceId: "inst-2" }), taskRec({ instanceId: "inst-2" })]) expect(() => cardIdentityForRecord(r, SCOPE)).toThrow(/different instance/);
		for (const r of [ticket({ userId: "u2" }), taskRec({ userId: "u2" })]) expect(() => cardIdentityForRecord(r, SCOPE)).toThrow(/different owner/);
		expect(() => id(ticket({ ticketId: "" }))).toThrow(/ticketId/);
		expect(() => id(taskRec({ taskId: "" }))).toThrow(/taskId/);
	});

	it("no id of any kind collides, even when the raw ids are the same string", () => {
		const ids = [coding({ sessionId: "x" }), scan({ runId: "x" }), attempt({ runId: "x" }), queued({ entryId: "x" }), ticket({ ticketId: "x" }), taskRec({ taskId: "x" })].map((r) => id(r));
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("this slice stays out of the board builder", () => {
	it("imports nothing from the builder, routes, MCP or console", () => {
		const src = readFileSync(join(__dirname, "board-identity.ts"), "utf8");
		const imports = [...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
		expect(imports.sort()).toEqual(["./board-order.js", "./board-runs.js", "./coding-board.js", "./local-browser/scan-board.js"]);
		expect(imports.some((i) => /\/board\.js$|routes|mcp|console/.test(i))).toBe(false);
	});
});
