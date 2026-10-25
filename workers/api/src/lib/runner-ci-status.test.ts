/**
 * #1213 — CI runner health, routing mode and the stuck-queued-job watcher in machine status.
 * Pure rules over facts the caller fetched; the live read of GitHub is covered in actions-runner-provision.test.ts.
 */
import { describe, expect, it } from "vitest";
import { ciRunnerHealth, DEFAULT_STUCK_QUEUE_MINUTES, routingModeView, stuckQueuedJobs, type QueuedJob } from "./runner-ci-status.js";

const NODE = "Sergeys-Mac-mini.local";
const LABEL = "pags-sergeys-mac-mini-local";
const online = (...n: string[]) => new Set(n);

describe("runner health", () => {
	const facts = (over: Partial<{ status: string; busy: boolean; labels: string[] }> = {}) => ({ id: 7, status: "online", busy: false, labels: ["self-hosted", "macOS", "ARM64", "pags", LABEL], ...over });

	it("an online, idle, pin-scoped runner is routable", () => {
		const h = ciRunnerHealth(facts(), NODE);
		expect(h).toMatchObject({ registered: true, online: true, busy: false, pinScoped: true, routable: true });
		expect(h.summary).toMatch(/online and idle/);
	});

	it("busy is reported, and a busy runner is still routable (jobs queue behind it)", () => {
		const h = ciRunnerHealth(facts({ busy: true }), NODE);
		expect(h).toMatchObject({ busy: true, routable: true });
		expect(h.summary).toMatch(/running a job/);
	});

	it("offline: not routable, and says so", () => {
		const h = ciRunnerHealth(facts({ status: "offline" }), NODE);
		expect(h).toMatchObject({ online: false, routable: false });
		expect(h.summary).toMatch(/offline/);
	});

	it("an unavailable runner (#1272) is online but never routable", () => {
		const h = ciRunnerHealth(facts({ labels: ["self-hosted", "pags-unavailable"] }), NODE);
		expect(h).toMatchObject({ online: true, routable: false });
		expect(h.summary).toMatch(/unavailable/);
	});

	it("a runner that does not carry exactly its own label is not routable — the mutual-exclusion rule", () => {
		expect(ciRunnerHealth(facts({ labels: ["self-hosted", "pags"] }), NODE)).toMatchObject({ pinScoped: false, routable: false });
		expect(ciRunnerHealth(facts({ labels: ["self-hosted", "pags", "pags-other-machine"] }), NODE)).toMatchObject({ pinScoped: false, routable: false });
	});

	it("no runner registered: its jobs run on GitHub-hosted", () => {
		const h = ciRunnerHealth(null, NODE);
		expect(h).toMatchObject({ registered: false, online: false, routable: false });
		expect(h.summary).toMatch(/GitHub-hosted/);
	});
});

describe("routing mode", () => {
	const base = { repo: "proappstore-online/interns", visibility: "private", pinnedNode: NODE, onlineNodes: online(NODE) };

	it("GitHub-hosted by default, with the minutes it knows", () => {
		const v = routingModeView({ ...base, minutes: { usedPercent: 40, exhausted: false } });
		expect(v).toMatchObject({ mode: "github-hosted", reason: "default", usedPercent: 40, minutesExhausted: false, alert: null });
	});

	it("unknown minutes are null, never 'fine'", () => {
		expect(routingModeView(base)).toMatchObject({ usedPercent: null, minutesExhausted: null });
	});

	it("exhausted minutes: the pinned machine's exact label set", () => {
		const v = routingModeView({ ...base, minutes: { exhausted: true } });
		expect(v).toMatchObject({ mode: "self-hosted", reason: "minutes_exhausted", labels: ["self-hosted", LABEL], alert: null });
		expect(v.summary).toContain("used up");
	});

	it("low minutes route at the threshold and say how much is used", () => {
		const v = routingModeView({ ...base, minutes: { usedPercent: 93 } });
		expect(v).toMatchObject({ mode: "self-hosted", reason: "minutes_low" });
		expect(v.summary).toContain("93%");
	});

	it("a public repo or an unpinned one is never self-hosted", () => {
		expect(routingModeView({ ...base, visibility: "public", minutes: { exhausted: true } })).toMatchObject({ mode: "github-hosted", reason: "not_private" });
		expect(routingModeView({ ...base, pinnedNode: null, minutes: { exhausted: true } })).toMatchObject({ mode: "github-hosted", reason: "not_pinned" });
	});

	it("pinned machine offline: GitHub-hosted while minutes remain, with an alert", () => {
		const v = routingModeView({ ...base, onlineNodes: online(), minutes: { usedPercent: 95, exhausted: false } });
		expect(v.mode).toBe("github-hosted");
		expect(v.alert).toMatch(/offline.*GitHub-hosted/);
	});

	it("pinned machine offline and no minutes: stays self-hosted and alerts the owner — never silent", () => {
		const v = routingModeView({ ...base, onlineNodes: online(), minutes: { exhausted: true } });
		expect(v.mode).toBe("self-hosted");
		expect(v.alert).toMatch(/waiting for .* offline.*exhausted/);
	});
});

describe("the stuck-queued-job watcher", () => {
	const now = new Date("2026-10-26T12:00:00Z");
	const ago = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
	const job = (over: Partial<QueuedJob> = {}): QueuedJob => ({ repo: "proappstore-online/interns", runId: 1, labels: ["self-hosted", LABEL], queuedAt: ago(30), ...over });
	const ctx = { now, nodeByLabel: { [LABEL]: NODE }, minutesRemain: (_repo: string): boolean | null => true };

	it("a job younger than the threshold is not stuck; the default is 15 minutes", () => {
		expect(DEFAULT_STUCK_QUEUE_MINUTES).toBe(15);
		expect(stuckQueuedJobs({ ...ctx, jobs: [job({ queuedAt: ago(14) })], onlineNodes: online() })).toEqual([]);
		expect(stuckQueuedJobs({ ...ctx, jobs: [job({ queuedAt: ago(15) })], onlineNodes: online() })).toHaveLength(1);
	});

	it("queued for an OFFLINE machine with minutes left: re-routed to GitHub-hosted", () => {
		const [v] = stuckQueuedJobs({ ...ctx, jobs: [job()], onlineNodes: online() });
		expect(v).toMatchObject({ kind: "reroute", ageMinutes: 30 });
		expect(v.reason).toMatch(/offline.*re-dispatched/);
	});

	it("queued for an offline machine with no minutes (or unknown): alerts the owner", () => {
		for (const remain of [false, null]) {
			const [v] = stuckQueuedJobs({ ...ctx, minutesRemain: () => remain, jobs: [job()], onlineNodes: online() });
			expect(v.kind).toBe("alert");
			expect(v.reason).toMatch(/pags up/);
		}
	});

	it("queued for an ONLINE machine: alert, not a re-route — it is busy, and moving it would run it twice", () => {
		const [v] = stuckQueuedJobs({ ...ctx, jobs: [job()], onlineNodes: online(NODE) });
		expect(v.kind).toBe("alert");
		expect(v.reason).toMatch(/online.*busy/);
	});

	it("queued on GitHub-hosted: alert pointing at the minutes and spending limit", () => {
		const [v] = stuckQueuedJobs({ ...ctx, jobs: [job({ labels: ["ubuntu-latest"] })], onlineNodes: online(NODE) });
		expect(v.kind).toBe("alert");
		expect(v.reason).toMatch(/Actions minutes/);
	});

	it("a generic-label job is never treated as pinned to a machine", () => {
		const [v] = stuckQueuedJobs({ ...ctx, jobs: [job({ labels: ["self-hosted", "pags"] })], onlineNodes: online() });
		expect(v.kind).toBe("alert");
	});

	it("an unreadable queue time is not judged; several jobs each get their own verdict", () => {
		const out = stuckQueuedJobs({ ...ctx, jobs: [job({ queuedAt: "not a date" }), job({ runId: 2 }), job({ runId: 3, queuedAt: ago(60) })], onlineNodes: online() });
		expect(out.map((v) => v.job.runId)).toEqual([2, 3]);
	});

	it("a custom threshold applies", () => {
		expect(stuckQueuedJobs({ ...ctx, thresholdMinutes: 45, jobs: [job({ queuedAt: ago(30) })], onlineNodes: online() })).toEqual([]);
	});
});
