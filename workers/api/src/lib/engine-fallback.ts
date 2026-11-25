/**
 * Switching to the next AI subscription when the current one is spent (#1621).
 *
 * An engine preset names the preset to fall back to (`CodingEngine.fallbackId`), so "Codex, then Claude" is
 * configuration, not code. Detection is NOT here: the run already classifies a refused turn
 * (`engine-provider-error.ts`: `limit` parks, `billing` ends). This module only decides what to do with that
 * verdict before it parks or ends — try the next subscription — and words what the owner is told.
 *
 * No Env and no I/O of its own: every effect goes through `PauseDeps`. The switch itself (session row, engine restart) is `workflows/coding-session/pause-effects.ts`.
 */

import { clipMarked } from "./clip-marked.js";
import type { CodingResult } from "./coding-loop.js";
import type { EngineWaitState } from "./coding-wait.js";
import type { ProviderErrorRecord } from "./engine-provider-error.js";

/** The session switch `PauseDeps.switchEngine` performs (#1621); `exhausted` is true when a chain was configured and has nothing left. */
export type SwitchEngine = (tried: string[]) => Promise<{ ok: true; fromId: string; from: string; to: string } | { ok: false; exhausted: boolean; labels: string[]; why: string }>;

/** The slice of `PauseDeps` the fallback uses — declared here so this module never imports `coding-pause.ts` (a static cycle the import-graph test forbids). */
export interface FallbackDeps {
	repo: string;
	switchEngine?: SwitchEngine;
	trace?: (name: string, message: string, data: Record<string, unknown>) => Promise<void>;
	notify: (title: string, body: string, key: string, alert: boolean) => Promise<void>;
	announce: (message: string) => Promise<void>;
}

/** A refused turn that means the subscription behind the engine is spent: `billing` (no credit — nothing waiting fixes it) or `limit` (a usage window that reopens later). */
export type QuotaStop = "billing" | "limit";

/**
 * Is this run result the engine's own subscription running out? A provider failing TRANSIENTLY is not (retrying is
 * its remedy), and neither is any other failure. `waiting` without a `waitKind` of `transient` is a usage limit,
 * whether the platform's table or the Pilot's own `wait_for_reset` raised it.
 */
export function quotaStop(result: { outcome: string; waitKind?: "limit" | "transient"; providerError?: Pick<ProviderErrorRecord, "kind"> }): QuotaStop | null {
	if (result.outcome === "waiting" && result.waitKind !== "transient") return "limit";
	if (result.outcome === "engine_error" && result.providerError?.kind === "billing") return "billing";
	return null;
}

/**
 * The next preset to run on after `currentId`: follow the `fallbackId` chain, skipping any preset this run already
 * used (`tried`) so a cycle (A to B to A) ends instead of looping. Null when the chain has nothing left.
 */
export function nextFallbackEngine<E extends { id: string; fallbackId?: string }>(engines: readonly E[], currentId: string, tried: readonly string[]): E | null {
	const seen = new Set([...tried, currentId]);
	let cur = engines.find((e) => e.id === currentId);
	for (let hop = 0; cur?.fallbackId && hop < engines.length; hop++) {
		const wanted: string = cur.fallbackId;
		const next = engines.find((e) => e.id === wanted);
		if (!next) return null;
		if (!seen.has(next.id)) return next;
		cur = next;
	}
	return null;
}

/** What the owner is told in the thread when the run switches subscription. */
export function engineFallbackMessage(repo: string, from: string, to: string, why: QuotaStop, evidence: string | undefined): string {
	const cause = why === "billing" ? "has no credit or quota left" : "hit its usage limit";
	return `🔁 **Switching AI subscription** on ${repo}: ${from} ${cause}${evidence ? ` ("${evidence}")` : ""}, so this session now runs **${to}** — the fallback you configured — and the instruction is resent. It goes back to ${from} when the run ends.`;
}

/** What the Pilot is told on the engine that replaces the spent one. */
export function engineFallbackNote(from: string, to: string): string {
	return `The platform switched this session's engine from ${from} to ${to} — the fallback the owner configured — because ${from}'s AI subscription is out of funds or at its limit. It is the same session and the same working tree, but ${to} has not read this conversation. Send your last instruction again. The switch is undone when this run ends.`;
}

/** The alert when every configured subscription is spent: what was tried, in order, and what the owner does. */
export function enginesExhaustedMessage(repo: string, labels: readonly string[]): string {
	return `${repo}: every configured AI subscription is out of funds or at its limit (${labels.join(", then ")}). Top one up, or add another engine as a fallback, then continue the run.`;
}

/**
 * The engine's subscription is spent — out of funds, or at its usage limit (#1621): run on the next one the owner configured instead of ending
 * (billing) or parking (limit). Null when this is not that, or no switch is possible — then the ordinary ending or park applies, and when a configured
 * chain is used up the owner is alerted, because nothing will recover on its own then.
 */
export async function fallBackToNextEngine(deps: FallbackDeps, input: { result: CodingResult; state: EngineWaitState }): Promise<{ resume: true; resumeNote: string } | null> {
	const { result, state } = input;
	const why = quotaStop(result);
	if (!why || !deps.switchEngine) return null;
	const err = result.providerError;
	const switched = await deps.switchEngine(state.enginesTried ?? []);
	if (!switched.ok) {
		if (switched.exhausted) {
			await deps.trace?.("engine_fallback_exhausted", `Every configured AI subscription is spent (${switched.labels.join(", then ")}): ${switched.why}.`, { attempt: 0, why, engines: switched.labels });
			await deps.notify("Coder is out of AI subscriptions", enginesExhaustedMessage(deps.repo, switched.labels), "engine-fallback-exhausted", true);
			await deps.announce(`⛔ ${enginesExhaustedMessage(deps.repo, switched.labels)}`);
		}
		return null;
	}
	state.enginesTried = [...(state.enginesTried ?? []), switched.fromId];
	const evidence = err ? clipMarked(err.text, 200, { keep: "tail" }) : undefined;
	await deps.trace?.("engine_fallback", `${switched.from} is out of funds or at its limit (${why}); the session now runs ${switched.to}.`, { attempt: state.enginesTried.length, why, from: switched.from, to: switched.to, ...(err ? { rule: err.rule, provider: err.provider } : {}) });
	await deps.announce(engineFallbackMessage(deps.repo, switched.from, switched.to, why, evidence));
	return { resume: true, resumeNote: engineFallbackNote(switched.from, switched.to) };
}
