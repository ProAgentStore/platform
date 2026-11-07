/** The owner-facing sentence for a verification run that failed on the engine (#1598). */
import { describe, expect, it } from "vitest";
import { engineFailureSentence, readableVerificationDetail } from "./verification-engine-failure.js";

const AT = Date.UTC(2026, 10, 8, 0, 0); // 11:00 on 8 Nov in Melbourne (+11:00)
const ZONE = "Australia/Melbourne";
const EVENTS = ['{"type":"thread.started","thread_id":"019a"}', '{"type":"turn.started"}', '{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"opening the page"}}'];
/** The runner's own error: the last five output lines, so the limit line is in the tail and no earlier line carries it. */
const codex = (...last: string[]) => `The codex CLI exited with code 1: ${[...EVENTS, ...last].join("\n")}`;
const LIMIT = "ERROR: You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 2:05 PM.";
const STORED = (error: string) => `The verification run ended failed (engine_failed): ${error}`;
const RESET = "Resets at 2026-11-08 14:05 +11:00 (Australia/Melbourne).";

describe("engineFailureSentence", () => {
	it("a Codex usage limit names the engine and the reset time in the owner's zone", () => {
		expect(engineFailureSentence(codex(LIMIT), AT, ZONE)).toBe(`Codex usage limit reached. ${RESET}`);
	});

	it("reads the limit from the whole error, not from what a clip would keep", () => {
		const long = codex(`${"x".repeat(2_000)}`, LIMIT);
		expect(engineFailureSentence(long, AT, ZONE)).toBe(`Codex usage limit reached. ${RESET}`);
	});

	it("a Claude session limit says Claude, with the reset when it has one", () => {
		const claude = (line: string) => `The claude CLI exited with code 1: ${line}`;
		expect(engineFailureSentence(claude("You've hit your session limit · resets 3am"), AT, ZONE)).toBe("Claude usage limit reached. Resets at 2026-11-09 03:00 +11:00 (Australia/Melbourne).");
		// Not a time (a named day is `far`) and no hint: nothing about when.
		expect(engineFailureSentence(claude("You've hit your weekly limit · resets Nov 12"), AT, ZONE)).toBe("Claude usage limit reached.");
		expect(engineFailureSentence(claude("You've hit your session limit"), AT, ZONE)).toBe("Claude usage limit reached.");
	});

	it("a relative hint counts from when the run ended", () => {
		expect(engineFailureSentence(codex("You've hit your usage limit. try again in 2 hours"), AT, ZONE)).toBe("Codex usage limit reached. Resets at 2026-11-08 13:00 +11:00 (Australia/Melbourne).");
	});

	it("billing and transient failures get their own sentences", () => {
		expect(engineFailureSentence(codex("insufficient_quota"), AT, ZONE)).toBe("Codex account has no quota left.");
		expect(engineFailureSentence(codex("Selected model is at capacity"), AT, ZONE)).toBe("Codex was unavailable.");
	});

	it("an unrecognised failure with a parsable prefix, and one without, never show raw output", () => {
		const unknown = engineFailureSentence(codex('{"type":"error","message":"boom"}'), AT, ZONE);
		expect(unknown).toBe("The Codex CLI stopped (exit code 1).");
		const unparsable = engineFailureSentence('{"type":"turn.failed"}', AT, ZONE);
		expect(unparsable).toBe("The CLI stopped with an error.");
		for (const s of [unknown, unparsable]) {
			expect(s).not.toContain("{");
			expect(s).not.toContain('"type":');
		}
	});
});

describe("readableVerificationDetail (stored rows)", () => {
	const NOW = AT + 60_000;

	it("rewrites a stored engine_failed sentence", () => {
		expect(readableVerificationDetail(STORED(codex(LIMIT)), AT, ZONE, NOW)).toBe(`Codex usage limit reached. ${RESET}`);
	});

	it("a row clipped when written, whose limit line is gone, reads as the exit-code sentence", () => {
		const clipped = STORED(codex(LIMIT)).slice(0, 120);
		expect(clipped).not.toContain("usage limit");
		expect(readableVerificationDetail(clipped, AT, ZONE, NOW)).toBe("The Codex CLI stopped (exit code 1).");
	});

	it("drops a reset that has already passed", () => {
		const later = Date.UTC(2026, 10, 9);
		expect(readableVerificationDetail(STORED(codex(LIMIT)), AT, ZONE, later)).toBe("Codex usage limit reached.");
	});

	it("returns everything else byte for byte", () => {
		for (const d of [
			"Browser verification: active.",
			"found expired",
			"The verification run ended failed (runner_lost): The runner went offline during the run.",
			"The verification run ended failed (engine_failed).",
			"Browser verification is off for this Scout. Turn it on in Settings → Browser (set_instance_browser_verification).",
			"Codex usage limit reached. Resets at 2026-11-08 14:05 +11:00 (Australia/Melbourne).",
			"",
		]) expect(readableVerificationDetail(d, AT, ZONE, NOW)).toBe(d);
		expect(readableVerificationDetail(null, AT, ZONE, NOW)).toBeNull();
	});
});
