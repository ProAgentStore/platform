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

	it("blocks IPv6 loopback / link-local / ULA / mapped", () => {
		for (const u of ["https://[::1]/", "https://[fe80::1]/", "https://[fc00::1]/", "https://[::ffff:127.0.0.1]/"]) {
			expect(checkPublicHttpsUrl(u).ok, u).toBe(false);
		}
	});
});
