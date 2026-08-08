import { describe, expect, it } from "vitest";
import { foldPullActs, pullActsFor, pullNumberFromTarget } from "./pull-attribution.js";
import type { Env } from "../types.js";

const act = (over: Record<string, unknown> = {}) => ({
	trace_id: "run-1",
	ts: 1_700_000_000_000,
	context: JSON.stringify({ act: "pr.open", target: "#42", sessionId: "sess-1", ...over }),
});

describe("pullNumberFromTarget — exact or absent", () => {
	it("reads the number out of the act's target", () => {
		expect(pullNumberFromTarget("#42")).toBe(42);
		expect(pullNumberFromTarget("  #7 ")).toBe(7);
	});

	/**
	 * `gh pr create --fill` is the common form and the runner's `prRef()` returns null for it — the
	 * number is only in the command's OUTPUT, which the act classifier never sees. Those PRs stay
	 * UNATTRIBUTED on purpose. Pairing an unnumbered act with whichever PR appeared around the same
	 * time would be a guess, and `engine-acts.ts` states the rule: the difference between "it
	 * merged" and "we did not see whether it merged" is the difference between an audit trail and a
	 * guess. A badge that is usually right is worst exactly when someone is asking who did this.
	 */
	it("refuses everything that is not exactly a PR number", () => {
		for (const bad of [null, undefined, 42, "", "42", "#", "#0", "#4a", "PR #4", "#4 (merged)"]) {
			expect(pullNumberFromTarget(bad)).toBeNull();
		}
	});
});

describe("foldPullActs", () => {
	it("maps a PR number to the run whose engine acted on it", () => {
		const map = foldPullActs([act()]);
		expect(map.get(42)).toMatchObject({ traceId: "run-1", act: "pr.open", sessionId: "sess-1" });
	});

	it("keeps the NEWEST act — rows arrive newest-first, so a later merge supersedes the open", () => {
		const map = foldPullActs([
			{ ...act({ act: "pr.merge" }), trace_id: "run-2", ts: 2 },
			{ ...act({ act: "pr.open" }), trace_id: "run-1", ts: 1 },
		]);
		expect(map.get(42)).toMatchObject({ traceId: "run-2", act: "pr.merge" });
	});

	it("ignores acts that are not about pull requests", () => {
		expect(foldPullActs([act({ act: "push.force", target: "#42" })]).size).toBe(0);
	});

	it("ignores an act with no number rather than attributing it to something", () => {
		expect(foldPullActs([act({ target: null })]).size).toBe(0);
	});

	it("survives a corrupt context blob", () => {
		expect(foldPullActs([{ trace_id: "r", ts: 1, context: "{not json" }]).size).toBe(0);
	});
});

describe("pullActsFor", () => {
	it("scopes the read to BOTH the owner and the instance, in SQL", async () => {
		let sql = "";
		let binds: unknown[] = [];
		const env = {
			DB: {
				prepare(q: string) {
					sql = q;
					return {
						bind: (...b: unknown[]) => {
							binds = b;
							return { all: async () => ({ results: [act()] }) };
						},
					};
				},
			},
		} as unknown as Env;
		const map = await pullActsFor(env, "inst-1", "user-1");
		expect(sql).toMatch(/user_id = \?1/);
		expect(sql).toMatch(/instance_id = \?2/);
		expect(binds.slice(0, 2)).toEqual(["user-1", "inst-1"]);
		expect(map.get(42)?.traceId).toBe("run-1");
	});

	it("degrades to no attribution rather than failing the panel", async () => {
		const env = {
			DB: {
				prepare() {
					throw new Error("D1 down");
				},
			},
		} as unknown as Env;
		expect((await pullActsFor(env, "i", "u")).size).toBe(0);
	});
});
