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
 *
 * ── Two halves, because a pool has two ends (#516)
 *
 * The guard above only asks whether the CALLER passed a `budgetId`. `JOB_APPLY` passed that test
 * for a while by being exempted, because the argument would have gone nowhere: the apply workflow
 * had no `reserve()` anywhere in it, so the pool would have been handed over and never drawn on —
 * which looks identical, from the call site, to a pool that works. So the second guard below asks
 * the RECEIVING side's question, and asks it by PREDICATE rather than from a list: every workflow
 * class that can reach a model call has `reserve()` somewhere in its admission path. A list is how
 * `JOB_APPLY` was missed by #502 in the first place; the predicate found `BROWSER_TASK` the moment
 * it was written, which is the whole argument for it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * `JOB_APPLY` used to be exempted here as a recorded gap. It is not one any more: #516 wired
 * `lib/apply-decide-budget.ts` into the loop's `decide` and `startJobApply` now opens the pool, so
 * the entry is gone rather than updated — an exemption that stops being true has to leave.
 */
const isWatch = (s: Site) => /mode:\s*["']watch["']/.test(s.rawArgs);

const EXEMPT: Array<{ match: (s: Site) => boolean; why: string }> = [
	{ match: isWatch, why: "watch mode: one bounded summary call, not a loop" },
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

	it("the apply entry point passes one too (#516)", () => {
		const apply = SITES.filter((s) => s.binding === "JOB_APPLY");
		expect(apply.length).toBe(1);
		expect(apply[0].args, `${apply[0].rel} starts an apply with no pool`).toMatch(/\bbudgetId\b/);
	});
});

// ── The receiving side: does the pool get DRAWN on? ─────────────────────────────────────────────
//
// Everything below is found, not listed. `JOB_APPLY` was handed no pool for as long as it was, and
// the guard above could not have said so, because the argument it checks would have been passed
// into a workflow with no `reserve()` in it — indistinguishable, from the call site, from one that
// draws every iteration.

const ALL_TS = tsFiles(SRC);
const RAW = new Map(ALL_TS.map((f) => [f, readFileSync(f, "utf-8")] as const));
const STRIPPED = new Map<string, string>();

/** Local files one file imports, resolved to real paths. Memoized — the walk revisits hubs a lot. */
const IMPORTS = new Map<string, string[]>();
function importsOf(file: string): string[] {
	let out = IMPORTS.get(file);
	if (out) return out;
	out = [];
	for (const m of (RAW.get(file) ?? readFileSync(file, "utf-8")).matchAll(/(?:^|\n)\s*import[\s\S]*?from\s*["']([^"']+)["']/g)) {
		const spec = m[1];
		if (!spec.startsWith(".")) continue;
		const base = join(dirname(file), spec.replace(/\.js$/, ""));
		for (const cand of [`${base}.ts`, join(base, "index.ts")]) {
			if (existsSync(cand)) {
				out.push(cand);
				break;
			}
		}
	}
	IMPORTS.set(file, out);
	return out;
}

/**
 * Every file the entry reaches through RELATIVE imports, transitively, inside workers/api/src.
 *
 * TYPE-ONLY imports count, deliberately. `import-graph.test.ts` makes the same call for the same
 * reason: an erased edge is still the edge a reader follows, and a workflow that reaches the model
 * through one is still the workflow that spends the money.
 */
const REACH = new Map<string, Set<string>>();
function reachableFrom(entry: string): Set<string> {
	const memo = REACH.get(entry);
	if (memo) return memo;
	const seen = new Set<string>();
	const stack = [entry];
	while (stack.length) {
		const file = stack.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const next of importsOf(file)) stack.push(next);
	}
	seen.delete(entry);
	REACH.set(entry, seen);
	return seen;
}

/** Comment/literal-stripped source, computed on demand — stripping all ~400 files costs 20s. */
function stripped(file: string): string {
	let s = STRIPPED.get(file);
	if (s === undefined) {
		s = stripCommentsAndLiterals(RAW.get(file) ?? readFileSync(file, "utf-8"));
		STRIPPED.set(file, s);
	}
	return s;
}
/** Raw hit first (cheap), confirmed against the stripped source (correct). */
const callsFn = (file: string, re: RegExp) => re.test(RAW.get(file) ?? "") && re.test(stripped(file));

/**
 * Files that actually call a model.
 *
 * `runUserWorkersAi` is the single BYOK choke point (it is what records usage), so "can this
 * workflow spend the user's tokens" is exactly "does it reach a file that calls it".
 */
const MODEL_CALLERS = new Set(ALL_TS.filter((f) => callsFn(f, /\brunUserWorkersAi\s*\(/)));

/**
 * Files that draw on a pool. Comments are stripped first, deliberately: `connectors/supervision.ts`
 * mentions `reserve()` in prose and calls nothing, and a guard fooled by a comment is a guard that
 * reports admission control which does not exist.
 */
const RESERVE_CALLERS = new Set(
	ALL_TS.filter((f) => !f.endsWith("delegation-budget-store.ts") && callsFn(f, /\breserve\s*\(/)),
);

/** The workflow CLASSES — `coding-session-params.ts` is a type leaf, not an entry point. */
const WORKFLOWS = tsFiles(join(SRC, "workflows")).filter((f) => callsFn(f, /extends\s+WorkflowEntrypoint\b/));

const rel = (f: string) => f.slice(SRC.length);

/**
 * Workflow classes that reach a model and legitimately draw on no pool.
 *
 * Each entry is a claim about the workflow's SHAPE, and each is re-checked below against what the
 * walk actually found — an exemption that no longer matches a model-driving workflow is stale
 * config pretending to be a decision.
 */
const UNPOOLED: Array<{ file: string; why: string }> = [
	{
		file: "workflows/pipeline-run.ts",
		why: "a pipeline is a definition-bounded step list, not an open-ended loop, and #382 decided deliberately that the run opens a pool only when the DEFINITION names a tool that can open a delegation tree (`pipelineOpensDelegations`) — opening one for every 5-minute sweep would leave three D1 ops and a permanent unused row behind to bound a delegation that will never happen",
	},
	{
		file: "workflows/browser-task.ts",
		why: "a REAL gap, recorded rather than hidden — surfaced by this guard the first time it was written (#516). BROWSER_TASK runs the SAME `runApplyLoop` engine as the apply path, 12 rounds × 60 steps of BYOK Claude, started from `routes/instances-browse.ts` with no pool. The fix is the apply one applied to a second binding and a second params type; it is its own change and its own issue, and naming it here is what stops it being rediscovered as a surprise",
	},
];

describe("a workflow that can spend the user's tokens draws on a pool (#516)", () => {
	it("the walk found the workflows and the model callers at all — it is not vacuous", () => {
		expect(ALL_TS.length, "the source walk found almost nothing — this guard has stopped measuring").toBeGreaterThan(100);
		// 5 workflow classes today. The denominator is asserted (ADR 0002 G1) because a walk that
		// found nothing would pass exactly as loudly as one that found everything. `coding-watch.ts`
		// is deliberately absent: it is watch MODE, a plain function `coding-session.ts` calls, not a
		// class with a binding — which is why the `watch` exemption lives on the call site above,
		// where the mode is actually chosen.
		expect(WORKFLOWS.map(rel).sort()).toEqual([
			"workflows/agent-loop.ts",
			"workflows/browser-task.ts",
			"workflows/coding-session.ts",
			"workflows/job-apply.ts",
			"workflows/pipeline-run.ts",
		]);
		expect(MODEL_CALLERS.size, "no file calls runUserWorkersAi — the choke point was renamed").toBeGreaterThan(5);
		expect([...RESERVE_CALLERS].map(rel).sort(), "callers of reserve()").toEqual([
			"lib/apply-decide-budget.ts",
			"lib/coding-decide-budget.ts",
			"workflows/agent-loop.ts",
		]);
	});

	it("every workflow that reaches a model has reserve() in its admission path", () => {
		const offenders: string[] = [];
		for (const wf of WORKFLOWS) {
			const reach = reachableFrom(wf);
			if (![...reach].some((f) => MODEL_CALLERS.has(f))) continue; // spends nothing
			if (UNPOOLED.some((e) => rel(wf) === e.file)) continue;
			if (![wf, ...reach].some((f) => RESERVE_CALLERS.has(f))) offenders.push(rel(wf));
		}
		expect(
			offenders,
			"This workflow can spend the user's BYOK tokens in a loop and nothing reserves against a\n" +
				"pool: no admission check, no settle, no account ceiling consulted, and no row for a stop\n" +
				"to act on when the run wedges. Wrap the model call the way `lib/apply-decide-budget.ts`\n" +
				"and `lib/coding-decide-budget.ts` do — reserve, run, settle in a `finally` — and thread\n" +
				"`budgetId` + `depth` onto the params from the entry point.",
		).toEqual([]);
	});

	it("the guard is measuring the workflows it claims to — the model-driving set is stated", () => {
		const driving = WORKFLOWS.filter((wf) => [...reachableFrom(wf)].some((f) => MODEL_CALLERS.has(f))).map(rel).sort();
		// All five drive a model. If one drops out of this list, the walk stopped resolving its
		// imports — and the guard above would silently pass it.
		expect(driving).toEqual([
			"workflows/agent-loop.ts",
			"workflows/browser-task.ts",
			"workflows/coding-session.ts",
			"workflows/job-apply.ts",
			"workflows/pipeline-run.ts",
		]);
	});

	it("each unpooled workflow is still real — the file exists and still reaches a model", () => {
		for (const e of UNPOOLED) {
			const wf = WORKFLOWS.find((f) => rel(f) === e.file);
			expect(wf, `${e.file} is exempted and is not a workflow class: ${e.why}`).toBeTruthy();
			expect([...reachableFrom(wf as string)].some((f) => MODEL_CALLERS.has(f)), e.why).toBe(true);
		}
	});

	it("the apply path draws on the pool it is handed (#516)", () => {
		// The specific wiring this ticket added, asserted where a reader looks for it: the workflow
		// reads `budgetId` off its payload and routes its decide through the gate, rather than
		// accepting the parameter and ignoring it.
		const src = stripped(join(SRC, "workflows/job-apply.ts"));
		expect(src).toMatch(/decideWithinBudget\(/);
		expect(src).toMatch(/budgetId:\s*event\.payload\.budgetId/);
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
