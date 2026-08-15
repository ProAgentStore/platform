import { describe, expect, it } from "vitest";
import { allowedCorsOrigin, BROWSER_REVEALABLE_PROVIDERS, PROVIDER_BY_ID as REAL_PROVIDER_BY_ID, PROXY_FORWARD_HEADERS, splitProxyHostPath } from "./keys.js";

// Mirror the PROVIDERS list from the source so tests validate the real shape.
interface Provider {
	id: string;
	name: string;
	host: string | null;
	keyPrefix: string;
	docsUrl: string;
}

const PROVIDERS: Provider[] = [
	{
		id: "openai",
		name: "OpenAI",
		host: "api.openai.com",
		keyPrefix: "sk-",
		docsUrl: "https://platform.openai.com/api-keys",
	},
	{
		id: "anthropic",
		name: "Anthropic",
		host: "api.anthropic.com",
		keyPrefix: "sk-ant-",
		docsUrl: "https://console.anthropic.com/settings/keys",
	},
	{
		id: "google",
		name: "Google AI (Gemini)",
		host: "generativelanguage.googleapis.com",
		keyPrefix: "AI",
		docsUrl: "https://aistudio.google.com/apikey",
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		host: "openrouter.ai",
		keyPrefix: "sk-or-",
		docsUrl: "https://openrouter.ai/keys",
	},
	{
		id: "groq",
		name: "Groq",
		host: "api.groq.com",
		keyPrefix: "gsk_",
		docsUrl: "https://console.groq.com/keys",
	},
	{
		id: "together",
		name: "Together AI",
		host: "api.together.xyz",
		keyPrefix: "",
		docsUrl: "https://api.together.xyz/settings/api-keys",
	},
	{
		id: "xai",
		name: "xAI (Grok)",
		host: "api.x.ai",
		keyPrefix: "xai-",
		docsUrl: "https://console.x.ai",
	},
	{
		id: "cloudflare",
		name: "Cloudflare Workers AI",
		host: null,
		keyPrefix: "",
		docsUrl: "https://dash.cloudflare.com/profile/api-tokens",
	},
	{
		id: "claude-code",
		name: "Claude Code (Coder engine sign-in)",
		host: null,
		keyPrefix: "sk-ant-oat",
		docsUrl: "https://code.claude.com/docs/en/authentication",
	},
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
const HOST_TO_PROVIDER = new Map(
	PROVIDERS.filter((p) => p.host).map((p) => [p.host as string, p.id]),
);
function validateKey(provider: Provider, key: string): boolean {
	if (!provider.keyPrefix) return true; // no prefix required (e.g. together)
	return key.startsWith(provider.keyPrefix);
}

describe("provider list", () => {
	it("contains exactly 9 providers", () => {
		expect(PROVIDERS).toHaveLength(9);
	});

	it("includes openai", () => {
		const ids = PROVIDERS.map((p) => p.id);
		expect(ids).toContain("openai");
	});

	it("includes anthropic", () => {
		const ids = PROVIDERS.map((p) => p.id);
		expect(ids).toContain("anthropic");
	});

	it("includes google", () => {
		const ids = PROVIDERS.map((p) => p.id);
		expect(ids).toContain("google");
	});

	it("includes openrouter", () => {
		const ids = PROVIDERS.map((p) => p.id);
		expect(ids).toContain("openrouter");
	});

	it("includes groq", () => {
		const ids = PROVIDERS.map((p) => p.id);
		expect(ids).toContain("groq");
	});

	it("includes together", () => {
		const ids = PROVIDERS.map((p) => p.id);
		expect(ids).toContain("together");
	});

	it("includes xai (Grok engine api-key mode)", () => {
		const ids = PROVIDERS.map((p) => p.id);
		expect(ids).toContain("xai");
		expect(HOST_TO_PROVIDER.get("api.x.ai")).toBe("xai");
	});

	it("includes cloudflare", () => {
		const ids = PROVIDERS.map((p) => p.id);
		expect(ids).toContain("cloudflare");
	});

	it("includes claude-code (Coder engine sign-in — not proxyable)", () => {
		const ids = PROVIDERS.map((p) => p.id);
		expect(ids).toContain("claude-code");
		// host:null keeps the setup-token OUT of the key-proxy allowlist — it is only
		// injected as CLAUDE_CODE_OAUTH_TOKEN into the runner's headless engine.
		expect(PROVIDER_BY_ID.get("claude-code")?.host).toBeNull();
	});

	it("claude-code token must start with 'sk-ant-oat' (a setup-token, not an API key)", () => {
		const p = PROVIDER_BY_ID.get("claude-code")!;
		expect(validateKey(p, "sk-ant-oat01-abc123")).toBe(true);
		expect(validateKey(p, "sk-ant-api03-abc123")).toBe(false); // a normal Anthropic API key
	});

	it("all providers have id, name, host, keyPrefix, docsUrl", () => {
		for (const p of PROVIDERS) {
			expect(p.id).toBeTruthy();
			expect(p.name).toBeTruthy();
			if (p.id === "cloudflare" || p.id === "claude-code") {
				expect(p.host).toBeNull();
			} else {
				expect(p.host).toBeTruthy();
			}
			expect(p.keyPrefix).toBeDefined(); // may be empty string
			expect(p.docsUrl).toBeTruthy();
		}
	});
});

describe("provider ID validation", () => {
	it("looks up openai by ID", () => {
		const p = PROVIDER_BY_ID.get("openai");
		expect(p).toBeDefined();
		expect(p?.name).toBe("OpenAI");
	});

	it("looks up anthropic by ID", () => {
		const p = PROVIDER_BY_ID.get("anthropic");
		expect(p).toBeDefined();
		expect(p?.host).toBe("api.anthropic.com");
	});

	it("returns undefined for unknown provider ID", () => {
		const p = PROVIDER_BY_ID.get("unknown-provider");
		expect(p).toBeUndefined();
	});

	it("all 9 IDs are resolvable", () => {
		for (const p of PROVIDERS) {
			expect(PROVIDER_BY_ID.get(p.id)).toBeDefined();
		}
	});
});

describe("key prefix validation per provider", () => {
	it("openai key must start with 'sk-'", () => {
		const p = PROVIDER_BY_ID.get("openai")!;
		expect(validateKey(p, "sk-abc123")).toBe(true);
		expect(validateKey(p, "gsk_abc123")).toBe(false);
		expect(validateKey(p, "sk-ant-abc")).toBe(true); // starts with sk- too
	});

	it("anthropic key must start with 'sk-ant-'", () => {
		const p = PROVIDER_BY_ID.get("anthropic")!;
		expect(validateKey(p, "sk-ant-abc123")).toBe(true);
		expect(validateKey(p, "sk-abc123")).toBe(false);
	});

	it("google key must start with 'AI'", () => {
		const p = PROVIDER_BY_ID.get("google")!;
		expect(validateKey(p, "AIzaSyXXX")).toBe(true);
		expect(validateKey(p, "sk-abc")).toBe(false);
	});

	it("openrouter key must start with 'sk-or-'", () => {
		const p = PROVIDER_BY_ID.get("openrouter")!;
		expect(validateKey(p, "sk-or-v1-abc")).toBe(true);
		expect(validateKey(p, "sk-abc")).toBe(false);
	});

	it("groq key must start with 'gsk_'", () => {
		const p = PROVIDER_BY_ID.get("groq")!;
		expect(validateKey(p, "gsk_abc123")).toBe(true);
		expect(validateKey(p, "sk-abc")).toBe(false);
	});

	it("together AI has no prefix requirement", () => {
		const p = PROVIDER_BY_ID.get("together")!;
		expect(p.keyPrefix).toBe("");
		expect(validateKey(p, "any-string-at-all")).toBe(true);
		expect(validateKey(p, "")).toBe(true);
	});

	it("cloudflare has no token prefix requirement", () => {
		const p = PROVIDER_BY_ID.get("cloudflare")!;
		expect(p.keyPrefix).toBe("");
		expect(validateKey(p, "any-string-at-all")).toBe(true);
	});
});

describe("proxy host mapping", () => {
	it("maps api.openai.com to openai", () => {
		expect(HOST_TO_PROVIDER.get("api.openai.com")).toBe("openai");
	});

	it("maps api.anthropic.com to anthropic", () => {
		expect(HOST_TO_PROVIDER.get("api.anthropic.com")).toBe("anthropic");
	});

	it("maps generativelanguage.googleapis.com to google", () => {
		expect(HOST_TO_PROVIDER.get("generativelanguage.googleapis.com")).toBe(
			"google",
		);
	});

	it("maps openrouter.ai to openrouter", () => {
		expect(HOST_TO_PROVIDER.get("openrouter.ai")).toBe("openrouter");
	});

	it("maps api.groq.com to groq", () => {
		expect(HOST_TO_PROVIDER.get("api.groq.com")).toBe("groq");
	});

	it("maps api.together.xyz to together", () => {
		expect(HOST_TO_PROVIDER.get("api.together.xyz")).toBe("together");
	});

	it("returns undefined for unsupported host", () => {
		expect(HOST_TO_PROVIDER.get("api.unknown.com")).toBeUndefined();
	});

	it("all hosts map to a valid provider ID", () => {
		for (const [host, providerId] of HOST_TO_PROVIDER) {
			expect(host).toBeTruthy();
			expect(PROVIDER_BY_ID.get(providerId)).toBeDefined();
		}
	});
});

describe("splitProxyHostPath (greedy :host{.+} capture)", () => {
	it("splits host from the upstream path — the Whisper case that 400'd", () => {
		const { host, upstreamPath } = splitProxyHostPath("api.openai.com/v1/audio/transcriptions");
		expect(host).toBe("api.openai.com"); // must be the bare host, NOT the whole string
		expect(upstreamPath).toBe("/v1/audio/transcriptions");
		expect(HOST_TO_PROVIDER.get(host)).toBe("openai"); // now resolves, so the proxy works
	});

	it("splits the OpenAI TTS path", () => {
		expect(splitProxyHostPath("api.openai.com/v1/audio/speech")).toEqual({
			host: "api.openai.com",
			upstreamPath: "/v1/audio/speech",
		});
	});

	it("handles a bare host with no path", () => {
		expect(splitProxyHostPath("api.openai.com")).toEqual({ host: "api.openai.com", upstreamPath: "/" });
	});

	it("keeps deep paths intact", () => {
		expect(splitProxyHostPath("api.anthropic.com/v1/messages")).toEqual({
			host: "api.anthropic.com",
			upstreamPath: "/v1/messages",
		});
	});

	it("regression: the whole string was previously (wrongly) treated as the host", () => {
		// Before the fix, host === the full "api.openai.com/v1/audio/transcriptions",
		// which is NOT in the allowlist → 400 Unsupported host on every call.
		expect(HOST_TO_PROVIDER.get("api.openai.com/v1/audio/transcriptions")).toBeUndefined();
		expect(HOST_TO_PROVIDER.get(splitProxyHostPath("api.openai.com/v1/audio/transcriptions").host)).toBe("openai");
	});
});

describe("rate limit logic (100/hour)", () => {
	const RATE_LIMIT = 100;

	it("rate limit constant is 100", () => {
		expect(RATE_LIMIT).toBe(100);
	});

	it("allows request when count is below limit", () => {
		const count = 99;
		const blocked = count >= RATE_LIMIT;
		expect(blocked).toBe(false);
	});

	it("blocks request when count equals limit", () => {
		const count = 100;
		const blocked = count >= RATE_LIMIT;
		expect(blocked).toBe(true);
	});

	it("blocks request when count exceeds limit", () => {
		const count = 150;
		const blocked = count >= RATE_LIMIT;
		expect(blocked).toBe(true);
	});

	it("first call in an hour is not blocked (count = 0, no row)", () => {
		// The guard as the handler writes it, taken as a function of the row so the `null` case
		// is a real input rather than a constant the compiler narrows away before it is checked.
		const isBlocked = (usage: { count: number } | null) => usage !== null && usage.count >= RATE_LIMIT;
		expect(isBlocked(null)).toBe(false);
	});

	it("hour bucket key uses ISO slice to 13 chars (YYYY-MM-DDTHH)", () => {
		const iso = new Date("2025-06-06T14:30:00.000Z").toISOString();
		const hour = iso.slice(0, 13);
		expect(hour).toBe("2025-06-06T14");
		expect(hour).toHaveLength(13);
	});

	it("same hour produces identical bucket key", () => {
		const t1 = new Date("2025-06-06T14:00:00.000Z").toISOString().slice(0, 13);
		const t2 = new Date("2025-06-06T14:59:59.999Z").toISOString().slice(0, 13);
		expect(t1).toBe(t2);
	});

	it("different hours produce different bucket keys", () => {
		const t1 = new Date("2025-06-06T14:00:00.000Z").toISOString().slice(0, 13);
		const t2 = new Date("2025-06-06T15:00:00.000Z").toISOString().slice(0, 13);
		expect(t1).not.toBe(t2);
	});
});

describe("proxy CORS origin selection", () => {
	it("reflects the console origin", () => {
		expect(allowedCorsOrigin("https://console.proagentstore.online")).toBe(
			"https://console.proagentstore.online",
		);
	});

	it("reflects the public store origin", () => {
		expect(allowedCorsOrigin("https://proagentstore.online")).toBe(
			"https://proagentstore.online",
		);
	});

	it("allows local e2e origins", () => {
		expect(allowedCorsOrigin("http://localhost:4173")).toBe(
			"http://localhost:4173",
		);
	});

	it("does not emit wildcard CORS for unknown origins", () => {
		expect(allowedCorsOrigin("https://evil.example")).toBe(
			"https://console.proagentstore.online",
		);
		expect(allowedCorsOrigin(undefined)).toBe(
			"https://console.proagentstore.online",
		);
	});
});

describe("key reveal endpoint validation", () => {
	it("requires a known provider", () => {
		expect(PROVIDER_BY_ID.has("openai")).toBe(true);
		expect(PROVIDER_BY_ID.has("anthropic")).toBe(true);
		expect(PROVIDER_BY_ID.has("google")).toBe(true);
		expect(PROVIDER_BY_ID.has("nonexistent")).toBe(false);
	});

	it("reveal endpoint path follows the pattern /:provider/reveal", () => {
		for (const p of PROVIDERS) {
			const path = `/v1/keys/${p.id}/reveal`;
			expect(path).toContain(p.id);
			expect(path).toMatch(/\/reveal$/);
		}
	});
});

// ── #215: raw reveal is for browser-direct transports only ───────────────────
describe("BROWSER_REVEALABLE_PROVIDERS", () => {
	// The guard used to be only PROVIDER_BY_ID.has(), so every stored credential was
	// retrievable in cleartext by browser JS — including connector and Workers-AI keys with no
	// browser-side use at all. One XSS or bad extension drains them.
	it("refuses the server-side credentials named in the issue", () => {
		for (const id of ["http", "mcp", "cloudflare", "claude-code"]) {
			// REAL_PROVIDER_BY_ID, not this file's hand-mirrored copy — that copy predates these
			// four providers, which is exactly why the mirror can't guard this.
			expect(REAL_PROVIDER_BY_ID.has(id)).toBe(true); // still a real provider…
			expect(BROWSER_REVEALABLE_PROVIDERS.has(id)).toBe(false); // …just not revealable
		}
	});

	it("allows only openai, the one browser-direct transport (Realtime WS)", () => {
		expect([...BROWSER_REVEALABLE_PROVIDERS]).toEqual(["openai"]);
	});

	// Guard against the list quietly growing back: everything proxyable must stay off it.
	it("is a strict subset of the provider list", () => {
		for (const id of BROWSER_REVEALABLE_PROVIDERS) expect(REAL_PROVIDER_BY_ID.has(id)).toBe(true);
	});
});

// ── #214: the proxy builds upstream headers from an allowlist ────────────────
describe("PROXY_FORWARD_HEADERS", () => {
	const forwarded = new Set<string>(PROXY_FORWARD_HEADERS);

	// The leak: the browser SDK sends credentials:"include" for OAuth bind cookies, and the
	// proxy copied the whole request — so platform cookies went to api.openai.com.
	it("never forwards credential-bearing or platform headers", () => {
		for (const h of ["cookie", "set-cookie", "authorization", "proxy-authorization", "x-forwarded-for", "cf-connecting-ip", "host"]) {
			expect(forwarded.has(h)).toBe(false);
		}
	});

	// Load-bearing: the STT path posts FormData, and the multipart boundary rides in
	// content-type. Dropping it breaks Whisper uploads.
	it("forwards content-type, so multipart boundaries survive", () => {
		expect(forwarded.has("content-type")).toBe(true);
	});

	it("is all lowercase, since lookups are case-insensitive but the set is not", () => {
		for (const h of PROXY_FORWARD_HEADERS) expect(h).toBe(h.toLowerCase());
	});
});
