import { describe, expect, it } from "vitest";
import { cleanForSpeech } from "./tts.js";

describe("cleanForSpeech", () => {
	it("leaves plain prose untouched", () => {
		expect(cleanForSpeech("Your flight is booked, see you at the gate.")).toBe(
			"Your flight is booked, see you at the gate.",
		);
	});

	it("replaces fenced code blocks with '(code)'", () => {
		expect(cleanForSpeech("before ```\nconst x = 1\n``` after")).toBe("before (code) after");
	});

	it("keeps short plain-word inline code but drops technical tokens", () => {
		expect(cleanForSpeech("run `npm test` please")).toBe("run npm test please");
		expect(cleanForSpeech("value `x.y_z()` here")).toBe("value here");
	});

	it("replaces URLs with 'a link'", () => {
		expect(cleanForSpeech("go to https://example.com/path?q=1 now")).toBe("go to a link now");
	});

	it("replaces unix + windows file paths with 'a file'", () => {
		expect(cleanForSpeech("open /etc/hosts please")).toBe("open a file please");
		expect(cleanForSpeech("edit ./src/app.ts now")).toBe("edit a file now");
	});

	it("replaces bare filenames-with-extensions with 'a file'", () => {
		expect(cleanForSpeech("the config.json file")).toBe("the a file file");
	});

	it("strips git-like hashes", () => {
		expect(cleanForSpeech("commit deadbeef1 done")).toBe("commit done");
	});

	it("strips markdown formatting characters", () => {
		expect(cleanForSpeech("**Bold** _italic_ # Heading")).toBe("Bold italic Heading");
	});

	it("strips emoji", () => {
		expect(cleanForSpeech("Nice work 🎉 done")).toBe("Nice work done");
	});

	it("collapses whitespace", () => {
		expect(cleanForSpeech("a\n\n  b\t c")).toBe("a b c");
	});

	it("caps the spoken length at 1500 chars", () => {
		expect(cleanForSpeech("a".repeat(3000)).length).toBe(1500);
	});
});
