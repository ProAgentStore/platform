import { describe, expect, it } from "vitest";
import { canonicalJobUrl } from "../scan.js";

describe("Gmail Scout canonical URL dedupe", () => {
	it("removes tracking, fragments and trailing slashes before comparing job URLs", () => {
		expect(canonicalJobUrl("https://Jobs.Example.com/role/42/?utm_source=mail&ref=weekly#apply"))
			.toBe("https://jobs.example.com/role/42");
	});
	it("refuses non-URLs rather than creating a lead without a canonical identity", () => {
		expect(canonicalJobUrl("javascript:alert(1)")).toBeNull();
	});
});
