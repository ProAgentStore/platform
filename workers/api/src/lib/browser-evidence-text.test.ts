import { expect, it } from "vitest";
import { browserEvidenceText } from "./browser-evidence-text.js";

it.each([
 ["Loading https://jobs.test/apply?seek-token=SYNTHETIC_TOKEN_PREFIX…", "Loading https://jobs.test/apply"],
 ["Failed https://user:SYNTHETIC_PASSWORD@jobs.test/apply?token=PRIVATE#SECRET", "Failed https://jobs.test/apply"],
 ["Read HTTPS://jobs.test/one#SECRET then https://jobs.test/two?token=PRIVATE", "Read https://jobs.test/one then https://jobs.test/two"],
 ["Loading https://user:SYNTHETIC_PASSWORD…", "Loading [URL redacted]"],
])("removes embedded URL credentials before clipping: %s", (input, output) => {
 expect(browserEvidenceText(input, 200)).toBe(output);
});
it("sanitizes before clipping, stays bounded, and marks oversized omissions", () => {
 const input = `Loading https://jobs.test/apply?token=${"SYNTHETIC_SECRET".repeat(20)}`;
 expect(browserEvidenceText(input, 40)).toBe("Loading https://jobs.test/apply");
 expect(browserEvidenceText("ordinary text ".repeat(30), 60)).toMatch(/\[cut:/);
 expect(browserEvidenceText("ordinary text ".repeat(30), 60)?.length).toBeLessThanOrEqual(60);
 expect(browserEvidenceText("x".repeat(16_385), 200)).toBe("[diagnostic text omitted: oversized]");
});
