/**
 * SSRF guard for agent-driven outbound fetches (fetch_url tool, /knowledge
 * ingest-url). The URL is attacker-influenceable (prompt injection, or the owner
 * pasting a link), so before we fetch it we reject non-public targets.
 *
 * This replaces a denylist that was duplicated in two files and missed several
 * bypasses: the cloud/link-local range 169.254.0.0/16, loopback beyond the exact
 * 127.0.0.1 (127.0.0.0/8, 127.1), CGNAT 100.64.0.0/10, integer/hex-encoded IPs
 * (https://2130706433, https://0x7f000001), and IPv6 loopback/link-local/ULA/
 * IPv4-mapped forms. Not DNS-rebinding-proof — the Workers fetch API doesn't
 * expose the resolved address — but it closes the reachable-by-literal holes.
 */
export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

function isPrivateV4(octets: number[]): boolean {
	const [a, b] = octets;
	return (
		a === 0 || // "this" network
		a === 10 || // RFC1918
		a === 127 || // loopback /8 (not just 127.0.0.1)
		(a === 169 && b === 254) || // link-local / cloud metadata
		(a === 172 && b >= 16 && b <= 31) || // RFC1918
		(a === 192 && b === 168) || // RFC1918
		(a === 100 && b >= 64 && b <= 127) || // CGNAT
		a >= 224 // multicast + reserved
	);
}

/** Validate that `raw` is an https URL pointing at a public host. */
export function checkPublicHttpsUrl(raw: string): UrlCheck {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return { ok: false, reason: "Invalid URL" };
	}
	if (parsed.protocol !== "https:") return { ok: false, reason: "Only https URLs allowed" };

	let host = parsed.hostname.toLowerCase();
	const isV6Literal = host.startsWith("[") && host.endsWith("]");
	if (isV6Literal) host = host.slice(1, -1);

	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
		return { ok: false, reason: "Cannot fetch internal/private URLs" };
	}

	// Dotted IPv4. NOTE: `host` is `parsed.hostname`, which the WHATWG URL parser has
	// ALREADY canonicalised — shorthand (127.1), octal (0177.0.0.1), hex (0x7f.0.0.1),
	// and integer (2130706433) IPv4 forms are all normalised to dotted-decimal before
	// they reach here, so this single check covers every encoding.
	const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const octets = v4.slice(1).map(Number);
		if (octets.some((n) => n > 255)) return { ok: false, reason: "Invalid URL" };
		if (isPrivateV4(octets)) return { ok: false, reason: "Cannot fetch internal/private URLs" };
		return { ok: true, url: parsed };
	}

	// Integer- or hex-encoded IPv4 the URL parser somehow left un-normalised (defensive).
	if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) {
		return { ok: false, reason: "Numeric-IP URLs are not allowed" };
	}

	// IPv6 loopback / link-local / unique-local / IPv4-mapped
	if (isV6Literal || host.includes(":")) {
		if (
			host === "::" ||
			host === "::1" ||
			host.startsWith("fe80:") ||
			host.startsWith("fc") ||
			host.startsWith("fd") ||
			host.startsWith("::ffff:")
		) {
			return { ok: false, reason: "Cannot fetch internal/private URLs" };
		}
	}

	return { ok: true, url: parsed };
}
