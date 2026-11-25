import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingRepo, CodingSessionRecord } from "./coding-types.js";
import type { Env } from "../types.js";

// #1142: a session runs in the checkout on the machine it starts on, not in "the" workdir of the binding.
vi.mock("./coding-store.js", () => ({
	createSession: vi.fn(),
	endSession: vi.fn(async () => true),
	getActiveSessionForRepo: vi.fn(),
	getLastFinishedSessionForRepo: vi.fn(async () => null),
	getRepo: vi.fn(),
	reassignSessionNode: vi.fn(async () => undefined),
	updateRepoClone: vi.fn(async () => undefined),
}));
vi.mock("./runner-client.js", () => ({
	READ_TIMEOUT_MS: 15_000,
	callRunner: vi.fn(async () => ({ ok: true })),
	getBoundRunnerConn: vi.fn(),
	getRunnerConnIgnoringLiveness: vi.fn(),
	relayConnected: vi.fn(async () => true),
}));
vi.mock("./coding-engines.js", () => ({ resolveEngine: vi.fn(), resolveEngineEnv: vi.fn(async () => ({})) }));
vi.mock("./github-app.js", () => ({ installationTokenForOwner: vi.fn(async () => null), repoScopedInstallationToken: vi.fn(async () => null) }));
vi.mock("./runtime-nodes.js", () => ({ normalizeRunnerNode: (v: unknown) => (typeof v === "string" ? v.trim() : "") }));
vi.mock("./instance-connectivity.js", () => ({ runtimeConnectivity: vi.fn() }));
vi.mock("./coding-session-sweeper.js", () => ({ IDLE_SESSION_MS: 1, lastIdleReapForRepo: vi.fn(async () => null) }));
vi.mock("./coding-timeline.js", () => ({ loadRepoTimeline: vi.fn(async () => []), appendTimeline: vi.fn(async () => undefined) }));
vi.mock("./coding-workdir.js", () => ({
	checkWorkdirVia: vi.fn(),
	cloneStatusForVerdict: (v: { state: string }) => (v.state === "ok" ? "ready" : v.state === "unverified" ? null : "needs_attention"),
}));
vi.mock("./coding-repo-checkouts.js", () => ({
	machineIdForNode: vi.fn(),
	getCheckout: vi.fn(),
	upsertCheckout: vi.fn(async () => true),
	effectiveWorkdir: (c: { workdir?: string | null } | null, w?: string) => c?.workdir?.trim() || w,
}));

const store = await import("./coding-store.js");
const runner = await import("./runner-client.js");
const wd = await import("./coding-workdir.js");
const checkouts = await import("./coding-repo-checkouts.js");
const { startSessionOnRunner } = await import("./coding-session-open.js");

const env = {} as Env;
const repo: CodingRepo = { id: "r1", instanceId: "i1", userId: "u1", name: "acme/app", githubRepo: "acme/app", branch: "", cloneStatus: "ready", workdir: "~/dev/app", provider: "github", createdAt: "", updatedAt: "" };
const session: CodingSessionRecord = { id: "s1", instanceId: "i1", repoId: "r1", userId: "u1", clientType: "claude", status: "active", runnerNode: "studio", startedAt: "", updatedAt: "" };
const conn = { endpointUrl: "https://r", token: "t", instanceId: "i1", userId: "u1", env, runnerNode: "studio", relayName: "i1" };
const startBody = () => vi.mocked(runner.callRunner).mock.calls.find((c) => c[1] === "/coding/start")?.[2] as { workDir?: string };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(runner.getRunnerConnIgnoringLiveness).mockResolvedValue(conn as never);
	vi.mocked(runner.relayConnected).mockResolvedValue(true);
	vi.mocked(runner.callRunner).mockResolvedValue({ ok: true } as never);
	vi.mocked(checkouts.machineIdForNode).mockResolvedValue("m-stu");
	vi.mocked(wd.checkWorkdirVia).mockImplementation((async (_c: unknown, path: string) => ({ state: "ok", path, detail: "" })) as never);
});

describe("startSessionOnRunner uses the checkout of the machine it runs on (#1142)", () => {
	it("runs in that machine's own folder when its checkout has one, and records the verdict on that checkout", async () => {
		vi.mocked(checkouts.getCheckout).mockResolvedValue({ workdir: "~/code/app", cloneStatus: "unknown" } as never);
		await startSessionOnRunner(env, "i1", "u1", { ...session }, repo);
		expect(startBody().workDir).toBe("~/code/app");
		expect(vi.mocked(wd.checkWorkdirVia).mock.calls[0][1]).toBe("~/code/app");
		expect(checkouts.upsertCheckout).toHaveBeenCalledWith(env, "i1", "u1", "r1", "m-stu", { cloneStatus: "ready", cloneError: null, verified: true });
		// The binding keeps the latest verdict from any machine, for the readers that only know it.
		expect(store.updateRepoClone).toHaveBeenCalledWith(env, "r1", expect.objectContaining({ cloneStatus: "ready", checkedNow: true }));
	});

	it("falls back to the binding's folder, and creates the missing checkout row before starting", async () => {
		vi.mocked(checkouts.getCheckout).mockResolvedValue(null);
		await startSessionOnRunner(env, "i1", "u1", { ...session }, repo);
		expect(startBody().workDir).toBe("~/dev/app");
		const calls = vi.mocked(checkouts.upsertCheckout).mock.calls.map((c) => c[5]);
		expect(calls).toEqual([{ cloneStatus: "unknown" }, { cloneStatus: "ready", cloneError: null, verified: true }]);
		// Created BEFORE the start: the first upsert precedes the runner call.
		expect(vi.mocked(checkouts.upsertCheckout).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runner.callRunner).mock.invocationCallOrder.at(-1) as number);
	});

	it("records a failed start on this machine's checkout only, not an unreachable runner", async () => {
		vi.mocked(checkouts.getCheckout).mockResolvedValue({ workdir: null, cloneStatus: "ready" } as never);
		vi.mocked(runner.callRunner).mockRejectedValueOnce(new Error("git clone failed: auth"));
		const res = await startSessionOnRunner(env, "i1", "u1", { ...session }, repo);
		expect(res.startError).toContain("auth");
		expect(checkouts.upsertCheckout).toHaveBeenLastCalledWith(env, "i1", "u1", "r1", "m-stu", { cloneStatus: "error", cloneError: "git clone failed: auth" });
	});

	it("starts normally on a machine whose id is unknown, writing no checkout", async () => {
		vi.mocked(checkouts.machineIdForNode).mockResolvedValue(null);
		await startSessionOnRunner(env, "i1", "u1", { ...session }, repo);
		expect(startBody().workDir).toBe("~/dev/app");
		expect(checkouts.upsertCheckout).not.toHaveBeenCalled();
		expect(checkouts.getCheckout).not.toHaveBeenCalled();
	});
});

describe("startSessionOnRunner and the repository's checkout strategy (#1714)", () => {
	const paths = () => vi.mocked(runner.callRunner).mock.calls.map((c) => c[1]);
	const withStrategy = (strategy: CodingRepo["strategy"]): CodingRepo => ({ ...repo, strategy });
	beforeEach(() => vi.mocked(checkouts.getCheckout).mockResolvedValue(null));

	it("a repository with no stored strategy is never asked about, on a fresh open or any other", async () => {
		await startSessionOnRunner(env, "i1", "u1", { ...session }, repo, { freshOpen: true });
		expect(paths()).not.toContain("/coding/admit-checkout");
		expect(paths()).toContain("/coding/start");
	});

	it("an explicit shared-direct repository is refused on a fresh open when its checkout is dirty, naming the paths, and nothing is started", async () => {
		vi.mocked(runner.callRunner).mockImplementation((async (_c: unknown, path: string) => (path === "/coding/admit-checkout" ? { ok: false, blocking: ["a.ts"], blockingCount: 1 } : { ok: true })) as never);
		const res = await startSessionOnRunner(env, "i1", "u1", { ...session }, withStrategy("shared-direct"), { freshOpen: true });
		expect(res.conn).toBeNull();
		expect(res.startError).toContain("`a.ts`");
		expect(paths()).not.toContain("/coding/start");
	});

	it("...but a re-attach (not a fresh open) is never admission-checked: it holds its own edits", async () => {
		await startSessionOnRunner(env, "i1", "u1", { ...session }, withStrategy("shared-direct"));
		expect(paths()).not.toContain("/coding/admit-checkout");
		expect(paths()).toContain("/coding/start");
	});

	it("shell-edit tracking is asked of the runner for an explicit shared-direct repository only (#1717)", async () => {
		const sent = () => (vi.mocked(runner.callRunner).mock.calls.find((c) => c[1] === "/coding/start")?.[2] as { trackShellEdits?: boolean }).trackShellEdits;
		await startSessionOnRunner(env, "i1", "u1", { ...session }, withStrategy("shared-direct"));
		expect(sent()).toBe(true);
		vi.mocked(runner.callRunner).mockClear();
		await startSessionOnRunner(env, "i1", "u1", { ...session }, repo);
		expect(sent()).toBeUndefined();
		vi.mocked(runner.callRunner).mockClear();
		await startSessionOnRunner(env, "i1", "u1", { ...session }, withStrategy("isolated-direct"));
		expect(sent()).toBeUndefined();
	});

	it("an isolated repository whose runner did not report a worktree is refused and its engine stopped, not silently run shared", async () => {
		const res = await startSessionOnRunner(env, "i1", "u1", { ...session }, withStrategy("isolated-pr"), { freshOpen: true });
		expect(res.conn).toBeNull();
		expect(res.startError).toMatch(/did not report an isolated worktree/);
		expect(paths()).toEqual(expect.arrayContaining(["/coding/start", "/coding/end"]));
	});

	it("an isolated repository whose runner reported its worktree starts normally", async () => {
		vi.mocked(runner.callRunner).mockResolvedValue({ ok: true, checkout: { mode: "worktree", path: "/wt/x" } } as never);
		const res = await startSessionOnRunner(env, "i1", "u1", { ...session }, withStrategy("isolated-direct"), { freshOpen: true });
		expect(res.startError).toBeUndefined();
		expect(res.conn).not.toBeNull();
		expect(paths()).not.toContain("/coding/end");
	});
});
