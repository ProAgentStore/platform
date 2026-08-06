import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPublicHttpsUrl, safeFetch, SsrfError } from "./ssrf.js";

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

	it("decodes a leading-zero octet the way the network stack does (GHSA-mwp4-54f8-5fhr)", () => {
		// That advisory is against `ip-address`, whose `Address4` reads a leading-zero octet as
		// DECIMAL while `inet_aton`/`getaddrinfo`/the WHATWG URL parser read it as OCTAL — so a
		// guard built on it calls `012.0.0.1` the public `12.0.0.1` and then `fetch` connects to
		// the private `10.0.0.1`. PAGS is not exposed to that class because `checkPublicHttpsUrl`
		// never parses the host itself: it reads `parsed.hostname`, already canonicalised by the
		// parser the advisory names as correct. This pins that property, since the reachability
		// argument in SECURITY.md rests on it.
		expect(checkPublicHttpsUrl("https://012.0.0.1/").ok).toBe(false); // octal → 10.0.0.1 (RFC1918)
		expect(checkPublicHttpsUrl("https://0177.0.0.1/").ok).toBe(false); // octal → 127.0.0.1 (loopback)
		expect(checkPublicHttpsUrl("https://0251.0376.0251.0376/").ok).toBe(false); // octal → 169.254.169.254 (metadata)
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

describe("safeFetch (redirect re-validation)", () => {
	afterEach(() => vi.unstubAllGlobals());

	/** A 3xx Response with a Location header (Response can't be built with a 302 body-status,
	 *  so stub the shape the code reads: status + headers.get('location')). */
	function redirect(location: string) {
		return { status: 302, headers: { get: (h: string) => (h.toLowerCase() === "location" ? location : null) } } as unknown as Response;
	}

	it("follows a redirect to another PUBLIC https host", async () => {
		const calls: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
			calls.push(url);
			expect(init.redirect).toBe("manual"); // never auto-follow
			if (url === "https://a.example/start") return redirect("https://b.example/end");
			return new Response("ok", { status: 200 });
		}));
		const res = await safeFetch("https://a.example/start");
		expect(res.status).toBe(200);
		expect(calls).toEqual(["https://a.example/start", "https://b.example/end"]);
	});

	it("REFUSES a redirect to a private host (the SSRF hole)", async () => {
		vi.stubGlobal("fetch", vi.fn(async (url: string) =>
			url === "https://public.example/redir" ? redirect("http://169.254.169.254/latest/meta-data/") : new Response("secret", { status: 200 }),
		));
		await expect(safeFetch("https://public.example/redir")).rejects.toBeInstanceOf(SsrfError);
	});

	it("REFUSES a redirect that downgrades to http on a public host", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => redirect("http://public.example/")));
		await expect(safeFetch("https://public.example/")).rejects.toThrow(/https/i);
	});

	it("rejects the initial URL when it's private (before any fetch)", async () => {
		const f = vi.fn();
		vi.stubGlobal("fetch", f);
		await expect(safeFetch("https://127.0.0.1/")).rejects.toBeInstanceOf(SsrfError);
		expect(f).not.toHaveBeenCalled();
	});

	it("gives up after too many redirects", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => redirect("https://public.example/loop")));
		await expect(safeFetch("https://public.example/loop", {}, 3)).rejects.toThrow(/too many redirects/i);
	});
});

describe("safeFetch — credentials must not cross an origin boundary", () => {
	afterEach(() => vi.unstubAllGlobals());

	/** Records the headers each hop was actually called with. */
	function traceFetch(hops: Array<string | null>) {
		const seen: Array<Record<string, string>> = [];
		let i = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				seen.push(Object.fromEntries(new Headers(init.headers as HeadersInit).entries()));
				const next = hops[i++];
				return next
					? new Response(null, { status: 302, headers: { location: next } })
					: new Response("ok", { status: 200 });
			}),
		);
		return seen;
	}

	it("strips the vault secret when the host changes — the leak", () => {
		// The http/mcp connectors put the owner's DECRYPTED vault token in `Authorization`.
		// Spreading the original init into every hop handed it to whatever host the previous
		// host's Location named: one `302 → https://attacker.example/` from a hijacked or
		// CDN-redirecting vendor path and the key is gone. The SSRF guard cannot help — the
		// attacker's host is a perfectly ordinary public HTTPS host.
		const seen = traceFetch(["https://attacker.example/steal", null]);
		return safeFetch("https://vendor.example/api", {
			headers: { Authorization: "Bearer SECRET", "X-Api-Key": "SECRET2", Accept: "application/json" },
		}).then(() => {
			expect(seen[0].authorization).toBe("Bearer SECRET");
			expect(seen[1].authorization).toBeUndefined();
			expect(seen[1]["x-api-key"]).toBeUndefined();
			// A non-credential header still rides along — this strips secrets, not the request.
			expect(seen[1].accept).toBe("application/json");
		});
	});

	it("KEEPS credentials on a same-origin redirect — the ordinary case must still work", async () => {
		const seen = traceFetch(["https://vendor.example/api/v2", null]);
		await safeFetch("https://vendor.example/api", { headers: { Authorization: "Bearer SECRET" } });
		expect(seen[1].authorization).toBe("Bearer SECRET");
	});

	it("stays stripped across a further hop back to the ORIGINAL origin", async () => {
		// vendor → attacker → vendor must not restore the secret: the attacker chose that hop.
		const seen = traceFetch(["https://attacker.example/a", "https://vendor.example/b", null]);
		await safeFetch("https://vendor.example/api", { headers: { Authorization: "Bearer SECRET" } });
		expect(seen[2].authorization).toBeUndefined();
	});

	it("strips a connector-named custom credential header too", async () => {
		// `auth.mode:"api-key"` lets the connector config name its own header, so the rule has
		// to be shaped like a credential rather than an exact allowlist.
		const seen = traceFetch(["https://attacker.example/x", null]);
		await safeFetch("https://vendor.example/api", { headers: { "X-Vendor-Token": "SECRET", "X-Trace-Id": "keep" } });
		expect(seen[1]["x-vendor-token"]).toBeUndefined();
		expect(seen[1]["x-trace-id"]).toBe("keep");
	});
});
