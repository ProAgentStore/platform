/** #1230: the allow-list file, its validating loader, and the provisional state of a vault password that no site has confirmed yet. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types.js";
import { anyCredentialForHost, confirmCredential, createCredential, findCredentialForHost, passwordLoginForHost } from "../credentials.js";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "../d1-sqlite.js";
import { ACCOUNT_CREATION_HOSTS, accountCreationHostFor, parseAccountCreationHosts } from "./account-creation-hosts.js";
import { mergeRunnerSettings, RUNNER_DEFAULTS } from "./policy.js";

describe("account-creation-hosts.json", () => {
	it("starts with the four job boards of #1230; SEEK and Indeed on, LinkedIn and Glassdoor listed but off, none accepting terms for the owner", () => {
		const by = Object.fromEntries(ACCOUNT_CREATION_HOSTS.map((h) => [h.host, h]));
		expect(by["seek.com.au"]?.enabled).toBe(true);
		expect(by["indeed.com"]?.enabled).toBe(true);
		expect(by["linkedin.com"]?.enabled).toBe(false);
		expect(by["glassdoor.com"]?.enabled).toBe(false);
		expect(ACCOUNT_CREATION_HOSTS.every((h) => h.acceptTerms === false)).toBe(true);
	});

	it("matches a site's subdomains, never a look-alike", () => {
		expect(accountCreationHostFor("secure.indeed.com")?.host).toBe("indeed.com");
		expect(accountCreationHostFor("au.seek.com.au")?.host).toBe("seek.com.au");
		expect(accountCreationHostFor("notindeed.com")).toBeNull();
		expect(accountCreationHostFor("indeed.com.evil.io")).toBeNull();
		expect(accountCreationHostFor(undefined)).toBeNull();
	});

	it("drops a malformed or duplicate entry instead of guessing, and treats anything but `true` as off", () => {
		const out = parseAccountCreationHosts({ hosts: [{ host: "A.example.com", enabled: "yes" }, { host: "a.example.com", enabled: true }, { host: "no spaces.com" }, { host: "localhost" }, null, { host: "b.example.org", enabled: true, acceptTerms: true }] });
		expect(out.map((h) => [h.host, h.enabled, h.acceptTerms])).toEqual([["a.example.com", false, false], ["b.example.org", true, true]]);
		expect(parseAccountCreationHosts(null)).toEqual([]);
		expect(parseAccountCreationHosts({ hosts: "x" })).toEqual([]);
	});
});

describe("the accountCreation setting", () => {
	it("is a boolean, and only a boolean", () => {
		expect(RUNNER_DEFAULTS.accountCreation).toBe(false);
		expect(mergeRunnerSettings(RUNNER_DEFAULTS, { accountCreation: true })).toMatchObject({ settings: { accountCreation: true } });
		expect(mergeRunnerSettings(RUNNER_DEFAULTS, { accountCreation: "yes" })).toEqual({ error: "accountCreation must be true or false" });
	});
});

describe("a provisional vault password", () => {
	const KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	let d1: RealSchemaD1;
	const env = () => ({ DB: d1.DB, KEY_ENCRYPTION_KEY: KEK }) as unknown as Env;
	beforeEach(() => {
		d1 = realSchemaD1();
		seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	});
	afterEach(() => d1.close());

	it("is stored and seen as 'a credential exists', but never offered to sign in with until the site has confirmed it", async () => {
		const id = await createCredential(env(), "i1", "u1", { domain: "indeed.com", username: "a@b.co", password: "Pr0visional&Pass-1", provisional: true } as Parameters<typeof createCredential>[3]);
		expect(await anyCredentialForHost(env(), "i1", "u1", "secure.indeed.com")).toEqual({ id, provisional: true });
		expect(await findCredentialForHost(env(), "i1", "u1", "secure.indeed.com")).toBeNull();
		expect(await passwordLoginForHost(env(), "i1", "u1", "secure.indeed.com")).toBeNull();
		expect(await confirmCredential(env(), "i1", "u1", id, "accepted")).toBe(true);
		expect(await findCredentialForHost(env(), "i1", "u1", "secure.indeed.com")).toMatchObject({ id, password: "Pr0visional&Pass-1" });
		expect(await confirmCredential(env(), "i1", "u1", id)).toBe(false);
	});
});
