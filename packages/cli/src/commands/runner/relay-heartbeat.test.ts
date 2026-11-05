/** #1545: exercise the real heartbeat timer, HTTP fetch/body read, fairness and following cycle. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectViaRelay } from "./relay.js";

vi.mock("../../output.js", () => ({ writeLine: () => undefined, writeError: () => undefined }));
vi.mock("../../machine.js", () => ({ loadMachineIdentity: () => ({ id: "", names: [] }) }));
vi.mock("../../capabilities/detect.js", () => ({ CapabilityReporter: class { refreshIfDue() {} payload() { return {}; } accept() {} } }));
vi.mock("./resources.js", () => ({
	probeRuntimeHealth: async () => ({ state: "responsive" }), recordRunnerStart: () => 1,
	sampleDisk: () => null, sampleMemAvailable: () => null, sampleResources: () => ({ cpus: 4, sessions: [] }),
}));
vi.mock("./cleanup-sync.js", () => ({ createCleanupSync: () => ({ collect: async () => ({ status: null }), accept: async () => undefined }) }));
vi.mock("../../bootstrap/update-log.js", () => ({ updateLogUpload: () => ({ body: () => ({}), answered() {} }) }));
vi.mock("./release-trial.js", () => ({
	releaseTrial: () => ({ rollbacks: () => [], rolledBack: () => false, proven() {} }),
	agentsStillMissing: () => [], rollbackAvailable: () => false, applyRetryRolledBack: () => ({}),
}));

const FIRST = "first-agent", SECOND = "second-agent";
let mode: "fetch" | "body" | "ok";
let signals: Array<AbortSignal | undefined>;
let posts: string[];

class FakeSocket {
	static OPEN = 1;
	readyState = 0;
	onopen?: () => void;
	onmessage?: (event: { data: string }) => void;
	onclose?: (event: { code: number; reason: string }) => void;
	onerror?: () => void;
	send() {}
	close() {}
}

beforeEach(() => {
	vi.useFakeTimers();
	mode = "fetch"; signals = []; posts = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		if (url.endsWith("/runtime/heartbeat")) {
			const id = url.includes(FIRST) ? FIRST : SECOND;
			posts.push(id);
			if (id === FIRST && mode !== "ok") {
				const signal = init?.signal ?? undefined; signals.push(signal);
				if (mode === "fetch") return new Promise<Response>(() => undefined); // even an uncooperative fetch is bounded
				return new Response(new ReadableStream({ start(controller) { signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true }); } }));
			}
		}
		return new Response(JSON.stringify({ capabilities: [], instances: [], token: "test-relay", autoUpdate: false }));
	});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function start() {
	const healthy = vi.fn();
	await connectViaRelay([FIRST, SECOND], "http://local.test", "runner-test", { pagsToken: "inert-test-token", apiBase: "https://api.test" }, false, false, healthy);
	return healthy;
}

describe("bounded per-agent heartbeat delivery", () => {
	it.each(["fetch", "body"] as const)("a stalled %s cannot starve another agent or the next heartbeat", async (stall) => {
		mode = stall;
		const healthy = await start();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(posts).toEqual([FIRST, SECOND]); // second is not queued behind a permanently pending first
		await vi.advanceTimersByTimeAsync(10_000);
		expect(signals[0]?.aborted).toBe(true);
		expect(healthy).not.toHaveBeenCalled();
		mode = "ok";
		await vi.advanceTimersByTimeAsync(30_000);
		expect(posts).toEqual([FIRST, SECOND, FIRST, SECOND]);
		expect(healthy).toHaveBeenCalledOnce();
	});

	it("successful heartbeat delivery keeps the all-agent success callback", async () => {
		mode = "ok";
		const healthy = await start();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(posts).toEqual([FIRST, SECOND]);
		expect(healthy).toHaveBeenCalledOnce();
	});
});
