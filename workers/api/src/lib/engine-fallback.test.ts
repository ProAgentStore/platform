/**
 * #1621 — a coding run whose engine's AI subscription is spent moves to the next configured one.
 *
 * Driven from the runner's report of the failed turn through `foldTurn` (the existing detection, #1326) into `resolvePause`, as the workflow does.
 * Only the machine, the clock and the session switch are stand-ins.
 */
import { describe, expect, it } from "vitest";
import type { CodingEngine } from "./coding-engines.js";
import type { CodingResult } from "./coding-loop.js";
import { type PauseDeps, resolvePause } from "./coding-pause.js";
import { EMPTY_STREAK, foldTurn } from "./coding-turn-outcome.js";
import type { EngineWaitState } from "./coding-wait.js";
import { nextFallbackEngine, quotaStop } from "./engine-fallback.js";

const E = (id: string, fallbackId?: string): CodingEngine => ({ id, label: id.toUpperCase(), command: id, ...(fallbackId ? { fallbackId } : {}) });

describe("nextFallbackEngine", () => {
	it("follows the chain and never returns a preset the run already used", () => {
		const engines = [E("codex", "claude"), E("claude", "gemini"), E("gemini")];
		expect(nextFallbackEngine(engines, "codex", [])?.id).toBe("claude");
		expect(nextFallbackEngine(engines, "claude", ["codex"])?.id).toBe("gemini");
		expect(nextFallbackEngine(engines, "gemini", ["codex", "claude"])).toBeNull();
	});
	it("ends a cycle instead of looping and ignores a dangling pointer", () => {
		expect(nextFallbackEngine([E("a", "b"), E("b", "a")], "b", ["a"])).toBeNull();
		expect(nextFallbackEngine([E("a", "gone")], "a", [])).toBeNull();
		expect(nextFallbackEngine([E("a")], "a", [])).toBeNull();
	});
});

describe("quotaStop", () => {
	it("is a usage limit or an empty account, never a transient failure", () => {
		expect(quotaStop({ outcome: "waiting", waitKind: "limit" })).toBe("limit");
		expect(quotaStop({ outcome: "waiting" })).toBe("limit");
		expect(quotaStop({ outcome: "waiting", waitKind: "transient" })).toBeNull();
		expect(quotaStop({ outcome: "engine_error", providerError: { kind: "billing" } })).toBe("billing");
		expect(quotaStop({ outcome: "engine_error", providerError: { kind: "limit" } })).toBeNull();
		expect(quotaStop({ outcome: "done" })).toBeNull();
	});
});

function run(opts: { chain: CodingEngine[]; startId: string; line: string }) {
	const facts: string[] = [];
	const notified: Array<{ title: string; alert: boolean }> = [];
	const announced: string[] = [];
	let current = opts.startId;
	const deps: PauseDeps = {
		repo: "acme/app",
		instanceId: "i1",
		now: () => 1_800_000_000_000,
		takeover: async () => undefined,
		takeoverStatus: async () => ({ resolved: false }),
		endTakeover: async () => undefined,
		sleep: async () => undefined,
		notify: async (title, _b, _k, alert) => void notified.push({ title, alert }),
		announce: async (m) => void announced.push(m),
		card: async () => undefined,
		tick: async () => true,
		reauthCompletedSince: async () => false,
		restartEngine: async () => undefined,
		trace: async (name) => void facts.push(name),
		switchEngine: async (tried) => {
			const cur = opts.chain.find((e) => e.id === current) as CodingEngine;
			const next = nextFallbackEngine(opts.chain, cur.id, tried);
			if (!next) return { ok: false, exhausted: tried.length > 0 || !!cur.fallbackId, labels: [cur.label], why: "none left" };
			current = next.id;
			return { ok: true, fromId: cur.id, from: cur.label, to: next.label };
		},
	};
	const state: EngineWaitState = { waits: 0, spentMs: 0 };
	const fail = async () => {
		const folded = foldTurn({ turns: EMPTY_STREAK, transientStreak: 0 }, { lastTurn: { verdict: "failed", exitCode: 1, signal: null, at: Date.now(), detail: "[exit 1]", tail: [opts.line] } }, { repo: "acme/app", signInBlock: () => null });
		const { kind: _k, ...result } = folded.ending as { kind: string } & CodingResult;
		return resolvePause(deps, { round: 0, result: { ...result, steps: 3 } as CodingResult, state });
	};
	return { fail, facts, notified, announced, state, current: () => current };
}

describe("a spent subscription", () => {
	const chain = [E("codex", "claude"), E("claude")];

	it("codex usage limit: switches to claude and resumes instead of parking", async () => {
		const r = run({ chain, startId: "codex", line: "You've hit your usage limit. Try again in 3 hours." });
		const v = await r.fail();
		expect(v.resume).toBe(true);
		expect(r.current()).toBe("claude");
		expect(r.facts).toContain("engine_fallback");
		expect(r.state.enginesTried).toEqual(["codex"]);
		expect(r.announced[0]).toContain("CODEX");
		expect(r.announced[0]).toContain("CLAUDE");
	});

	it("codex out of credits: switches instead of ending engine_error", async () => {
		const r = run({ chain, startId: "codex", line: "Your workspace is out of credits." });
		expect((await r.fail()).resume).toBe(true);
		expect(r.current()).toBe("claude");
	});

	it("every subscription spent: alerts a human and the run ends as before", async () => {
		const r = run({ chain, startId: "codex", line: "Your workspace is out of credits." });
		await r.fail();
		const v = await r.fail();
		expect(v.resume).toBe(false);
		if (!v.resume) expect(v.result.outcome).toBe("engine_error");
		expect(r.facts).toContain("engine_fallback_exhausted");
		expect(r.notified).toEqual([{ title: "Coder is out of AI subscriptions", alert: true }]);
	});

	it("no fallback configured: unchanged, and nobody is alerted", async () => {
		const r = run({ chain: [E("codex")], startId: "codex", line: "Your workspace is out of credits." });
		const v = await r.fail();
		expect(v.resume).toBe(false);
		expect(r.facts).toEqual([]);
		expect(r.notified).toEqual([]);
	});
});
