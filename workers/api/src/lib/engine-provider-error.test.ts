/**
 * #1326 — a failed engine turn is read for its AI provider's own words, for every engine. Each row below is a phrase the CLI or
 * provider prints; the loop tests drive the real `runCodingLoop` with an engine that fails that way.
 */
import { describe, expect, it } from "vitest";
import { stopReasonFor } from "./coding-pause.js";
import { type CodingDecision, type CodingDeps, type CodingGoal, type CodingPaneSnapshot, runCodingLoop } from "./coding-loop.js";
import { engineProviderError } from "./engine-provider-error.js";

describe("the table: what each engine's provider says, and what it means", () => {
	// Strings read out of the installed CLIs (Claude Code 2.1.310, Codex 0.164.0, Gemini CLI 0.57.0, Grok 1.0.62), verbatim
	// including their curly apostrophes, unless marked as the provider API's own body.
	const cases: Array<[string, string, "limit" | "transient" | "billing" | null]> = [
		// Claude Code (Anthropic)
		["claude", "You’ve hit your session limit · resets 3am (Australia/Melbourne)", "limit"],
		["claude", "You've hit your weekly limit · resets Mon 9am", "limit"],
		["claude", "Claude usage limit reached. Your limit will reset at 10pm (Australia/Melbourne).", "limit"],
		["claude", 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', "limit"],
		["claude", "You're out of usage credits", "billing"],
		["claude", "Your org is out of usage · add funds to continue", "billing"],
		["claude", "You've hit your monthly spend limit.", "billing"],
		["claude", "Credit balance is too low", "billing"],
		["claude", 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', "billing"],
		["claude", 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "transient"],
		["claude", 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', "transient"],
		["claude", "Server is temporarily limiting requests (not your usage limit)", "transient"],
		["claude", "Opus is experiencing high load. Switch to Sonnet.", "transient"],
		["claude", "API Error: Connection error.", "transient"],
		["claude", "API Error: Request timed out.", "transient"],
		["claude", "API Error: Unable to connect to API.", "transient"],
		// Codex (OpenAI)
		["codex", "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 4:12 PM.", "limit"],
		["codex", 'stream error: {"code":"rate_limit_exceeded","message":"Rate limit reached for gpt-5 in organization org-x"}', "limit"],
		["codex", "error: usage_limit_reached", "limit"],
		["codex", 'ERROR: {"error":{"type":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}', "billing"],
		["codex", "Your workspace is out of credits. Add credits to continue.", "billing"],
		["codex", "You hit your spend cap set in your workspace settings.", "billing"],
		["codex", "Selected model is at capacity. Please try a different model.", "transient"],
		["codex", "We’re currently experiencing high demand, which may cause temporary errors.", "transient"],
		["codex", "exceeded retry limit, last status: 500 Internal Server Error", "transient"],
		["codex", "stream disconnected before completion: error sending request", "transient"],
		// Gemini CLI (Google) — "[API Error: <msg> (Status: <status>)]" is the CLI's own framing
		["gemini", "[API Error: You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests (Status: RESOURCE_EXHAUSTED)]", "limit"],
		["gemini", "You have exhausted your capacity on this model. Your quota will reset after 3h12m.", "limit"],
		["gemini", "Usage limit reached for all Pro models.", "limit"],
		["gemini", "[API Error: Internal error encountered. (Status: INTERNAL)]", "transient"],
		["gemini", '[API Error: {"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}]', "transient"],
		["gemini", "[API Error: request to https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse failed, reason: ECONNRESET]", "transient"],
		// Grok (xAI)
		["grok", "You’ve hit your team’s API rate limit. Try again shortly.", "limit"],
		["grok", "You've hit the rate limit for your plan.", "limit"],
		["grok", "You’ve reached your free Grok Build usage limit for now.", "limit"],
		["grok", "You hit your weekly limit.", "limit"],
		["grok", "You’ve hit the credit limit for your plan.", "billing"],
		["grok", "You're out of credits or over your spending limit. Add credits and retry.", "billing"],
		["grok", "Purchase credits to keep using Grok Build", "billing"],
		["grok", "Model is temporarily overloaded. Try again in a moment.", "transient"],
		["grok", "The service is busy. Wait a minute and send again.", "transient"],
		["grok", "API error (status 503)", "transient"],
		// Not provider statements: a project's own output on a turn that failed for real, and engine misconfiguration.
		["any", "expected status 200, got status 500", null],
		["any", "Error: connect ECONNREFUSED 127.0.0.1:5432", null],
		["any", "expect(cart.total).toBe(0) — user has no credits remaining", null],
		["any", "✓ shows 'No credits remaining' banner — No credit card required", null],
		["any", "This feature requires billing to be enabled", null],
		["any", "it('shows the credit balance is too low banner') failed", null],
		["any", "expected 503 SERVICE UNAVAILABLE", null],
		["any", "OAuth callback returned error=server_error", null],
		["any", "An error occurred while processing your request.", null],
		["any", "Connection error", null],
		["codex", "Not inside a trusted directory and --skip-git-repo-check was not specified.", null],
		["grok", 'Error: model "grok-9-imaginary" not found (400 invalid_request_error)', null],
	];
	for (const [engine, line, kind] of cases) {
		it(`${engine}: ${line.slice(0, 70)} → ${kind ?? "not a provider error"}`, () => {
			expect(engineProviderError(undefined, ["some earlier output", line])?.kind ?? null).toBe(kind);
		});
	}

	it("ranks by what the run must do, not by line order: billing over a limit over a transient failure", () => {
		// A CLI often prints a retry line before the verdict; the verdict that changes the response wins wherever it sits.
		expect(engineProviderError("API Error: 529 overloaded_error", ["Claude usage limit reached."])?.kind).toBe("limit");
		expect(engineProviderError(undefined, ["Claude usage limit reached.", "API Error: 529 overloaded_error"])?.kind).toBe("limit");
		expect(engineProviderError(undefined, ["usage_limit_reached", "insufficient_quota"])?.kind).toBe("billing");
		// …except Gemini's free-tier 429, which borrows OpenAI's billing sentence but is a rate window.
		expect(engineProviderError(undefined, ["You exceeded your current quota, please check your plan and billing details. (Status: RESOURCE_EXHAUSTED)"])?.kind).toBe("limit");
	});

	it("quotes the matching line as evidence and names who the row was written for", () => {
		expect(engineProviderError(undefined, ["  error: usage_limit_reached  "])).toEqual({ kind: "limit", provider: "openai (codex)", evidence: "error: usage_limit_reached" });
	});
});

describe("runCodingLoop: a provider failure is handled by kind, not spent as an engine strike", () => {
	const GOAL: CodingGoal = { objective: "add a test", repo: "demo", clientType: "codex" };

	/** An engine whose turns fail with the given tails in order (the last repeats), or succeed on `null`. */
	function engine(tails: Array<string[] | null>, decisions: CodingDecision[]) {
		let at = 1_000;
		let turn = 0;
		let lastTurn: CodingPaneSnapshot["lastTurn"];
		const sent: string[] = [];
		const seen: string[][] = [];
		let i = 0;
		const snap = (): CodingPaneSnapshot => ({ pane: "", runState: "idle", ready: true, alive: true, ...(lastTurn ? { lastTurn } : {}) });
		const deps: CodingDeps = {
			snapshot: async () => snap(),
			waitIdle: async () => snap(),
			act: async (a) => {
				sent.push(a.kind === "message" ? a.text : a.kind);
				at += 1000;
				const tail = tails[Math.min(turn++, tails.length - 1)];
				lastTurn = tail === null ? { verdict: "ok", exitCode: 0, signal: null, at } : { verdict: "failed", exitCode: 1, signal: null, at, detail: tail[tail.length - 1], tail };
				return snap();
			},
			decide: async (p) => {
				seen.push([...p.actionLog]);
				return decisions[Math.min(i++, decisions.length - 1)];
			},
		};
		return { deps, sent, seen };
	}
	const again: CodingDecision = { action: { kind: "message", text: "run the tests" } };

	it("a usage limit parks the run on the first failed turn (engine_limit), whatever the Pilot would have made of it", async () => {
		const { deps, sent } = engine([["ERROR: You've hit your usage limit. Try again in 2 hours."]], [again]);
		const r = await runCodingLoop(deps, GOAL, { maxSteps: 30 });
		expect(r.outcome).toBe("waiting");
		expect(r.detail).toContain("usage or rate limit (openai (codex))");
		expect(stopReasonFor(r.outcome)).toBe("engine_limit");
		expect(sent).toHaveLength(1);
	});

	it("after the park, the next round RETRIES — the turn that parked it is not read as a new limit", async () => {
		// Review finding: a new round starts with an empty streak, and the first snapshot still carries the parked turn.
		const { deps, sent } = engine([["Claude usage limit reached. Your limit will reset at 10pm."], null], [again, again, { finish: { status: "done", detail: "ok" } }]);
		expect((await runCodingLoop(deps, GOAL, { maxSteps: 30 })).outcome).toBe("waiting");
		const second = await runCodingLoop(deps, GOAL, { maxSteps: 30 });
		expect(second.outcome).toBe("done");
		expect(sent).toHaveLength(2);
	});

	it("one transient provider failure is retried and is NOT a strike; the Pilot is told to resend", async () => {
		const { deps, sent, seen } = engine([['API Error: 529 {"type":"overloaded_error"}'], null], [again, again, { finish: { status: "done", detail: "ok" } }]);
		const r = await runCodingLoop(deps, GOAL, { maxSteps: 30 });
		expect(r.outcome).toBe("done");
		expect(sent).toHaveLength(2);
		expect(seen[1].join("\n")).toContain("send the SAME instruction again");
		expect(seen[1].join("\n")).not.toMatch(/refusing to run/);
	});

	it("a transient failure that repeats on the next turn parks and retries later instead of dying", async () => {
		const { deps, sent } = engine([["API Error: 503 Service Unavailable"]], [again]);
		const r = await runCodingLoop(deps, GOAL, { maxSteps: 30 });
		expect(r.outcome).toBe("waiting");
		expect(r.detail).toMatch(/kept failing transiently/);
		expect(sent).toHaveLength(2);
	});

	it("an empty provider account ends the run at once with where to fix it — not after three strikes", async () => {
		const { deps, sent } = engine([['{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}']], [again]);
		const r = await runCodingLoop(deps, GOAL, { maxSteps: 30 });
		expect(r.outcome).toBe("engine_error");
		expect(r.detail).toContain("no credit or quota left");
		expect(r.detail).toContain("not your PAGS API key");
		expect(sent).toHaveLength(1);
	});

	it("a real failure right after a transient one still counts — the transient pass does not hide it", async () => {
		const REFUSAL = "Not inside a trusted directory and --skip-git-repo-check was not specified.";
		const { deps, seen } = engine([["API Error: 502 Bad Gateway"], [REFUSAL]], [again, again, { finish: { status: "failed", detail: "x" } }]);
		await runCodingLoop(deps, GOAL, { maxSteps: 30 });
		expect(seen[2].join("\n")).toMatch(/refusing to run/);
	});

	it("an engine that refuses for its own reasons still ends after three strikes, unchanged", async () => {
		// Different instructions each time, as in #545's production run — a repeated one trips #522's guard instead.
		const { deps, sent } = engine([["Not inside a trusted directory and --skip-git-repo-check was not specified."]], ["one", "two", "three", "four"].map((text) => ({ action: { kind: "message" as const, text } })));
		const r = await runCodingLoop(deps, GOAL, { maxSteps: 30 });
		expect(r.outcome).toBe("engine_error");
		expect(sent).toHaveLength(3);
	});
});
