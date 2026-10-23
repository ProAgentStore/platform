import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";
import { type CodingGoal, decideCodingAction } from "./coding-loop.js";
import { encryptKey } from "./crypto.js";

type Block = { type: string; text: string; cache_control?: { type: string; ttl?: string } };
type RequestBody = { system: Block[]; tools: unknown[]; messages: Array<{ role: string; content: Block[] }> };
const KEK = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const snapshot = { pane: "The CLI finished its turn.", runState: "idle" as const, ready: true, alive: true };

async function provider() {
	const key = await encryptKey("sk-ant-cache-fixture", KEK);
	const env = {
		KEY_ENCRYPTION_KEY: KEK,
		DB: { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({
			first: async () => sql.includes("SELECT key_ciphertext") && args[1] === "anthropic"
				? { key_ciphertext: key.ciphertext, dek_wrapped: key.dekWrapped, iv: key.iv } : null,
			run: async () => ({ success: true }),
		}) }) },
	} as unknown as Env;
	const requests: RequestBody[] = [];
	vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
		requests.push(JSON.parse(init.body as string));
		const frames = [
			{ type: "message_start", message: { usage: { input_tokens: 1 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Needs review." } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
			{ type: "message_stop" },
		];
		return new Response(new ReadableStream({ start(controller) {
			controller.enqueue(new TextEncoder().encode(frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join("")));
			controller.close();
		} }), { headers: { "Content-Type": "text/event-stream" } });
	}));
	return { requests, decide: (goal: CodingGoal, actionLog: string[] = []) => decideCodingAction(env, "owner", { goal, actionLog, snapshot }) };
}

afterEach(() => vi.unstubAllGlobals());

describe("Pilot cross-run provider cache boundary (#1317)", () => {
	// Invariant: different runs share platform/tool bytes before the first cache boundary;
	// owner rules, the objective and live constraints retain their authority after that boundary.
	it("reuses the platform prefix across different objectives, repositories, engines and owner rules", async () => {
		const { requests, decide } = await provider();
		await decide({ repo: "owner/first", clientType: "claude", objective: "Fix issue #123", standingInstructions: "First owner's full rules", mergePolicy: "direct" });
		await decide({ repo: "owner/second", clientType: "codex", objective: "Fix issue #456", standingInstructions: "Second owner's full rules", mergePolicy: "none" });
		const [first, second] = requests;
		expect(first.system[0]).toEqual(second.system[0]);
		expect(first.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(first.tools).toEqual(second.tools);
		expect(first.system[0].text).not.toMatch(/owner\/first|owner\/second|issue #123|issue #456|owner's full rules/);
		expect(first.system[1].text).toContain('Engine: "claude". Repository: "owner/first".');
		expect(second.system[1].text).toContain('Engine: "codex". Repository: "owner/second".');
		expect(first.system[1].text).toContain("OBJECTIVE: Fix issue #123");
		expect(second.system[1].text).toContain("OBJECTIVE: Fix issue #456");
		expect(first.system[1].text).not.toContain("Second owner's full rules");
		expect(second.system[1].text).not.toContain("First owner's full rules");
		expect(first.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("keeps full owner instructions and fences, merge authority, and the latest constraints in order", async () => {
		const { requests, decide } = await provider();
		const standingInstructions = "Never deploy without approval.\n```sh\npnpm -w test:full\n```";
		const objective = "Implement every acceptance criterion, then deploy.";
		await decide({ repo: "owner/repo", clientType: "claude", objective, standingInstructions, specialInstructions: "Keep all evidence intact.", mergePolicy: "none", dryRun: true,
			ownerDirectives: [{ text: "Only investigate; do not edit files.", at: Date.UTC(2026, 9, 23), delivery: "pending", processed: false }],
			scopeConstraints: [{ kind: "read_only", source: "owner directive 1" }],
		});
		const system = requests[0].system;
		const text = system.map((b) => b.text).join("");
		expect(text).toContain(`USER RULES (highest priority):\n${standingInstructions}\n\nKeep all evidence intact.`);
		expect(text).toContain(`OBJECTIVE: ${objective}`);
		expect(text.indexOf("MERGE AUTHORITY")).toBeGreaterThan(text.indexOf(`OBJECTIVE: ${objective}`));
		expect(text).toContain("this OVERRIDES the objective");
		expect(text).toContain("TEST MODE: avoid destructive or irreversible instructions");
		expect(system[2].text).toContain("Only investigate; do not edit files.");
		expect(system[2].text).toContain("They OVERRIDE the objective and any earlier instruction");
		expect(system[2].text).toContain("CONSTRAINTS IN FORCE");
		expect(system[2].text.indexOf("CONSTRAINTS IN FORCE")).toBeGreaterThan(system[2].text.indexOf("Only investigate"));
		expect(system[2].cache_control).toBeUndefined();
	});

	it("retains the run and append-only step caches when a later round changes the owner's hint", async () => {
		const { requests, decide } = await provider();
		const goal = { repo: "owner/repo", clientType: "claude" as const, objective: "Fix issue #123" };
		await decide({ ...goal, resumeNote: "The previous turn finished." }, ["Read the issue", "Implemented the change"]);
		await decide({ ...goal, userHint: "Run the full suite before finishing." }, ["Read the issue", "Implemented the change", "Ran the full suite"]);
		const [first, second] = requests;
		expect(first.system.slice(0, 2)).toEqual(second.system.slice(0, 2));
		expect(first.system[2].text).toContain("The previous turn finished.");
		expect(second.system[2].text).toContain("Run the full suite before finishing.");
		const a = first.messages[0].content;
		const b = second.messages[0].content;
		expect(a[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(b[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(b.slice(0, 2).map(({ text }) => text)).toEqual(a.slice(0, 2).map(({ text }) => text));
		expect([...second.system, ...b].filter((block) => block.cache_control)).toHaveLength(3);
	});
});
