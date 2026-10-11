/**
 * `coding_session_end` tells the caller what the end actually did (#1015).
 *
 * The API reports whether this call closed the session, whether the machine confirmed the engine
 * stopped, what became of a direct-turn claim and — only when it was released — what the queue drain
 * did. The tool used to answer "Session … ended." for all of it. The handler is driven for real
 * against a stubbed `fetch`; the bodies are the shapes `routes/coding-drive.ts` returns.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EndSessionResponse } from "./coding-session-end-text.js";
import { registerCodingSessionTools } from "./coding-tools.js";
import type { McpEnv } from "./http.js";
import type { SafetyContext } from "./safety.js";

const env: McpEnv = { API_BASE: "https://api.test" };
type ToolResult = { content: { type: string; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function setup(endBody: unknown, endStatus = 200) {
	const calls: Array<{ url: string; method: string }> = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method || "GET").toUpperCase();
		calls.push({ url, method });
		const body = method === "POST" ? endBody : { sessions: [{ id: "S1", status: "active" }] };
		return new Response(JSON.stringify(body), { status: method === "POST" ? endStatus : 200, headers: { "content-type": "application/json" } });
	});
	const tools = new Map<string, Handler>();
	registerCodingSessionTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as coding-repo-remove.test.ts
		{ tool: (n: string, _d: string, _s: Record<string, unknown>, handler: Handler) => tools.set(n, handler) } as any,
		env,
		(t?: string) => t || "session-token",
		(): SafetyContext => ({ env, subject: "u1", scopes: ["read", "write", "runtime", "destructive"] }),
	);
	const tool = tools.get("coding_session_end");
	expect(tool, "coding_session_end is not registered").toBeDefined();
	return { calls, run: async () => (await (tool as Handler)({ instance_id: "i1", session_id: "S1" })).content[0].text };
}
afterEach(() => vi.unstubAllGlobals());

const WARNING = "The session is closed, but the engine on n1 did not confirm it stopped — it may still be running.";
const ended = (over: Partial<EndSessionResponse>): EndSessionResponse => ({ ok: true, session: "already_ended", engineStopped: true, ...over });

describe("coding_session_end reports each outcome the API reported", () => {
	it("confirmed recovery: already ended, stop confirmed, claim released, and the queued objective admitted", async () => {
		const { calls, run } = setup(ended({ directTurn: { turnId: "dt-1", released: true, queue: { attempted: true, drained: true, entryId: "objq-2", started: true, runId: "run-2" } } }));
		const t = await run();
		expect(t).toMatch(/^Session S1 was already ended — this call closed nothing new\. The engine on the machine confirmed it stopped\. The direct-turn claim dt-1 was released\. The next queued objective \(objq-2\) was admitted and started as run run-2\./);
		expect(t).not.toMatch(/^Session S1 ended\./);
		expect(calls.filter((c) => c.method === "POST")).toEqual([{ url: "https://api.test/v1/instances/i1/coding/sessions/S1/end", method: "POST" }]);
	});

	it("a repeat changes nothing, and says only that", async () => {
		const t = await setup(ended({})).run();
		expect(t).toMatch(/^Session S1 was already ended — this call closed nothing new\. The engine on the machine confirmed it stopped\.\n/);
		expect(t).not.toMatch(/claim|queue|admitted/);
	});

	it("an unconfirmed stop keeps the claim and admits nothing — and says the engine may still be running", async () => {
		const t = await setup(ended({ engineStopped: false, warning: WARNING, directTurn: { turnId: "dt-1", released: false, reason: "stop_not_confirmed" } })).run();
		expect(t).toContain(WARNING);
		expect(t).toContain("The direct-turn claim dt-1 was kept, because no machine confirmed the engine stopped. Nothing was admitted from the queue.");
		expect(t).not.toMatch(/was released|confirmed it stopped\./);
	});

	it("a newer claim is not released by an older end", async () => {
		const t = await setup(ended({ directTurn: { turnId: "dt-1", released: false, reason: "superseded" } })).run();
		expect(t).toContain("a newer instruction now holds the session. Nothing was admitted from the queue.");
	});

	it("a drain deferred because the repository is still owned says it waits", async () => {
		const t = await setup(ended({ directTurn: { turnId: "dt-1", released: true, queue: { attempted: false, reason: "repo_still_owned" } } })).run();
		expect(t).toContain("was released. Another session still owns the repository, so the queue was not drained; it waits for that work.");
	});

	it("a drain that claimed an entry and failed to start it says so, and whether it kept its place", async () => {
		const t = await setup(ended({ directTurn: { turnId: "dt-1", released: true, queue: { attempted: true, drained: true, entryId: "objq-2", started: false, requeued: true, error: "runner offline" } } })).run();
		expect(t).toContain("The next queued objective (objq-2) could not be started (runner offline); it kept its place in the queue.");
		expect(t).not.toMatch(/started as run/);
	});

	it("an empty queue is reported as empty, not as an admission", async () => {
		const t = await setup(ended({ directTurn: { turnId: "dt-1", released: true, queue: { attempted: true, drained: false } } })).run();
		expect(t).toContain("was released. Nothing was queued for this repository.");
	});

	it("a live session ended with a confirmed stop", async () => {
		const t = await setup({ ok: true, session: "ended", engineStopped: true }).run();
		expect(t).toMatch(/^Session S1 ended\. The engine on the machine confirmed it stopped\.\n/);
	});

	it("no connected machine: the stop is unknown, not confirmed", async () => {
		const t = await setup({ ok: true, session: "ended", engineStopped: null }).run();
		expect(t).toMatch(/^Session S1 ended\. No machine was connected to tell the engine to stop, so whether it stopped is unknown/);
	});

	it("an unknown session is not reported as ended", async () => {
		const t = await setup({ ok: false, session: "not_found", engineStopped: null }).run();
		expect(t).toMatch(/^Session S1 was not found — nothing was ended\./);
	});

	it("forwards the API's own structured answer after the sentences", async () => {
		const body = ended({ directTurn: { turnId: "dt-1", released: true, queue: { attempted: false, reason: "repo_still_owned" } } });
		const t = await setup(body).run();
		expect(JSON.parse(t.split("\n").at(-1) as string)).toEqual(body);
	});

	// ── preserved paths ──
	it("an API error is still an error", async () => {
		const t = await setup({ error: "Not your instance" }, 403).run();
		expect(t).toMatch(/^Error ending session S1:/);
	});

	it("a lost confirmation is still `outcome: unknown`", async () => {
		const t = await setup({ error: "bad gateway" }, 502).run();
		expect(JSON.parse(t)).toMatchObject({ outcome: "unknown", tool: "coding_session_end" });
	});
});
