/**
 * #890: warn before an unattended device-code sign-in expires. The runner seam and the notification
 * are stubbed. The record lives in an in-memory store whose claim and close-out keep the same
 * conditions the SQL does. The expiry arithmetic, the pane reading and the sweep are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineReauthState } from "./engine-reauth-store.js";
import type { Env } from "../types.js";

const { callRunner, getBoundRunnerConn, notifyUser, store } = vi.hoisted(() => ({
	callRunner: vi.fn(),
	getBoundRunnerConn: vi.fn(),
	notifyUser: vi.fn(async () => undefined),
	store: { state: null as EngineReauthState | null, writes: 0, waitingSession: null as string | null },
}));
vi.mock("./runner-client.js", () => ({ READ_TIMEOUT_MS: 15_000, callRunner, getBoundRunnerConn }));
vi.mock("../routes/push.js", () => ({ notifyUser }));
vi.mock("./engine-reauth-store.js", async (orig) => ({
	...(await orig<typeof import("./engine-reauth-store.js")>()),
	readReauthState: async () => store.state,
	signInSessionId: async () => store.waitingSession,
	writeReauthState: async (_e: unknown, _i: unknown, _u: unknown, s: EngineReauthState) => {
		store.state = s;
		store.writes++;
	},
	claimExpiryWarning: async (_e: unknown, _i: unknown, _u: unknown, startedAt: number, now: number) => {
		const s = store.state;
		if (s?.status !== "pending" || s.startedAt !== startedAt || s.expiryWarnedAt !== null) return false;
		store.state = { ...s, expiryWarnedAt: now };
		return true;
	},
	finishReauthIfCurrent: async (_e: unknown, _i: unknown, _u: unknown, startedAt: number, status: "succeeded" | "failed", now: number) => {
		const s = store.state;
		if (s?.status !== "pending" || s.startedAt !== startedAt) return false;
		store.state = { ...s, status, completedAt: now };
		return true;
	},
}));

const { expiryWarningText, observeDeviceAuth, paneShowsDeviceAuth, reauthExpiryView, runReauthExpiryWatch, sweepReauthFlow } = await import("./engine-reauth-expiry.js");

const MIN = 60_000;
const T0 = Date.parse("2026-10-01T09:00:00Z");
const INSTANCE = "inst-1";
const UID = "user-1";
const conn = { endpointUrl: "http://pink-laptop", token: "t", instanceId: INSTANCE, userId: UID, runnerNode: "pink-laptop", relayName: "r" };

const DEVICE_PANE = [
	"$ codex login --device-auth",
	"Follow these steps to sign in with ChatGPT using device code authorization:",
	"1. Open this link in your browser and sign in to your account",
	"   https://auth.openai.com/codex/device",
	"2. Enter this one-time code (expires in 15 minutes)",
	"   ABCD-EFGH2",
].join("\n");

const flow = (over: Partial<EngineReauthState> = {}): EngineReauthState => ({
	clientType: "codex",
	method: "codex-device-auth",
	session: "pags-signin-codex",
	runnerNode: "pink-laptop",
	status: "pending",
	startedAt: T0,
	completedAt: null,
	origin: "relay",
	deviceCode: null,
	expiryWarnedAt: null,
	...over,
});

let pane: string | Error = DEVICE_PANE;

/** A D1 stub that answers the sweep's candidate query from the in-memory record. */
function sweepEnv(): Env {
	return {
		DB: {
			prepare: () => ({
				bind: (oldest: number, newest: number) => ({
					all: async () => {
						const s = store.state;
						const hit = s && s.status === "pending" && s.startedAt >= oldest && s.startedAt <= newest;
						return { results: hit ? [{ id: INSTANCE, user_id: UID, state: JSON.stringify(s) }] : [] };
					},
				}),
			}),
		},
	} as unknown as Env;
}
const env = {} as Env;

beforeEach(() => {
	vi.clearAllMocks();
	store.state = null;
	store.writes = 0;
	store.waitingSession = null;
	pane = DEVICE_PANE;
	getBoundRunnerConn.mockResolvedValue(conn);
	callRunner.mockImplementation(async (_c: unknown, path: string) => {
		if (path !== "/tmux/capture") return { ok: true };
		if (pane instanceof Error) throw pane;
		return { pane };
	});
});

describe("reauthExpiryView: the flag coding_diagnostics and coding_session_capture carry", () => {
	it("counts down a pending Codex device code, soon at 5 minutes left, expired at 15", () => {
		expect(reauthExpiryView(flow(), T0 + 5 * MIN)).toMatchObject({ expiringSoon: false, expired: false, expiresInSeconds: 600, expiresAt: "2026-10-01T09:15:00.000Z" });
		expect(reauthExpiryView(flow(), T0 + 10 * MIN + 30_000)).toMatchObject({ expiringSoon: true, expired: false, expiresInSeconds: 270 });
		expect(reauthExpiryView(flow(), T0 + 15 * MIN + 1)).toMatchObject({ expiringSoon: false, expired: true, expiresInSeconds: 0 });
	});

	it("is null when there is nothing to watch: no flow, a finished one, or a method with no known lifetime", () => {
		expect(reauthExpiryView(null, T0)).toBeNull();
		expect(reauthExpiryView(flow({ status: "succeeded", completedAt: T0 + MIN }), T0 + 11 * MIN)).toBeNull();
		expect(reauthExpiryView(flow({ clientType: "claude", method: "claude-login" }), T0 + 11 * MIN)).toBeNull();
	});
});

describe("the sweep warns ONCE about an unattended device code, while it still works", () => {
	it("an unattended flow past the threshold raises the warning exactly once", async () => {
		store.state = flow();
		await runReauthExpiryWatch(sweepEnv(), T0 + 10 * MIN + 5_000);
		await runReauthExpiryWatch(sweepEnv(), T0 + 11 * MIN);
		await runReauthExpiryWatch(sweepEnv(), T0 + 12 * MIN);
		expect(notifyUser).toHaveBeenCalledTimes(1);
		const [, uid, type, title, body, , opts] = notifyUser.mock.calls[0] as unknown as [Env, string, string, string, string, unknown, { kind?: string; instanceId?: string }];
		expect(uid).toBe(UID);
		expect(type).toBe("coding");
		expect(title).toContain("expires in ~5 min");
		expect(body).toContain("https://auth.openai.com/codex/device");
		expect(body).toContain("ABCD-EFGH2");
		expect(opts).toMatchObject({ kind: "alert", instanceId: INSTANCE });
		// No run waits on this sign-in, so it opens the instance's Coding tab — never the console home (#897).
		expect((notifyUser.mock.calls[0] as unknown[] | undefined)?.[5]).toBe(`/console/instances/${INSTANCE}/coding`);
		expect(store.state?.expiryWarnedAt).toBe(T0 + 10 * MIN + 5_000);
		// The flag carries the same fact.
		expect(reauthExpiryView(store.state, T0 + 11 * MIN)).toMatchObject({ expiringSoon: true, warnedAt: new Date(T0 + 10 * MIN + 5_000).toISOString() });
	});

	it("deep-links the run that is waiting on the sign-in (#897)", async () => {
		store.state = flow();
		store.waitingSession = "csess_parked";
		await runReauthExpiryWatch(sweepEnv(), T0 + 11 * MIN);
		expect((notifyUser.mock.calls[0] as unknown[] | undefined)?.[5]).toBe(`/console/instances/${INSTANCE}/coding/csess_parked`);
	});

	it("two overlapping sweeps still warn once: the marker is claimed before the notification", async () => {
		store.state = flow();
		const s = store.state;
		await Promise.all([sweepReauthFlow(env, INSTANCE, UID, s, T0 + 11 * MIN), sweepReauthFlow(env, INSTANCE, UID, s, T0 + 11 * MIN)]);
		expect(notifyUser).toHaveBeenCalledTimes(1);
	});

	it("nothing before the threshold", async () => {
		store.state = flow();
		await runReauthExpiryWatch(sweepEnv(), T0 + 9 * MIN);
		expect(await sweepReauthFlow(env, INSTANCE, UID, flow(), T0 + 9 * MIN)).toBe("waiting");
		expect(notifyUser).not.toHaveBeenCalled();
	});

	it("a login completed before the threshold raises nothing, and the record is closed so the flag clears", async () => {
		store.state = flow();
		pane = `${DEVICE_PANE}\nSuccessfully logged in`;
		await runReauthExpiryWatch(sweepEnv(), T0 + 10 * MIN + 5_000);
		expect(notifyUser).not.toHaveBeenCalled();
		expect(store.state?.status).toBe("succeeded");
		expect(reauthExpiryView(store.state, T0 + 11 * MIN)).toBeNull();
	});

	it("a login that already timed out, or whose terminal is gone, is closed as failed with no warning", async () => {
		store.state = flow();
		pane = `${DEVICE_PANE}\nError: device auth timed out after 15 minutes`;
		expect(await sweepReauthFlow(env, INSTANCE, UID, flow(), T0 + 11 * MIN)).toBe("finished");
		expect(store.state?.status).toBe("failed");

		store.state = flow();
		pane = new Error('Runner /tmux/capture → 404: {"error":"no such session"}');
		expect(await sweepReauthFlow(env, INSTANCE, UID, flow(), T0 + 11 * MIN)).toBe("finished");
		expect(notifyUser).not.toHaveBeenCalled();
	});

	it("a runner that cannot be read sends nothing and changes nothing: the flow cannot be confirmed as waiting", async () => {
		store.state = flow();
		getBoundRunnerConn.mockResolvedValueOnce(null);
		expect(await sweepReauthFlow(env, INSTANCE, UID, flow(), T0 + 11 * MIN)).toBe("unreadable");
		pane = new Error("Relay command timed out");
		expect(await sweepReauthFlow(env, INSTANCE, UID, flow(), T0 + 11 * MIN)).toBe("unreadable");
		expect(notifyUser).not.toHaveBeenCalled();
		expect(store.state).toEqual(flow());
	});

	it("never watches a method with no known lifetime (a Claude sign-in)", async () => {
		store.state = flow({ clientType: "claude", method: "claude-login", session: "pags-signin-claude" });
		await runReauthExpiryWatch(sweepEnv(), T0 + 11 * MIN);
		expect(callRunner).not.toHaveBeenCalled();
		expect(notifyUser).not.toHaveBeenCalled();
	});

	it("says when the code expires, and never mentions an API key", () => {
		const t = expiryWarningText({ clientType: "codex", url: "https://auth.openai.com/codex/device", deviceCode: "ABCD-EFGH2", expiresAt: T0 + 15 * MIN, now: T0 + 10 * MIN, machine: "pink-laptop" });
		expect(t.body).toContain('on machine "pink-laptop"');
		expect(t.body).toContain("09:15 UTC");
		expect(`${t.title} ${t.body}`).not.toMatch(/api[ _-]?key/i);
	});
});

describe("a device-code sign-in typed into the owner's own tmux session is watched too", () => {
	const observe = (p: string, now = T0, session = "work") =>
		observeDeviceAuth(env, { instanceId: INSTANCE, userId: UID, runnerNode: "pink-laptop", session, pane: p, now });

	it("records it as `observed`, timed from when it was first seen", async () => {
		expect(await observe(DEVICE_PANE)).toBe(true);
		expect(store.state).toMatchObject({ origin: "observed", session: "work", method: "codex-device-auth", deviceCode: "ABCD-EFGH2", startedAt: T0, status: "pending" });
	});

	it("seeing the same code again keeps the original start, which is what the warning is timed from", async () => {
		await observe(DEVICE_PANE, T0);
		expect(await observe(DEVICE_PANE, T0 + 4 * MIN)).toBe(false);
		expect(store.state?.startedAt).toBe(T0);
		expect(store.writes).toBe(1);
	});

	it("a NEW code in the same session is a new flow", async () => {
		await observe(DEVICE_PANE, T0);
		expect(await observe(DEVICE_PANE.replace("ABCD-EFGH2", "WXYZ-12345"), T0 + 16 * MIN)).toBe(true);
		expect(store.state).toMatchObject({ deviceCode: "WXYZ-12345", startedAt: T0 + 16 * MIN });
	});

	it("does not overwrite a live relay flow in another session", async () => {
		store.state = flow();
		expect(await observe(DEVICE_PANE, T0 + 2 * MIN)).toBe(false);
		expect(store.state).toEqual(flow());
	});

	it("the relay's own session, captured through tmux, is not re-recorded", async () => {
		store.state = flow();
		expect(await observe(DEVICE_PANE, T0 + 2 * MIN, "pags-signin-codex")).toBe(false);
	});
});

describe("a normal, non-auth session is never flagged", () => {
	const HEALTHY_PANES = [
		// A coding engine at work.
		"╭──────────────╮\n│ ✻ Welcome to Claude Code │\n> fix the failing test\n● Read(src/app.ts)\n● Edit(src/app.ts)\n  ⎿ Updated 3 lines",
		// Codex working on a turn, with a link in its output.
		'{"type":"item.completed","item":{"type":"agent_message","text":"Docs: https://platform.openai.com/docs/guides"}}',
		// A shell: git, a build, a UUID-ish token and a sign-in host, but no device-code prompt.
		"$ git log --oneline -3\n484046a4 feat(#891): refuse a run\n$ npm test\nPASS 12 suites\nrelease ABCD-1234 tagged\nsee https://github.com/login for access",
		"",
	];

	it("the pane test does not fire", () => {
		for (const p of HEALTHY_PANES) expect(paneShowsDeviceAuth(p)).toBeNull();
	});

	it("observing those panes records nothing, and the flag stays null", async () => {
		for (const p of HEALTHY_PANES) expect(await observeDeviceAuth(env, { instanceId: INSTANCE, userId: UID, runnerNode: null, session: "work", pane: p, now: T0 })).toBe(false);
		expect(store.writes).toBe(0);
		expect(reauthExpiryView(store.state, T0 + 11 * MIN)).toBeNull();
	});

	it("with no flow on record the sweep reads no pane and sends nothing", async () => {
		await runReauthExpiryWatch(sweepEnv(), T0 + 11 * MIN);
		expect(callRunner).not.toHaveBeenCalled();
		expect(notifyUser).not.toHaveBeenCalled();
	});
});
