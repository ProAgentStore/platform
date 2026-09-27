import { describe, expect, it } from "vitest";
import { type RunnerSetupAnswer, type RunnerSetupStep, runnerSetupLink, runnerSetupView } from "./runner-setup-view";

const CODING = "/instances/i1/coding";
const step = (s: RunnerSetupStep["step"], done: boolean, link?: string): RunnerSetupStep => ({ step: s, done, instruction: `do ${s}`, link });
const answer = (steps: RunnerSetupStep[]): RunnerSetupAnswer => ({ instanceId: "i1", ready: steps.every((s) => s.done), steps });

describe("runnerSetupView — when the card shows (#869)", () => {
	it("is hidden before the first answer, once setup is ready, and for an answer with no steps", () => {
		expect(runnerSetupView(null, CODING)).toBeNull();
		expect(runnerSetupView(answer([step("runner_connected", true), step("repo_bound", true)]), CODING)).toBeNull();
		expect(runnerSetupView({ instanceId: "i1", ready: false, steps: [] }, CODING)).toBeNull();
	});

	it("follows the server's `ready`, not its own count", () => {
		// The server owns the verdict; a card that second-guessed it could disagree with coding_loop_start.
		expect(runnerSetupView({ instanceId: "i1", ready: true, steps: [step("runner_connected", false)] }, CODING)).toBeNull();
	});

	it("counts what is done and marks the FIRST open step as current — only that one", () => {
		const v = runnerSetupView(answer([step("runner_connected", true), step("instance_attached", false), step("github_app", false)]), CODING);
		expect(v).toMatchObject({ doneCount: 1, total: 3 });
		expect(v?.rows.map((r) => [r.id, r.done, r.current])).toEqual([
			["runner_connected", true, false],
			["instance_attached", false, true],
			["github_app", false, false],
		]);
	});

	it("keeps the server's order and instruction, with a title per step", () => {
		const v = runnerSetupView(answer([step("engine_signed_in", false), step("runner_connected", false)]), CODING);
		expect(v?.rows.map((r) => r.title)).toEqual(["Sign in to the coding engine", "Install the CLI and run pags up"]);
		expect(v?.rows[0].instruction).toBe("do engine_signed_in");
	});

	it("an unknown step from a newer server still renders, titled by its id", () => {
		const v = runnerSetupView({ instanceId: "i1", ready: false, steps: [{ step: "billing" as RunnerSetupStep["step"], done: false, instruction: "x" }] }, CODING);
		expect(v?.rows[0].title).toBe("billing");
	});
});

describe("runnerSetupLink — where a step's link goes", () => {
	it("routes a console link under the router's base", () => {
		expect(runnerSetupLink("/console/instances/i1/board", CODING)).toEqual({ kind: "route", to: "/instances/i1/board" });
		expect(runnerSetupLink("/console", CODING)).toEqual({ kind: "route", to: "/" });
	});

	it("drops a link to the Coding tab the user is already on", () => {
		expect(runnerSetupLink("/console/instances/i1/coding", CODING)).toBeNull();
	});

	it("opens an https link as external, and refuses anything else", () => {
		expect(runnerSetupLink("https://github.com/apps/x/installations/new", CODING)).toEqual({ kind: "external", href: "https://github.com/apps/x/installations/new" });
		expect(runnerSetupLink("javascript:alert(1)", CODING)).toBeNull();
		expect(runnerSetupLink("http://example.com", CODING)).toBeNull();
		expect(runnerSetupLink(undefined, CODING)).toBeNull();
	});
});
