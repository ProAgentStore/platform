import { describe, expect, it } from "vitest";
import { applicationProgressEvidence } from "./applicationProgress";

describe("application progress evidence", () => {
	it("renders null native counts as unmeasured, never as zero fields", () => {
		const rendered = applicationProgressEvidence({ filled: null, uploaded: null, fieldCounts: "unmeasured", executionEvidence: {
			schemaVersion: 1, fieldCounts: "unmeasured", nativeCalls: { attempted: 19, succeeded: 14, failed: 5, notDispatched: 0, truncated: false, dropped: 2, coverage: "retained" },
			screenshotsDelivered: 0, screenshotRequests: 0, independentScreenshotAvailable: true, blockingQuestions: 1, optionalQuestions: 2, browser: { state: "pending", timeouts: 5 }, causes: ["browser_timeout", "unresolved_answers"],
		} });
		expect(rendered).toBe("Field and attachment completion unmeasured · 19 recorded native calls, 5 failed, 2 older records unavailable · 0 image payloads delivered to model tools (0 screenshot requests; independent capture available) · 2 optional questions omitted");
	});
	it("describes guarded counts as actions, not distinct completed fields", () => {
		expect(applicationProgressEvidence({ filled: 4, uploaded: 1 })).toBe("4 fill actions, 1 upload");
	});
	it("supports older native results without manufacturing evidence", () => {
		expect(applicationProgressEvidence({ filled: null, uploaded: null })).toBe("Field and attachment completion unmeasured");
	});
});
