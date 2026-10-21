/**
 * #1280 — the identity validator and the echo guard, adversarially. Pure: no database, no network.
 */
import { describe, expect, it } from "vitest";
import { containsSecret, ECHO_MESSAGE, scrubSecret, validateIdentityResponse } from "./email-worker-identity-validator.js";

const SECRET = "bridge-bearer-PLAINTEXT-0123456789";
const good = { contractVersion: "email-worker/v1", account: { address: "support@example.com" } };
const cf = (over: Record<string, unknown> = {}) => ({
	contractVersion: "email-worker/v1",
	provider: "cloudflare",
	account: { address: "admin@example.com" },
	domains: ["example.com"],
	senders: ["admin@example.com"],
	replyIdentities: ["admin@example.com"],
	routes: [{ address: "info@example.com", destination: "you@verified.example" }],
	...over,
});
describe("accepts the supported contract", () => {
	it("a generic email-worker/v1 provider, with or without an account address or a provider field", () => {
		expect(validateIdentityResponse(good, SECRET).ok).toBe(true);
		expect(validateIdentityResponse({ contractVersion: "email-worker/v1" }, SECRET).ok).toBe(true);
		expect(validateIdentityResponse({ contractVersion: "email-worker/v1", account: { address: null } }, SECRET).ok).toBe(true);
		expect(validateIdentityResponse({ contractVersion: "email-worker/v1", account: null, provider: "generic" }, SECRET).ok).toBe(true);
	});

	it("a well-formed Cloudflare identity", () => {
		expect(validateIdentityResponse(cf(), SECRET).ok).toBe(true);
		expect(validateIdentityResponse(cf({ mailboxes: ["admin@example.com"] }), SECRET).ok).toBe(true);
	});
});

describe("rejects everything else, with a fixed reason", () => {
	it.each([
		["a bare {}", {}],
		["null", null],
		["an array", []],
		["a string", "email-worker/v1"],
		["a missing contractVersion", { account: { address: "a@b.com" } }],
		["email-worker/v2", { contractVersion: "email-worker/v2" }],
		["'unknown'", { contractVersion: "unknown" }],
		["a null version", { contractVersion: null }],
		["a numeric version", { contractVersion: 1 }],
		["a fuzzy version (case)", { contractVersion: "Email-Worker/V1" }],
		["a fuzzy version (padding)", { contractVersion: " email-worker/v1" }],
		["an account that is a string", { contractVersion: "email-worker/v1", account: "support@example.com" }],
		["an account that is a number", { contractVersion: "email-worker/v1", account: 7 }],
		["an account that is a list", { contractVersion: "email-worker/v1", account: ["a@b.com"] }],
		["an account address that is not an address", { contractVersion: "email-worker/v1", account: { address: "not-an-email" } }],
		["an address with a display name", { contractVersion: "email-worker/v1", account: { address: "Admin <a@b.com>" } }],
		["an address with a header injection", { contractVersion: "email-worker/v1", account: { address: "a@b.com\r\nBcc: x@evil.example" } }],
		["a numeric address", { contractVersion: "email-worker/v1", account: { address: 42 } }],
		["an IP literal address", { contractVersion: "email-worker/v1", account: { address: "a@[127.0.0.1]" } }],
		["an unknown provider (not a generic fallback)", { contractVersion: "email-worker/v1", provider: "sendgrid" }],
		["a provider that is not a string", { contractVersion: "email-worker/v1", provider: { name: "cloudflare" } }],
		["cloudflare domains that are not a list", cf({ domains: "example.com" })],
		["cloudflare domains with a non-string entry", cf({ domains: ["example.com", 7] })],
		["cloudflare domains with a non-domain entry", cf({ domains: ["not a domain"] })],
		["cloudflare senders with a non-string entry", cf({ senders: ["admin@example.com", { a: 1 }] })],
		["cloudflare senders with an invalid address", cf({ senders: ["admin"] })],
		["cloudflare senders that are not a list", cf({ senders: "admin@example.com" })],
		["cloudflare replyIdentities with a bad entry", cf({ replyIdentities: [null] })],
		["cloudflare mailboxes that are not a list", cf({ mailboxes: { a: 1 } })],
		["cloudflare routes that are not a list", cf({ routes: {} })],
		["a route that is a string", cf({ routes: ["info@example.com"] })],
		["a route without an address", cf({ routes: [{ destination: "x@y.example" }] })],
		["a route with a non-string destination", cf({ routes: [{ address: "info@example.com", destination: 5 }] })],
	])("%s", (_why, raw) => {
		const r = validateIdentityResponse(raw, SECRET);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).not.toContain(SECRET);
	});
});

describe("credential echo", () => {
	it("is rejected with the fixed message wherever the secret appears — and the message never carries it", () => {
		const where: Array<[string, unknown]> = [
			["account.address", { contractVersion: "email-worker/v1", account: { address: `${SECRET}@example.com` } }],
			["contractVersion", { contractVersion: SECRET }],
			["contractVersion suffix", { contractVersion: `email-worker/v1 ${SECRET}` }],
			["a nested key", { contractVersion: "email-worker/v1", extra: { [SECRET]: true } }],
			["a top-level key", { contractVersion: "email-worker/v1", [SECRET]: 1 }],
			["routes[0].something", cf({ routes: [{ address: "info@example.com", note: SECRET }] })],
			["a deep array", { contractVersion: "email-worker/v1", a: [[[{ b: [SECRET] }]]] }],
			["a mid-string fragment", { contractVersion: "email-worker/v1", motd: `welcome ${SECRET}, goodbye` }],
			["senders", cf({ senders: [`${SECRET}@example.com`] })],
		];
		for (const [place, raw] of where) {
			const r = validateIdentityResponse(raw, SECRET);
			expect(r.ok, place).toBe(false);
			if (!r.ok) {
				expect(r.reason, place).toBe(ECHO_MESSAGE);
				expect(r.echo, place).toBe(true);
				expect(JSON.stringify(r), place).not.toContain(SECRET);
			}
		}
	});

	it("catches a secret that JSON escaping would split", () => {
		const odd = 'p"a\\ss\nword-with-escapes';
		expect(containsSecret({ x: odd }, odd)).toBe(true);
		expect(containsSecret({ x: "clean" }, odd)).toBe(false);
	});

	it("a short secret is matched as a whole value or key, not as a substring of ordinary words", () => {
		expect(containsSecret({ contractVersion: "email-worker/v1", account: { address: "a@b.com" } }, "s")).toBe(false);
		expect(containsSecret({ x: "s" }, "s")).toBe(true);
		expect(containsSecret({ s: 1 }, "s")).toBe(true);
	});

	it("an empty secret echoes nothing", () => {
		expect(containsSecret({ a: "b" }, "")).toBe(false);
		expect(containsSecret({ a: "b" }, "   ")).toBe(false);
	});

	it("an unserialisable reply cannot be shown clean", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(containsSecret(cyclic, SECRET)).toBe(true);
	});
});

describe("scrubSecret", () => {
	it("removes every occurrence from error text", () => {
		expect(scrubSecret(`bad ${SECRET} and again ${SECRET}`, SECRET)).toBe("bad [redacted] and again [redacted]");
		expect(scrubSecret("nothing here", SECRET)).toBe("nothing here");
		expect(scrubSecret("text", "")).toBe("text");
	});
});
