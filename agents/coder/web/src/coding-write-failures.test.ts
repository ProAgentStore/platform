import { describe, expect, it } from "vitest";
import {
	clearHistoryFailureNotice,
	sessionAttachFailureNotice,
	workModeSaveFailureNotice,
} from "./coding-write-failures";

/**
 * These three sentences replace three `catch {}`s that had let the Coding tab go on displaying the
 * outcome the user asked for (#291). Each test asserts the property that made the original silence
 * harmful, so the obvious "tidy-up" — shortening these to a generic "Something went wrong" — fails
 * here rather than in production.
 */

describe("workModeSaveFailureNotice", () => {
	it("states the setting did NOT change, because the toggle was already showing that it had", () => {
		// The optimistic flip is the whole problem: the user's evidence is the control under their
		// finger. A message that only says "couldn't save" leaves that evidence unchallenged.
		const msg = workModeSaveFailureNotice(new Error("500 Internal Error"));
		expect(msg).toMatch(/still set the old way/i);
		expect(msg).toContain("500 Internal Error");
	});

	it("does not print [object Object] for a non-Error rejection", () => {
		// Not a hypothetical: a network-level rejection from `api()` is often a plain object, and
		// that is the failure mode these notices exist for. `String(err)` — the idiom used
		// elsewhere on this tab — renders it as "[object Object]", which is a sentence that
		// replaces a silent failure with a useless one.
		const msg = workModeSaveFailureNotice({ code: "ETIMEDOUT" });
		expect(msg).not.toContain("[object Object]");
		expect(msg).toContain("ETIMEDOUT");
	});

	it("survives a circular rejection value rather than throwing inside the error path", () => {
		// Throwing while rendering an error message loses BOTH the message and the original
		// failure — the worst possible outcome for code whose entire job is not losing failures.
		const circular: Record<string, unknown> = { code: "EBADF" };
		circular.self = circular;
		expect(() => workModeSaveFailureNotice(circular)).not.toThrow();
	});
});

describe("sessionAttachFailureNotice", () => {
	it("distinguishes 'no engine' from 'engine is quiet', which is the confusion it exists to end", () => {
		const msg = sessionAttachFailureNotice(new Error("runner offline"));
		expect(msg).toMatch(/isn't running/i);
	});

	it("names the one-command fix, since an offline machine is the common cause", () => {
		// Without this the user is told the engine is not running and given nothing to do about it,
		// which is only marginally better than the silence it replaced.
		expect(sessionAttachFailureNotice(new Error("runner offline"))).toContain("pags up");
	});
});

describe("clearHistoryFailureNotice", () => {
	it("says nothing was deleted — the pane's own state cannot be trusted at this moment", () => {
		// The destructive read: the user confirmed a clear, so they will assume it happened unless
		// told otherwise, and the transcript reappearing on the next reload looks like a bug rather
		// than the truth. This is the one sentence that stops them re-running it.
		const msg = clearHistoryFailureNotice(new Error("409 conflict"));
		expect(msg).toMatch(/nothing was deleted/i);
		expect(msg).toContain("409 conflict");
	});
});
