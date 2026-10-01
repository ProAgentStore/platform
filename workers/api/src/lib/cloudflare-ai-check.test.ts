import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";

// The stored credentials are the ones from the #893 incident: the TOKEN saved in the account-ID slot.
const TOKEN = "cf-token-fixture-not-a-real-token-000000";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

vi.mock("./user-ai.js", () => ({
	getUserCloudflareAiCredentials: vi.fn(async () => ({ accountId: TOKEN, token: ACCOUNT_ID })),
}));

const { cloudflareAiCredentialProblem } = await import("./cloudflare-ai-check.js");

afterEach(() => vi.unstubAllGlobals());

describe("cloudflareAiCredentialProblem never echoes a stored credential (#893)", () => {
	it("redacts Cloudflare's 404, which quotes the account path, before it reaches the message", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			success: false,
			errors: [{ code: 7003, message: `Could not route to /client/v4/accounts/${TOKEN}/ai/models/search, perhaps your object identifier is invalid?` }],
		}), { status: 404 })));
		const problem = await cloudflareAiCredentialProblem({} as Env, "u1");
		expect(problem?.status).toBe(400);
		expect(problem?.error).toContain("HTTP 404");
		expect(problem?.error).toContain("Could not route to /client/v4/accounts/••••/ai/models/search");
		expect(problem?.error).not.toContain(TOKEN);
		expect(problem?.error).not.toContain(ACCOUNT_ID);
	});

	it("masks a stored value the upstream repeats anywhere else in its text", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			errors: [{ message: `token ${ACCOUNT_ID} is not valid for account ${TOKEN.toUpperCase()}` }],
		}), { status: 400 })));
		const problem = await cloudflareAiCredentialProblem({} as Env, "u1");
		expect(problem?.error).not.toContain(ACCOUNT_ID);
		expect(problem?.error.toLowerCase()).not.toContain(TOKEN);
	});

	it("redacts a transport error that carries the request URL", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => {
			throw new Error(`fetch failed: https://api.cloudflare.com/client/v4/accounts/${TOKEN}/ai/models/search`);
		}));
		const problem = await cloudflareAiCredentialProblem({} as Env, "u1");
		expect(problem?.status).toBe(502);
		expect(problem?.error).not.toContain(TOKEN);
	});
});
