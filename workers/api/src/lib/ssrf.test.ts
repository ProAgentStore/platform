import { describe, expect, it } from "vitest";
import { checkPublicHttpsUrl } from "./ssrf.js";

describe("checkPublicHttpsUrl", () => {
	it("allows normal public https URLs", () => {
		expect(checkPublicHttpsUrl("https://example.com/page").ok).toBe(true);
		expect(checkPublicHttpsUrl("https://api.github.com/repos/x/y").ok).toBe(true);
	});

	it("rejects non-https", () => {
		expect(checkPublicHttpsUrl("http://example.com").ok).toBe(false);
		expect(checkPublicHttpsUrl("file:///etc/passwd").ok).toBe(false);
	});

	it("blocks loopback and private ranges (incl. bypasses the old denylist missed)", () => {
		for (const u of [
			"https://localhost/x",
			"https://127.0.0.1/",
			"https://127.0.0.2/", // 127.0.0.0/8, not just .1
			"https://10.0.0.5/",
			"https://192.168.1.1/",
			"https://172.16.0.1/",
			"https://169.254.169.254/latest/meta-data/", // cloud metadata
			"https://100.64.0.1/", // CGNAT
			"https://foo.internal/",
			"https://bar.local/",
		]) {
			expect(checkPublicHttpsUrl(u).ok, u).toBe(false);
		}
	});

	it("blocks integer- and hex-encoded IPv4", () => {
		expect(checkPublicHttpsUrl("https://2130706433/").ok).toBe(false); // 127.0.0.1
		expect(checkPublicHttpsUrl("https://0x7f000001/").ok).toBe(false);
	});

	it("blocks inet_aton shorthand / octal / hex-dotted forms of private IPs", () => {
		// These all resolve to a private target; the WHATWG URL parser canonicalises them
		// to dotted-decimal (127.1 → 127.0.0.1, 2852039166 → 169.254.169.254) BEFORE the
		// guard sees the hostname, so the single isPrivateV4 check catches every encoding.
		for (const u of [
			"https://127.1/",        // 2-part shorthand → 127.0.0.1
			"https://10.1/",         // → 10.0.0.1
			"https://0177.0.0.1/",   // octal first octet → 127.0.0.1
			"https://0x7f.0.0.1/",   // hex first octet → 127.0.0.1
			"https://192.168.257/",  // 3-part shorthand → 192.168.1.1
			"https://2852039166/",   // integer form of 169.254.169.254 (cloud metadata)
		]) {
			expect(checkPublicHttpsUrl(u).ok, u).toBe(false);
		}
	});

	it("still allows a genuinely public IP written in a non-canonical form", () => {
		// 134744072 and 8.526344 both normalise to the PUBLIC 8.8.8.8 — that IS where the
		// fetch would connect, so allowing them is correct, not a bypass.
		expect(checkPublicHttpsUrl("https://8.8.8.8/").ok).toBe(true);
		expect(checkPublicHttpsUrl("https://134744072/").ok).toBe(true);
	});

	it("blocks IPv6 loopback / link-local / ULA / mapped", () => {
		for (const u of ["https://[::1]/", "https://[fe80::1]/", "https://[fc00::1]/", "https://[::ffff:127.0.0.1]/"]) {
			expect(checkPublicHttpsUrl(u).ok, u).toBe(false);
		}
	});
});
