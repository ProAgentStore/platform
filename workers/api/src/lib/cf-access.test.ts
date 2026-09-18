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
	// `warnedOff` is module-level and once-per-isolate (#108), so these three run in this order on
	// purpose: the silent case first, before any call can have consumed the one warning.
	it("stays silent on a local build (API_BUILD = dev)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { passed } = await run({ API_BUILD: "dev" });
		expect(passed).toBe(true);
		expect(warn).not.toHaveBeenCalled();
		expect(logError).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("warns ONCE per isolate on a deployed build that the gate is off — and never writes the error log", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const first = await run({ API_BUILD: "abc1234" });
		expect(first.passed).toBe(true);
		expect(first.thrown).toBeUndefined();
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][0]).toContain("gate is OFF");
		// The second admin request on the same isolate is what the admin SPA's polling looks like.
		await run({ API_BUILD: "abc1234" });
		expect(warn).toHaveBeenCalledOnce();
		expect(logError).not.toHaveBeenCalled();
		warn.mockRestore();
	});

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

	// #108 C2 — required, not checked-if-present. Cloudflare always sets both, so an assertion
	// without one is not Cloudflare's; "no expiry" must never read as "never expires".
	it("rejects a correctly signed token with NO exp", async () => {
		const { exp: _exp, ...claims } = validClaims();
		const { passed } = await run(ENFORCING, await signJwt(claims));
		expect(passed).toBe(false);
	});

	it("rejects a correctly signed token whose exp is not a number", async () => {
		const { passed } = await run(ENFORCING, await signJwt({ ...validClaims(), exp: "never" }));
		expect(passed).toBe(false);
	});

	it("rejects a correctly signed token with NO iss", async () => {
		const { iss: _iss, ...claims } = validClaims();
		const { passed } = await run(ENFORCING, await signJwt(claims));
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

// ── #108 C1: a service token verifies exactly like a person ─────────────────
// Same aud, same iss, same JWKS. Without classification, one Service Auth policy added in the
// dashboard widens the gate to a bearer credential that never met the IdP — with no deploy.
describe("cloudflareAccessGate — service-token assertions", () => {
	const ENFORCING = { ...CONFIGURED, CF_ACCESS_ENFORCE: "true" };
	const { email: _email, ...base } = validClaims();
	/** What Cloudflare mints for a service token: a Client ID as `common_name`, and no `email`. */
	const serviceClaims = () => ({ ...base, exp: Math.floor(Date.now() / 1000) + 600, type: "service_auth", common_name: "abc123.access" });

	it("BLOCKS a correctly signed service assertion by default, under its own outcome", async () => {
		const { passed, thrown } = await run(ENFORCING, await signJwt(serviceClaims()));
		expect(passed).toBe(false);
		expect((thrown as { status: number }).status).toBe(403);
		const arg = vi.mocked(logError).mock.calls[0][1];
		// NOT "invalid": that would send the reader to check an aud and a JWKS that are both fine.
		expect(arg.context).toMatchObject({ mode: "enforce", outcome: "service", kind: "service", commonName: "abc123.access" });
		expect(arg.message).toContain("CF_ACCESS_ALLOW_SERVICE");
	});

	it("classifies on EITHER signal — `type` alone, or a common_name with no email", async () => {
		const typeOnly = await run(ENFORCING, await signJwt({ ...base, type: "service_auth" }));
		expect(typeOnly.passed).toBe(false);
		const nameOnly = await run(ENFORCING, await signJwt({ ...base, common_name: "abc123.access" }));
		expect(nameOnly.passed).toBe(false);
	});

	it("does NOT mistake a person for a machine because their token also carries a common_name", async () => {
		const { passed } = await run(ENFORCING, await signJwt({ ...validClaims(), common_name: "" }));
		expect(passed).toBe(true);
		const both = await run(ENFORCING, await signJwt({ ...validClaims(), common_name: "abc123.access" }));
		expect(both.passed).toBe(true);
	});

	it("audit ALLOWS it and records it — the soak must surface a stray Service Auth policy", async () => {
		const { passed } = await run(CONFIGURED, await signJwt(serviceClaims()));
		expect(passed).toBe(true);
		expect(vi.mocked(logError).mock.calls[0][1].context).toMatchObject({ mode: "audit", outcome: "service" });
	});

	it("admits it, silently, only on an explicit CF_ACCESS_ALLOW_SERVICE affirmative", async () => {
		for (const v of ["1", "true", "yes", "on"]) {
			const { passed } = await run({ ...ENFORCING, CF_ACCESS_ALLOW_SERVICE: v }, await signJwt(serviceClaims()));
			expect(passed, v).toBe(true);
		}
		expect(logError).not.toHaveBeenCalled();
		// The lockout rule inverted: here a typo must degrade to REFUSING, never to admitting.
		for (const v of ["", "false", "0", "undefined", "maybe"]) {
			const { passed } = await run({ ...ENFORCING, CF_ACCESS_ALLOW_SERVICE: v }, await signJwt(serviceClaims()));
			expect(passed, v).toBe(false);
		}
	});

	it("the flag admits a VERIFIED service token only — a forged one is still invalid", async () => {
		const token = await signJwt({ ...serviceClaims(), aud: ["someone-elses-aud"] });
		const { passed } = await run({ ...ENFORCING, CF_ACCESS_ALLOW_SERVICE: "true" }, token);
		expect(passed).toBe(false);
		expect(vi.mocked(logError).mock.calls[0][1].context).toMatchObject({ outcome: "invalid" });
	});
});

// ── #108 C3: an `invalid` burst has to be diagnosable from the log alone ─────
describe("cloudflareAccessGate — what the log says about a refused token", () => {
	it("names the kid and the email of an invalid user token", async () => {
		await run(CONFIGURED, await signJwt({ ...validClaims(), aud: ["someone-elses-aud"] }));
		expect(vi.mocked(logError).mock.calls[0][1].context).toMatchObject({
			outcome: "invalid",
			kid: KID,
			kind: "user",
			email: "operator@example.com",
		});
	});

	it("names a kid the JWKS does not have — what a key rotation looks like", async () => {
		await run(CONFIGURED, await signJwt(validClaims(), { kid: "rotated-away" }));
		expect(vi.mocked(logError).mock.calls[0][1].context).toMatchObject({ outcome: "invalid", kid: "rotated-away" });
	});

	it("bounds what an attacker-supplied claim can write into the log", async () => {
		await run(CONFIGURED, await signJwt({ ...validClaims(), aud: ["x"], email: "a".repeat(5000) }));
		const ctxArg = vi.mocked(logError).mock.calls[0][1].context as { email: string };
		expect(ctxArg.email.length).toBe(128);
	});

	it("a missing or unparseable token carries no identity, and does not throw building the context", async () => {
		await run(CONFIGURED);
		expect(vi.mocked(logError).mock.calls[0][1].context).toMatchObject({ outcome: "missing" });
		vi.mocked(logError).mockClear();
		await run(CONFIGURED, "not.a.jwt");
		expect(vi.mocked(logError).mock.calls[0][1].context).toMatchObject({ outcome: "invalid" });
	});
});
