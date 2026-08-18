import { beforeEach, describe, expect, it, vi } from "vitest";
// The real class, not a stub: `isRunnerUnreachable` is the classification under test, and mocking
// it here would assert nothing about which errors it actually recognises.
import { RunnerUnreachableError } from "./runner-unreachable.js";
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
	getLastFinishedSessionForRepo: vi.fn(),
	getRepo: vi.fn(),
	reassignSessionNode: vi.fn(async () => undefined),
	updateRepoClone: vi.fn(async () => undefined),
}));
vi.mock("./runner-client.js", () => ({
	callRunner: vi.fn(async () => ({ ok: true })),
	getBoundRunnerConn: vi.fn(),
	// The loader, not the live-checked resolve (#532): `startSessionOnRunner` reasons about a
	// stamped node that may be dead, and probes the relay itself.
	getRunnerConnIgnoringLiveness: vi.fn(),
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
const engines = await import("./coding-engines.js");
const { ensureActiveSession, ensureSessionForChat, sessionOpenedNotice } = await import("./coding-session-open.js");

const env = {} as Env;
const repo: CodingRepo = {
	id: "repo_1",
	instanceId: "inst",
	userId: "u",
	name: "fws/platform",
	branch: "",
	cloneStatus: "ready",
	workdir: "/Users/x/dev/fws",
	// Required on `CodingRepo` and absent here until #599 compiled this file. `"local"` is what
	// `toRepo` (coding-store.ts:74) resolves for a repo that has a `workdir` and no `github_repo`,
	// so this is the value the fixture was always standing in for.
	provider: "local",
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
	vi.mocked(runner.getRunnerConnIgnoringLiveness).mockResolvedValue(conn as never);
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
	vi.mocked(store.getLastFinishedSessionForRepo).mockResolvedValue(null);
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

	it("sends the session's gh write scope to the runner, from D1 and not from the checkout (#679)", async () => {
		// The wiring assertion, not the guard's own. `StartCodingInput.ghScope` is optional, and an
		// optional field with no writer is the #570/#591 class this repo keeps paying for: the
		// runner would install no guard, `coding_diagnostics` would honestly report "unguarded"
		// forever, and everything would look implemented.
		//
		// It is sent from HERE rather than derived on the machine because the Engine has a shell in
		// that checkout and could rewrite `git remote origin` — a locally-derived scope is a scope
		// the Engine can widen itself.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(session("csess_scope"));
		await ensureActiveSession(env, "inst", "u", { ...repo, githubRepo: "ProAgentStore/platform" });
		const start = vi.mocked(runner.callRunner).mock.calls.find((c) => c[1] === "/coding/start");
		expect((start?.[2] as { ghScope?: string[] }).ghScope).toEqual(["ProAgentStore/platform"]);
	});

	it("sends NO scope for a repo with no GitHub coordinates — absent means 'not said' (#679)", async () => {
		// A local-only repo has nothing to compare a write against. Sending `[]` would make the
		// runner refuse every `gh` write in that session, which is the failure direction that
		// breaks working sessions rather than the one that leaves a known gap.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(session("csess_local"));
		await ensureActiveSession(env, "inst", "u", repo); // fixture has workdir, no githubRepo
		const start = vi.mocked(runner.callRunner).mock.calls.find((c) => c[1] === "/coding/start");
		expect((start?.[2] as { ghScope?: string[] }).ghScope).toBeUndefined();
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
		// `undefined`, not `null`: `toRepo` maps the column with `?? undefined` (coding-store.ts:81),
		// so a repo with no clone error can only ever reach this code as `undefined`. The `null` here
		// was a shape the store cannot emit.
		vi.mocked(store.getRepo).mockResolvedValue({ ...repo, cloneError: undefined });
		expect(await ensureActiveSession(env, "inst", "u", repo)).toMatchObject({ ok: false });
	});

	it("relocates a reused session to the machine that is live now", async () => {
		// Machine-switch reclaim. `getRunnerConnIgnoringLiveness` resolves from D1 even for a laptop
		// that closed its lid (the `status` column is never cleared), so without the live check a run
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
		expect(res.ok && res.notice).toMatch(/gone to sleep after 6 hours/);
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
		expect(n).not.toMatch(/gone to sleep/);
	});

	it("does not hand the model the word 'session' to repeat at the user (#695)", () => {
		// This notice is the widest channel the platform has for teaching that noun: the closing
		// instruction makes the model REPEAT the sentence, so "Started a coding session for X"
		// became "I started a coding session" in the user's chat. #257 and #408 spent two issues
		// making the concept unnecessary; one tool result was undoing both.
		const n = sessionOpenedNotice({
			repoName: "chess-academy",
			sessionId: "csess_1",
			engine: "claude",
			node: "mac",
			reapedPrevious: true,
			idleHours: 6,
		});
		expect(n).not.toMatch(/session/i);
		// The disclosure it exists for survives: a process appeared on their machine, and the id is
		// still there as the handle for a support question.
		expect(n).toMatch(/Engine is running there now/);
		expect(n).toContain("csess_1");
		expect(n).toMatch(/gone to sleep after 6 hours/);
	});

	it("claims a resume ONLY when the machine confirmed one (#408)", () => {
		// The single most important correctness detail in #408. `mode: "resume"` is what the CLOUD
		// asked for; `resumed` is what the MACHINE did. A runner published before this feature drops
		// the request and starts clean, so announcing the intent would tell most of the fleet the
		// opposite of what happened — a confident wrong answer to "do you remember what we were
		// doing?", which is worse than the silence this notice was added to fix.
		const asked = { mode: "resume", resumeFrom: "csess_old", reason: "the previous conversation on this repo was last touched 2 hours ago" } as const;
		const confirmed = sessionOpenedNotice({ repoName: "r", sessionId: "csess_2", engine: "claude", continuity: asked, resumed: true });
		expect(confirmed).toMatch(/picked up this repo's previous conversation/);

		for (const unconfirmed of [undefined, false]) {
			const n = sessionOpenedNotice({ repoName: "r", sessionId: "csess_2", engine: "claude", continuity: asked, resumed: unconfirmed });
			expect(n).toMatch(/FRESH conversation/);
			expect(n).not.toMatch(/picked up/);
		}
	});

	it("says WHY it started clean, so a fresh start is never unexplained", () => {
		const n = sessionOpenedNotice({
			repoName: "r",
			sessionId: "csess_3",
			engine: "claude",
			continuity: { mode: "fresh", resumeFrom: null, reason: "the previous conversation on this repo was last touched 9 days ago" },
		});
		expect(n).toContain("9 days ago");
		expect(n).toMatch(/fresh conversation/);
	});
});

describe("continuity on the open path (#408)", () => {
	const priorClaude = { id: "csess_old", clientType: "claude", status: "ended", lastActivityAt: Date.now() - 3_600_000 };

	it("asks the runner to continue a recent conversation, and reports what it confirmed", async () => {
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_new"));
		vi.mocked(store.getLastFinishedSessionForRepo).mockResolvedValue(priorClaude);
		vi.mocked(runner.callRunner).mockResolvedValue({ resumed: true } as never);
		const res = await ensureSessionForChat(env, "inst", "u", repo);
		const startBody = vi.mocked(runner.callRunner).mock.calls[0][2] as { resumeFrom?: string };
		expect(startBody.resumeFrom).toBe("csess_old");
		expect(res.ok && res.notice).toMatch(/picked up this repo's previous conversation/);
	});

	it("degrades to a truthful FRESH notice against a runner that ignores the field", async () => {
		// Backward compatibility is load-bearing, not a nicety: an older `pags up` answers
		// `/coding/start` with a snapshot that has no `resumed` key at all, and it always starts a
		// new conversation because its resume store is keyed by a session id it has never seen. The
		// cloud must read the absence as "clean", not as "presumably fine".
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_new"));
		vi.mocked(store.getLastFinishedSessionForRepo).mockResolvedValue(priorClaude);
		vi.mocked(runner.callRunner).mockResolvedValue({ sessionId: "csess_new", pane: "", ready: true } as never);
		const res = await ensureSessionForChat(env, "inst", "u", repo);
		expect(res.ok && res.notice).toMatch(/FRESH conversation/);
		expect(res.ok && res.notice).not.toMatch(/picked up/);
	});

	it("does not ask for a resume it decided against", async () => {
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_new"));
		vi.mocked(store.getLastFinishedSessionForRepo).mockResolvedValue({ ...priorClaude, lastActivityAt: Date.now() - 30 * 24 * 3_600_000 });
		const res = await ensureSessionForChat(env, "inst", "u", repo);
		expect((vi.mocked(runner.callRunner).mock.calls[0][2] as { resumeFrom?: string }).resumeFrom).toBeUndefined();
		expect(res.ok && res.notice).toMatch(/30 days ago/);
	});

	it("decides nothing on a REUSED session — it already IS the conversation", async () => {
		// A re-attach's own session id is the resume key on the runner, so nominating a predecessor
		// there could only override the better answer. The lookup must not even happen.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(session("csess_live"));
		await ensureSessionForChat(env, "inst", "u", repo);
		expect(store.getLastFinishedSessionForRepo).not.toHaveBeenCalled();
		expect((vi.mocked(runner.callRunner).mock.calls[0][2] as { resumeFrom?: string }).resumeFrom).toBeUndefined();
	});
});

describe("a transport failure is never stored as the repo's state (#440)", () => {
	// The bug, measured on production and reproduced from the string itself: `pas/platform` on the
	// Coder Home instance read `clone_status = "error"`, `clone_error = "No runner connected — run
	// `pags up`"`, `updated_at` five days old, while the checkout held 18 entries and answered
	// `insideWorkTree: true`. That message is `callRunner`'s pre-#341 503 text (deleted in
	// b347f68), so this catch is the only place it can have been written from.
	//
	// The obvious wrong fix is to keep writing and merely improve the wording. These tests fail if
	// anyone does that: what is asserted is that NOTHING is written.
	beforeEach(() => {
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_new"));
	});

	it("writes no clone status at all when the machine is unreachable", async () => {
		vi.mocked(runner.callRunner).mockRejectedValue(new RunnerUnreachableError("No runner connected — the relay has no live socket for this agent."));
		await ensureActiveSession(env, "inst", "u", repo);
		expect(store.updateRepoClone).not.toHaveBeenCalled();
	});

	it("recognises a disconnect that crossed a step boundary and arrived as a bare message", async () => {
		// A Workflow serialises the error, so the receiving side gets the text and not the
		// prototype — which is why `isRunnerUnreachable` matches the marker too (#341). A guard
		// that only did `instanceof` would let the Pilot's path go on condemning checkouts.
		vi.mocked(runner.callRunner).mockRejectedValue(new Error("No runner connected — the relay has no live socket for this agent."));
		await ensureActiveSession(env, "inst", "u", repo);
		expect(store.updateRepoClone).not.toHaveBeenCalled();
	});

	it("still records a failure that IS about the repository", async () => {
		// The other direction, and the reason this is a classification rather than a blanket
		// "stop writing": a clone that fails because the repository is gone is exactly what
		// `clone_status` is for, and #405 relies on it.
		vi.mocked(runner.callRunner).mockRejectedValue(new Error("fatal: repository not found"));
		await ensureActiveSession(env, "inst", "u", repo);
		expect(store.updateRepoClone).toHaveBeenCalledWith(env, "repo_1", { cloneStatus: "error", cloneError: "fatal: repository not found" });
	});

	it("reports the transport failure to the caller instead of losing it with the write", async () => {
		// Not writing must not become not saying. The caller used to learn WHY by re-reading
		// `clone_error` off the row this catch had just written; with no write, that read would
		// return the last FILESYSTEM verdict — a different failure, possibly days old — and relay
		// it to the owner as the reason their session did not start.
		vi.mocked(runner.callRunner).mockRejectedValue(new RunnerUnreachableError("No runner connected — the relay has no live socket for this agent."));
		vi.mocked(store.getRepo).mockResolvedValue({ ...repo, cloneError: "a stale verdict from Monday" });
		const res = await ensureActiveSession(env, "inst", "u", repo);
		expect(res).toMatchObject({ ok: false });
		expect(!res.ok && res.startError).toMatch(/no live socket/);
		expect(!res.ok && res.startError).not.toMatch(/Monday/);
	});
});

describe("a successful spawn is not a look at the checkout (#548)", () => {
	// The mirror of #440, four lines above its guard in the same function. `/coding/start`
	// succeeding means the runner could chdir into the path and was willing to spawn a command —
	// which a plain folder with no `.git` satisfies perfectly — and the old code took that as proof
	// enough to write `clone_status = "ready", clone_error = null`. So the run's own first act
	// ERASED the verdict that should have stopped it: `~/dev/aipa` carried `needs_attention` and
	// #405's sentence, and starting a session replaced them with `ready`.
	//
	// `checkWorkdirVia` is NOT mocked here: it is the real function over the mocked `callRunner`,
	// so what is asserted is the whole path from the runner's answer to the row.
	beforeEach(() => {
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_new"));
	});

	/** `/coding/start` succeeds; `/coding/repo-check` answers whatever the test says. */
	const runnerAnswering = (check: unknown) =>
		vi.mocked(runner.callRunner).mockImplementation((async (_c: unknown, path: string) =>
			path === "/coding/repo-check" ? check : { ok: true }) as never);

	it("does NOT promote a condemned folder to `ready` just because the engine launched in it", async () => {
		runnerAnswering({ checked: true, path: "/Users/x/dev/fws", exists: true, isDirectory: true, entryCount: 1, insideWorkTree: false, gitChecked: true });
		await ensureActiveSession(env, "inst", "u", repo);
		const statuses = vi.mocked(store.updateRepoClone).mock.calls.map((c) => c[2].cloneStatus);
		expect(statuses).not.toContain("ready");
	});

	it("stores the verdict the machine actually gave, with the relayable sentence", async () => {
		runnerAnswering({ checked: true, path: "/Users/x/dev/fws", exists: true, isDirectory: true, entryCount: 1, insideWorkTree: false, gitChecked: true });
		await ensureActiveSession(env, "inst", "u", repo);
		expect(store.updateRepoClone).toHaveBeenCalledWith(env, "repo_1", {
			cloneStatus: "needs_attention",
			cloneError: expect.stringContaining("not inside a git working tree"),
			checkedNow: true,
		});
	});

	it("writes `ready` when the machine says the checkout IS a work tree", async () => {
		// Not a blanket "stop writing": a healthy repo must still be recorded healthy, and stamped
		// fresh — otherwise a correct `ready` becomes indistinguishable from one nobody has
		// re-confirmed since Monday (#440's whole point in adding the column).
		runnerAnswering({ checked: true, path: "/Users/x/dev/fws", exists: true, isDirectory: true, entryCount: 12, insideWorkTree: true, gitChecked: true });
		await ensureActiveSession(env, "inst", "u", repo);
		expect(store.updateRepoClone).toHaveBeenCalledWith(env, "repo_1", { cloneStatus: "ready", cloneError: null, checkedNow: true });
	});

	it("writes NOTHING when the machine cannot answer the check", async () => {
		// A `pags up` older than `/coding/repo-check` answers `{error:"Not found"}`. Condemning on
		// that would break every repo on a machine the moment the API shipped ahead of the CLI —
		// which is exactly why `cloneStatusForVerdict` returns null for `unverified`.
		runnerAnswering({ error: "Not found" });
		await ensureActiveSession(env, "inst", "u", repo);
		expect(store.updateRepoClone).not.toHaveBeenCalled();
	});

	it("still calls a MANAGED CLONE ready without probing, because the clone itself is the look", async () => {
		// No `workdir` → nothing local to check, and `/coding/start` is what cloned it. Asking
		// `/coding/repo-check` about a managed dir whose path D1 never learns would answer about
		// nothing.
		const cloned = { ...repo, workdir: undefined, cloneUrl: "https://github.com/o/r.git" };
		vi.mocked(runner.callRunner).mockResolvedValue({ ok: true } as never);
		await ensureActiveSession(env, "inst", "u", cloned);
		expect(store.updateRepoClone).toHaveBeenCalledWith(env, "repo_1", { cloneStatus: "ready", cloneError: null });
		expect(vi.mocked(runner.callRunner).mock.calls.some((c) => c[1] === "/coding/repo-check")).toBe(false);
	});

	it("a failed probe does not fail an open that already worked", async () => {
		vi.mocked(runner.callRunner).mockImplementation((async (_c: unknown, path: string) => {
			if (path === "/coding/repo-check") throw new Error("relay exploded");
			return { ok: true };
		}) as never);
		const res = await ensureActiveSession(env, "inst", "u", repo);
		expect(res).toMatchObject({ ok: true, opened: true });
	});
});

describe("an agent-opened session picks the engine the OWNER set, not a column nobody can edit (#549)", () => {
	it("resolves from the instance default, never from `coding_repos.default_client`", () => {
		// The bug, measured: the owner set the ⚙ CLI engines default to Codex and `start_work`
		// opened a CLAUDE session at 12:08:30. `default_client` is written once at create as
		// "claude", has no UI, is not accepted by the repo PUT route, and is never sent by the
		// console — so on this path it was a hardcoded constant outranking the control he used.
		//
		// It is also the wrong TYPE for the job: it holds a `CodingClientType`, while `resolveEngine`
		// matches PRESET ids, so it only ever worked because the seeded ids happen to equal the
		// client types. Passing null falls through to `defaultEngineId` — the same thing the
		// console's own open path sends as `engineId`.
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_new"));
		return ensureActiveSession(env, "inst", "u", repo).then(() => {
			expect(engines.resolveEngine).toHaveBeenCalledWith(env, "inst", "u", null);
		});
	});
});
