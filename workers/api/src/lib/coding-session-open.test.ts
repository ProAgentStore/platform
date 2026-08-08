import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingRepo, CodingSessionRecord } from "./coding-types.js";
import type { Env } from "../types.js";

// The orchestration in `coding-session-open.ts` is the part #271 left untested, and `opened` is the
// field that decides who may close a session later (`shouldEndSessionAfterRun`). Get it wrong in
// one direction and every delegated run leaks a session; get it wrong in the other and a background
// job closes a session a human opened — which is #271 again, from the other side. The lost-race
// branch is exactly the kind of path that regresses silently, so it is pinned here.
vi.mock("./coding-store.js", () => ({
	createSession: vi.fn(),
	endSession: vi.fn(async () => true),
	getActiveSessionForRepo: vi.fn(),
	getRepo: vi.fn(),
	reassignSessionNode: vi.fn(async () => undefined),
	updateRepoClone: vi.fn(async () => undefined),
}));
vi.mock("./runner-client.js", () => ({
	callRunner: vi.fn(async () => ({ ok: true })),
	getBoundRunnerConn: vi.fn(),
	getRunnerConn: vi.fn(),
	relayConnected: vi.fn(async () => true),
}));
vi.mock("./coding-engines.js", () => ({
	resolveEngine: vi.fn(async () => ({ command: "claude", clientType: "claude" })),
	resolveEngineEnv: vi.fn(async () => ({})),
}));
vi.mock("./github-app.js", () => ({ installationTokenForOwner: vi.fn(async () => null) }));
vi.mock("./runtime-nodes.js", () => ({ normalizeRunnerNode: (v: unknown) => (typeof v === "string" ? v.trim() : "") }));
vi.mock("./instance-connectivity.js", () => ({ runtimeConnectivity: vi.fn() }));
vi.mock("./coding-session-sweeper.js", () => ({
	IDLE_SESSION_MS: 6 * 60 * 60_000,
	lastIdleReapForRepo: vi.fn(async () => null),
}));

const store = await import("./coding-store.js");
const runner = await import("./runner-client.js");
const connectivity = await import("./instance-connectivity.js");
const sweeper = await import("./coding-session-sweeper.js");
const { ensureActiveSession, ensureSessionForChat, sessionOpenedNotice } = await import("./coding-session-open.js");

const env = {} as Env;
const repo: CodingRepo = {
	id: "repo_1",
	instanceId: "inst",
	userId: "u",
	name: "fws/platform",
	branch: "",
	cloneStatus: "ready",
	defaultClient: "claude",
	workdir: "/Users/x/dev/fws",
	createdAt: "",
	updatedAt: "",
};
const session = (id: string): CodingSessionRecord => ({
	id,
	instanceId: "inst",
	repoId: "repo_1",
	userId: "u",
	clientType: "claude",
	status: "active",
	runnerNode: "mac",
	startedAt: "",
	updatedAt: "",
});
const conn = { endpointUrl: "https://r", token: "t", instanceId: "inst", userId: "u", env, runnerNode: "mac", relayName: "inst" };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(runner.getRunnerConn).mockResolvedValue(conn as never);
	vi.mocked(runner.getBoundRunnerConn).mockResolvedValue(conn as never);
	vi.mocked(runner.relayConnected).mockResolvedValue(true);
	vi.mocked(runner.callRunner).mockResolvedValue({ ok: true } as never);
	vi.mocked(store.endSession).mockResolvedValue(true);
	vi.mocked(connectivity.runtimeConnectivity).mockResolvedValue({
		hasRuntimeRow: true,
		relayConnected: true,
		node: "mac",
		runnerVersion: "0.4.35",
		lastSeenAt: null,
	});
	vi.mocked(sweeper.lastIdleReapForRepo).mockResolvedValue(null);
});

describe("ensureActiveSession — who owns the session (#271, #275)", () => {
	it("reports opened:false for a session it merely REUSED", async () => {
		// The whole point of #271. A run that inherits a human's session must not report `opened`,
		// or it takes the right to close it and the user watches their terminal disappear.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(session("csess_human"));
		const res = await ensureActiveSession(env, "inst", "u", repo);
		expect(res).toMatchObject({ ok: true, opened: false });
		expect(store.createSession).not.toHaveBeenCalled();
	});

	it("re-attaches a reused session to the runner before handing it over", async () => {
		// A session can be `active` in D1 while its engine process is gone (runner restarted,
		// laptop slept). Without the re-attach the reused path quietly drives a dead pane, which
		// looks exactly like a hung agent.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(session("csess_stale"));
		await ensureActiveSession(env, "inst", "u", repo);
		expect(vi.mocked(runner.callRunner).mock.calls[0][1]).toBe("/coding/start");
	});

	it("reports opened:true only for a session it created and started", async () => {
		// The other direction: a session the run opened IS the run's to clean up, and if this
		// reported false nothing would ever close it — the leak #275 is about.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_new"));
		const res = await ensureActiveSession(env, "inst", "u", repo);
		expect(res).toMatchObject({ ok: true, opened: true });
		expect(res.ok && res.session.id).toBe("csess_new");
	});

	it("reports opened:false for the winner when it LOSES the one-active-session-per-repo race", async () => {
		// Two delegated goals landing together: the loser's insert violates the unique index, and
		// the session it then uses was opened by somebody else. Claiming ownership here would let
		// the loser close the winner's session out from under a live run.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValueOnce(null).mockResolvedValueOnce(session("csess_winner"));
		vi.mocked(store.createSession).mockRejectedValue(new Error("UNIQUE constraint failed"));
		const res = await ensureActiveSession(env, "inst", "u", repo);
		expect(res).toMatchObject({ ok: true, opened: false });
		expect(res.ok && res.session.id).toBe("csess_winner");
	});

	it("fails cleanly when it loses the race and the winner has already gone", async () => {
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockRejectedValue(new Error("UNIQUE constraint failed"));
		const res = await ensureActiveSession(env, "inst", "u", repo);
		expect(res).toMatchObject({ ok: false });
	});

	it("closes the session it created when the engine never launched, and reports WHY", async () => {
		// A session row whose engine never started is worse than none: `getActiveSessionForRepo`
		// would hand it to every later attempt, so the repo stays permanently blocked behind a
		// session that cannot do anything — and the caller would blame the runner.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_dead"));
		vi.mocked(runner.callRunner).mockRejectedValue(new Error("fatal: repository not found"));
		vi.mocked(store.getRepo).mockResolvedValue({ ...repo, cloneError: "fatal: repository not found" });
		const res = await ensureActiveSession(env, "inst", "u", repo);
		expect(res).toMatchObject({ ok: false, startError: "fatal: repository not found" });
		expect(store.endSession).toHaveBeenCalledWith(env, "inst", "u", "csess_dead", "error");
	});

	it("does not report ok:true for a REUSED session whose engine could not be re-attached (#325)", async () => {
		// The re-attach exists so the reused path isn't "quietly driving a dead pane" — but its
		// answer was discarded twice over (the throw caught, the null return unread) and `ok: true`
		// returned regardless, which is that same outcome. `loop-drivers` reads ok:true as a live
		// engine: it claims the driver, opens the run row and bills the Pilot's reasoning turns
		// against a pane that never launched.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(session("csess_dead"));
		vi.mocked(runner.callRunner).mockRejectedValue(new Error("fatal: repository not found"));
		vi.mocked(store.getRepo).mockResolvedValue({ ...repo, cloneError: "fatal: repository not found" });
		expect(await ensureActiveSession(env, "inst", "u", repo)).toMatchObject({ ok: false, startError: "fatal: repository not found" });
	});

	it("does not report ok:true for the RACE WINNER when its engine could not be re-attached (#325)", async () => {
		// Same discarded answer, second copy. A loser that reports a live engine is worse here:
		// the winner's own run is already driving that pane.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValueOnce(null).mockResolvedValueOnce(session("csess_winner"));
		vi.mocked(store.createSession).mockRejectedValue(new Error("UNIQUE constraint failed"));
		vi.mocked(runner.callRunner).mockRejectedValue(new Error("no runner"));
		vi.mocked(store.getRepo).mockResolvedValue({ ...repo, cloneError: null });
		expect(await ensureActiveSession(env, "inst", "u", repo)).toMatchObject({ ok: false });
	});

	it("relocates a reused session to the machine that is live now", async () => {
		// Machine-switch reclaim. `getRunnerConn` resolves from D1 even for a laptop that closed
		// its lid (the `status` column is never cleared), so without the live check a delegated run
		// dead-ends on the offline node while the user's other machine sits connected.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(session("csess_moved"));
		vi.mocked(runner.relayConnected).mockResolvedValue(false);
		vi.mocked(runner.getBoundRunnerConn).mockResolvedValue({ ...conn, runnerNode: "laptop" } as never);
		await ensureActiveSession(env, "inst", "u", repo);
		expect(store.reassignSessionNode).toHaveBeenCalledWith(env, "inst", "u", "csess_moved", "laptop");
	});
});

describe("ensureSessionForChat — the chat surface may open one too (#407)", () => {
	const offline = { hasRuntimeRow: true, relayConnected: false, node: "mac", runnerVersion: "0.4.35", lastSeenAt: null };

	it("creates NO session row when the runner is offline, and gives the runner diagnosis", async () => {
		// The criterion most likely to be skipped, and the reason the connectivity check sits ahead
		// of `ensureActiveSession` rather than inside it: `ensureActiveSession` INSERTS the row
		// first and only then discovers there is nothing to launch on. Harmless for a Loop that
		// 409s either way; not harmless for a read tool a user may call over and over on a train,
		// each call writing and ending a row. The refusal also has to blame the runner — the whole
		// point of #271's wording work is that a diagnosis names the ACTUAL blocker.
		vi.mocked(connectivity.runtimeConnectivity).mockResolvedValue(offline);
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		const res = await ensureSessionForChat(env, "inst", "u", repo);
		expect(res.ok).toBe(false);
		expect(store.createSession).not.toHaveBeenCalled();
		expect(runner.callRunner).not.toHaveBeenCalled();
		expect(!res.ok && res.message).toMatch(/pags up/);
		expect(!res.ok && res.message).toContain("fws/platform");
	});

	it("hands back the existing session even when it refuses, so a caller can degrade", async () => {
		// `read_terminal` answers an offline runner with the last saved snapshot, which needs the
		// session id. Returning a bare failure turns a partial answer into no answer.
		vi.mocked(connectivity.runtimeConnectivity).mockResolvedValue(offline);
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(session("csess_known"));
		const res = await ensureSessionForChat(env, "inst", "u", repo);
		expect(res.ok).toBe(false);
		expect(!res.ok && res.session?.id).toBe("csess_known");
	});

	it("opens one when the runner is live and there is none, and NAMES it", async () => {
		// A coding session is a child process on somebody's laptop. The chat already spawns one
		// via `start_work` without asking; what it never did was say so.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_new"));
		const res = await ensureSessionForChat(env, "inst", "u", repo);
		expect(res).toMatchObject({ ok: true, opened: true });
		expect(res.ok && res.notice).toContain("csess_new");
		expect(res.ok && res.notice).toContain("fws/platform");
		expect(res.ok && res.notice).toContain("mac");
	});

	it("says nothing when it merely reused a session somebody else opened", async () => {
		// The notice is news. Announcing a session on every read_terminal would train the model to
		// tell the user their engine restarted when nothing happened.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(session("csess_live"));
		const res = await ensureSessionForChat(env, "inst", "u", repo);
		expect(res).toMatchObject({ ok: true, opened: false });
		expect(res.ok && res.notice).toBeNull();
		expect(sweeper.lastIdleReapForRepo).not.toHaveBeenCalled();
	});

	it("explains the six-hour reap when that is why there was no session", async () => {
		// The sweeper writes this to the coding timeline, which lives in the Co-pilot view — the
		// one place a chat user never looks. From chat the session simply stopped existing and the
		// next question failed for a reason nothing stated.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_new"));
		vi.mocked(sweeper.lastIdleReapForRepo).mockResolvedValue({ sessionId: "csess_old", endedAt: "2026-08-08 01:00:00" });
		const res = await ensureSessionForChat(env, "inst", "u", repo);
		expect(res.ok && res.notice).toMatch(/closed automatically after 6 hours/);
	});

	it("blames the start failure, not the runner, when the runner is up", async () => {
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_dead"));
		vi.mocked(runner.callRunner).mockRejectedValue(new Error("fatal: repository not found"));
		vi.mocked(store.getRepo).mockResolvedValue({ ...repo, cloneError: "fatal: repository not found" });
		const res = await ensureSessionForChat(env, "inst", "u", repo);
		expect(res.ok).toBe(false);
		expect(!res.ok && res.message).toMatch(/not a `pags up` problem/);
		expect(!res.ok && res.message).toContain("fatal: repository not found");
	});
});

describe("sessionOpenedNotice", () => {
	it("tells the model to relay it — the string is the only lever this module has", () => {
		// The prompt builder is a different file. If the tool result does not ask for the sentence,
		// nothing else will, and the process appears on the user's laptop in silence.
		const n = sessionOpenedNotice({ repoName: "chess-academy", sessionId: "csess_1", engine: "claude", node: "mac" });
		expect(n).toMatch(/Say in your reply/);
		expect(n).toContain("chess-academy");
		expect(n).toContain("csess_1");
		expect(n).not.toMatch(/closed automatically/);
	});
});
