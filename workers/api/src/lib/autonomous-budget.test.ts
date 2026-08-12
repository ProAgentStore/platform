/**
 * Every autonomous entry point opens a budget pool (#184, #502) — asserted over the SOURCE,
 * because the omission typechecks and its effect is only visible two files away.
 *
 * `budgetId` is optional on every workflow's params type, and the Pilot reads it like this
 * (`workflows/coding-session.ts`):
 *
 *     const budgetId = event.payload.budgetId ?? null;
 *     if (!budgetId) return decideCodingAction(env, userId, p, { kind: "coding", instanceId });
 *
 * So a call site that forgets it does not fail, does not warn, and does not spend any less. It
 * runs the identical loop with the admission check switched off: nothing reserves, nothing
 * settles, the account's rolling ceiling is never consulted, and the run's spend is invisible to
 * `GET /v1/budget/limits`. #184 scoped itself to "an admission check at EVERY autonomous entry
 * point"; the check landed inside `reserve()`, which is only reached by callers that were handed
 * a pool, so the promise was only as good as each call site's memory. Two had forgotten (#502),
 * plus the Overseer's delegation found while writing this.
 *
 * The rule this file enforces: if you hand work to a workflow that drives a model in a LOOP,
 * you hand it a pool. Exemptions are listed with a reason and compared exactly, so removing one
 * fails the test too — the list can only shrink deliberately.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripCommentsAndLiterals } from "./source-guard.js";

const SRC = new URL("../", import.meta.url).pathname; // workers/api/src
const MCP_SRC = new URL("../../../mcp/src/", import.meta.url).pathname;

/**
 * The workflow bindings that drive a model repeatedly without a human in the loop. A one-shot
 * model call is not one of these — it is bounded by construction, and pooling it would buy
 * accounting at the price of a D1 row per summary.
 */
const LOOPING_WORKFLOWS = ["CODING_SESSION", "AGENT_LOOP", "JOB_APPLY"] as const;

interface Site {
	rel: string;
	binding: string;
	/** The argument text with comments and string literals blanked — for identifier checks. */
	args: string;
	/** The same slice as written — for the checks that turn on a string literal. */
	rawArgs: string;
}

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d)) {
			const p = join(d, entry);
			if (statSync(p).isDirectory()) {
				walk(p);
				continue;
			}
			if (!p.endsWith(".ts") || p.endsWith(".test.ts") || p.endsWith(".d.ts")) continue;
			out.push(p);
		}
	};
	walk(dir);
	return out;
}

/** Balanced slice of the call's arguments, starting at the `(` index. */
function argsAt(source: string, open: number): string {
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const c = source[i];
		if (c === "(" || c === "{" || c === "[") depth++;
		else if (c === ")" || c === "}" || c === "]") {
			depth--;
			if (depth === 0) return source.slice(open + 1, i);
		}
	}
	return source.slice(open + 1);
}

/** Every `<BINDING>.create(` call site in the API worker, with the arguments it passes. */
function createSites(): Site[] {
	const sites: Site[] = [];
	for (const path of tsFiles(SRC)) {
		const raw = readFileSync(path, "utf-8");
		// Comments and string literals blanked so a `budgetId` in prose cannot satisfy the guard —
		// offsets are preserved, so the same index addresses both texts.
		const code = stripCommentsAndLiterals(raw);
		for (const binding of LOOPING_WORKFLOWS) {
			const needle = new RegExp(`${binding}\\.create\\s*\\(`, "g");
			for (const m of code.matchAll(needle)) {
				const open = m.index + m[0].length - 1;
				sites.push({
					rel: path.slice(SRC.length),
					binding,
					args: argsAt(code, open),
					// Blanking preserves offsets, so the same span addresses both texts.
					rawArgs: argsAt(raw, open),
				});
			}
		}
	}
	return sites;
}

const SITES = createSites();

/**
 * Call sites that legitimately start a workflow with no pool.
 *
 * `watch` is not a loop: `workflows/coding-watch.ts` polls the pane for the engine to finish and
 * makes exactly ONE `copilotSummary` call at the end. Pooling a single bounded call would add a
 * `delegation_budgets` row per instruction sent and buy nothing the ledger does not already have.
 *
 * `JOB_APPLY` is a REAL gap, recorded rather than hidden. The apply loop drives BYOK Claude for
 * as many steps as the ATS takes, and `reserve()` has no caller inside it at all — so unlike the
 * coding sites this is not a missing argument, it is missing wiring in `lib/apply-loop.ts`. That
 * is its own change and its own issue; naming it here is what keeps it from being rediscovered as
 * a surprise by the next person who reads #184's promise.
 */
const isWatch = (s: Site) => /mode:\s*["']watch["']/.test(s.rawArgs);

const EXEMPT: Array<{ match: (s: Site) => boolean; why: string }> = [
	{ match: isWatch, why: "watch mode: one bounded summary call, not a loop" },
	{ match: (s) => s.binding === "JOB_APPLY", why: "apply loop has no reserve() wiring at all — separate change (see the docblock)" },
];

describe("every autonomous entry point opens a budget pool (#184, #502)", () => {
	it("finds the workflow call sites at all — the guard is not vacuous", () => {
		expect(SITES.length).toBeGreaterThanOrEqual(5);
		expect(new Set(SITES.map((s) => s.binding))).toEqual(new Set(LOOPING_WORKFLOWS));
	});

	it("no looping workflow is started without a budgetId", () => {
		const offenders = SITES.filter((s) => !/\bbudgetId\b/.test(s.args))
			.filter((s) => !EXEMPT.some((e) => e.match(s)))
			.map((s) => `${s.rel} → ${s.binding}.create`);
		expect(
			offenders,
			"This starts autonomous model work with no pool. The Pilot's `decide` short-circuits\n" +
				"past reserve() when `budgetId` is null, so the run spends with nothing reserving,\n" +
				"nothing settling and no account-ceiling check — and `requestCancel` has no spend to\n" +
				"stop. Open one with `openBudget(env, userId, instanceId)` and pass `budgetId` +\n" +
				"`depth: 0` (or inherit the caller's, as lib/delegate-instance.ts does).",
		).toEqual([]);
	});

	it("the exemptions are still real — each one still matches a call site", () => {
		// An allowlist entry that matches nothing is stale config pretending to be a decision.
		for (const e of EXEMPT) {
			expect(SITES.some((s) => e.match(s)), e.why).toBe(true);
		}
	});

	it("both coding entry points that #502 fixed pass a pool", () => {
		const coding = SITES.filter((s) => s.binding === "CODING_SESSION" && !isWatch(s));
		expect(coding.length).toBeGreaterThanOrEqual(3);
		for (const s of coding) expect(s.args, `${s.rel} starts a Pilot with no pool`).toMatch(/\bbudgetId\b/);
	});
});

/**
 * The other half of #502: the MCP worker must not orchestrate a loop of its own.
 *
 * `coding_loop_start` used to run the whole thing inline — a `/chat` with the objective, then up
 * to 49 rounds of `/loop-decide` + `/chat` — and neither endpoint touches the budget. It was a
 * second implementation of `lib/loop-orchestrator.ts` living in a different deployable, with no
 * pool, no run row, and its "running" flag in a Map that only that Durable Object could see.
 * There is one loop driver, and it is on the server.
 */
describe("the MCP worker delegates loops, it does not run them (#502)", () => {
	const mcp = tsFiles(MCP_SRC).map((p) => ({ rel: p.slice(MCP_SRC.length), code: stripCommentsAndLiterals(readFileSync(p, "utf-8")) }));

	it("scans the MCP worker at all", () => {
		expect(mcp.length).toBeGreaterThan(5);
	});

	it("no MCP tool calls /loop-decide", () => {
		// `/loop-decide` is the orchestrator's own decision endpoint. A client calling it is a
		// client that has taken over the loop — the shape this guard exists to keep out.
		const offenders = mcp.filter((f) => /loop-decide/.test(f.code)).map((f) => f.rel);
		expect(
			offenders,
			"Start the durable run with POST /v1/instances/:id/loop and poll it instead. That path\n" +
				"opens the pool, claims the single driver (#208), writes the run row cancel acts on,\n" +
				"and survives the request.",
		).toEqual([]);
	});
});
