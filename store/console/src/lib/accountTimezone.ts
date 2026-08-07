/**
 * The owner's timezone in the console — seeded once, then honoured (#345).
 *
 * #329 gave every agent a clock in the user's own zone, read from `users.preferences.timezone`.
 * Nothing ever wrote that field. So the fix shipped and the standing case stayed "unset": every
 * agent kept narrating in UTC until an owner discovered a setting that had no UI. This module is
 * the missing half — it makes unset a TRANSIENT state instead of a permanent one.
 *
 * ── Seed, do not bind
 *
 * The browser knows the machine's zone for free, and #329 deliberately rejected it as the SOURCE OF
 * TRUTH: it changes when you travel, it is absent on every non-browser path (cron triggers, the
 * pump, MCP), and it is not something the owner can correct. Writing it ONCE, when the stored value
 * is empty, is the useful half of that; re-asserting it on every load would reintroduce all three
 * problems — an owner who set Australia/Sydney and then opened the console from a hotel in Tokyo
 * would find their setting silently rewritten, which is worse than never having asked.
 *
 * So `timezoneSeed` returns null the moment anything is stored. That is the whole rule, and it is
 * pure so it can be tested without a network or a React tree (#282: this console has no
 * component-testing infrastructure, so the decision lives here and not in a component).
 *
 * ── And a second, quieter rule: don't record a non-answer
 *
 * `parseAccountPreferences` keeps `undefined` and `"UTC"` distinguishable on purpose — one is a
 * user nobody asked, the other a user who really is there — and seeding must not collapse them. A
 * browser resolving to `UTC` is overwhelmingly a machine whose clock was never configured (a VM, a
 * locked-down laptop), not somebody in Reykjavík; real UTC-adjacent users resolve to
 * `Atlantic/Reykjavik` or `Europe/London`. Recording it would convert "nobody told us" into "the
 * user is in UTC" and switch off the honest hedge in `clockPrompt`'s unset branch — while changing
 * no displayed hour at all, since the two render identically. Nothing is lost by declining.
 */
import { useSyncExternalStore } from "react";
import { api } from "@proagentstore/sdk/client";

/**
 * The zone this machine claims, or null when the runtime will not say.
 *
 * Distinct from `triggerSchedule.browserTimeZone()`, which falls back to `"UTC"` because its caller
 * needs SOMETHING to put in a select. Here the difference matters: a fallback would be recorded as
 * the user's answer.
 */
export function machineTimeZone(): string | null {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
	} catch {
		return null;
	}
}

/** Every zone the browser knows, when it can tell us; a usable shortlist when it cannot. */
export function timeZoneOptions(current?: string): string[] {
	const withCurrent = (list: string[]) => (current && !list.includes(current) ? [current, ...list] : list);
	try {
		const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
		if (typeof supported === "function") return withCurrent(["UTC", ...supported("timeZone")]);
	} catch {
		// fall through
	}
	return withCurrent(["UTC", "Australia/Melbourne", "Australia/Sydney", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Singapore"]);
}

/**
 * Mirrors the server's `isValidTimeZone` (`lib/cron-time.ts`), including its 64-char bound, so the
 * platform keeps ONE timezone vocabulary. A value this rejects would be rejected by `PUT
 * /v1/preferences` with a 400 anyway — better not to send it.
 */
function isRealZone(value: string): boolean {
	if (!value || value.length > 64) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/** Zones that mean "this machine was never told where it is". See the header note. */
const NON_ANSWERS = new Set(["UTC", "Etc/UTC", "GMT", "Etc/GMT", "Etc/Greenwich", "Universal", "Zulu"]);

/**
 * The zone to WRITE, or null for "leave it alone".
 *
 * PURE. Null on every path but one: nothing stored, and the browser gave a real, informative zone.
 */
export function timezoneSeed(stored: unknown, browser: string | null | undefined): string | null {
	// Anything already stored wins, forever. This is the seed-don't-bind rule.
	if (typeof stored === "string" && stored.trim()) return null;
	const zone = typeof browser === "string" ? browser.trim() : "";
	if (!zone || NON_ANSWERS.has(zone) || !isRealZone(zone)) return null;
	return zone;
}

// ── The store ────────────────────────────────────────────────────────────────────────────────
//
// Module-level rather than a context, so the seed fires ONCE per page load no matter how many
// components read it, and so `stampTitle` can be handed a zone without threading a prop through
// the transcript. `undefined` is the unset state here too — a reader falls back to the browser's
// zone, which is what it did before this existed.

let zone: string | undefined;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function publish(next: string | undefined): void {
	if (zone === next) return;
	zone = next;
	for (const fn of listeners) fn();
}

/** The stored account zone, or undefined when it is unset / not yet loaded. */
export function accountTimeZone(): string | undefined {
	return zone;
}

/** Called by the Preferences page after a save, so the transcript re-renders without a reload. */
export function setAccountTimeZone(next: string | undefined): void {
	publish(next?.trim() ? next.trim() : undefined);
}

/** Drop everything on sign-out — the next user's zone is not this one's. */
export function resetAccountTimeZone(): void {
	inflight = null;
	publish(undefined);
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/**
 * Read the account zone, then seed it if and only if it is empty.
 *
 * Memoised on the in-flight promise, so React's development double-effect (and two components
 * calling it) cannot produce two PUTs — a seed that fired twice would be harmless today and is
 * exactly the kind of thing that stops being harmless later.
 */
export function loadAccountTimeZone(): Promise<void> {
	if (!inflight) inflight = seedOnce();
	return inflight;
}

async function seedOnce(): Promise<void> {
	try {
		const d = await api<{ preferences?: { timezone?: string } }>("/v1/preferences");
		const stored = typeof d.preferences?.timezone === "string" ? d.preferences.timezone : undefined;
		const seed = timezoneSeed(stored, machineTimeZone());
		if (!seed) {
			publish(stored);
			return;
		}
		await api("/v1/preferences", { method: "PUT", body: JSON.stringify({ timezone: seed }) });
		publish(seed);
	} catch {
		// A failed read or a rejected seed leaves the zone unset, and every reader falls back to
		// the browser's own — the behaviour before this module existed. Nothing here is worth
		// interrupting the app for.
	}
}

/** The account zone, re-rendering when the seed lands or the owner changes it. */
export function useAccountTimeZone(): string | undefined {
	return useSyncExternalStore(subscribe, accountTimeZone, accountTimeZone);
}
