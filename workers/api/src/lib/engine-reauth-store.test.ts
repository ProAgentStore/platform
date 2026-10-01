/** #881: the record a parked run waits on, and the rule that says the engine is not signed in. */
import { describe, expect, it } from "vitest";
import { type EngineReauthState, type LatestRunRow, parseReauthState, reauthSucceededSince, SIGN_IN_BLOCK_WINDOW_MS, signInBlockFrom } from "./engine-reauth-store.js";

const T = 1_700_000_000_000;
const relay = (over: Partial<EngineReauthState> = {}): EngineReauthState => ({
	clientType: "claude",
	method: "claude-login",
	session: "pags-signin-claude",
	runnerNode: "pink-laptop",
	status: "succeeded",
	startedAt: T,
	completedAt: T + 60_000,
	origin: "relay",
	deviceCode: null,
	expiryWarnedAt: null,
	...over,
});
const run = (over: Partial<LatestRunRow> = {}): LatestRunRow => ({
	run_id: "da66854d-aef2",
	session_id: "csess_1",
	status: "needs_human",
	stop_reason: "engine_auth",
	waiting_reason: null,
	started_at: T - 600_000,
	finished_at: T,
	...over,
});

describe("parseReauthState", () => {
	it("round-trips a record and rejects a malformed one", () => {
		expect(parseReauthState(JSON.parse(JSON.stringify(relay())))).toEqual(relay());
		expect(parseReauthState({ status: "succeeded" })).toBeNull();
		expect(parseReauthState({ ...relay(), status: "weird" })).toBeNull();
		expect(parseReauthState("nope")).toBeNull();
	});

	it("reads a record written before #890 as a relay flow that was never warned", () => {
		const { origin: _o, deviceCode: _d, expiryWarnedAt: _w, ...old } = relay();
		expect(parseReauthState(old)).toEqual(relay());
		expect(parseReauthState({ ...relay(), origin: "observed", deviceCode: "ABCD-EFGH2", expiryWarnedAt: T + 1 })).toMatchObject({ origin: "observed", deviceCode: "ABCD-EFGH2", expiryWarnedAt: T + 1 });
	});
});

describe("reauthSucceededSince — what a parked run polls", () => {
	it("is true only for a success at or after the park began", () => {
		expect(reauthSucceededSince(relay(), T)).toBe(true);
		expect(reauthSucceededSince(relay(), T + 60_001)).toBe(false);
		expect(reauthSucceededSince(relay({ status: "pending", completedAt: null }), T)).toBe(false);
		expect(reauthSucceededSince(null, T)).toBe(false);
	});
});

describe("signInBlockFrom — the diagnostics signal", () => {
	it("flags a run that stopped on sign-in, until a relay signs the engine in after it", () => {
		expect(signInBlockFrom(run(), null, T + 1000)).toEqual({ runId: "da66854d-aef2", sessionId: "csess_1", state: "stopped", since: T });
		expect(signInBlockFrom(run(), relay(), T + 120_000)).toBeNull();
		// A sign-in BEFORE the run stopped does not clear it — the engine lost its login again after.
		expect(signInBlockFrom(run({ finished_at: T + 120_000 }), relay(), T + 130_000)).not.toBeNull();
	});

	it("flags a run parked on sign-in", () => {
		const parked = run({ status: "running", stop_reason: null, waiting_reason: "engine_auth", finished_at: null });
		expect(signInBlockFrom(parked, null, T)?.state).toBe("parked");
	});

	it("ignores other endings, other parks, and a stale stop", () => {
		expect(signInBlockFrom(run({ stop_reason: "escalated" }), null, T)).toBeNull();
		expect(signInBlockFrom(run({ status: "running", stop_reason: null, waiting_reason: "human", finished_at: null }), null, T)).toBeNull();
		expect(signInBlockFrom(run(), null, T + SIGN_IN_BLOCK_WINDOW_MS + 1)).toBeNull();
		expect(signInBlockFrom(null, null, T)).toBeNull();
	});
});
