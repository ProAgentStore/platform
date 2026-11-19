/** #1483 — new work is held while a deferred update waits for an idle window; running work is never touched. */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { holdForPendingUpdate, NEW_WORK_ROUTES, startsNewWork } from "./update-hold.js";
import { MAX_DEFERRED_UPDATE_LEASE_MS } from "./self-update.js";

const NOW = 1_000_000;
const lease = { operationId: "op-1", expiresAt: NOW + 4 * 60_000 };
const none = async () => new Set<string>();
const hold = (over: Partial<Parameters<typeof holdForPendingUpdate>[0]> & { path: string }) =>
	holdForPendingUpdate({ lease, method: "POST", liveSessions: none, now: NOW, ...over });

describe("which requests begin new work", () => {
	it.each(NEW_WORK_ROUTES)("%s (POST) does", (path) => {
		expect(startsNewWork("POST", path)).toBe(true);
		expect(startsNewWork("post", `${path}/`)).toBe(true);
		expect(startsNewWork("POST", `${path}?x=1`)).toBe(true);
	});

	it.each([
		["POST", "/coding/act"],
		["POST", "/coding/capture"],
		["POST", "/coding/end"],
		["POST", "/local-apply/directive"],
		["POST", "/local-apply/cancel"],
		["POST", "/local-apply/status"],
		["POST", "/coding/git"],
		["GET", "/coding/start"],
		["GET", "/coding/sessions"],
	])("%s %s acts on or reads existing work, so it is never held", (method, path) => {
		expect(startsNewWork(method, path)).toBe(false);
	});
});

describe("holdForPendingUpdate: a pending update plus later admissions (#1483)", () => {
	it("holds a NEW coding session while the lease is active, saying why and for how long", async () => {
		const reason = await hold({ path: "/coding/start", body: { sessionId: "s-new" } });
		expect(reason).toMatch(/runner update is waiting for running work/);
		expect(reason).toMatch(/new work is not started/);
		expect(reason).toMatch(/240s/);
		expect(reason).toMatch(/Running sessions are untouched/);
		expect(reason).toMatch(/Retry shortly/);
	});

	it.each(["/local-browser/run", "/local-apply/run", "/local-artifact/run"])("holds a new %s too", async (path) => {
		expect(await hold({ path, body: { runId: "r" } })).toMatch(/update is waiting/);
	});

	it("never holds work that is already running: acts, captures, ends, directives, cancels and reads pass", async () => {
		for (const path of ["/coding/act", "/coding/capture", "/coding/end", "/local-apply/directive", "/local-apply/cancel"]) {
			expect(await hold({ path, body: { sessionId: "s-live" } }), path).toBeNull();
		}
		expect(await hold({ method: "GET", path: "/coding/start" })).toBeNull();
	});

	it("a start for a session that is already alive re-attaches it and is not new work", async () => {
		const reason = await hold({ path: "/coding/start", body: { sessionId: "s-live" }, liveSessions: async () => new Set(["s-live", "s-other"]) });
		expect(reason).toBeNull();
		// …while a different, genuinely new session is still held in the same moment.
		expect(await hold({ path: "/coding/start", body: { sessionId: "s-new" }, liveSessions: async () => new Set(["s-live"]) })).toMatch(/update is waiting/);
	});

	it("fails toward holding when the session look cannot be read or throws — a refusal is retryable, an admission prolongs the wait", async () => {
		expect(await hold({ path: "/coding/start", body: { sessionId: "s" }, liveSessions: async () => null })).toMatch(/update is waiting/);
		expect(await hold({ path: "/coding/start", body: { sessionId: "s" }, liveSessions: async () => { throw new Error("boom"); } })).toMatch(/update is waiting/);
	});

	it("does not consult the session list for anything but a coding start", async () => {
		const liveSessions = vi.fn(none);
		await hold({ path: "/local-apply/run", liveSessions });
		await hold({ path: "/coding/act", liveSessions });
		expect(liveSessions).not.toHaveBeenCalled();
	});
});

describe("holdForPendingUpdate: the hold is bounded by the lease, never indefinite", () => {
	it("admits everything when no update is waiting", async () => {
		expect(await hold({ lease: null, path: "/coding/start", body: { sessionId: "s" } })).toBeNull();
	});

	it("lifts by itself the moment the lease lapses, and at the lease's own expiry instant", async () => {
		const req = { path: "/coding/start", body: { sessionId: "s" } };
		expect(await hold({ ...req, now: lease.expiresAt - 1 })).toMatch(/update is waiting/);
		expect(await hold({ ...req, now: lease.expiresAt })).toBeNull();
		expect(await hold({ ...req, now: lease.expiresAt + 10 * 60_000 })).toBeNull();
	});

	it("can never hold new work longer than the longest lease the control plane may grant", async () => {
		const longest = { operationId: "op-max", expiresAt: NOW + MAX_DEFERRED_UPDATE_LEASE_MS };
		const reason = await hold({ lease: longest, path: "/local-apply/run" });
		expect(reason).toMatch(new RegExp(`${MAX_DEFERRED_UPDATE_LEASE_MS / 1000}s`));
		expect(await hold({ lease: longest, path: "/local-apply/run", now: NOW + MAX_DEFERRED_UPDATE_LEASE_MS })).toBeNull();
	});

	it("reports at least one second remaining, never 0s", async () => {
		expect(await hold({ path: "/coding/start", body: { sessionId: "s" }, now: lease.expiresAt - 1 })).toMatch(/for up to 1s/);
	});
});

describe("the relay applies the hold (wiring guard)", () => {
	const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

	it("the socket asks the hold before the drain gate and answers a retryable 503 that says an update is pending", () => {
		const src = read("./relay-socket.ts");
		expect(src.indexOf("newWorkHold(method")).toBeGreaterThan(-1);
		expect(src.indexOf("newWorkHold(method")).toBeLessThan(src.indexOf("beginMutation()"));
		expect(src).toMatch(/status: 503, result: \{ error: held, updatePending: true \}/);
	});

	it("the relay hands it the live deferred lease, so the hold ends when the update does", () => {
		const src = read("./relay.ts");
		expect(src).toMatch(/holdForPendingUpdate\(\{ lease: deferredManualLease/);
	});
});
