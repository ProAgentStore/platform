/**
 * #1124 — the pure half of HTTP auth strategies: what each renders, what it refuses, and the scrub list
 * that keeps every secret-derived value out of what is returned. The end-to-end proof (real routes, the
 * Discord case, OAuth2 refresh) is `routes/http-auth-strategies.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { describeRendering, parseTemplate, renderAuth, scrubSecrets, StrategyError, validateStrategy } from "./http-auth-strategies.js";

const SECRET = "tok_ABCdef123";

describe("renderAuth (#1124)", () => {
	it.each([
		["bearer", {}, [["Authorization", `Bearer ${SECRET}`]], []],
		["header_template", { header: { name: "Authorization", template: "Bot {{secret}}" } }, [["Authorization", `Bot ${SECRET}`]], []],
		["header_template", { header: { name: "X-Token", template: "pre-{{secret}}-post" } }, [["X-Token", `pre-${SECRET}-post`]], []],
		["api_key", { in: "header", name: "X-Api-Key" }, [["X-Api-Key", SECRET]], []],
		["api_key", { in: "query", name: "key" }, [], [["key", SECRET]]],
		["basic", { username: "u" }, [["Authorization", `Basic ${btoa(`u:${SECRET}`)}`]], []],
		["multi_header", { headers: [{ name: "X-Key", template: "{{secret}}" }, { name: "X-V", template: "2" }] }, [["X-Key", SECRET], ["X-V", "2"]], []],
		["none", { staticHeaders: { Accept: "application/json" } }, [["Accept", "application/json"]], []],
	])("%s %j", (strategy, cfg, headers, query) => {
		const r = renderAuth(validateStrategy(strategy, cfg), { secret: SECRET });
		expect(r.headers).toEqual(headers);
		expect(r.query).toEqual(query);
		expect(r.sensitive).toContain(SECRET);
	});

	it("OAuth2 sends the ACCESS token, never the client secret, and refuses to render without one", () => {
		const cfg = validateStrategy("oauth2_client_credentials", { tokenUrl: "https://a.example/t", clientId: "c" });
		const r = renderAuth(cfg, { secret: "client-secret", accessToken: "access-1" });
		expect(r.headers).toEqual([["Authorization", "Bearer access-1"]]);
		expect(r.sensitive).toEqual(expect.arrayContaining(["access-1", "client-secret", "Bearer access-1"]));
		expect(() => renderAuth(cfg, { secret: "client-secret" })).toThrow(StrategyError);
	});

	it("a staticHeader never replaces the credential header the strategy set", () => {
		const r = renderAuth(validateStrategy("bearer", { staticHeaders: { authorization: "Bearer fake" } }), { secret: SECRET });
		expect(r.headers).toEqual([["Authorization", `Bearer ${SECRET}`]]);
	});
});

describe("templating and validation (#1124)", () => {
	it("a template is literals around at most one {{secret}}", () => {
		expect(parseTemplate("Bot {{secret}}", "t")).toEqual({ prefix: "Bot ", suffix: "", usesSecret: true });
		expect(parseTemplate("2024-01", "t")).toEqual({ prefix: "2024-01", suffix: "", usesSecret: false });
		expect(() => parseTemplate("{{secret}}{{secret}}", "t")).toThrow(/once/);
		expect(() => parseTemplate("{{token}}", "t")).toThrow(/no \{ or \}/);
		expect(() => parseTemplate("Bot {{secret}}\n", "t")).toThrow(/line breaks/);
	});

	it("OAuth2 URLs must be https and carry no credentials; unknown strategies are refused", () => {
		expect(() => validateStrategy("oauth2_client_credentials", { tokenUrl: "http://a.example/t", clientId: "c" })).toThrow(/https/);
		expect(() => validateStrategy("oauth2_client_credentials", { tokenUrl: "https://u:p@a.example/t", clientId: "c" })).toThrow(/without credentials/);
		expect(() => validateStrategy("oauth2_authorization_code", { tokenUrl: "https://a.example/t", clientId: "c" })).toThrow(/authorizeUrl/);
		expect(() => validateStrategy("hmac", {})).toThrow(/must be one of/);
	});

	it("describeRendering names headers and parameters, never values", () => {
		expect(describeRendering(validateStrategy("api_key", { in: "query", name: "key" }))).toEqual({ headers: [], query: ["key"] });
		expect(describeRendering(validateStrategy("header_template", { header: { name: "Authorization", template: "Bot {{secret}}" } }))).toEqual({ headers: ["Authorization"], query: [] });
	});
});

describe("scrubSecrets (#1124)", () => {
	it("removes the longest value first, so a whole header goes before the secret inside it", () => {
		const r = renderAuth(validateStrategy("header_template", { header: { name: "Authorization", template: "Bot {{secret}}" } }), { secret: SECRET });
		expect(scrubSecrets(`sent "Bot ${SECRET}" and ${SECRET}`, r.sensitive)).toBe('sent "[redacted]" and [redacted]');
	});

	it("leaves values too short to scrub safely alone (a 1-3 character secret would shred any text)", () => {
		expect(scrubSecrets("abc abc", ["abc"])).toBe("abc abc");
	});
});
