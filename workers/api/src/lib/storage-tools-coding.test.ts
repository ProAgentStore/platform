// The chat surface's coding tools, end to end (#407).
//
// The asymmetry this pins: the SAME agent, in the SAME conversation, about the SAME repo, could be
// told "go fix issue #12" and silently spawn a `claude --dangerously-skip-permissions` child
// process on the user's laptop (`start_work` → loop driver → `ensureActiveSession`), but asking
// "what's the terminal showing?" answered "No active session" and told them to go and press a
// button. The path with the LARGER consequence was the one that self-served.
//
// Only the leaves are mocked — D1, the relay, the engine resolver. `coding-session-open.ts` runs
// for real, because the acceptance criterion that matters most ("runner offline ⇒ no session row")
// is a fact about that module's ORDERING, and a test that stubbed it out would assert nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingRepo, CodingSessionRecord } from "./coding-types.js";
import type { AgentStorageEngine } from "../agent-storage.js";
import type { Env } from "../types.js";

vi.mock("./coding-store.js", () => ({
	listRepos: vi.fn(),
	listSessions: vi.fn(async () => []),
	getActiveSessionForRepo: vi.fn(),
	getLastFinishedSessionForRepo: vi.fn(async () => null),
	createSession: vi.fn(),
	endSession: vi.fn(async () => true),
	getRepo: vi.fn(async () => null),
	reassignSessionNode: vi.fn(async () => undefined),
	updateRepoClone: vi.fn(async () => undefined),
}));
vi.mock("./runner-client.js", () => ({
	READ_TIMEOUT_MS: 20_000,
	callRunner: vi.fn(async () => ({ ok: true })),
	getBoundRunnerConn: vi.fn(),
	// `startSessionOnRunner` holds the stamped row and probes for itself (#532).
	getRunnerConnIgnoringLiveness: vi.fn(),
	relayConnected: vi.fn(async () => true),
}));
vi.mock("./coding-engines.js", () => ({
	resolveEngine: vi.fn(async () => ({ command: "claude", clientType: "claude" })),
	resolveEngineEnv: vi.fn(async () => ({})),
}));
vi.mock("./git-credentials.js", () => ({ resolveCloneCredential: vi.fn(async () => null) }));
vi.mock("./instance-connectivity.js", () => ({ runtimeConnectivity: vi.fn() }));
vi.mock("./coding-session-sweeper.js", () => ({
	IDLE_SESSION_MS: 6 * 60 * 60_000,
	lastIdleReapForRepo: vi.fn(async () => null),
}));
vi.mock("./coding-timeline.js", () => ({ lastTerminal: vi.fn(async () => null) }));
vi.mock("./runtime-nodes.js", () => ({ normalizeRunnerNode: (v: unknown) => (typeof v === "string" ? v.trim() : "") }));

const store = await import("./coding-store.js");
const runner = await import("./runner-client.js");
const connectivity = await import("./instance-connectivity.js");
const sweeper = await import("./coding-session-sweeper.js");
const timeline = await import("./coding-timeline.js");
const { executeStorageTool } = await import("./storage-tools.js");

const env = {} as Env;
const engine = {} as AgentStorageEngine;
const ctx = { env, agentId: "inst", userId: "u" };

const repo: CodingRepo = {
	id: "repo_1",
	instanceId: "inst",
	userId: "u",
	name: "chess-academy",
	provider: "github",
	branch: "",
	cloneStatus: "ready",
	workdir: "/Users/x/dev/chess-academy",
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
	vi.mocked(store.listRepos).mockResolvedValue([repo]);
	vi.mocked(store.listSessions).mockResolvedValue([]);
	vi.mocked(store.getLastFinishedSessionForRepo).mockResolvedValue(null);
	vi.mocked(store.endSession).mockResolvedValue(true);
	vi.mocked(runner.getRunnerConnIgnoringLiveness).mockResolvedValue(conn as never);
	vi.mocked(runner.getBoundRunnerConn).mockResolvedValue(conn as never);
	vi.mocked(runner.relayConnected).mockResolvedValue(true);
	vi.mocked(runner.callRunner).mockResolvedValue({ pane: "$ pnpm test\nall good", runState: "idle" } as never);
	vi.mocked(connectivity.runtimeConnectivity).mockResolvedValue({
		hasRuntimeRow: true,
		relayConnected: true,
		node: "mac",
		runnerVersion: "0.4.35",
		lastSeenAt: null,
	});
	vi.mocked(sweeper.lastIdleReapForRepo).mockResolvedValue(null);
	vi.mocked(timeline.lastTerminal).mockResolvedValue(null);
});

describe("read_terminal opens a session rather than refusing (#407)", () => {
	it("answers in ONE turn when there is no live session", async () => {
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_new"));
		const res = await executeStorageTool({ name: "read_terminal", input: { repo_name: "chess-academy" } }, engine, ctx);
		expect(res.success).toBe(true);
		// One turn: the session opened AND the pane came back, in the same tool result. Two turns
		// would mean the model has to notice a refusal and pick a different tool, which is the
		// behaviour that made the user press the button themselves.
		expect(res.content).toContain("Started a coding session for chess-academy");
		expect(res.content).toContain("csess_new");
		expect(res.content).toContain("all good");
		expect(res.content).not.toMatch(/No active session/);
	});

	it("creates NO session row with the runner offline, and says the runner is why", async () => {
		// The acceptance criterion most likely to be quietly skipped. A read tool can be called
		// repeatedly, and each call reaching `createSession` would write-then-end a row for a
		// machine that is not there — while telling the user something other than the truth.
		vi.mocked(connectivity.runtimeConnectivity).mockResolvedValue({
			hasRuntimeRow: true,
			relayConnected: false,
			node: "mac",
			runnerVersion: "0.4.35",
			lastSeenAt: null,
		});
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		const res = await executeStorageTool({ name: "read_terminal", input: { repo_name: "chess-academy" } }, engine, ctx);
		expect(res.success).toBe(false);
		expect(store.createSession).not.toHaveBeenCalled();
		expect(runner.callRunner).not.toHaveBeenCalled();
		expect(res.content).toMatch(/pags up/);
		expect(res.content).toContain("mac");
	});

	it("still shows the last snapshot when the runner is offline and one was saved", async () => {
		// The degraded answer that existed before #407 must survive it: labelled scrollback beats
		// nothing, as long as it is never presented as live.
		vi.mocked(connectivity.runtimeConnectivity).mockResolvedValue({
			hasRuntimeRow: true,
			relayConnected: false,
			node: "mac",
			runnerVersion: null,
			lastSeenAt: null,
		});
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(session("csess_known"));
		vi.mocked(timeline.lastTerminal).mockResolvedValue("$ pnpm build\ndone");
		const res = await executeStorageTool({ name: "read_terminal", input: { repo_name: "chess-academy" } }, engine, ctx);
		expect(res.success).toBe(true);
		expect(res.content).toMatch(/last snapshot — not live/);
		expect(res.content).toContain("done");
		expect(store.createSession).not.toHaveBeenCalled();
	});

	it("reports the six-hour reap as the reason there was nothing to read", async () => {
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_new"));
		vi.mocked(sweeper.lastIdleReapForRepo).mockResolvedValue({ sessionId: "csess_old", endedAt: "2026-08-08 01:00:00" });
		const res = await executeStorageTool({ name: "read_terminal", input: { repo_name: "chess-academy" } }, engine, ctx);
		expect(res.content).toMatch(/closed automatically after 6 hours/);
	});

	it("says nothing extra when it reused a live session", async () => {
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(session("csess_live"));
		const res = await executeStorageTool({ name: "read_terminal", input: { repo_name: "chess-academy" } }, engine, ctx);
		expect(res.content).not.toMatch(/Started a coding session/);
		expect(res.content).toMatch(/\[live · idle\]/);
	});
});

describe("send_to_cli opens a session rather than refusing (#407)", () => {
	it("opens one and names it before sending", async () => {
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		vi.mocked(store.createSession).mockResolvedValue(session("csess_new"));
		const res = await executeStorageTool(
			{ name: "send_to_cli", input: { repo_name: "chess-academy", message: "run the tests" } },
			engine,
			ctx,
		);
		expect(res.success).toBe(true);
		expect(res.content).toContain("Started a coding session for chess-academy");
		expect(res.content).toContain('Sent to chess-academy: "run the tests"');
		const act = vi.mocked(runner.callRunner).mock.calls.find((c) => c[1] === "/coding/act");
		expect(act?.[2]).toMatchObject({ sessionId: "csess_new" });
	});

	it("refuses with the runner diagnosis and writes no row when the runner is offline", async () => {
		vi.mocked(connectivity.runtimeConnectivity).mockResolvedValue({
			hasRuntimeRow: false,
			relayConnected: false,
			node: null,
			runnerVersion: null,
			lastSeenAt: null,
		});
		vi.mocked(store.getActiveSessionForRepo).mockResolvedValue(null);
		const res = await executeStorageTool(
			{ name: "send_to_cli", input: { repo_name: "chess-academy", message: "run the tests" } },
			engine,
			ctx,
		);
		expect(res.success).toBe(false);
		expect(store.createSession).not.toHaveBeenCalled();
		expect(res.content).toMatch(/pags up/);
	});
});
