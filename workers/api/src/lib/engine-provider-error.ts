/**
 * What a failed ENGINE turn's own words say about its AI provider (#1326).
 *
 * The coding CLIs (Claude Code, Codex, Gemini CLI, Grok, a local Ollama) talk to their providers
 * themselves, so a provider refusal reaches the platform only as the CLI's printed error. Before
 * this, none of them was read: a 529 "overloaded" or a usage-window refusal counted as one of the
 * three consecutive failed turns that end a run `engine_error`, and a usage limit was parked only
 * if the Pilot LLM happened to recognise it and call `wait_for_reset`. This table makes the common
 * cases deterministic.
 *
 * Three kinds, because each wants a different response:
 *
 *   * `limit`     — a usage/rate window. It reopens by itself, so the run PARKS (the existing
 *                   `engine_limit` park — backoff, bounded) instead of spending strikes.
 *   * `transient` — the provider is overloaded, erroring or unreachable. Retrying is the remedy:
 *                   the first is not a strike, a repeat parks briefly like a limit.
 *   * `billing`   — the account behind the CLI has no money or quota left. Nothing waiting or
 *                   retrying changes it, so the run ends at once with the provider's own words
 *                   and the page to go to, instead of after three strikes.
 *
 * Sign-in failures are NOT here: `engine-auth-prompt.ts` owns them and is checked first.
 *
 * Pure and table-driven: each row names the provider/engine it was written for, so a reworded
 * CLI error is a one-line change and a test, not a hunt. Matching is case-insensitive substring or
 * regex over the turn's detail and its last output lines. ORDER MATTERS: billing before limit
 * (`insufficient_quota` is a 429 on OpenAI), limit before transient (a 429 is not a 5xx).
 */

import { clipMarked } from "./clip-marked.js";
import type { ResetHint } from "./coding-wait.js";

export type EngineProviderErrorKind = "limit" | "transient" | "billing";

export interface EngineProviderError {
	kind: EngineProviderErrorKind;
	/** Who the matching row was written for, e.g. `openai (codex)`. */
	provider: string;
	/** The line of the engine's output that matched, verbatim (already redacted upstream). */
	evidence: string;
}

interface Row {
	kind: EngineProviderErrorKind;
	provider: string;
	match: RegExp;
}

/**
 * The table. Every pattern is a phrase the CLI or provider actually prints — read out of the installed CLIs (Claude Code
 * 2.1.310, Codex 0.164.0, Gemini CLI 0.57.0, Grok 1.0.62) in October 2026; keep the comment naming its source. Apostrophes
 * are matched as ['’]: Codex and Grok print the curly one.
 */
export const ENGINE_PROVIDER_ERRORS: readonly Row[] = [
	// FIRST, ahead of billing: Gemini's free-tier 429 says "You exceeded your current quota, please check your plan and billing"
	// — OpenAI's billing sentence — yet it is a rate window (`RESOURCE_EXHAUSTED`, "Quota exceeded for metric") that reopens.
	{ kind: "limit", provider: "google (gemini)", match: /resource_exhausted|quota exceeded for (?:quota )?metric|exhausted your capacity on this model|quota will reset after/i },

	// ── billing: no money / quota behind the account — ends the run with a remedy. Ending is the costliest response, so
	// every row is the provider's own token or a sentence only a CLI prints, never free text an app's tests print.
	// Claude Code: "Credit balance is too low", "You're out of usage credits", "Your org is out of usage · add funds", "You've hit your monthly spend limit."
	{ kind: "billing", provider: "anthropic (claude)", match: /^\s*credit balance is too low|api error.{0,200}credit balance is too low|you['’]re out of usage credits|org is out of usage|you['’]ve hit your monthly spend limit/im },
	// Codex: `insufficient_quota`, "You exceeded your current quota", "Your workspace is out of credits", "You hit your spend cap set in your workspace".
	{ kind: "billing", provider: "openai (codex)", match: /\binsufficient_quota\b|you exceeded your current quota|workspace is out of credits|hit your spend cap/i },
	// Grok: "You've hit the credit limit for your plan", "out of credits or over your spending limit", "Purchase credits to keep using Grok Build".
	{ kind: "billing", provider: "xai (grok)", match: /credit limit for your plan|over your spending limit|purchase credits to keep using grok/i },

	// ── limit: a usage or rate window that reopens by itself — park
	// Claude Code: "You've hit your session limit · resets 3am" (also weekly/Opus/Sonnet/Fable limit), the older "Claude usage
	// limit reached … will reset", and the API's `rate_limit_error`.
	{ kind: "limit", provider: "anthropic (claude)", match: /you['’]ve hit your (?:session|weekly|opus|sonnet|fable|fast) limit|claude usage limit reached|limit will reset|\brate_limit_error\b/i },
	// Codex: "You've hit your usage limit. Visit https://chatgpt.com/settings/usage…", `rate_limit_exceeded`, `usage_limit_reached`, "Rate limit reached for".
	{ kind: "limit", provider: "openai (codex)", match: /you['’]ve hit your usage limit|\brate_limit_exceeded\b|\busage_limit_reached\b|rate limit reached for/i },
	// Grok: "You've hit your team's API rate limit", "You've hit the rate limit for your plan", "You've reached your free Grok Build
	// usage limit", "You hit your free usage limit", "You hit your weekly limit".
	{ kind: "limit", provider: "xai (grok)", match: /hit your team['’]s api rate limit|hit the rate limit for your plan|reached your free .{0,20}usage limit|you hit your (?:free usage|weekly) limit/i },
	// Any CLI: "Usage limit reached" (Gemini "…for all Pro models", Codex), and a 429 as the CLI frames it — never a bare
	// "status 429", which is as likely the project's own failing test.
	{ kind: "limit", provider: "any", match: /\busage limit reached\b|\bapi error:?\s*429\b|\b429 too many requests\b/i },

	// ── transient: overloaded / server error / network — retry. Cheap when wrong (one free retry, then a short park), but
	// still anchored to how the CLI frames it.
	// Claude Code: 529 `overloaded_error`, "API Error: 500 {…"type":"api_error"…}", "Server is temporarily limiting requests
	// (not your usage limit)", "Opus is experiencing high load".
	{ kind: "transient", provider: "anthropic (claude)", match: /\boverloaded_error\b|api error.{0,40}"type":\s*"api_error"|temporarily limiting requests|is experiencing high load/i },
	// Codex: "Selected model is at capacity", "We're currently experiencing high demand", "exceeded retry limit, last status: 500",
	// "stream disconnected before completion".
	{ kind: "transient", provider: "openai (codex)", match: /model is at capacity|currently experiencing high demand|last status: 5\d\d|unexpected status 5\d\d|stream disconnected before completion/i },
	// Gemini CLI: "[API Error: … (Status: INTERNAL)]" / UNAVAILABLE / DEADLINE_EXCEEDED, in its own framing or the API's JSON.
	{ kind: "transient", provider: "google (gemini)", match: /\(status: (?:internal|unavailable|deadline_exceeded)\)|"status":\s*"(?:INTERNAL|UNAVAILABLE|DEADLINE_EXCEEDED)"/i },
	// Grok: "Model is temporarily overloaded", "The service is busy. Wait a minute", "API error (status 503)".
	{ kind: "transient", provider: "xai (grok)", match: /model is temporarily overloaded|service is busy\. wait|api error \(status 5\d\d/i },
	// Any CLI: "API Error: 503 …".
	{ kind: "transient", provider: "any", match: /\bapi error:?\s*5\d\d\b/i },
	// Network, only as the CLI frames it: Claude "API Error: Connection error." / "Request timed out." / "Unable to connect to API.",
	// Gemini "[API Error: request to https://… failed, reason: ECONNRESET]" (a long URL sits between). A bare ECONNREFUSED is just
	// as likely the project's own test output on a turn that failed for real.
	{ kind: "transient", provider: "network", match: /api error:?.{0,240}(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|connection error|request timed out|unable to connect to api)/i },
];

/** Read a failed turn. Null when nothing in it is a provider statement — then the ordinary failed-turn handling applies. */
export function engineProviderError(detail: string | undefined, tail: readonly string[] | undefined): EngineProviderError | null {
	// Rows outrank lines: the first ROW that matches anywhere decides, so billing beats a limit beats a transient
	// failure wherever each sits. Within a row the newest line is quoted, being where a CLI says why it stopped.
	const lines = [...(tail ?? [])].reverse();
	if (detail) lines.unshift(detail);
	for (const row of ENGINE_PROVIDER_ERRORS) {
		for (const line of lines) {
			if (row.match.test(line)) return { kind: row.kind, provider: row.provider, evidence: clipMarked(line.trim(), 300, { within: true }) };
		}
	}
	return null;
}

/** What the Pilot is told when a turn failed on a transient provider error it should simply resend. */
export function transientProviderNote(e: EngineProviderError): string {
	return `the engine's AI provider failed transiently (${e.provider}): "${e.evidence}". This is NOT a problem with your instruction and does not count against the engine — send the SAME instruction again. If it fails the same way again the run waits and retries by itself.`;
}

/** Why the run is parking, in the owner's thread and the run row. */
export function providerParkReason(e: EngineProviderError, repeatedTransient: boolean): string {
	return e.kind === "limit"
		? `The coding CLI's AI provider reported a usage or rate limit (${e.provider}): "${e.evidence}". Waiting for the window to reopen, then continuing.`
		: `The coding CLI's AI provider kept failing transiently (${e.provider})${repeatedTransient ? " on consecutive turns" : ""}: "${e.evidence}". Waiting, then retrying.`;
}

/** The run's ending when the account behind the CLI has no money or quota: the provider's words and where to fix it. */
export function providerBillingDetail(e: EngineProviderError, repo: string): string {
	return `The coding CLI in ${repo} stopped because its AI provider account has no credit or quota left (${e.provider}): "${e.evidence}". This is the account the CLI is signed in with on the machine, not your PAGS API key. Top it up or switch plans at the provider, then continue the run. Waiting or retrying will not change it.`;
}

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/**
 * When the limit lifts, as the CLI printed it (#1344) — a hint the planner places in time, or null. Read without a clock
 * (the loop is replayed): Codex "try again in 2 hours", Gemini "quota will reset after 3h12m", Claude "resets 3am
 * (Australia/Melbourne)", Codex "try again at 4:12 PM", and a reset on a named day ("resets Aug 17", "resets Mon 9am").
 */
export function resetHintFromLine(line: string): ResetHint | null {
	// Units as words ("2 hours") or single letters, which may run straight into the next number ("3h12m").
	// Days count too (#1362): Codex's weekly limit prints "try again in 2 days 3 hours", which is beyond any run's wait.
	const rel = /\b(?:in|after)\s+((?:\d+\s*(?:(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)\b|[dhms](?=\d|\b))\s*(?:and\s*|,\s*)?)+)/i.exec(line);
	if (rel) {
		let ms = 0;
		for (const [, n, unit] of rel[1].matchAll(/(\d+)\s*([dhms])/gi)) ms += Number(n) * UNIT_MS[unit.toLowerCase()];
		if (ms > 0) return { inMs: ms };
	}
	// A named day or month only when a date or time follows it (#1362): "resets Aug 17", "resets Mon 9am" — never
	// "resets monthly" or "resets may vary".
	if (/\bresets?\s+(?:on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d)/i.test(line)) return { far: true };
	const clock = /\b(?:resets?|try again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([A-Za-z]+\/[A-Za-z_/]+)\))?/i.exec(line);
	if (clock) {
		const h12 = Number(clock[1]) % 12;
		const hour = clock[3].toLowerCase() === "pm" ? h12 + 12 : h12;
		const minute = clock[2] ? Number(clock[2]) : 0;
		if (hour < 24 && minute < 60) return { clock: { hour, minute }, ...(clock[4] ? { zone: clock[4] } : {}) };
	}
	return null;
}

/**
 * What the loop does with a failed turn's provider reading. Null when the turn is not a provider failure — the ordinary
 * strike applies. A billing failure ends; a limit, or a transient failure on the turn after another, parks; a first
 * transient failure is retried. `transientStreak` is the count to carry to the next failed turn.
 */
export interface ProviderTurnVerdict {
	end?: string;
	park?: string;
	/** A limit parks on the usage-limit budget; a repeated transient failure on its own short ladder (#1344). */
	waitKind?: "limit" | "transient";
	resetHint?: ResetHint;
	retry?: string;
	transientStreak: number;
}

export function providerTurnVerdict(e: EngineProviderError | null, transientStreak: number, repo: string): ProviderTurnVerdict | null {
	if (!e) return null;
	if (e.kind === "billing") return { end: providerBillingDetail(e, repo), transientStreak: 0 };
	if (e.kind === "limit") {
		const resetHint = resetHintFromLine(e.evidence);
		return { park: providerParkReason(e, false), waitKind: "limit", ...(resetHint ? { resetHint } : {}), transientStreak: 0 };
	}
	if (transientStreak >= 1) return { park: providerParkReason(e, true), waitKind: "transient", transientStreak: 0 };
	return { retry: transientProviderNote(e), transientStreak: transientStreak + 1 };
}
