/**
 * `set_instance_runner_node` never answers a pin move with a bare failure (#885).
 *
 * Live: the move landed, the caller got "MCP tool call failed", and told its user it had failed.
 * The tool promises a structured answer for each way a move can end, and these pin all four as the
 * caller receives them — through the real handler, with only the API (fetch) and the audit store faked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerRuntimeTools } from "./runtime.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function setup(kvPut: (k: string, v: string) => Promise<void> = async () => {}) {
	const handlers = new Map<string, Handler>();
	const server = { tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) };
	const env: McpEnv = { API_BASE: "https://api.test", OAUTH_KV: { put: kvPut } as unknown as KVNamespace };
	registerRuntimeTools(server as never, {
		env,
		tokenFor: (p?: string) => p || "session-token",
		safetyFor: (): SafetyContext => ({ env, subject: "user-1", scopes: ["read", "write", "runtime", "destructive"] }),
		groups: new Set(["coding"]),
	});
	const pin = handlers.get("set_instance_runner_node");
	if (!pin) throw new Error("set_instance_runner_node not registered");
	return (runner_node = "laptop") => pin({ instance_id: "inst-1", runner_node });
}

function apiAnswers(status: number, body: unknown) {
	vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const UNCONFIRMED = {
	runnerNode: "laptop",
	attachment: { node: "laptop", attached: false, unconfirmed: true, detail: "The pin to laptop is saved; attachment and release of other machines are not yet confirmed. Call instance_runner_node to check current placement." },
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("set_instance_runner_node on a slow or failed attach (#885)", () => {
	it("hands the caller the documented unconfirmed state, with the pin it saved", async () => {
		apiAnswers(200, UNCONFIRMED);
		const res = await setup()();
		expect(res.isError).not.toBe(true);
		expect(JSON.parse(res.content[0].text)).toEqual(UNCONFIRMED);
	});

	it("still hands it over when the audit write after the move fails — the live failure", async () => {
		// The move has landed by the time the tool audits it. A failing audit store used to throw out
		// of the handler, and the host showed that as a bare "tool call failed" about a saved pin.
		apiAnswers(200, UNCONFIRMED);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const res = await setup(async () => {
			throw new Error("KV PUT failed: 429 Too Many Requests");
		})();
		expect(res.isError).not.toBe(true);
		expect(JSON.parse(res.content[0].text)).toMatchObject({ runnerNode: "laptop", attachment: { unconfirmed: true } });
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("answers an API that never replies as outcome unknown with the poll, not as a failure", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
		const pending = setup()();
		await vi.advanceTimersByTimeAsync(20_000);
		const res = await pending;
		expect(JSON.parse(res.content[0].text)).toMatchObject({
			outcome: "unknown",
			tool: "set_instance_runner_node",
			poll: { tool: "instance_runner_node", input: { instance_id: "inst-1" } },
			possibleOutcomes: ["not-started", "pin-saved-attachment-pending", "attached"],
		});
	});

	it("keeps a genuine refusal an error WITH its reason — never one indistinguishable from a timeout", async () => {
		apiAnswers(404, { error: "Instance not found" });
		const res = await setup()();
		expect(res.content[0].text).toBe("Error: Instance not found");
	});
});
