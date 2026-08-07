import { afterEach, describe, expect, it, vi } from "vitest";
import { appJwt, githubAccessDenial, githubAppConfigured, resolveGithubAccess } from "./github-app.js";
import type { Env } from "../types.js";

/** Export a generated RSA private key as PKCS#8 PEM (what GitHub gives you). */
async function makePem(): Promise<{ pem: string; publicKey: CryptoKey }> {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	let bin = "";
	for (const b of pkcs8) bin += String.fromCharCode(b);
	const b64 = btoa(bin).replace(/(.{64})/g, "$1\n");
	return { pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`, publicKey: pair.publicKey };
}

function b64urlToBytes(s: string): Uint8Array {
	const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	const raw = atob(pad);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

describe("github app config gate", () => {
	it("is off without app id + private key", () => {
		expect(githubAppConfigured({} as Env)).toBe(false);
		expect(githubAppConfigured({ GITHUB_APP_ID: "1" } as Env)).toBe(false);
	});
	it("is on with both set", () => {
		expect(githubAppConfigured({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k" } as Env)).toBe(true);
	});
});

describe("appJwt (WebCrypto RS256)", () => {
	it("mints a verifiable 3-part JWT with the right issuer", async () => {
		const { pem, publicKey } = await makePem();
		const env = { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: pem } as Env;
		const jwt = await appJwt(env);
		const [h, p, s] = jwt.split(".");
		expect(h && p && s).toBeTruthy();

		const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
		const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
		expect(header.alg).toBe("RS256");
		expect(payload.iss).toBe("123456");
		expect(payload.exp).toBeGreaterThan(payload.iat);

		const ok = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			publicKey,
			b64urlToBytes(s),
			new TextEncoder().encode(`${h}.${p}`),
		);
		expect(ok).toBe(true);
	});

	it("throws when not configured", async () => {
		await expect(appJwt({} as Env)).rejects.toThrow(/not configured/);
	});
});

// ── #321: five conditions, one of them retryable ──────────────────────────────────────────────
//
// Observed: `Couldn't reach GitHub for "fws" (No github access for "fws".). This is usually
// transient — try again.` Access was fine; "fws" was a display label, not a GitHub owner. Both
// halves pointed the reader somewhere wrong, and the retry hint recommended a loop that could
// never terminate. These pin the wording per condition, because the wording IS the bug.

describe("githubAccessDenial — the message names the actual condition", () => {
	it("marks exactly one state retryable", () => {
		const states = ["app-not-configured", "owner-unknown", "not-installed", "not-authorized", "transient"] as const;
		const retryable = states.filter((state) => githubAccessDenial({ state, owner: "acme" }).retryable);
		expect(retryable).toEqual(["transient"]);
	});

	it("an unknown owner is a WRONG ARGUMENT, not an authorization problem", () => {
		const d = githubAccessDenial({ state: "owner-unknown", owner: "fws" });
		expect(d.message).toMatch(/not a GitHub account or organisation/);
		expect(d.message).toMatch(/not an authorization problem/i);
		// And it points at the field that IS a path — the value the caller should have passed.
		expect(d.remedy).toMatch(/githubRepo/);
		expect(d.remedy).toMatch(/fail identically/);
	});

	it("only the not-installed case says to install the App, and carries the URL", () => {
		const d = githubAccessDenial({ state: "not-installed", owner: "acme", installUrl: "https://github.com/apps/pags/installations/new" });
		expect(d.message).toMatch(/not installed on "acme"/);
		expect(d.remedy).toContain("https://github.com/apps/pags/installations/new");
		// The three that are NOT a missing installation must not send anyone to install one.
		for (const state of ["owner-unknown", "not-authorized", "transient"] as const) {
			expect(`${githubAccessDenial({ state, owner: "acme" }).remedy}`).not.toMatch(/^Install /);
		}
	});

	it("separates 'installed but you are not authorized' from 'not installed at all'", () => {
		const d = githubAccessDenial({ state: "not-authorized", owner: "acme" });
		expect(d.message).toMatch(/installed on "acme", but this account is not authorized/);
		expect(d.remedy).toMatch(/Connect GitHub/);
	});

	it("an unconfigured platform tells the reader their own settings cannot fix it", () => {
		const d = githubAccessDenial({ state: "app-not-configured", owner: "acme" });
		expect(d.retryable).toBe(false);
		expect(d.remedy).toMatch(/Nothing in your own settings/);
	});

	it("only the transient message invites a retry", () => {
		const all = (["app-not-configured", "owner-unknown", "not-installed", "not-authorized", "transient"] as const).map((state) =>
			githubAccessDenial({ state, owner: "acme" }),
		);
		for (const d of all) {
			const text = `${d.message} ${d.remedy ?? ""}`;
			expect(/try again/i.test(text), `${d.state}: "${text}"`).toBe(d.retryable);
		}
	});
});

describe("resolveGithubAccess — which condition it decides it is", () => {
	const DB = (row: unknown) => ({ prepare: () => ({ bind: () => ({ first: async () => row, run: async () => ({}) }) }) });

	/** Route the three endpoints this path touches. */
	const routeFetch = (opts: { installs?: unknown[]; installsStatus?: number; userStatus?: number; mint?: boolean }) =>
		vi.fn(async (url: string) => {
			if (String(url).includes("/app/installations/") ) {
				return opts.mint === false
					? ({ ok: false, status: 500, json: async () => ({}) } as Response)
					: ({ ok: true, status: 200, json: async () => ({ token: "ghs_x", expires_at: new Date(Date.now() + 3600e3).toISOString() }) } as Response);
			}
			if (String(url).endsWith("/app/installations")) {
				const status = opts.installsStatus ?? 200;
				return { ok: status === 200, status, json: async () => opts.installs ?? [] } as Response;
			}
			if (String(url).includes("/users/")) {
				const status = opts.userStatus ?? 200;
				return { ok: status === 200, status, json: async () => ({}) } as Response;
			}
			return { ok: false, status: 404, json: async () => ({}) } as Response;
		});

	let env: Env;
	const withApp = async (over: Record<string, unknown> = {}) => {
		const { pem } = await makePem();
		return { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_SLUG: "pags", DB: DB(null), ...over } as unknown as Env;
	};

	afterEach(() => vi.unstubAllGlobals());

	it("an inert deployment is app-not-configured, never an authorization claim", async () => {
		const r = await resolveGithubAccess({} as Env, "u1", "acme");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.state).toBe("app-not-configured");
	});

	it('"fws" — installed nowhere and not a GitHub account — is owner-unknown, not "no access"', async () => {
		// THE reported failure. A 404 from /users/<owner> is what separates "go install an App"
		// from "you passed a display label", and only this probe can tell them apart.
		env = await withApp();
		vi.stubGlobal("fetch", routeFetch({ installs: [{ id: 7, account: { login: "freewebstore-online", type: "Organization" } }], userStatus: 404 }));
		const r = await resolveGithubAccess(env, "u1", "fws", { diagnose: true });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.state).toBe("owner-unknown");
			expect(r.retryable).toBe(false);
		}
	});

	it("a real owner with no installation is not-installed, and gets the install URL", async () => {
		env = await withApp();
		vi.stubGlobal("fetch", routeFetch({ installs: [], userStatus: 200 }));
		const r = await resolveGithubAccess(env, "u1", "acme", { diagnose: true });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.state).toBe("not-installed");
			expect(r.remedy).toContain("https://github.com/apps/pags/installations/new");
		}
	});

	it("does NOT claim the owner is unknown when GitHub would not say", async () => {
		// The over-claim this whole change is about, in miniature: a 500 on the existence probe
		// is not evidence of anything, and must not be reported as "no such owner".
		env = await withApp();
		vi.stubGlobal("fetch", routeFetch({ installs: [], userStatus: 500 }));
		const r = await resolveGithubAccess(env, "u1", "acme", { diagnose: true });
		if (!r.ok) expect(r.state).toBe("not-installed");
	});

	it("installed, but no VERIFIED binding for this user → not-authorized (the IDOR guard, named)", async () => {
		env = await withApp({ DB: DB(null) });
		vi.stubGlobal("fetch", routeFetch({ installs: [{ id: 7, account: { login: "acme", type: "Organization" } }] }));
		const r = await resolveGithubAccess(env, "u1", "acme");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.state).toBe("not-authorized");
			expect(r.retryable).toBe(false);
		}
	});

	it("a bound installation whose mint fails right now IS transient", async () => {
		env = await withApp({ DB: DB({ id: "row", token_expires_at: null }) });
		vi.stubGlobal("fetch", routeFetch({ installs: [{ id: 7, account: { login: "acme", type: "Organization" } }], mint: false }));
		const r = await resolveGithubAccess(env, "u1", "acme");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.state).toBe("transient");
			expect(r.retryable).toBe(true);
		}
	});

	it("GitHub refusing the APP's own credentials is not transient — retrying cannot fix it", async () => {
		env = await withApp();
		vi.stubGlobal("fetch", routeFetch({ installsStatus: 401 }));
		const r = await resolveGithubAccess(env, "u1", "acme");
		if (!r.ok) {
			expect(r.state).toBe("app-not-configured");
			expect(r.retryable).toBe(false);
		}
	});

	it("a 5xx on the installation list IS transient", async () => {
		env = await withApp();
		vi.stubGlobal("fetch", routeFetch({ installsStatus: 503 }));
		const r = await resolveGithubAccess(env, "u1", "acme");
		if (!r.ok) expect(r.state).toBe("transient");
	});

	it("without `diagnose` it does not pay for prose nobody reads", async () => {
		// `installationTokenForOwner`'s callers treat "no token" as "clone it publicly", so the
		// failure path is their ORDINARY path. It must not cost two extra GitHub calls each time.
		env = await withApp();
		const fetchMock = routeFetch({ installs: [], userStatus: 404 });
		vi.stubGlobal("fetch", fetchMock);
		const r = await resolveGithubAccess(env, "u1", "fws");
		if (!r.ok) expect(r.state).toBe("not-installed");
		expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("/users/"))).toBe(false);
	});

	it("a verified binding still yields a token — the guard is untouched", async () => {
		env = await withApp({ DB: DB({ id: "row", token_expires_at: null }) });
		vi.stubGlobal("fetch", routeFetch({ installs: [{ id: 7, account: { login: "acme", type: "User" } }] }));
		const r = await resolveGithubAccess(env, "u1", "acme");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.token).toBe("ghs_x");
	});
});
