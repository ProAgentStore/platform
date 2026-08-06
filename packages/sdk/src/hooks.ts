// @proagentstore/sdk/hooks — React hooks for agent UIs.
//
// Shared hooks the console shell and agent UIs both call, so every agent's UI
// talks to platform "system services" the same way, exposed on the
// `./hooks` subpath. React is an optional peer dependency (only UIs pull it in).
// More hooks (useInstance, useRunner, useVoice…) move here from the console as
// the agent-OS SDK forms. See ../../PLAN-agent-os.md.

import { useEffect, useRef, useState } from "react";

import { resolvePollMs, resolvePollTier, shouldRefreshOnResume, type PollCadence, type PollTier } from "./poll-cadence.js";

export { resolvePollTier, resolvePollMs, shouldRefreshOnResume } from "./poll-cadence.js";
export type { PollTier, PollCadence, PollSignals } from "./poll-cadence.js";

export { useVoice, type VoiceMode } from "./voice/use-voice.js";
export { buildTranscribePrompt } from "./voice/prompt.js";
export { resolveVoiceStatus, type VoiceStatus } from "./voice/convo.js";
// TTS engine — so agent UIs (e.g. the repos overview play button) can speak text
// with the instance's configured voice without instantiating a full useVoice hook.
export { createTts } from "./voice/config.js";
// Voice config is cached and revalidated in the background so the hands-free start path never
// waits on it (#284). Whoever WRITES voice settings must drop that cache, so the change applies
// on the very next mic start rather than the one after it.
export { invalidateVoiceConfig } from "./voice/config.js";
export type { Dictation, DictationStatus, VoicePhase } from "./voice/machine.js";
// The dictation stored beside a transcript (#319) is compared on READ, not on write — the
// message carries one string, and the loss/divergence over it is derived by the same pure
// functions the send path used to decide whether it was worth storing at all.
export { dictationDiverged, dictationLoss, storedDictation } from "./voice/machine.js";
// The ONE guard for changing which agent you are talking to (#277/#279) — exported so a
// consumer driving a switch from the UI side (a tap on the conversation indicator) makes the
// same decision the voice command does.
export { prepareConversationSwitch, type SwitchPrep } from "./voice/machine.js";
export type { VoiceTts } from "./voice/tts.js";

/** Call `fn` every `ms` milliseconds while the component is mounted (and `enabled`). */
export function usePolling(fn: () => void, ms: number, enabled = true): void {
	const savedFn = useRef(fn);
	savedFn.current = fn;

	useEffect(() => {
		if (!enabled || ms <= 0) return;
		const id = setInterval(() => savedFn.current(), ms);
		return () => clearInterval(id);
	}, [ms, enabled]);
}

/** Live `document.hidden`. `false` outside a browser (SSR / tests). */
export function useDocumentVisibilityHidden(): boolean {
	const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);

	useEffect(() => {
		if (typeof document === "undefined") return;
		const onChange = () => setHidden(document.hidden);
		document.addEventListener("visibilitychange", onChange);
		// The tab can have flipped between the initial render and this effect.
		onChange();
		return () => document.removeEventListener("visibilitychange", onChange);
	}, []);

	return hidden;
}

/**
 * `usePolling` with the three-tier cadence policy from CODER-007 (#83): full
 * rate while `busy`, a slower rate when visible-and-idle, and nothing at all in
 * a hidden idle tab — plus one immediate fetch whenever the tier speeds up, so
 * a suppressed poll is never something the user can observe as staleness.
 *
 * Drop-in for `usePolling(fn, ms, enabled)`: pass the old interval as
 * `activeMs` and behaviour while working is unchanged.
 */
export function useTieredPolling(fn: () => void, cadence: PollCadence, busy: boolean, enabled = true): void {
	const savedFn = useRef(fn);
	savedFn.current = fn;

	const hidden = useDocumentVisibilityHidden();
	const signals = { hidden, busy };
	const tier = resolvePollTier(signals);
	const ms = resolvePollMs(cadence, signals);

	// Catch-up fetch on a tier speed-up (tab refocused, engine started). Skipped
	// while disabled — a disabled poll has no value to bring up to date.
	const prevTier = useRef<PollTier | null>(null);
	useEffect(() => {
		if (enabled && shouldRefreshOnResume(prevTier.current, tier)) savedFn.current();
		prevTier.current = enabled ? tier : null;
	}, [tier, enabled]);

	usePolling(fn, ms, enabled);
}
