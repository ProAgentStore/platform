import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("./start.js", () => ({ startLocalBrowserRun: vi.fn() }));
vi.mock("../trigger-skip.js", () => ({ notifyTriggerSkip: vi.fn(async () => undefined) }));

import type { Env } from "../../types.js";
import { notifyTriggerSkip } from "../trigger-skip.js";
import { startLocalBrowserRun } from "./start.js";
import { runLocalBrowserTrigger } from "./trigger.js";

const env = {} as Env;
const target = { id: "trig-1", name: "Daily SEEK sweep", instance_id: "scout-1", user_id: "u1" };
const start = startLocalBrowserRun as unknown as Mock;
const skip = notifyTriggerSkip as unknown as Mock;
const run = (over: Record<string, unknown> = {}) => ({ id: "run-1234abcd", status: "running", errorCode: null, error: null, ...over });

beforeEach(() => {
	start.mockReset();
	skip.mockClear();
});

describe("run_local_browser — a scheduled research run through the owner's start path (#962)", () => {
	it("starts the run with the objective, marked as the trigger's, and reports it", async () => {
		start.mockResolvedValue({ kind: "started", run: run() });
		const out = await runLocalBrowserTrigger(env, target, "Senior roles on SEEK and Indeed");
		expect(out).toEqual({ runId: "run-1234abcd", status: "running", objective: "Senior roles on SEEK and Indeed" });
		expect(start).toHaveBeenCalledWith(env, "scout-1", "u1", expect.objectContaining({ objective: "Senior roles on SEEK and Indeed", source: "trigger" }));
		// A fresh request key per fire: each tick is a new run, not a replay of the last one.
		const [first] = start.mock.calls.map((c) => c[3].requestId);
		await runLocalBrowserTrigger(env, target, "again");
		expect(start.mock.calls[1][3].requestId).not.toBe(first);
		expect(skip).not.toHaveBeenCalled();
	});

	it("a run already going is a SKIP, told once — not a trigger failure", async () => {
		start.mockResolvedValue({ kind: "at_capacity", error: "1 local browser run(s) already active" });
		await expect(runLocalBrowserTrigger(env, target, "x")).resolves.toMatchObject({ skipped: true, reason: "a run is already in progress" });
		expect(skip).toHaveBeenCalledWith(env, target, "busy");
	});

	it("no runner this tick is a SKIP too — the run the start recorded says why", async () => {
		start.mockResolvedValue({ kind: "started", run: run({ status: "failed", errorCode: "runner_offline", error: "No runner is connected." }) });
		await expect(runLocalBrowserTrigger(env, target, "x")).resolves.toMatchObject({ skipped: true, reason: "runner offline", runId: "run-1234abcd" });
		expect(skip).toHaveBeenCalledWith(env, target, "offline");
	});

	it("a run the agent can never make FAILS the trigger, with the reason", async () => {
		start.mockResolvedValue({ kind: "refused", error: "This agent does not use local CLI browser research" });
		await expect(runLocalBrowserTrigger(env, target, "x")).rejects.toThrow(/does not use local CLI browser research/);
		start.mockResolvedValue({ kind: "started", run: run({ status: "failed", errorCode: "runner_unsupported", error: "Update the CLI" }) });
		await expect(runLocalBrowserTrigger(env, target, "x")).rejects.toThrow(/Update the CLI/);
		expect(skip).not.toHaveBeenCalled();
	});
});
