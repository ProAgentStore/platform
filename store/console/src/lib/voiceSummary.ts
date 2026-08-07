// The one-line "what am I actually getting" beside the voice override radio.
//
// It claimed the saved PREFERENCE and called it the effective value. `resolveVoiceConfig`
// (packages/sdk/src/voice/config.ts) is the thing that actually decides, and it only chooses an
// OpenAI-backed provider when the user's key is present — otherwise it falls back to the browser
// rather than fail. So an account with `sttMode:"openai"` and no OpenAI key read
// "Whisper · OpenAI voice" on a radio labelled "Using your defaults", while every turn ran on
// browser dictation and the browser voice. The tab had already fetched `/v1/keys/status` for
// exactly this reason two hooks above, and did not consult it here.
//
// The rule is restated rather than imported: this module is pure and unit-tested with no SDK dist
// on hand, and the SDK's own entry points do not export the resolver. The test below pins the
// rule, so a change on either side has to be made on both.

/** `true`/`false` once `/v1/keys/status` has answered; `null` while it is in flight. */
export type KeyPresence = boolean | null;

/**
 * Speaking speed as a multiplier. Stored 25–400 with 100 as normal.
 *
 * `toFixed(2)` with one trailing zero stripped left the DEFAULT reading "1.0×" while the
 * no-value fallback beside it read "1×" — the same speed, spelled two ways, in one control.
 */
export function formatSpeed(speed: unknown): string {
	if (typeof speed !== "number" || !Number.isFinite(speed)) return "1×";
	return `${Number((speed / 100).toFixed(2))}×`;
}

/**
 * What this agent's voice will actually do, given the saved settings and whether the OpenAI key
 * that half of them require is present.
 *
 * `hasOpenAiKey === null` means the answer has not arrived: report the saved choice rather than
 * assert a fallback that may not happen, so the line does not flicker through a wrong claim. A
 * definite `false` names the missing key, because "Dictation" where the user chose Whisper is
 * otherwise indistinguishable from the setting having been lost.
 */
export function voiceSummary(voiceSettings: Record<string, unknown> | null, hasOpenAiKey: KeyPresence): string {
	const vs = voiceSettings || {};
	const wantsWhisper = vs.sttMode === "openai";
	const wantsOpenAiTts = typeof vs.provider === "string" && vs.provider.includes("openai");
	const blocked = hasOpenAiKey === false && (wantsWhisper || wantsOpenAiTts);
	const usable = hasOpenAiKey !== false;
	const parts = [
		wantsWhisper && usable ? "Whisper" : "Dictation",
		wantsOpenAiTts && usable ? "OpenAI voice" : "Browser voice",
		formatSpeed(vs.speed),
	];
	if (blocked) parts.push("needs an OpenAI key");
	return parts.join(" · ");
}
