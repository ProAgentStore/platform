import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareAccessConfigured, cloudflareAccessGate, cloudflareAccessMode } from "./cf-access.js";
import { logError } from "./error-log.js";
import type { Env } from "../types.js";

vi.mock("./error-log.js", () => ({ logError: vi.fn(async () => undefined) }));

const env = (over: Partial<Env>): Env => over as unknown as Env;

describe("cloudflareAccessConfigured", () => {
	it("is true only when BOTH team domain AND aud are set", () => {
		expect(cloudflareAccessConfigured(env({ CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_AUD: "aud123" }))).toBe(true);
	});

	it("is false when only the team domain is set", () => {
		expect(cloudflareAccessConfigured(env({ CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }))).toBe(false);
	});

	it("is false when only the aud is set", () => {
		expect(cloudflareAccessConfigured(env({ CF_ACCESS_AUD: "aud123" }))).toBe(false);
	});

	it("is false when neither is set (inert dev/prod default)", () => {
		expect(cloudflareAccessConfigured(env({}))).toBe(false);
	});

	it("treats empty-string env vars as unconfigured (inert)", () => {
		expect(cloudflareAccessConfigured(env({ CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: "" }))).toBe(false);
		expect(cloudflareAccessConfigured(env({ CF_ACCESS_TEAM_DOMAIN: "team.x", CF_ACCESS_AUD: "" }))).toBe(false);
	});
});

const CONFIGURED = { CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CF_ACCESS_AUD: "aud123" };

describe("cloudflareAccessMode", () => {
	it("is off until both vars are set — the state prod runs in today", () => {
		expect(cloudflareAccessMode(env({}))).toBe("off");
		expect(cloudflareAccessMode(env({ CF_ACCESS_TEAM_DOMAIN: "team.x" }))).toBe("off");
	});

	it("is audit as soon as the vars appear, WITHOUT enforcing", () => {
		expect(cloudflareAccessMode(env(CONFIGURED))).toBe("audit");
	});

	it("enforces only on an explicit affirmative", () => {
		for (const v of ["1", "true", "TRUE", "yes", "on", " true "]) {
			expect(cloudflareAccessMode(env({ ...CONFIGURED, CF_ACCESS_ENFORCE: v }))).toBe("enforce");
		}
	});

	/** The lockout guard: a typo must degrade to watching, never to blocking. */
	it("treats anything unrecognised as audit, including the shell's 'undefined'", () => {
		for (const v of ["", "false", "0", "no", "off", "undefined", "null", "maybe"]) {
			expect(cloudflareAccessMode(env({ ...CONFIGURED, CF_ACCESS_ENFORCE: v }))).toBe("audit");
		}
	});
});

// ── The gate, against a REAL RS256 signature ────────────────────────────────
// A stubbed verifier would pass while the actual claim checks rotted. These build a
// genuine key, sign a genuine JWT, and serve a genuine JWKS.

let keyPair: CryptoKeyPair;
let jwks: { keys: unknown[] };
const KID = "test-kid-1";

const b64url = (b: ArrayBuffer | Uint8Array) => {
	const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
	let s = "";
	for (const byte of bytes) s += String.fromCharCode(byte);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function signJwt(payload: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
	const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: KID, ...header })));
	const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(`${h}.${p}`));
	return `${h}.${p}.${b64url(sig)}`;
}

/** A valid, unexpired assertion for our team + aud. */
const validClaims = () => ({
	aud: [CONFIGURED.CF_ACCESS_AUD],
	iss: `https://${CONFIGURED.CF_ACCESS_TEAM_DOMAIN}`,
	exp: Math.floor(Date.now() / 1000) + 600,
	email: "operator@example.com",
});

beforeEach(async () => {
	vi.mocked(logError).mockClear();
	if (!keyPair) {
		keyPair = (await crypto.subtle.generateKey(
			{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
		jwks = { keys: [{ ...jwk, kid: KID, alg: "RS256" }] };
	}
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 })),
	);
});

afterEach(() => vi.unstubAllGlobals());

/** Minimal Hono-shaped context: the gate touches env, req.header, req.path, req.method. */
function ctx(e: Partial<Env>, token?: string) {
	return {
		env: e as Env,
		req: {
			header: (n: string) => (n.toLowerCase() === "cf-access-jwt-assertion" ? token : undefined),
			path: "/v1/admin/me",
			method: "GET",
		},
	} as never;
}

async function run(e: Partial<Env>, token?: string) {
	const next = vi.fn(async () => undefined);
	let thrown: unknown;
	try {
		await cloudflareAccessGate()(ctx(e, token), next as never);
	} catch (err) {
		thrown = err;
	}
	return { passed: next.mock.calls.length > 0, thrown };
}

describe("cloudflareAccessGate — off", () => {
	it("is a pure no-op when unconfigured, and logs nothing", async () => {
		const { passed, thrown } = await run({});
		expect(passed).toBe(true);
		expect(thrown).toBeUndefined();
		expect(logError).not.toHaveBeenCalled();
	});
});

describe("cloudflareAccessGate — audit", () => {
	/** The whole reason the mode exists. If this ever fails, enabling Access bricks the portal. */
	it("ALLOWS a request with no Access token, and records why", async () => {
		const { passed, thrown } = await run(CONFIGURED);
		expect(passed).toBe(true);
		expect(thrown).toBeUndefined();
		expect(logError).toHaveBeenCalledOnce();
		const arg = vi.mocked(logError).mock.calls[0][1];
		expect(arg.source).toBe("cf-access");
		expect(arg.level).toBe("warn");
		expect(arg.context).toMatchObject({ mode: "audit", outcome: "missing" });
		// Nothing was blocked, so nothing may claim a 403 status.
		expect(arg.status).toBeUndefined();
	});

	it("ALLOWS a request with a garbage token, and records it as invalid", async () => {
		const { passed } = await run(CONFIGURED, "not.a.jwt");
		expect(passed).toBe(true);
		expect(vi.mocked(logError).mock.calls[0][1].context).toMatchObject({ mode: "audit", outcome: "invalid" });
	});

	/** Silence is the signal that enforcing is safe — so a healthy request must be silent. */
	it("passes a VALID token through and logs NOTHING", async () => {
		const { passed, thrown } = await run(CONFIGURED, await signJwt(validClaims()));
		expect(passed).toBe(true);
		expect(thrown).toBeUndefined();
		expect(logError).not.toHaveBeenCalled();
	});
});

describe("cloudflareAccessGate — enforce", () => {
	const ENFORCING = { ...CONFIGURED, CF_ACCESS_ENFORCE: "true" };

	it("BLOCKS a missing token with 403 and records it", async () => {
		const { passed, thrown } = await run(ENFORCING);
		expect(passed).toBe(false);
		expect((thrown as { status: number }).status).toBe(403);
		expect(vi.mocked(logError).mock.calls[0][1]).toMatchObject({ source: "cf-access", status: 403 });
	});

	it("BLOCKS a garbage token", async () => {
		const { passed, thrown } = await run(ENFORCING, "not.a.jwt");
		expect(passed).toBe(false);
		expect((thrown as { status: number }).status).toBe(403);
	});

	it("admits a valid token", async () => {
		const { passed, thrown } = await run(ENFORCING, await signJwt(validClaims()));
		expect(passed).toBe(true);
		expect(thrown).toBeUndefined();
	});

	// The claim checks that make the assertion worth verifying at all.
	it("rejects a token minted for a DIFFERENT Access application (aud mismatch)", async () => {
		const { passed } = await run(ENFORCING, await signJwt({ ...validClaims(), aud: ["someone-elses-aud"] }));
		expect(passed).toBe(false);
	});

	it("rejects an expired token", async () => {
		const { passed } = await run(ENFORCING, await signJwt({ ...validClaims(), exp: Math.floor(Date.now() / 1000) - 60 }));
		expect(passed).toBe(false);
	});

	it("rejects a token from a different team domain", async () => {
		const { passed } = await run(ENFORCING, await signJwt({ ...validClaims(), iss: "https://attacker.cloudflareaccess.com" }));
		expect(passed).toBe(false);
	});

	it("rejects alg:none — the signature is not optional", async () => {
		const { passed } = await run(ENFORCING, await signJwt(validClaims(), { alg: "none" }));
		expect(passed).toBe(false);
	});

	it("rejects a token signed by a key that is not in the team JWKS", async () => {
		const other = (await crypto.subtle.generateKey(
			{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: KID })));
		const p = b64url(new TextEncoder().encode(JSON.stringify(validClaims())));
		const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", other.privateKey, new TextEncoder().encode(`${h}.${p}`));
		const { passed } = await run(ENFORCING, `${h}.${p}.${b64url(sig)}`);
		expect(passed).toBe(false);
	});

	/** Fail CLOSED: if the team JWKS is unreachable we must not admit the request.
	 *  A DISTINCT team domain, because the JWKS cache is module-level and keyed by domain —
	 *  reusing the usual one would silently serve a cached key and test nothing. */
	it("blocks when the JWKS fetch fails", async () => {
		const domain = "unreachable-team.cloudflareaccess.com";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 500 })),
		);
		const token = await signJwt({ ...validClaims(), iss: `https://${domain}` });
		const { passed } = await run({ ...ENFORCING, CF_ACCESS_TEAM_DOMAIN: domain }, token);
		expect(passed).toBe(false);
	});

	/** The log must never be able to decide the perimeter's answer. */
	it("still blocks when the error log itself throws", async () => {
		vi.mocked(logError).mockRejectedValueOnce(new Error("D1 down"));
		const { passed, thrown } = await run(ENFORCING);
		expect(passed).toBe(false);
		expect((thrown as { status: number }).status).toBe(403);
	});

	it("still ALLOWS in audit when the error log itself throws", async () => {
		vi.mocked(logError).mockRejectedValueOnce(new Error("D1 down"));
		const { passed } = await run(CONFIGURED);
		expect(passed).toBe(true);
	});
});
