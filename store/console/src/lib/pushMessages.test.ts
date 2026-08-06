import { describe, it, expect } from "vitest";
import { isSuppressedPush, PUSH_SUPPRESSED_MESSAGE } from "./pushMessages";

describe("isSuppressedPush", () => {
	it("recognises the message the service worker posts", () => {
		expect(isSuppressedPush({ type: PUSH_SUPPRESSED_MESSAGE, title: "Needs you", body: "Solve a CAPTCHA" })).toBe(true);
	});

	it("does not require any payload fields", () => {
		// The SW forwards whatever the push carried; a bare envelope still means "go re-read
		// your notifications", which is the only thing the page does with it.
		expect(isSuppressedPush({ type: PUSH_SUPPRESSED_MESSAGE })).toBe(true);
	});

	it("ignores other traffic on the same channel", () => {
		// `message` on a page is shared with extensions, older SW versions and any MessagePort.
		expect(isSuppressedPush({ type: "workbox-broadcast-update" })).toBe(false);
		expect(isSuppressedPush({ type: "" })).toBe(false);
		expect(isSuppressedPush({})).toBe(false);
	});

	it("does not throw on a non-object payload", () => {
		// event.data is frequently a bare string, and a service worker cannot be trusted to
		// have been updated in lockstep with the page that is running.
		for (const junk of [null, undefined, "pags:push-suppressed", 7, [], true]) {
			expect(isSuppressedPush(junk)).toBe(false);
		}
	});
});
