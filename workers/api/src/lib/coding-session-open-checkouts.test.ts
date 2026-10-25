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
