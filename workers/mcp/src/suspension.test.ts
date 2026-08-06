import { afterEach, describe, expect, it, vi } from "vitest";
import { suspensionBlock } from "./suspension.js";

const env = { API_BASE: "https://api.test" };

/** Stub the one network boundary the gate has, recording what it was asked. */
function stubMe(reply: { status: number } | { throws: true }) {
	const calls: Array<{ url: string; auth: string | null }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: typeof input === "string" ? input : input.toString(),
			auth: new Headers(init?.headers).get("Authorization"),
		});
		if ("throws" in reply) throw new Error("network down");
		return new Response("{}", { status: reply.status });
	});
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("suspensionBlock", () => {
	it("blocks the call when the API reports the account suspended", async () => {
		// Prevents: a suspended user keeping access to the GitHub-backed tools, which run on
		// the worker's own token and so never meet the API's requireUser gate (#273).
		stubMe({ status: 403 });
		const res = await suspensionBlock(env, "tok", "scaffold_agent");
		expect(res?.content[0].text).toContain("scaffold_agent");
		expect(res?.content[0].text).toContain("suspended");
	});

	it("asks the API as the identity being gated, not as the worker", async () => {
		// Prevents: probing with the wrong credential (or none), which would answer for
		// somebody else and pass a suspended caller through.
		const calls = stubMe({ status: 200 });
		await suspensionBlock(env, "tok-abc", "write_agent_file");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.test/v1/auth/me");
		expect(calls[0].auth).toBe("Bearer tok-abc");
	});

	it("allows an account in good standing", async () => {
		stubMe({ status: 200 });
		expect(await suspensionBlock(env, "tok", "write_agent_file")).toBeNull();
	});

	it("fails OPEN when the API is unreachable", async () => {
		// Prevents: an API blip taking the entire MCP surface down. Matches the API gate's
		// own documented fail-open on a D1 error — one moderated account briefly getting
		// through is a far smaller failure than every tool erroring for everyone.
		stubMe({ throws: true });
		expect(await suspensionBlock(env, "tok", "write_agent_file")).toBeNull();
	});

	it("fails OPEN on a 5xx, and does not treat 401/404 as suspension", async () => {
		// Prevents: conflating "bad token" or "unknown user" with "suspended" — those have
		// their own handling downstream, and 403 is the only status /v1/auth/me uses for the
		// suspension gate.
		for (const status of [401, 404, 500, 502]) {
			stubMe({ status });
			expect(await suspensionBlock(env, "tok", "write_agent_file")).toBeNull();
			vi.unstubAllGlobals();
		}
	});

	it("makes no network call at all when the caller has no identity", async () => {
		// Prevents: an unauthenticated public tool (agent_info) paying for a probe that
		// could never answer anything — there is no account to suspend.
		const calls = stubMe({ status: 403 });
		expect(await suspensionBlock(env, null, "agent_info")).toBeNull();
		expect(calls).toHaveLength(0);
	});
});
