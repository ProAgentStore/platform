/**
 * The metering call sites, held to the source (#554, #556).
 *
 * Both of the defects this file guards are absences, and an absence is what a test suite is worst
 * at noticing: every ledger row still writes, every response is still 200, and the only symptom is
 * a number on a page that is quietly wrong. Neither had a failing assertion anywhere in the repo.
 *
 * ── Why source-level and not driven
 *
 * `routes/coding.contract.test.ts` DRIVES both of the call sites it can reach, and that is the
 * stronger test where it applies — what is asserted there is the value that reaches D1. But it can
 * only cover the sites reachable through a Hono route, and two of the four `recordEngineUsage`
 * calls live in a Workflow. #356 fixed those two; #554 then found the fourth still missing the
 * same argument, because what was fixed both times was a LIST of known sites rather than the
 * general form. This is the general form: any site, including one added tomorrow.
 *
 * A grep cannot check that the value is CORRECT — the contract test does that. It can check that
 * the argument was passed at all, which is the mistake that has now been made twice.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripCommentsAndLiterals } from "./source-guard.js";

const SRC = new URL("../", import.meta.url).pathname; // workers/api/src

/** Every non-test .ts file under workers/api/src, with comments and literals blanked. */
function sources(): Array<{ rel: string; code: string }> {
	const out: Array<{ rel: string; code: string }> = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d)) {
			const p = join(d, entry);
			if (statSync(p).isDirectory()) {
				walk(p);
				continue;
			}
			if (!p.endsWith(".ts") || p.endsWith(".test.ts") || p.endsWith(".d.ts")) continue;
			out.push({ rel: p.slice(SRC.length), code: stripCommentsAndLiterals(readFileSync(p, "utf-8")) });
		}
	};
	walk(SRC);
	return out;
}

/**
 * The full argument text of every call to `name`, balanced across newlines.
 *
 * A line-based match is not enough here: all four `recordEngineUsage` calls are multi-line, and
 * the argument this file exists to find sits on the second one. Comments and string literals are
 * already blanked by the caller, so a paren inside either cannot unbalance the walk.
 */
function callArgs(code: string, name: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`(?<![.\\w$])${name}\\s*\\(`, "g");
	for (let m = re.exec(code); m; m = re.exec(code)) {
		// Not the declaration. `export function foo(` and `const foo = (` both contain the name
		// followed by a paren, and counting them is how a "this must have a caller" guard passes
		// against a function nobody calls — the exact failure being guarded against.
		if (/(?:function|const|let|var)\s+$/.test(code.slice(Math.max(0, m.index - 24), m.index))) continue;
		let depth = 1;
		let i = m.index + m[0].length;
		for (; i < code.length && depth > 0; i++) {
			if (code[i] === "(") depth++;
			else if (code[i] === ")") depth--;
		}
		out.push(code.slice(m.index + m[0].length, i - 1));
	}
	return out;
}

/** Every non-test call site of `name`, with the module it sits in. */
function callSites(name: string): Array<{ rel: string; args: string }> {
	return sources().flatMap((s) => callArgs(s.code, name).map((args) => ({ rel: s.rel, args })));
}

describe("every engine-usage ledger write carries the payer observation (#554)", () => {
	const SITES = callSites("recordEngineUsage").filter((s) => s.rel !== "lib/usage.ts");

	it("finds the call sites at all — a rename must fail loudly, not silently pass", () => {
		// A guard that greps for a name is only as good as the name still existing. Zero hits is
		// the failure mode where this file reports success forever.
		expect(SITES.length).toBeGreaterThanOrEqual(4);
	});

	it("passes `authResolved` at every one of them", () => {
		// Drop it and `payerForEngineAuth(undefined)` returns null, so the row writes with the same
		// tokens, the same cost and `payer` silently NULL — excluded from `chargedCostMicros` and
		// bucketed as "Payer not established". Nothing fails; the Usage page just stops being able
		// to say who paid. That has now happened twice (#356, #554).
		const missing = SITES.filter((s) => !/\bauthResolved\b/.test(s.args)).map((s) => s.rel);
		expect(missing).toEqual([]);
	});
});

describe("the metering classifier is wired to something (#556)", () => {
	it("has at least one production caller", () => {
		// It shipped with #348, ten unit assertions, a docstring describing the exact case this
		// guard now covers — and zero call sites. A classifier nobody consults cannot classify
		// anything, and the gap it described stayed open for the eight months it existed. The unit
		// tests could not notice: they call it themselves.
		//
		// Not asserted here: WHICH module calls it. Pinning the caller would make this fail on a
		// legitimate move, and the invariant is that the verdict reaches a decision somewhere, not
		// that it reaches it from a particular file.
		expect(callSites("classifyEngineMetering").length).toBeGreaterThanOrEqual(1);
	});

	it("has a recorder wired to BOTH rows of the 2x2, in different modules", () => {
		// #348 built the classifier over (driver x engine) and wired the recorder to the terminal
		// row only — the six connector sites. The composition is what produced the bug: a table
		// half-wired looks finished from either end. So the invariant is not "a recorder exists",
		// it is that each driver has one.
		//
		// Asserted by MODULE rather than by the `driver:` argument on purpose: the scan blanks
		// string literals, so `driver: "terminal"` is not visible to it — a test that greps for a
		// blanked literal is a test that can only pass by accident.
		const terminal = callSites("noteUnmeteredDrive").filter((s) => s.rel.startsWith("lib/connectors/"));
		expect(terminal.length).toBeGreaterThanOrEqual(1);
		// The headless row goes through `noteUnmeteredHeadlessDrive`, which is where the classifier
		// is consulted. Its callers are the doors that hand a coding engine work.
		const headless = callSites("noteUnmeteredHeadlessDrive").filter((s) => s.rel !== "lib/engine-metering.ts");
		expect(headless.length).toBeGreaterThanOrEqual(1);
	});
});
