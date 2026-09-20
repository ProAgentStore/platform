/**
 * The run-admission gate on `loopDriverFor` (#825).
 *
 * The gate is a WRAPPER rather than a check in each driver, and rather than a check at each call
 * site, and those two choices are what this file pins. Every `driver.start()` in the tree takes
 * its driver from `loopDriverFor` — `POST /:id/loop`, the continue route, `delegate_goal` and
 * `start_work` through the tool registry, the delegation helper and the objective-queue drainer —
 * so wrapping there covers all five AND the sixth nobody has written. `trigger-eligibility.ts`'s
 * own header records what the call-site version of this bug cost on the background side: a fix at
 * one writer covers that writer only, and a later one forgets.
 */
import { describe, expect, it } from "vitest";
import { PAUSED_RUN_REFUSAL } from "./instance-pause.js";
import { loopDriverFor } from "./loop-drivers.js";
import type { Env } from "../types.js";

/** An env whose single `agent_instances` read answers with the status under test. */
function envWithStatus(status: string | null, opts: { throws?: boolean } = {}) {
	const bound: unknown[][] = [];
	const env = {
		DB: {
			prepare: (sql: string) => ({
				bind: (...args: unknown[]) => {
					bound.push([sql, ...args]);
					return {
						first: async () => {
							if (opts.throws) throw new Error("D1 unavailable");
							return status === null ? null : { status };
						},
					};
				},
			}),
		},
	} as unknown as Env;
	return { env, bound };
}

const input = (env: Env) => ({
	env,
	instanceId: "inst-1",
	userId: "u1",
	objective: "do the thing",
	maxIterations: 5,
	budgetId: "b1",
	depth: 0,
});

describe("a paused instance cannot start a run", () => {
	it("refuses with 409 and the sentence that names both remedies", async () => {
		const { env } = envWithStatus("paused");
		// biome-ignore lint/suspicious/noExplicitAny: the driver input is wider than this test needs
		const res = await loopDriverFor(null).start(input(env) as any);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.status).toBe(409);
		expect(res.error).toBe(PAUSED_RUN_REFUSAL);
	});

	it("refuses BEFORE the driver runs — the gate read is the ONLY query it makes", async () => {
		// The gate is in front of the driver, not inside it: a paused coding agent with its laptop
		// shut must be told it is PAUSED — the fact the owner created and can act on — rather than
		// sent to run `pags up` for a run that would be refused anyway. Counting queries is what
		// proves the short-circuit: the coding driver's own first move is `listRepos`, so a second
		// statement here would mean the refusal came out the far side of the driver.
		const { env, bound } = envWithStatus("paused");
		// biome-ignore lint/suspicious/noExplicitAny: minimal capabilities stand-in
		const gated = loopDriverFor({ workflow: "CODING_SESSION" } as any);
		expect(gated.id).toBe("coding");
		// biome-ignore lint/suspicious/noExplicitAny: the driver input is wider than this test needs
		const res = await gated.start(input(env) as any);
		expect(res).toMatchObject({ ok: false, status: 409, error: PAUSED_RUN_REFUSAL });
		expect(bound).toHaveLength(1);
		expect(bound[0][0]).toMatch(/FROM agent_instances/);
	});

	it("scopes the status read to the CALLER, not just the instance id", async () => {
		const { env, bound } = envWithStatus("paused");
		// biome-ignore lint/suspicious/noExplicitAny: the driver input is wider than this test needs
		await loopDriverFor(null).start(input(env) as any);
		expect(bound[0]).toContain("inst-1");
		expect(bound[0]).toContain("u1");
	});
});

describe("the gate stays out of the way otherwise", () => {
	it("preserves the driver's identity, which other callers read", async () => {
		// `agent-self-description.ts` and `loop-presets-store.ts` compare `loopDriverFor(caps).id`;
		// a wrapper that renamed the driver would quietly change what agents say about themselves.
		expect(loopDriverFor(null).id).toBe("chat");
		// biome-ignore lint/suspicious/noExplicitAny: minimal capabilities stand-in
		expect(loopDriverFor({ workflow: "CODING_SESSION" } as any).id).toBe("coding");
		// biome-ignore lint/suspicious/noExplicitAny: minimal capabilities stand-in
		expect(loopDriverFor({ workflow: "NOT_A_WORKFLOW" } as any).id).toBe("chat");
	});

	it("admits an ACTIVE instance — the gate reads, then hands over to the driver", async () => {
		// The positive half. Without it, a gate that refused everything would pass every negative
		// assertion in this file.
		const { env, bound } = envWithStatus("active");
		// biome-ignore lint/suspicious/noExplicitAny: minimal capabilities stand-in
		const gated = loopDriverFor({ workflow: "CODING_SESSION" } as any);
		// The coding driver goes on to fail for its OWN reasons on this stub env; what matters is
		// that it was reached, which the second query proves and which a refusal would prevent.
		// biome-ignore lint/suspicious/noExplicitAny: the driver input is wider than this test needs
		await gated.start(input(env) as any).catch(() => undefined);
		expect(bound.length).toBeGreaterThan(1);
	});

	it("fails OPEN when the status read itself fails, rather than refusing the run", async () => {
		// This gate exists to stop work on an agent the owner switched off, not to make a dropped
		// D1 read look like one. Asserted by reaching the driver (a second query) rather than by a
		// negative match, which a thrown error would satisfy without the gate doing anything right.
		const { env, bound } = envWithStatus(null, { throws: true });
		// biome-ignore lint/suspicious/noExplicitAny: minimal capabilities stand-in
		const gated = loopDriverFor({ workflow: "CODING_SESSION" } as any);
		// biome-ignore lint/suspicious/noExplicitAny: the driver input is wider than this test needs
		const res = await gated.start(input(env) as any).catch(() => undefined);
		expect(res).not.toMatchObject({ ok: false, status: 409, error: PAUSED_RUN_REFUSAL });
		expect(bound.length).toBeGreaterThan(1);
	});
});
