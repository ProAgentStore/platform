/**
 * The browser error outbox (#1088), driven the way a browser drives it: a clock, a network that goes away
 * and comes back, a server that answers 503 or 400, storage that outlives the page, and a session that
 * appears after the failure. Every assertion is about what the platform RECEIVES.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { BACKOFF_MS, ErrorOutbox, MAX_EVENTS, OUTBOX_KEY, THROTTLE_MS, sessionFingerprint, type OutboxDeps } from "./error-outbox.js";

interface Sent {
	id: string;
	source: string;
	message: string;
	count: number;
	context?: Record<string, unknown>;
	auth: string | undefined;
}

let clock: number;
let online: boolean;
let token: string | null;
let answer: (n: number) => number | "throw";
let sent: Sent[];
let attempts: number;
let storage: Map<string, string>;
let timers: Array<{ at: number; fn: () => void }>;
let ids: number;

function deps(): OutboxDeps {
	return {
		endpoint: "https://api.example/v1/errors/client",
		fetch: async (_url, init) => {
			attempts++;
			const a = answer(attempts);
			if (a === "throw") throw new TypeError("Failed to fetch");
			const body = JSON.parse(init.body);
			if (a >= 200 && a < 300) sent.push({ id: body.id, source: body.source, message: body.message, count: body.count, context: body.context, auth: init.headers.Authorization });
			return { ok: a >= 200 && a < 300, status: a };
		},
		storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
		now: () => clock,
		online: () => online,
		token: () => token,
		schedule: (fn, ms) => void timers.push({ at: clock + ms, fn }),
		newId: () => `ev-${++ids}`,
	};
}

/** Let time pass: fire every timer that came due, and wait for the sends it starts. */
async function advance(ms: number) {
	clock += ms;
	for (;;) {
		const due = timers.filter((t) => t.at <= clock);
		if (!due.length) break;
		timers = timers.filter((t) => t.at > clock);
		for (const t of due) t.fn();
		await new Promise((r) => setTimeout(r, 0));
	}
	await new Promise((r) => setTimeout(r, 0));
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const report = (o: ErrorOutbox, message: string, source = "api") => o.report({ source, message, build: "b1" });

beforeEach(() => {
	clock = 1_000_000;
	online = true;
	token = null;
	answer = () => 200;
	sent = [];
	attempts = 0;
	storage = new Map();
	timers = [];
	ids = 0;
});

describe("delivery is acknowledged, not assumed (#1088)", () => {
	it("a 503 is not delivery: the event stays and is retried until the platform stores it", async () => {
		answer = (n) => (n === 1 ? 503 : 200);
		const o = new ErrorOutbox(deps());
		report(o, "GET /v1/x → 500");
		await settle();
		expect(sent).toEqual([]);
		expect(o.pending()).toHaveLength(1);
		await advance(BACKOFF_MS[0]);
		expect(sent.map((s) => s.message)).toEqual(["GET /v1/x → 500"]);
		expect(o.pending()).toHaveLength(0);
	});

	it("a 202 (spooled server-side) is delivery; a 400 can never succeed — dropped, and the drop is reported", async () => {
		answer = (n) => (n === 1 ? 400 : n === 2 ? 202 : 200);
		const o = new ErrorOutbox(deps());
		report(o, "malformed");
		await settle();
		expect(o.pending()).toHaveLength(0);
		expect(o.droppedCount()).toBe(1);
		report(o, "next one");
		await settle();
		expect(sent).toHaveLength(1);
		expect(sent[0].context).toEqual({ droppedReports: 1 });
		expect(o.droppedCount()).toBe(0);
	});

	it("a failed delivery does not suppress a later report of the same failure", async () => {
		answer = (n) => (n === 1 ? "throw" : 200);
		const o = new ErrorOutbox(deps());
		report(o, "same failure");
		await settle();
		report(o, "same failure");
		await advance(BACKOFF_MS[0]);
		// One event carrying BOTH occurrences — not one delivered and one silently dropped.
		expect(sent).toEqual([expect.objectContaining({ message: "same failure", count: 2 })]);
	});

	it("gives up after the last backoff step, and counts it rather than losing it silently", async () => {
		answer = () => 503;
		const o = new ErrorOutbox(deps());
		report(o, "never stored");
		await settle();
		for (const step of BACKOFF_MS) await advance(step);
		expect(attempts).toBe(BACKOFF_MS.length + 1);
		expect(o.pending()).toHaveLength(0);
		expect(o.droppedCount()).toBe(1);
	});
});

describe("offline, reload and duplicates (#1088)", () => {
	it("offline → online: nothing is sent while offline, everything waiting goes once the browser is back", async () => {
		online = false;
		const o = new ErrorOutbox(deps());
		report(o, "while offline A");
		report(o, "while offline B");
		await settle();
		expect(attempts).toBe(0);
		online = true;
		await o.flush();
		expect(sent.map((s) => s.message)).toEqual(["while offline A", "while offline B"]);
	});

	it("a reload replays what the previous page could not deliver — with the SAME id, so the server dedupes", async () => {
		answer = () => "throw";
		const first = new ErrorOutbox(deps());
		report(first, "before the reload");
		await settle();
		const id = first.pending()[0].id;
		expect(JSON.parse(storage.get(OUTBOX_KEY) as string).events[0].id).toBe(id);

		answer = () => 200;
		clock += BACKOFF_MS[0];
		const afterReload = new ErrorOutbox(deps());
		await afterReload.flush();
		expect(sent).toEqual([expect.objectContaining({ id, message: "before the reload" })]);
		expect(JSON.parse(storage.get(OUTBOX_KEY) as string).events).toEqual([]);
	});

	it("repeats within 30 s of a delivered report are counted and sent once the 30 s pass — never dropped", async () => {
		const o = new ErrorOutbox(deps());
		report(o, "flapping");
		await settle();
		report(o, "flapping");
		report(o, "flapping");
		await settle();
		expect(sent).toHaveLength(1);
		await advance(THROTTLE_MS);
		expect(sent.map((s) => s.count)).toEqual([1, 2]);
		expect(new Set(sent.map((s) => s.id)).size).toBe(2);
	});

	it("the outbox is bounded: past the cap the oldest are kept and the rest counted", async () => {
		online = false;
		const o = new ErrorOutbox(deps());
		for (let i = 0; i < MAX_EVENTS + 3; i++) report(o, `distinct ${i}`);
		expect(o.pending()).toHaveLength(MAX_EVENTS);
		expect(o.droppedCount()).toBe(3);
	});
});

describe("attribution is never upgraded (#1088)", () => {
	it("a pre-auth failure replayed after sign-in is still anonymous; a signed-in one goes under that session", async () => {
		online = false;
		const o = new ErrorOutbox(deps());
		report(o, "on the sign-in page");
		token = "session-A";
		report(o, "after sign-in");
		online = true;
		await o.flush();
		expect(sent.find((s) => s.message === "on the sign-in page")?.auth).toBeUndefined();
		expect(sent.find((s) => s.message === "after sign-in")?.auth).toBe("Bearer session-A");
	});

	it("an event made under one session is never sent under another — it goes anonymously instead", async () => {
		online = false;
		token = "session-A";
		const o = new ErrorOutbox(deps());
		report(o, "made as A");
		token = "session-B";
		online = true;
		await o.flush();
		expect(sent[0].auth).toBeUndefined();
	});

	it("stores a fingerprint, never the session token", async () => {
		token = "secret-session-token";
		answer = () => "throw";
		const o = new ErrorOutbox(deps());
		report(o, "kept on disk");
		await settle();
		const disk = storage.get(OUTBOX_KEY) as string;
		expect(disk).not.toContain("secret-session-token");
		expect(disk).toContain(sessionFingerprint("secret-session-token"));
	});
});
