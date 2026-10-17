/**
 * #1113 slice 1 — the routing rules the live self-hosted-runner loop must obey, held as pure decisions:
 * GitHub-hosted by default; the PINNED machine only, by its unique label, when minutes are exhausted
 * or low or a run failed to start for billing (#1112); never a public repo; never generic labels.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureFetch, loadActionsFixture } from "./__fixtures__/github-actions/fixture-fetch.js";
import { classifyStartFailure, runStartFailure } from "./github-actions.js";
import {
	assertPrivateRepo,
	getWorkflowRunnerDirective,
	GITHUB_HOSTED_LABEL,
	isPinScoped,
	labelCollisions,
	nodeRunnerLabel,
	PAGS_RUNNER_VARIABLE,
	PublicRepoError,
	selectRunnerLabel,
	shouldFallbackToSelfHosted,
} from "./runner-routing.js";

const NODE = "Sergeys-Mac-mini.local";
const PINNED = ["self-hosted", "pags-sergeys-mac-mini-local"];

afterEach(() => vi.unstubAllGlobals());

describe("selectRunnerLabel (#1113)", () => {
	it("GitHub-hosted by default — private, pinned, minutes fine", () => {
		expect(selectRunnerLabel({ visibility: "private", pinnedNode: NODE, minutes: { usedPercent: 40 } })).toEqual({ mode: "github-hosted", labels: [GITHUB_HOSTED_LABEL], variableValue: '"ubuntu-latest"', reason: "default" });
		expect(selectRunnerLabel({ visibility: "private", pinnedNode: NODE }).mode).toBe("github-hosted");
	});

	it("falls back to the PINNED machine on exhausted minutes, low minutes, or a run #1112 classified minutes_exhausted", () => {
		const base = { visibility: "private" as const, pinnedNode: NODE };
		for (const [extra, reason] of [
			[{ minutes: { exhausted: true } }, "minutes_exhausted"],
			[{ minutes: { usedPercent: 90 } }, "minutes_low"],
			[{ minutes: { usedPercent: 72 }, lowMinutesPercent: 70 }, "minutes_low"],
			[{ failureReason: { classification: "minutes_exhausted" as const } }, "run_not_started_for_billing"],
		] as const) {
			const d = selectRunnerLabel({ ...base, ...extra });
			expect(d, reason).toEqual({ mode: "self-hosted", labels: PINNED, variableValue: JSON.stringify(PINNED), reason });
			expect(isPinScoped(d.labels)).toBe(true);
		}
	});

	it("no fallback on not_started, unreadable annotations, or no reason — a run that never started is not proof of billing", () => {
		for (const failureReason of [{ classification: "not_started" as const }, null, undefined]) {
			expect(selectRunnerLabel({ visibility: "private", pinnedNode: NODE, failureReason }).mode).toBe("github-hosted");
		}
	});

	it("round-trip: once minutes read as fine again the route is back to GitHub-hosted — the decision has no memory", () => {
		expect(selectRunnerLabel({ visibility: "private", pinnedNode: NODE, minutes: { exhausted: true } }).mode).toBe("self-hosted");
		expect(selectRunnerLabel({ visibility: "private", pinnedNode: NODE, minutes: { exhausted: false, usedPercent: 3 } })).toMatchObject({ mode: "github-hosted", reason: "default" });
	});

	it("a public (or internal) repo, or an unpinned Coder, is GitHub-hosted whatever the minutes say", () => {
		for (const visibility of ["public", "internal", ""]) {
			expect(selectRunnerLabel({ visibility, pinnedNode: NODE, minutes: { exhausted: true } })).toMatchObject({ mode: "github-hosted", reason: "not_private" });
		}
		for (const pinnedNode of [null, undefined, "", "  "]) {
			expect(selectRunnerLabel({ visibility: "private", pinnedNode, minutes: { exhausted: true } })).toMatchObject({ mode: "github-hosted", reason: "not_pinned" });
		}
	});

	it("getWorkflowRunnerDirective names the repo and the variable it sets", () => {
		expect(getWorkflowRunnerDirective({ fullName: "pas-apps/interns", visibility: "private" }, NODE, { minutes: { exhausted: true } })).toEqual({
			repo: "pas-apps/interns",
			variable: PAGS_RUNNER_VARIABLE,
			mode: "self-hosted",
			labels: PINNED,
			variableValue: '["self-hosted","pags-sergeys-mac-mini-local"]',
			reason: "minutes_exhausted",
		});
	});
});

describe("the public-repo guard (#1113)", () => {
	it("assertPrivateRepo passes private and throws a typed error for anything else", () => {
		expect(() => assertPrivateRepo("private")).not.toThrow();
		for (const v of ["public", "internal", undefined, 42]) {
			expect(() => assertPrivateRepo(v)).toThrow(PublicRepoError);
		}
		expect(() => assertPrivateRepo("public")).toThrow(/fork pull requests could run code on the owner's machine/);
	});
});

describe("pin-scoped labels — never generic (#1113 mutual exclusion)", () => {
	it("the unique label is a slug of the canonical node name; an empty or over-long name is refused, never cut", () => {
		expect(nodeRunnerLabel("Sergeys-Mac-mini.local")).toBe("pags-sergeys-mac-mini-local");
		expect(nodeRunnerLabel("RL laptop")).toBe("pags-rl-laptop");
		expect(() => nodeRunnerLabel("  ")).toThrow(/canonical node name/);
		expect(() => nodeRunnerLabel("x".repeat(120))).toThrow(/too long/);
	});

	it("isPinScoped: exactly one machine label; generic labels alone, or two machines, are not", () => {
		expect(isPinScoped(PINNED)).toBe(true);
		expect(isPinScoped(["self-hosted", "pags", "pags-a"])).toBe(true);
		expect(isPinScoped(["self-hosted"])).toBe(false);
		expect(isPinScoped(["self-hosted", "pags"])).toBe(false);
		expect(isPinScoped(["self-hosted", "pags-a", "pags-b"])).toBe(false);
		expect(isPinScoped(["ubuntu-latest"])).toBe(false);
	});

	it("two machines whose names slug to the same label are reported, so neither is routed to by mistake", () => {
		expect(labelCollisions(["Mac.mini", "mac-mini", "dell"])).toEqual([{ label: "pags-mac-mini", nodes: ["Mac.mini", "mac-mini"] }]);
		expect(labelCollisions(["a", "b", "a"])).toEqual([]);
	});
});

describe("consumes #1112's classification as it actually comes out (#1113)", () => {
	it("shouldFallbackToSelfHosted is true only for minutes_exhausted", () => {
		expect(shouldFallbackToSelfHosted({ classification: "minutes_exhausted" })).toBe(true);
		expect(shouldFallbackToSelfHosted({ classification: "not_started" })).toBe(false);
		expect(shouldFallbackToSelfHosted(null)).toBe(false);
	});

	it("the billing fixture's real classification routes self-hosted; an ordinary failure and an unreadable annotation do not", async () => {
		const billing = loadActionsFixture("billing-annotation");
		const fromClassifier = classifyStartFailure({ status: "completed", steps: [] }, billing.annotations as never);
		expect(shouldFallbackToSelfHosted(fromClassifier)).toBe(true);

		vi.stubGlobal("fetch", fixtureFetch(loadActionsFixture("ordinary-failure")).fetch);
		expect(shouldFallbackToSelfHosted(await runStartFailure("acme/app", "tok", 900100))).toBe(false);
		vi.stubGlobal("fetch", fixtureFetch(loadActionsFixture("inaccessible-annotations")).fetch);
		const unreadable = await runStartFailure("acme/app", "tok", 900200);
		expect(unreadable).toMatchObject({ classification: "not_started", unreadable: { status: 403 } });
		expect(shouldFallbackToSelfHosted(unreadable)).toBe(false);
	});
});
