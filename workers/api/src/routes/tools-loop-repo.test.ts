/**
 * `POST /:id/loop` carries the caller's repo choice to the driver, and queues a busy objective under
 * THAT repo (#877). The driver is faked here: which repo it may pick and when it is busy are pinned
 * against the real driver in `lib/loop-drivers.test.ts` and `lib/loop-repo-scope.integration.test.ts`;
 * this file pins the route's half — what it forwards, and what it hands the queue.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import type { Env } from "../types.js";

const driverStart = vi.fn();
const enqueueObjective = vi.fn();
const backingOffAhead = vi.fn();
const listRepos = vi.fn();
const liveIssueClosedRefusal = vi.fn();

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});
vi.mock("./instances-runtime.js", async () => {
	const actual = await vi.importActual<typeof import("./instances-runtime.js")>("./instances-runtime.js");
	return { ...actual, requireOwnedInstance: async () => undefined };
});
vi.mock("../lib/billing.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/billing.js")>("../lib/billing.js");
	return { ...actual, requirePro: async () => undefined };
});
vi.mock("../lib/agent-capabilities.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/agent-capabilities.js")>("../lib/agent-capabilities.js");
	return { ...actual, capabilitiesForInstance: async () => ({ workflow: "CODING_SESSION" }) };
});
vi.mock("../lib/loop-limits-store.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/loop-limits-store.js")>("../lib/loop-limits-store.js");
	return { ...actual, readLoopLimits: async () => ({}) };
});
vi.mock("../lib/delegation-budget-store.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/delegation-budget-store.js")>("../lib/delegation-budget-store.js");
	return { ...actual, openBudget: async () => ({ id: "bud-1" }), resolveAccountCeilings: async () => ({ loopMaxIterations: 50 }) };
});
vi.mock("../lib/loop-drivers.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/loop-drivers.js")>("../lib/loop-drivers.js");
	return { ...actual, loopDriverFor: () => ({ id: "coding", label: "coding", start: (...a: unknown[]) => driverStart(...a) }) };
});
vi.mock("../lib/objective-queue.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/objective-queue.js")>("../lib/objective-queue.js");
	// `backingOffAhead` (#1388) reads the queue for an earlier entry waiting out a timed backoff; none here, so a start proceeds as it always did.
	return { ...actual, enqueueObjective: (...a: unknown[]) => enqueueObjective(...a), backingOffAhead: (...a: unknown[]) => backingOffAhead(...a) };
});
vi.mock("../lib/coding-store.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/coding-store.js")>("../lib/coding-store.js");
	return { ...actual, listRepos: (...a: unknown[]) => listRepos(...a) };
});
vi.mock("../lib/objective-dedupe.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/objective-dedupe.js")>("../lib/objective-dedupe.js");
	// A real repo (from the mocked `listRepos` above) makes the route read D1 for a duplicate; this
	// file's dummy `{ DB: {} }` env has none to read. No duplicate in any of these tests.
	return { ...actual, findDuplicateObjective: async () => null };
});
vi.mock("../lib/start-idempotency.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/start-idempotency.js")>("../lib/start-idempotency.js");
	// `startIssueFor` stays real (pure); only the LIVE GitHub check (#1404) is faked here — its own
	// correctness is pinned in `lib/start-idempotency.test.ts`. Defaults to "not closed" so every
	// test above this file's #1404 block, none of which sets it, is unaffected.
	return { ...actual, liveIssueClosedRefusal: (...a: unknown[]) => liveIssueClosedRefusal(...a) };
});

const { toolRoutes } = await import("./tools.js");

function app() {
	const router = new Hono<{ Bindings: Env }>();
	router.route("/v1/instances", toolRoutes);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 409) : c.json({ error: String(e) }, 500)));
	return router;
}
const post = (body: unknown) =>
	app().request("/v1/instances/i1/loop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { DB: {} } as unknown as Env);
const startInput = () => driverStart.mock.calls[0][0] as { repoId?: string; requireRepoChoice?: boolean };

beforeEach(() => {
	vi.clearAllMocks();
	driverStart.mockResolvedValue({ ok: true, runId: "run-1", driver: "coding" });
	backingOffAhead.mockResolvedValue(null);
	enqueueObjective.mockImplementation(async (_env: unknown, input: { repoId?: string }) => ({ id: "qe-1", repoId: input.repoId ?? null, status: "pending" }));
	listRepos.mockResolvedValue([]);
	liveIssueClosedRefusal.mockResolvedValue(null);
});

describe("POST /:id/loop — the objective's origin (#1019)", () => {
	it("an objective submitted through the account (console, API, or an MCP client such as coding_loop_start) is ACCOUNT-submitted — never 'the owner wrote it'", async () => {
		expect((await post({ objective: "fix it" })).status).toBe(201);
		expect(driverStart.mock.calls[0][0]).toMatchObject({ objectiveOrigin: { kind: "account", by: "console, API or MCP client" } });
	});

	it("a caller cannot claim an origin: a body `objectiveOrigin` is ignored", async () => {
		expect((await post({ objective: "fix it", objectiveOrigin: { kind: "owner" } })).status).toBe(201);
		expect(driverStart.mock.calls[0][0]).toMatchObject({ objectiveOrigin: { kind: "account" } });
	});
});

describe("POST /:id/loop — a runner that is gone for now is queued, not refused (#1388)", () => {
	const MISSED = "r1 could not start: Runner relay is connected but not responding [runner-unreachable:UNRESPONSIVE@/coding/start]";

	it("queue_if_busy + a start that meets UNRESPONSIVE: queued with its reason and first retry, not answered `refused`", async () => {
		driverStart.mockResolvedValue({ ok: false, status: 409, reason: "runner_unresponsive", error: MISSED });
		const res = await post({ objective: "step one", repoId: "r1", queueIfBusy: true });
		expect(res.status).toBe(202);
		expect(enqueueObjective).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ objective: "step one", deferral: { reason: "runner_unresponsive", note: MISSED } }));
		expect(await res.json()).toMatchObject({ queued: true, blocked: MISSED });
	});

	it("an overloaded machine queues the same way, with its own reason (an entry queued by the route used to carry neither reason nor retry time)", async () => {
		driverStart.mockResolvedValue({ ok: false, status: 409, reason: "runner_overloaded", error: "tiny-laptop is overloaded" });
		expect((await post({ objective: "step one", queueIfBusy: true })).status).toBe(202);
		expect(enqueueObjective).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deferral: { reason: "runner_overloaded", note: "tiny-laptop is overloaded" } }));
	});

	it("without queue_if_busy the refusal names its reason instead of the opaque `refused`, so the caller can tell a stall from a structural no", async () => {
		driverStart.mockResolvedValue({ ok: false, status: 409, reason: "runner_unresponsive", error: MISSED });
		const res = await post({ objective: "step one" });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ reason: "runner_unresponsive", startState: "not_started" });
		expect(enqueueObjective).not.toHaveBeenCalled();
	});

	it("an earlier objective is waiting out a backoff: a queue_if_busy start queues BEHIND it and the driver is never asked (step one → step two stay in order)", async () => {
		backingOffAhead.mockResolvedValue({ id: "objq-507", deferReason: "runner_unresponsive", nextRetryAt: Date.now() + 90_000 });
		const res = await post({ objective: "step two", repoId: "r1", queueIfBusy: true });
		expect(res.status).toBe(202);
		expect(driverStart).not.toHaveBeenCalled();
		expect(enqueueObjective).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ objective: "step two", repoId: "r1" }));
		const body = (await res.json()) as { queued: boolean; blocked: string };
		expect(body.queued).toBe(true);
		expect(body.blocked).toMatch(/earlier queued objective is waiting to retry \(runner_unresponsive, in 2 min\).*queued behind it/);
		expect(backingOffAhead).toHaveBeenCalledWith(expect.anything(), "i1", "r1");
	});

	it("…but only for a start that ASKED to queue: a plain start is the caller's explicit choice and goes to the driver as before", async () => {
		backingOffAhead.mockResolvedValue({ id: "objq-507", deferReason: "runner_unresponsive", nextRetryAt: Date.now() + 90_000 });
		expect((await post({ objective: "step two", repoId: "r1" })).status).toBe(201);
		expect(driverStart).toHaveBeenCalledTimes(1);
		expect(backingOffAhead).not.toHaveBeenCalled();
	});

	it("…and a start that asks to go FIRST (queuePosition: next) is not held behind it", async () => {
		backingOffAhead.mockResolvedValue({ id: "objq-507", deferReason: "runner_unresponsive", nextRetryAt: Date.now() + 90_000 });
		expect((await post({ objective: "step two", repoId: "r1", queueIfBusy: true, queuePosition: "next" })).status).toBe(201);
		expect(driverStart).toHaveBeenCalledTimes(1);
	});

	it("nothing backing off: a queue_if_busy start goes to the driver exactly as before", async () => {
		expect((await post({ objective: "step two", repoId: "r1", queueIfBusy: true })).status).toBe(201);
		expect(driverStart).toHaveBeenCalledTimes(1);
	});
});

describe("POST /:id/loop — repo targeting (#877)", () => {
	it("hands the named repo and coding_loop_start's requireRepoChoice to the driver", async () => {
		const res = await post({ objective: "fix it", repoId: " r2 ", requireRepoChoice: true });
		expect(res.status).toBe(201);
		expect(startInput()).toMatchObject({ repoId: "r2", requireRepoChoice: true });
	});

	it("a caller that names no repo and sends no flag is unchanged: no repo, no requirement", async () => {
		const res = await post({ objective: "fix it" });
		expect(res.status).toBe(201);
		expect(startInput().repoId).toBeUndefined();
		expect(startInput().requireRepoChoice).toBe(false);
	});

	it("a BUSY targeted repo with queue_if_busy is queued under that repo — not as an any-repo entry", async () => {
		driverStart.mockResolvedValue({ ok: false, status: 409, reason: "busy", error: "second/repo is already being worked on" });
		const res = await post({ objective: "next", repoId: "r2", requireRepoChoice: true, queueIfBusy: true });
		expect(res.status).toBe(202);
		expect(enqueueObjective).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ instanceId: "i1", repoId: "r2", objective: "next" }));
		const body = (await res.json()) as { queued: boolean; entry: { repoId: string } };
		expect(body).toMatchObject({ queued: true, entry: { repoId: "r2" } });
	});

	it("a refused repo_id (not on the instance) or a missing choice is NEVER queued — waiting fixes neither", async () => {
		for (const error of ["That repository (r9) is not on this agent", "This agent has 2 repositories, so the run needs a repo_id"]) {
			driverStart.mockResolvedValueOnce({ ok: false, status: 409, error });
			const res = await post({ objective: "x", repoId: "r9", requireRepoChoice: true, queueIfBusy: true });
			expect(res.status).toBe(409);
			expect(((await res.json()) as { error: string }).error).toBe(error);
		}
		expect(enqueueObjective).not.toHaveBeenCalled();
	});
});

/**
 * #1404: queueing is the one decision whose cache being stale costs hours, not nothing — "the repo
 * freed up, admission failed: Issue #1249 is closed on GitHub" with the owner told nothing in
 * between. The route now asks a LIVE check (`liveIssueClosedRefusal`, pinned on its own in
 * `lib/start-idempotency.test.ts`) at both places that are about to queue rather than run, and
 * refuses immediately instead.
 */
describe("POST /:id/loop — a closed linked issue is refused immediately, never queued (#1404)", () => {
	const CLOSED = {
		reason: "issue_closed" as const,
		error: "Issue #9 is closed on GitHub. Pass force: true with force_reason to start it anyway.",
		detail: { issue: 9, repoId: "r1", issue_url: "https://github.com/acme/widget/issues/9" },
	};

	beforeEach(() => {
		listRepos.mockResolvedValue([{ id: "r1", name: "widget", githubRepo: "acme/widget" }]);
	});

	it("a BUSY repo with queue_if_busy and a closed linked issue is refused at once — not queued", async () => {
		driverStart.mockResolvedValue({ ok: false, status: 409, reason: "busy", error: "widget is already being worked on" });
		liveIssueClosedRefusal.mockResolvedValue(CLOSED);
		const res = await post({ objective: "fix #9", repoId: "r1", issue: 9, queueIfBusy: true });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: CLOSED.error, reason: "issue_closed", startState: "not_started", issue: 9, repoId: "r1" });
		expect(enqueueObjective).not.toHaveBeenCalled();
		expect(liveIssueClosedRefusal).toHaveBeenCalledWith(expect.anything(), { userId: "u1", githubRepo: "acme/widget", repoId: "r1", issue: 9 });
	});

	it("queued behind an earlier backing-off entry: the closed check runs before the driver is even asked", async () => {
		backingOffAhead.mockResolvedValue({ id: "objq-1", deferReason: "runner_unresponsive", nextRetryAt: Date.now() + 60_000 });
		liveIssueClosedRefusal.mockResolvedValue(CLOSED);
		const res = await post({ objective: "fix #9", repoId: "r1", issue: 9, queueIfBusy: true });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: CLOSED.error, reason: "issue_closed" });
		expect(driverStart).not.toHaveBeenCalled();
		expect(enqueueObjective).not.toHaveBeenCalled();
	});

	it("an OPEN linked issue queues exactly as before — the live check is not a new way to refuse a working queue", async () => {
		driverStart.mockResolvedValue({ ok: false, status: 409, reason: "busy", error: "widget is already being worked on" });
		liveIssueClosedRefusal.mockResolvedValue(null);
		const res = await post({ objective: "fix #9", repoId: "r1", issue: 9, queueIfBusy: true });
		expect(res.status).toBe(202);
		expect(enqueueObjective).toHaveBeenCalled();
	});

	it("force: true skips the live check entirely — it is the caller's explicit override", async () => {
		driverStart.mockResolvedValue({ ok: false, status: 409, reason: "busy", error: "widget is already being worked on" });
		const res = await post({ objective: "fix #9", repoId: "r1", issue: 9, queueIfBusy: true, force: true });
		expect(res.status).toBe(202);
		expect(liveIssueClosedRefusal).not.toHaveBeenCalled();
	});
});
