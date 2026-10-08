import { describe, expect, it, vi } from "vitest";
import type { ApplyRun } from "./store.js";
import type { SupervisorCheckpoint } from "./supervision.js";

const { runUserWorkersAi } = vi.hoisted(() => ({ runUserWorkersAi: vi.fn() }));
vi.mock("../user-ai.js", () => ({ runUserWorkersAi }));

const { constrainBrainDirective, decideApplicationCheckpoint } = await import("./brain.js");

const run = (mode: "fill_and_review" | "auto_submit" = "auto_submit") => ({
	id: "run-1",
	instanceId: "runner-1",
	applicationId: "app-1",
	requestId: "event-1",
	status: "paused",
	policy: {
		engine: "claude",
		authMode: "machine",
		browserProfile: "isolated",
		mode,
		allowDomains: ["jobs.example.com"],
		limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 },
		gate: { allowed: mode === "auto_submit", gateId: mode === "auto_submit" ? "gate-1" : null, checks: [] },
	},
	pause: null,
	result: null,
	engineAuth: null,
	errorCode: null,
	error: null,
	runnerNode: "mac",
	trace: [],
	runnerSeq: 4,
	lastSyncedAt: null,
	createdAt: 1,
	startedAt: 1,
	endedAt: null,
}) as ApplyRun;

const checkpoint = (phase: SupervisorCheckpoint["facts"]["phase"] = "initial", blockers: string[] = []): SupervisorCheckpoint => ({
	runId: "run-1",
	instanceId: "runner-1",
	checkpointId: "checkpoint-1",
	schemaVersion: 1,
	runnerSeq: 4,
	receivedAt: 1,
	facts: { phase, actions: 2, filled: 1, uploaded: 0, blockers: blockers as SupervisorCheckpoint["facts"]["blockers"], url: "https://jobs.example.com/apply", domain: "jobs.example.com", title: "Staff engineer application" },
	directive: null,
});

const env = () => ({
	AGENT: {
		idFromName: (name: string) => name,
		get: () => ({ fetch: async () => Response.json({ model: "claude-sonnet-4-6", modelChosen: true }) }),
	},
}) as never;

describe("Application Runner cloud brain", () => {
	it("uses the Runner instance's selected brain and exposes only bounded checkpoint facts", async () => {
		runUserWorkersAi.mockResolvedValueOnce({ tool_calls: [{ name: "decide_application_checkpoint", arguments: { directive: "continue" } }] });
		await expect(decideApplicationCheckpoint(env(), "u1", run(), checkpoint())).resolves.toBe("continue");
		expect(runUserWorkersAi).toHaveBeenCalledWith(
			expect.anything(),
			"u1",
			"claude-sonnet-4-6",
			expect.objectContaining({ tools: expect.any(Array), maxTokens: 96, timeoutMs: 20_000 }),
			expect.objectContaining({ kind: "run", instanceId: "runner-1" }),
			{ honorModel: true },
		);
		const body = runUserWorkersAi.mock.calls[0][3] as { messages: Array<{ content: string }> };
		expect(body.messages[1].content).toContain('"checkpointId":"checkpoint-1"');
		expect(body.messages[1].content).not.toMatch(/resume|cover|answer|snapshot|cookie/i);
	});

	it("keeps policy as the final authority over a model's continue", () => {
		expect(constrainBrainDirective(run("fill_and_review"), checkpoint("before_submit"), "continue")).toBe("request_review");
		expect(constrainBrainDirective(run(), checkpoint("initial", ["captcha"]), "continue")).toBe("stop");
	});

	it("fails closed to review when the configured brain cannot answer", async () => {
		runUserWorkersAi.mockRejectedValueOnce(new Error("no BYOK key"));
		await expect(decideApplicationCheckpoint(env(), "u1", run(), checkpoint())).resolves.toBe("request_review");
	});
});
