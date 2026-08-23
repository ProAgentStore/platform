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

/** Thrown by {@link safeFetch} when a URL (or a redirect hop) fails the SSRF guard. */
export class SsrfError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "SsrfError";
	}
}

/**
 * Deadline applied to a `safeFetch` call whose caller supplied no `signal` of its own (#438).
 *
 * ── Why there is a number here at all
 *
 * Measured on `main` before this: `AbortSignal.timeout` appeared **0 times** in `workers/api/src`,
 * and of the ~148 `fetch(`-matching lines only three files built an `AbortController`
 * (`lib/user-ai.ts`, `lib/steps.ts`, `lib/mcp-credentials.ts`). Everything else could hang for as
 * long as a remote host chose to hold the socket open. `safeFetch` is the chokepoint that every
 * connector (`http`, `mcp`, `web-search`, `dcr`, `discovery`, `client`), the `fetch_url` tool and
 * the `/knowledge` ingest path already routes through, so one deadline here bounds all of them
 * without editing a call site.
 *
 * ── What 30s is sized against — repo values, not a feeling
 *
 * FLOOR. It must not be tighter than a deadline this codebase has already chosen for the same kind
 * of call: `probeReachable` (`lib/steps.ts`) lets its caller ask for up to **30_000ms** to decide a
 * stranger's HTTPS endpoint is dead, and `AI_FIRST_TOKEN_TIMEOUT_MS` (`lib/ai-deadlines.ts`) puts
 * "the provider has gone away" at **25_000ms**. A smaller default would mean adding a safety net
 * silently shortened a budget someone measured.
 *
 * CEILING. It must be absorbable by the request that contains it. The worst realistic case is the
 * chat tool loop, which runs up to 3 rounds and may call `fetch_url` in each: three dead hosts cost
 * 90s of non-model time inside a turn already permitted `AI_TOTAL_TIMEOUT_MS` = 180_000ms *per
 * model call*. So the floor cannot dominate a turn. At two minutes it would.
 *
 * This is a FLOOR, not a target: nothing that answers today gets slower. The only calls whose
 * behaviour changes are the ones that would previously have hung.
 *
 * ── Known trade-off, stated rather than discovered later
 *
 * An MCP `tools/call` (`lib/connectors/mcp.ts`) can be a remote server doing real work — building a
 * site, running a generation — and 30s may genuinely be short for it. Today that call has **no**
 * deadline, so this is strictly an improvement; if it proves tight, that call site states its own
 * budget the way `steps.ts` and `mcp-credentials.ts` already do (see the precedence rule below).
 */
export const SAFE_FETCH_TIMEOUT_MS = 30_000;

/**
 * SSRF-safe fetch. `checkPublicHttpsUrl` only validates the URL we pass to `fetch`,
 * but the default `redirect: "follow"` lets a public host 3xx-redirect us straight to
 * `http://169.254.169.254/…` or `http://127.0.0.1/…` — re-opening the exact holes the
 * guard closes. So follow redirects MANUALLY and re-validate every hop (which also
 * re-enforces https-only, blocking an http downgrade). Throws {@link SsrfError} when a
 * hop is rejected or the redirect budget is exhausted.
 *
 * ── Deadline precedence: the caller wins, and the floor only fills a vacuum (#438)
 *
 * `init.signal` supplied ⇒ it is used VERBATIM and no default is added. Not composed with
 * `AbortSignal.any`, deliberately: composing takes the *earlier* of the two, which makes the floor
 * a ceiling and removes the only way a caller can ask for MORE time. Both callers that pass a
 * signal today (`lib/steps.ts` probeReachable, `lib/mcp-credentials.ts` `ADVICE_BUDGET_MS`) back it
 * with an explicit timer, i.e. they have already decided; overriding a decision with a constant is
 * the same class of bug as clobbering it. The residual gap is honest and worth writing down: a
 * caller passing a cancellation-only signal that never fires gets no deadline. That is a property
 * of the call site, and the deadline ratchet in #438 is where it becomes visible.
 *
 * `init.signal` absent ⇒ {@link SAFE_FETCH_TIMEOUT_MS} applies, as ONE signal created before the
 * redirect loop so it spans the WHOLE chain. Per-hop would let a 5-redirect chain take 6× the
 * budget, which hands the effective deadline to the remote host — the party the guard exists to
 * distrust. `stripCredentialHeaders` rebuilds the init on a cross-origin hop and must carry the
 * signal through; `ssrf.test.ts` pins that.
 */
export async function safeFetch(raw: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
	let current = raw;
	let origin = originOf(raw);
	let hopInit: RequestInit = init.signal ? init : { ...init, signal: AbortSignal.timeout(SAFE_FETCH_TIMEOUT_MS) };
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const check = checkPublicHttpsUrl(current);
		if (!check.ok) throw new SsrfError(check.reason);
		const res = await fetch(current, { ...hopInit, redirect: "manual" });
		if (res.status < 300 || res.status >= 400) return res;
		const location = res.headers.get("location");
		if (!location) return res; // a 3xx with no Location — nothing to follow
		// Resolve relative redirects against the current URL, then re-validate at the top.
		try {
			current = new URL(location, current).toString();
		} catch {
			throw new SsrfError("Invalid redirect target");
		}
		// Credentials must NOT cross an origin boundary. The caller's headers carry the owner's
		// decrypted vault secret — `Authorization: Bearer <token>` from the http connector, the
		// `mcp` provider token, a configured `X-Api-Key`. Spreading the original init into every
		// hop handed that secret to whatever host the PREVIOUS host's Location named: one
		// `302 Location: https://attacker.example/` from a hijacked or CDN-redirecting vendor
		// path and the key is gone. The SSRF guard cannot help — the attacker's host is a
		// perfectly public HTTPS host. Browsers and curl strip Authorization on a cross-host
		// redirect for exactly this reason; now so do we.
		const nextOrigin = originOf(current);
		if (nextOrigin !== origin) {
			hopInit = stripCredentialHeaders(hopInit);
			origin = nextOrigin;
		}
	}
	throw new SsrfError("Too many redirects");
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}

/**
 * Headers that authenticate the caller and must be dropped when the origin changes.
 *
 * Deliberately a DENYLIST of the ones we actually send plus the standard ones, not an allowlist:
 * dropping a benign header on a redirect is harmless, keeping a secret one is not. `auth.mode:
 * "api-key"` lets the connector config name its own header, so any header whose name looks like a
 * credential goes too.
 */
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "www-authenticate"]);
const CREDENTIAL_HEADER_RE = /(^|[-_])(api[-_]?key|auth|token|secret|password|signature|sig)([-_]|$)/i;

function isCredentialHeader(name: string): boolean {
	const n = name.toLowerCase();
	return CREDENTIAL_HEADERS.has(n) || CREDENTIAL_HEADER_RE.test(n);
}

function stripCredentialHeaders(init: RequestInit): RequestInit {
	const next = new Headers(init.headers as HeadersInit | undefined);
	for (const name of [...next.keys()]) {
		if (isCredentialHeader(name)) next.delete(name);
	}
	return { ...init, headers: next };
}
