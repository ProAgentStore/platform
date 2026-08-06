/**
 * The wildcard-CORS allowlist for the host worker (#296).
 *
 * `Access-Control-Allow-Origin: *` is not wrong — it is wrong on a response that carries
 * something. VCQA reports every `*` identically, so this file records the DECISION instead of
 * the finding: exactly which resources are public, asserted as an exact set, with the reason each
 * one is on it. A new `*` is then a failing test that asks the author to justify it, and a
 * removed one is a failing test that asks them to delete the entry — the ratcheting shape the
 * repo's other guards use.
 *
 * WHY A SOURCE SCAN AND NOT A REQUEST TEST. `workers/host/src/index.ts` imports `./pages.js`,
 * which `build.js` generates from `store/` and `.gitignore` excludes. Importing the worker in a
 * unit test therefore requires a build step, and a test that needs a build step is a test that
 * gets skipped. The header table is a property of the source, so it is checked there.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");

/**
 * Resources served with `Access-Control-Allow-Origin: *`, and why each is safe to.
 *
 * The common property — the ONLY property that matters — is that none of them is produced from a
 * request identity. The host worker reads no `Authorization` header, verifies no session and
 * queries no per-user table (asserted below), so every byte it serves is the same for everyone.
 */
const PUBLIC_WILDCARD: Record<string, string> = {
	llmsTxt: "/llms.txt — public model-readable site summary",
	llmsFullTxt: "/llms-full.txt — the same, unabridged",
	skillsJson: "/skills.json — public skill manifest, fetched cross-origin by agents",
	mcpServerJson: "/.well-known/mcp-server.json — public MCP discovery document",
	widgetJs: "/widget.js — the embeddable chat widget, by definition loaded from other sites",
	authWidgetJs: "/auth-widget.js — the shared sign-in-state script, same reason",
};

/** Named header constants → their `Access-Control-Allow-Origin`, if they set one. */
function headerConstants(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of SRC.matchAll(/const (\w+): Record<string, string> = \{([\s\S]*?)\n\};/g)) {
		const acao = /"Access-Control-Allow-Origin":\s*"([^"]*)"/.exec(m[2]);
		if (acao) out[m[1]] = acao[1];
	}
	return out;
}

interface CorsResponse {
	/** The identifier of the body being served, e.g. `llmsTxt`. */
	body: string;
	/** The `Access-Control-Allow-Origin` value. */
	origin: string;
	/** `"inline"` when the header object is written at the call site, else the constant's name. */
	via: string;
}

/** Every `new Response(<body>, { headers: … })` that sets an origin. */
function corsResponses(): CorsResponse[] {
	const constants = headerConstants();
	const out: CorsResponse[] = [];
	// Inline header object: new Response(llmsTxt, { headers: { …, "Access-Control-Allow-Origin": "*" } })
	for (const m of SRC.matchAll(/new Response\(\s*(\w+),\s*\{\s*headers:\s*\{([^}]*)\}/g)) {
		const acao = /"Access-Control-Allow-Origin":\s*"([^"]*)"/.exec(m[2]);
		if (acao) out.push({ body: m[1], origin: acao[1], via: "inline" });
	}
	// Shared constant: new Response(widgetJs, { headers: JS_HEADERS })
	for (const m of SRC.matchAll(/new Response\(\s*(\w+),\s*\{\s*headers:\s*(\w+)\s*\}/g)) {
		if (constants[m[2]] !== undefined) out.push({ body: m[1], origin: constants[m[2]], via: m[2] });
	}
	return out;
}

describe("public wildcard CORS is an allowlist, not a habit (#296)", () => {
	const responses = corsResponses();

	it("attributes every Access-Control-Allow-Origin in the file", () => {
		// The safety net under the assertions below. A `*` added in a response shape this parser
		// does not recognise would otherwise pass silently — the exact failure mode that makes a
		// scanner-shaped test worthless. Each header is written in exactly one place: either
		// inline at a call site, or once in a shared constant. Count both; they must add up to
		// what the file literally declares.
		const declared = (SRC.match(/"Access-Control-Allow-Origin"/g) || []).length;
		const inline = responses.filter((r) => r.via === "inline").length;
		const constants = Object.keys(headerConstants()).length;
		expect(inline + constants, `parsed ${inline} inline + ${constants} in shared constants, but the file declares ${declared}. A response form this parser does not recognise sets CORS — extend corsResponses().`).toBe(declared);
	});

	it("exactly the documented public resources are served with `*`", () => {
		const wildcarded = [...new Set(responses.filter((r) => r.origin === "*").map((r) => r.body))].sort();
		expect(
			wildcarded,
			`wildcard-CORS resources changed.\nAdd the new one to PUBLIC_WILDCARD with a reason, or narrow it to an explicit origin. A '*' response must never depend on who asked.`,
		).toEqual(Object.keys(PUBLIC_WILDCARD).sort());
	});

	it("a non-public document is pinned to the store origin, not `*`", () => {
		// The counter-example that proves the allowlist is a choice: the OpenAPI spec is served
		// only to the store's own origin. If this ever becomes `*`, it was a decision.
		expect(responses.find((r) => r.body === "openapiYaml")?.origin).toBe("https://proagentstore.online");
	});

	it("no wildcard response is credentialed", () => {
		// `Access-Control-Allow-Origin: *` and `Allow-Credentials: true` are rejected together by
		// browsers, but a same-origin/subdomain variant of the mistake is not — so assert the
		// header is absent from this worker entirely rather than reasoning about combinations.
		expect(SRC).not.toContain("Access-Control-Allow-Credentials");
	});

	it("the host worker serves nothing that depends on the caller's identity", () => {
		// This is what actually makes `*` safe here, and it is the invariant most likely to be
		// broken by accident — a future "just add one authenticated endpoint" to a worker whose
		// default posture is public-and-cacheable. Every response is currently the same for
		// everyone, so there is nothing a cross-origin reader can learn that they could not have
		// fetched themselves.
		for (const forbidden of ["Authorization", "verifySession", "Bearer", "requireUser"]) {
			expect(SRC, `${forbidden} appeared in workers/host — this worker's wildcard CORS assumes it serves no per-caller data. Move the authenticated route to workers/api, or narrow every '*' first.`).not.toContain(forbidden);
		}
	});
});

describe("the credentialed API never uses wildcard CORS (#296)", () => {
	it("workers/api pins an explicit origin allowlist", () => {
		const api = readFileSync(new URL("../../api/src/index.ts", import.meta.url), "utf-8");
		// `credentials: true` is set there for the OAuth state-binding cookie, which makes a
		// wildcard origin both illegal and dangerous. Asserted from the other side so the two
		// workers cannot drift into each other's posture.
		expect(api).toContain("credentials: true");
		expect(api).not.toMatch(/origin:\s*"\*"/);
		expect(api).toContain('"https://proagentstore.online"');
	});
});
