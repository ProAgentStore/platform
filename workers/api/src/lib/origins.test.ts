import { describe, expect, it } from "vitest";
import { isAllowedBundleUrl, isAllowedReturnTo } from "./origins.js";

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

describe("isAllowedBundleUrl — a surface bundle is CODE in the console origin", () => {
	it("accepts a root-relative path — the form the docs and the shipped example use", () => {
		// The absolute-only version of this check rejected EVERY documented example
		// (`/console/surfaces/notes.js`), so a creator following the docs was silently dropped.
		expect(isAllowedBundleUrl("/console/surfaces/notes.js")).toBe(true);
		expect(isAllowedBundleUrl("  /console/surfaces/notes.js  ")).toBe(true);
	});

	it("accepts an absolute https URL on the platform's own hosts", () => {
		expect(isAllowedBundleUrl("https://proagentstore.online/console/surfaces/notes.js")).toBe(true);
		expect(isAllowedBundleUrl("https://cdn.proagentstore.online/s.js")).toBe(true);
		expect(isAllowedBundleUrl("https://ProAgentStore.Online/s.js")).toBe(true);
	});

	it("REJECTS the looks-relative-but-isn't bypasses", () => {
		// Both parse to a foreign origin (WHATWG treats `\` as `/` for special schemes), which is
		// why the check RESOLVES the URL instead of testing whether it starts with "/".
		expect(isAllowedBundleUrl("//evil.example/x.js")).toBe(false);
		expect(isAllowedBundleUrl("/\\evil.example/x.js")).toBe(false);
		expect(isAllowedBundleUrl("/\\/evil.example/x.js")).toBe(false);
	});

	it("rejects any host that is not ours, including a look-alike suffix", () => {
		expect(isAllowedBundleUrl("https://evil.example/x.js")).toBe(false);
		expect(isAllowedBundleUrl("https://proagentstore.online.evil.com/x.js")).toBe(false);
		expect(isAllowedBundleUrl("https://notproagentstore.online/x.js")).toBe(false);
		expect(isAllowedBundleUrl("https://freeagentstore.online/x.js")).toBe(false);
	});

	it("rejects non-https schemes, including localhost (unlike return_to)", () => {
		// A dev-only bundle host would be a production-reachable code-execution path if the env
		// were ever misread, so there is deliberately no localhost exception here.
		expect(isAllowedBundleUrl("http://proagentstore.online/x.js")).toBe(false);
		expect(isAllowedBundleUrl("http://localhost:5173/surfaces/notes.js")).toBe(false);
		expect(isAllowedBundleUrl("javascript:alert(1)")).toBe(false);
		expect(isAllowedBundleUrl("data:text/javascript,alert(1)")).toBe(false);
	});

	it("rejects a bare relative specifier and junk without throwing", () => {
		// "notes.js" would resolve against whatever page loaded it — not a contract the server
		// can honour.
		expect(isAllowedBundleUrl("notes.js")).toBe(false);
		expect(isAllowedBundleUrl("./notes.js")).toBe(false);
		expect(isAllowedBundleUrl("not a url")).toBe(false);
		expect(isAllowedBundleUrl("")).toBe(false);
		expect(isAllowedBundleUrl("   ")).toBe(false);
		expect(isAllowedBundleUrl(undefined as unknown as string)).toBe(false);
	});
});
