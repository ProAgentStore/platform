/** #1357 — a failed turn's STATED cause (`lastTurn.error`) decides before any reading of its prose. */
import { describe, expect, it } from "vitest";
import { EMPTY_STREAK, foldTurn, observeTurn, TURN_ERROR_MIN_CLI, type TurnCarry } from "./coding-turn-outcome.js";
import { structuredProviderError, validStructuredError } from "./engine-provider-error.js";
import { RUNNER_FEATURES } from "./runner-features.js";

const fresh = (): TurnCarry => ({ turns: EMPTY_STREAK, transientStreak: 0 });
const ctx = { repo: "acme/app", signInBlock: () => null };
const failed = (at: number, detail: string, error?: unknown) => ({ verdict: "failed", exitCode: 1, signal: null, at, detail, ...(error ? { error } : {}) }) as never;
const rule = (effects: unknown) => (effects as Array<{ event?: { name: string; data?: Record<string, unknown> } }>).find((e) => e.event?.name === "provider_error_classified")?.event?.data?.rule;

describe("validStructuredError", () => {
	it("keeps a well-formed error and bounds its strings", () => {
		expect(validStructuredError({ kind: "limit", provider: "anthropic (claude)", code: "429", resetsAt: 1_800_000_000_000 })).toEqual({ kind: "limit", provider: "anthropic (claude)", code: "429", resetsAt: 1_800_000_000_000 });
		expect(validStructuredError({ kind: "limit", provider: "x".repeat(500) })?.provider.length).toBeLessThan(80);
	});
	it("rejects anything a machine we do not control could send wrongly", () => {
		for (const bad of [null, "limit", [], {}, { kind: "nonsense", provider: "p" }, { kind: "limit" }, { kind: "limit", provider: "" }, { kind: 3, provider: "p" }]) expect(validStructuredError(bad)).toBeNull();
		expect(validStructuredError({ kind: "limit", provider: "p", resetsAt: -1, code: 429 })).toEqual({ kind: "limit", provider: "p" });
	});
});

describe("structuredProviderError", () => {
	it("is the stated kind, with rule structured/<kind>, quoting the turn's own words", () => {
		const e = structuredProviderError({ kind: "billing", provider: "anthropic (claude)", code: "402" }, "Credit balance is too low", ["a", "b"]);
		expect(e).toMatchObject({ kind: "billing", provider: "anthropic (claude)", rule: "structured/billing", evidence: "Credit balance is too low" });
		expect(e?.text).toBe("a\nb");
	});
	it("never acts on auth (sign-in has its own owner) or on no error", () => {
		expect(structuredProviderError({ kind: "auth", provider: "p" }, "Invalid API key", [])).toBeNull();
		expect(structuredProviderError(undefined, "x", [])).toBeNull();
	});
	it("still names the evidence when the turn printed nothing", () => {
		expect(structuredProviderError({ kind: "transient", provider: "p", code: "529" }, undefined, [])?.evidence).toMatch(/529/);
	});
});

describe("observeTurn / foldTurn with lastTurn.error", () => {
	it("records the validated error on the streak, and drops a malformed one", () => {
		expect(observeTurn(EMPTY_STREAK, failed(1, "boom", { kind: "limit", provider: "p" })).streak.lastError).toEqual({ kind: "limit", provider: "p" });
		expect(observeTurn(EMPTY_STREAK, failed(1, "boom", { kind: "wat", provider: "p" })).streak.lastError).toBeUndefined();
		expect(observeTurn(EMPTY_STREAK, failed(1, "boom")).streak).not.toHaveProperty("lastError");
	});
	it("a stated limit is classified structured/limit even when the words match no regex row", () => {
		const r = foldTurn(fresh(), { lastTurn: failed(1, "Something entirely unrecognisable", { kind: "limit", provider: "anthropic (claude)", code: "429" }) }, ctx);
		expect(rule(r.effects)).toBe("structured/limit");
	});
	it("the stated cause outranks the prose: a 503 whose words say 'rate limit' is transient", () => {
		const r = foldTurn(fresh(), { lastTurn: failed(1, "rate limit exceeded", { kind: "transient", provider: "p", code: "503" }) }, ctx);
		expect(rule(r.effects)).toBe("structured/transient");
	});
	it("CONTROL: with no stated error the text table still decides, as before", () => {
		const r = foldTurn(fresh(), { lastTurn: failed(1, "429 rate limit exceeded: usage limit reached") }, ctx);
		expect(String(rule(r.effects))).not.toMatch(/^structured/);
	});
	it("an auth error is carried but spends a strike like any unclassified failure", () => {
		const r = foldTurn(fresh(), { lastTurn: failed(1, "Invalid API key", { kind: "auth", provider: "p", code: "401" }) }, ctx);
		expect(rule(r.effects)).toBeUndefined();
		expect(r.carry.turns.consecutive).toBe(1);
	});
});

describe("TURN_ERROR_MIN_CLI", () => {
	it("is registered so an older runner is named as not reporting it", () => {
		expect(TURN_ERROR_MIN_CLI).toMatch(/^\d+\.\d+\.\d+$/);
		expect(RUNNER_FEATURES.some((f) => f.minCli === TURN_ERROR_MIN_CLI)).toBe(true);
	});
});
