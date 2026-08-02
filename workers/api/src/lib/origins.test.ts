import { describe, expect, it } from "vitest";
import { isAllowedReturnTo } from "./origins.js";

describe("isAllowedReturnTo", () => {
	it("allows the apex domain and any subdomain over https", () => {
		expect(isAllowedReturnTo("https://proagentstore.online/console/")).toBe(true);
		expect(isAllowedReturnTo("https://api.proagentstore.online/v1/auth/me")).toBe(true);
		expect(isAllowedReturnTo("https://mcp.proagentstore.online/mcp")).toBe(true);
	});

	it("allows localhost / 127.0.0.1 over http OR https (dev)", () => {
		expect(isAllowedReturnTo("http://localhost:5173/console")).toBe(true);
		expect(isAllowedReturnTo("https://localhost/console")).toBe(true);
		expect(isAllowedReturnTo("http://127.0.0.1:8787/")).toBe(true);
	});

	it("rejects the apex/subdomain over plain http (must be https)", () => {
		expect(isAllowedReturnTo("http://proagentstore.online/")).toBe(false);
		expect(isAllowedReturnTo("http://api.proagentstore.online/")).toBe(false);
	});

	it("rejects any sibling-store or unrelated host", () => {
		expect(isAllowedReturnTo("https://freeappstore.online/")).toBe(false);
		expect(isAllowedReturnTo("https://evil.com/")).toBe(false);
		// A look-alike suffix must not sneak past endsWith(".proagentstore.online").
		expect(isAllowedReturnTo("https://proagentstore.online.evil.com/")).toBe(false);
		// Substring-but-not-subdomain (no dot boundary) is rejected.
		expect(isAllowedReturnTo("https://notproagentstore.online/")).toBe(false);
	});

	it("rejects malformed / non-URL / non-http(s) input without throwing", () => {
		expect(isAllowedReturnTo("not a url")).toBe(false);
		expect(isAllowedReturnTo("")).toBe(false);
		expect(isAllowedReturnTo("javascript:alert(1)")).toBe(false);
		expect(isAllowedReturnTo("ftp://proagentstore.online/")).toBe(false);
	});

	it("normalizes host case (upper-case host still resolves to the allowlisted host)", () => {
		expect(isAllowedReturnTo("https://ProAgentStore.online/console")).toBe(true);
		expect(isAllowedReturnTo("https://API.ProAgentStore.Online/")).toBe(true);
	});
});
