import { describe, expect, it } from "vitest";
import { cloudflareAccessConfigured } from "./cf-access.js";
import type { Env } from "../types.js";

/** Only the pure config predicate is tested here. verifyAccessJwt is not exported and
 *  its happy path requires a live JWKS fetch (network) — deliberately out of scope. */
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
