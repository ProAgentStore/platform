/**
 * #1261 through the real MCP tool: an iteration-cap request reaches the caller whole.
 *
 * The owner's complaint was a coder note cut to "[cut: showing the first 553 of 716 characters]" in `waitNote` and
 * `waitingAsk`. The API now composes the report (what it did, the exact blocker, its plan, the steps it asks for and
 * why); this proves `coding_loop_status` hands the API's `waitNote` and `waitingAsk` on as written — no preview, no
 * cut marker — however long the blocker is. The handler is driven for real against a stubbed `fetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerCodingTools } from "./coding.js";
import type { InstanceToolsCtx } from "./shared.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const env: McpEnv = { API_BASE: "https://api.test" };

// A blocker far past the old 600-character clip, quoted exactly as a failing deploy prints it.
const BLOCKER = `Deploy failed on the migration check for 0002_channels: ${"migrations.json is missing the entry for 0002_channels; ".repeat(40)}end of error`;
const REPORT = [
	"What it did: Edited workers/api/src/routes/channels.ts, ran `pnpm test` (green), committed 3f9a1c2.",
	`Blocker: ${BLOCKER}`,
	"Plan: Add the 0002_channels entry to migrations.json, re-run the migration check, redeploy.",
	"Asking for 6 more steps — one edit, one check, one deploy; a second deploy attempt may be needed.",
].join("\n\n");
const QUESTION = "This run reached its cap of 10 iterations without finishing. Approve 6 more to let the same run continue in the same session (the working tree is untouched), or deny to stop it here.";
const WAIT_NOTE = `WAITING on YOUR APPROVAL, not stalled and not working — it reached its iteration cap without finishing and asks for 6 more iterations. ${REPORT}. Approve with answer_instance_input (task_id csess-1, value "approve" or a number of iterations) to resume this same run, or answer "deny" to stop it here.`;

function setup() {
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		const run = {
			runId: "run-1",
			status: "running",
			health: "waiting",
			waitingReason: "decision",
			waitNote: WAIT_NOTE,
			waitingAsk: { question: QUESTION, options: ["Approve 6 more iterations", "Deny — stop the run here"], why: REPORT, field: QUESTION, taskId: "csess-1", fullQuestion: `${QUESTION}\n\n${REPORT}` },
		};
		const body = url.pathname.endsWith("/loop") ? { runs: [run], total: 1, offset: 0, nextOffset: null } : {};
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	});
	const tools = new Map<string, Handler>();
	const ctx: InstanceToolsCtx = { env, tokenFor: (t?: string) => t || "session-token", safetyFor: (): SafetyContext => ({ env, subject: "u1", scopes: ["read"] }), groups: new Set() };
	// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server, same shape as objective-lifecycle-tools.test.ts
	registerCodingTools({ tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any, ctx);
	return tools;
}

afterEach(() => vi.unstubAllGlobals());

describe("an iteration-cap request through coding_loop_status (#1261)", () => {
	it("hands waitNote and waitingAsk on whole: the blocker is quoted to its last character and nothing is marked cut", async () => {
		const out = await setup().get("coding_loop_status")?.({ instance_id: "i1" });
		const text = out?.content[0].text ?? "";
		expect(BLOCKER.length).toBeGreaterThan(2_000); // far past the 600-character clip the owner hit
		const run = (JSON.parse(text) as { runs: Array<{ waitNote: string; waitingAsk: { question: string; why: string; fullQuestion: string; options: string[] } }> }).runs[0];
		expect(run.waitNote).toBe(WAIT_NOTE);
		expect(run.waitingAsk.fullQuestion).toBe(`${QUESTION}\n\n${REPORT}`);
		expect(run.waitingAsk.why).toBe(REPORT);
		expect(run.waitingAsk.fullQuestion).toContain(BLOCKER);
		expect(run.waitNote).toContain(BLOCKER);
		expect(text).not.toMatch(/\[cut: showing/);
	});

	it("keeps the three things the owner decides on — what it did, the plan, and why that many steps — beside the blocker", async () => {
		const out = await setup().get("coding_loop_status")?.({ instance_id: "i1" });
		const note = (JSON.parse(out?.content[0].text ?? "{}") as { runs: Array<{ waitNote: string }> }).runs[0].waitNote;
		expect(note).toContain("What it did: Edited workers/api/src/routes/channels.ts");
		expect(note).toContain("committed 3f9a1c2");
		expect(note).toContain("Plan: Add the 0002_channels entry to migrations.json");
		expect(note).toContain("Asking for 6 more steps — one edit, one check, one deploy; a second deploy attempt may be needed.");
		expect(note).toContain('answer_instance_input (task_id csess-1, value "approve" or a number of iterations)');
	});
});
