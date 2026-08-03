import { describe, it, expect, vi } from "vitest";

// Mock the BYOK helper the ai_generate step dynamically imports.
const runUserWorkersAi = vi.fn();
vi.mock("./user-ai.js", () => ({ runUserWorkersAi: (...a: unknown[]) => runUserWorkersAi(...a) }));

import { STEP_TOOLS } from "./steps.js";
import type { RegistryToolCtx } from "./tool-registry.js";

// biome-ignore lint/style/noNonNullAssertion: the step is defined in this module.
const aiGen = STEP_TOOLS.find((t) => t.name === "ai_generate")!;

describe("ai_generate step", () => {
	it("renders {{field}} per item and writes the reply to `as`", async () => {
		runUserWorkersAi.mockImplementation(async (_env, _uid, _model, body: { messages: Array<{ content: string }> }) => ({
			response: `drafted: ${body.messages[body.messages.length - 1].content}`,
		}));
		const ctx = { env: {}, userId: "u1", instanceId: "i1" } as unknown as RegistryToolCtx;
		const r = await aiGen.handler(ctx, {
			items: [{ name: "Splash Coffee", suburb: "Petersham" }],
			prompt: "Write outreach to {{name}} in {{suburb}}",
			as: "draft",
		});
		expect(r.success).toBe(true);
		const out = JSON.parse(r.content) as { items: Array<{ draft: string }>; generated: number };
		expect(out.items[0].draft).toBe("drafted: Write outreach to Splash Coffee in Petersham");
		expect(out.generated).toBe(1);
		// BYOK: called with the owner's uid + default model.
		expect(runUserWorkersAi).toHaveBeenCalledWith({}, "u1", "claude-sonnet-4-6", expect.anything(), expect.objectContaining({ kind: "pipeline", instanceId: "i1" }));
	});

	it("fails without an owner context (BYOK requires a uid)", async () => {
		const r = await aiGen.handler({ env: {}, instanceId: "i1" } as unknown as RegistryToolCtx, { items: [{}], prompt: "x" });
		expect(r.success).toBe(false);
	});

	it("is best-effort: a generation failure leaves `as` empty, batch still succeeds", async () => {
		runUserWorkersAi.mockRejectedValue(new Error("no key"));
		const r = await aiGen.handler({ env: {}, userId: "u1" } as unknown as RegistryToolCtx, {
			items: [{ name: "X" }],
			prompt: "hi {{name}}",
			as: "draft",
		});
		expect(r.success).toBe(true);
		expect((JSON.parse(r.content) as { items: Array<{ draft: string }> }).items[0].draft).toBe("");
	});
});
