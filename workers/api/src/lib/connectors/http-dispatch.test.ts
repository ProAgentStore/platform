// Dispatch-level tests for the http_request connector that mock the SSRF *boundary itself*
// (`safeFetch`), rather than the network under it. The sibling http.test.ts exercises the
// REAL safeFetch (mocking globalThis.fetch) — here we assert the connector's contract WHEN
// the shared guard rejects a hop or the fetch itself fails: the failure must be surfaced as
// a clean { success:false } tool result, never an unhandled throw. Kept in its own file so
// the vi.mock of ../ssrf.js doesn't disturb http.test.ts's real-guard assertions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock: replace safeFetch with a spy, but keep the real SsrfError class so the
// connector's `e instanceof SsrfError` branch (the "Blocked: …" path) is exercised for real.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("../ssrf.js", async () => {
	const actual = await vi.importActual<typeof import("../ssrf.js")>("../ssrf.js");
	return { ...actual, safeFetch };
});

// Import AFTER the mock is registered so http.ts binds to the mocked safeFetch.
const { getRegistryTool } = await import("../tool-registry.js");
const { SsrfError } = await import("../ssrf.js");
import type { RegistryToolCtx } from "../tool-registry.js";
import { unfenceUntrusted } from "../untrusted-fence.js";

const httpRequest = getRegistryTool("http_request")!;

/**
 * Knowingly-partial test doubles, and the only `any` left in this file.
 *
 * A `RegistryToolCtx` carries a whole `Env` of bindings and a four-method `ConnectorClient`;
 * the tool under test touches one or two of them. Declaring an interface for that subset would
 * put a second, unmaintained shape in front of the compiler and have it vouch for that, and
 * `as unknown as X` is the same claim with the lint rule switched off. So the cast is kept on
 * purpose and kept HERE — one place that says "fake", instead of call sites that imply otherwise.
 */
// biome-ignore lint/suspicious/noExplicitAny: deliberate partial double — see the block above.
const fake = <T,>(v: T): any => v;
const baseCtx = { env: fake({}) } as RegistryToolCtx;

async function run(input: Record<string, unknown>, ctx: RegistryToolCtx = baseCtx) {
	const r = await httpRequest.handler(ctx, input);
	let parsed: Record<string, unknown>;
	try {
		// #308: a successful envelope is fenced; unwrap the way the pipeline binder does.
		parsed = JSON.parse(unfenceUntrusted(r.content));
	} catch {
		parsed = undefined;
	}
	return { ...r, parsed };
}

beforeEach(() => safeFetch.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("http_request — SSRF guard surfaced via the shared safeFetch (mocked boundary)", () => {
	it("surfaces an SsrfError as a clean 'Blocked:' failure, not a crash", async () => {
		safeFetch.mockRejectedValueOnce(new SsrfError("Cannot fetch internal/private URLs"));
		const r = await run({ url: "https://internal.example/private" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/^Blocked:/);
		expect(r.content).toContain("Cannot fetch internal/private URLs");
		// It resolved a value (didn't reject) — the handler caught the throw.
		expect(r.parsed).toBeUndefined();
	});

	it("surfaces the https-only rejection from the guard as a Blocked failure", async () => {
		safeFetch.mockRejectedValueOnce(new SsrfError("Only https URLs allowed"));
		const r = await run({ url: "https://looks-ok.example/but-redirects-to-http" });
		expect(r.success).toBe(false);
		expect(r.content).toContain("Only https URLs allowed");
		expect(safeFetch).toHaveBeenCalledTimes(1);
	});

	it("surfaces a 'too many redirects' guard exhaustion as a Blocked failure", async () => {
		safeFetch.mockRejectedValueOnce(new SsrfError("Too many redirects"));
		const r = await run({ url: "https://redirect-loop.example/" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/blocked/i);
		expect(r.content).toContain("Too many redirects");
	});

	it("distinguishes a generic network error from an SSRF block", async () => {
		// A non-SsrfError (e.g. DNS failure) → "Request failed: …", still a clean failure.
		safeFetch.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));
		const r = await run({ url: "https://nonexistent.example/" });
		expect(r.success).toBe(false);
		expect(r.content).toMatch(/^Request failed:/);
		expect(r.content).not.toMatch(/^Blocked:/);
		expect(r.content).toContain("ENOTFOUND");
	});

	it("passes the assembled URL, method, and body through to safeFetch", async () => {
		safeFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const r = await run(
			{
				method: "POST",
				base: "https://api.example.com",
				path: "v1/thing",
				body: { q: "{{term}}" },
				inputs: { term: "hi" },
			},
			// A POST is a write, so it needs the instance's http write consent (#307) before it can
			// reach safeFetch at all. Granted here because the subject of this test is the dispatch.
			{ env: fake({ DB: { prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }) }) }) } }), instanceId: "inst1", userId: "u1" } as RegistryToolCtx,
		);
		expect(r.success).toBe(true);
		expect(safeFetch).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = safeFetch.mock.calls[0];
		expect(calledUrl).toBe("https://api.example.com/v1/thing");
		expect((init as RequestInit).method).toBe("POST");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({ q: "hi" });
	});
});
