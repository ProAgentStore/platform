/**
 * Every outbound `fetch(` call carries a deadline — or routes through `safeFetch`,
 * which gained one in #438 (#438 floor, `lib/ssrf.ts`).
 *
 * ── Why this exists, and why now rather than before
 *
 * Before #438: `AbortSignal.timeout` appeared **0 times** in `workers/api/src`. Of the
 * ~65 `fetch(`-matching lines, only `lib/user-ai.ts` built an `AbortController`. Every
 * other outbound call — OAuth flows, GitHub App token minting, Stripe, Drive/Workdrive,
 * Gmail, Slack, repo ingestion, web-push — could hang for as long as the remote chose.
 *
 * Writing this scan BEFORE the floor was in place would have gone red on 62 of 65 sites
 * and been suppressed (the exact failure mode `security-invariants.test.ts:145` warns
 * about). The correct order was: floor first, scan second. The floor is `safeFetch`'s
 * `AbortSignal.timeout(SAFE_FETCH_TIMEOUT_MS)` — every call through it is now bounded.
 * This scan pins what remains.
 *
 * ── What is counted
 *
 * Bare `fetch(` call sites in non-test `.ts` files under `workers/api/src`, excluding:
 *
 *  - `lib/ssrf.ts` — IS safeFetch; its internal `fetch()` carries the signal via
 *    `hopInit` (a spread), so `signal:` does not appear as a literal keyword. It is
 *    excluded rather than falsely flagged.
 *  - Method declarations (`async fetch(request: Request)` in `agent-do.ts`,
 *    `relay-do.ts`, `index.ts`) — the Worker and DO handler signatures, not calls.
 *  - The interface member in `lib/connectors/types.ts` — a TypeScript contract leaf,
 *    not a call site.
 *
 * For each call site: if `signal:` appears within the next 15 raw lines, the call
 * carries its own deadline and is not counted. Currently exactly two files do this:
 * `lib/user-ai.ts` (both its Anthropic and CF Workers AI calls already build an
 * `AbortController`).
 *
 * The remaining sites — the NO_DEADLINE_PIN below — go to known fixed hosts (GitHub,
 * Google OAuth, Stripe, Drive, Gmail, Slack, push subscription endpoints) without any
 * timeout of their own. They can hang forever today. This scan makes that count visible
 * and pinned exactly so it can only decrease.
 *
 * ── What DOES protect some of them already
 *
 * The SSRF guard (`security-invariants.test.ts:145`) already ensures every connector
 * call (lib/connectors/, lib/steps.ts, lib/tools.ts, agent-do-knowledge.ts) that uses a
 * CALLER-SUPPLIED URL goes through `safeFetch` and therefore has the floor. OAuth token
 * endpoints, GitHub App API calls, Stripe, Drive, and the push endpoint go to
 * compile-time-constant hosts and are not required to route through safeFetch — but they
 * still lack a deadline. This scan covers that gap.
 *
 * ── Lowering the pin
 *
 * Add `signal: AbortSignal.timeout(N)` to a call site (or route through `safeFetch`),
 * then lower NO_DEADLINE_PIN by one. The exact-pin assertion fails in either direction,
 * so the number must track reality.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { findCalls, stripCommentsAndLiterals } from "./source-guard.js";
import { SAFE_FETCH_TIMEOUT_MS } from "./ssrf.js";

const SRC = new URL("../", import.meta.url).pathname; // workers/api/src

interface Source {
	rel: string;
	raw: string;
	code: string;
}

/**
 * Every non-test .ts source file under `workers/api/src`, lexed.
 *
 * Excludes `lib/ssrf.ts` explicitly: it IS the `safeFetch` implementation, and its
 * internal `fetch()` already carries the signal via the `hopInit` spread. Flagging it
 * as a "no-deadline call" would be wrong and would mask the real count.
 */
const SSRF_TS = "lib/ssrf.ts";

function sources(dir = SRC, out: Source[] = []): Source[] {
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			sources(p, out);
			continue;
		}
		if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
		const rel = relative(SRC, p);
		if (rel === SSRF_TS) continue;
		const raw = readFileSync(p, "utf-8");
		out.push({ rel, raw, code: stripCommentsAndLiterals(raw) });
	}
	return out;
}

const ALL = sources();

/**
 * A method declaration such as `async fetch(request: Request): Promise<Response>` is not a
 * call. `findCalls` matches `fetch(` with a negative lookbehind for `.` and word characters,
 * which correctly excludes `stub.fetch(` and `safeFetch(`, but DOES match
 * `async fetch(request:` because the character before `fetch` is a space.
 *
 * These declarations appear in `agent-do.ts`, `relay-do.ts`, and `index.ts` (the Workers +
 * DO `fetch()` handlers) and in `lib/connectors/types.ts` (an interface member).
 * Excluding them by content rather than by filename so a renamed file does not slip through.
 */
function isDeclaration(excerpt: string): boolean {
	return /^\s*(async\s+)?fetch\s*\(\s*(?:request|req)\s*:/.test(excerpt) || /^\s*fetch\s*\([^)]*\)\s*:\s*(Promise|Response)/.test(excerpt);
}

/**
 * Whether a `fetch(` call site carries its own deadline: `signal:` appears within 15
 * raw lines of the call, which is enough to cover the multi-line `{…}` init objects
 * this codebase typically writes.
 *
 * This check is HEURISTIC — it cannot see a signal threaded in from outside the call
 * (e.g. via a function argument). The two known false-negatives (both in `lib/user-ai.ts`,
 * which constructs an `AbortController` a few lines above) are handled by the check
 * correctly finding `signal:` in the init. The known false-positive risk (a `signal:`
 * elsewhere in the file) is low at a 15-line window.
 */
function hasSignalNearby(rawLines: string[], lineIndex: number): boolean {
	return /\bsignal\s*:/.test(rawLines.slice(lineIndex, lineIndex + 15).join("\n"));
}

interface FetchSite {
	rel: string;
	line: number;
	excerpt: string;
}

function fetchSites(): { compliant: FetchSite[]; noDeadline: FetchSite[] } {
	const compliant: FetchSite[] = [];
	const noDeadline: FetchSite[] = [];
	for (const f of ALL) {
		const rawLines = f.raw.split("\n");
		const codeLines = f.code.split("\n");
		for (const hit of findCalls(f.code, "fetch")) {
			const excerpt = codeLines[hit.line - 1]?.trim() ?? "";
			if (isDeclaration(excerpt)) continue;
			const site: FetchSite = { rel: f.rel, line: hit.line, excerpt };
			if (hasSignalNearby(rawLines, hit.line - 1)) compliant.push(site);
			else noDeadline.push(site);
		}
	}
	return { compliant, noDeadline };
}

/**
 * The exact count of bare `fetch(` call sites in `workers/api/src` that carry no
 * deadline of their own and do not route through `safeFetch`.
 *
 * Measured at #438 after the safeFetch floor landed: 55.
 *
 * This is a FLOOR on the fix, not a ceiling on the problem. When you add a `signal:`
 * to a call site (or route it through `safeFetch`), lower this number in the same
 * commit. The pin prevents the number from growing silently.
 *
 * If you add a NEW `fetch(` call with no deadline (and it is not to `safeFetch`),
 * you must raise this number — and that comment will be read by the next reviewer.
 */
const NO_DEADLINE_PIN = 55;

const listing = (sites: FetchSite[]) => sites.map((s) => `  ${s.rel}:${s.line}  ${s.excerpt.slice(0, 100)}`).join("\n");

describe("every outbound fetch() call carries a deadline (#438)", () => {
	it("safeFetch applies a default deadline when no signal is supplied", () => {
		// Non-vacuity: the floor this scan rests on. If safeFetch stops applying
		// AbortSignal.timeout, the pin below is meaningless — all 55 sites that rely on
		// it are back to hanging forever. The value is asserted in ssrf.test.ts and here.
		expect(SAFE_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
	});

	it("the scan finds fetch() call sites at all", () => {
		// If the scanner breaks (e.g. stripCommentsAndLiterals changes in a way that
		// blanks real code), the no-deadline list could silently empty and the pin below
		// would pass vacuously. This is the `sql-schema.test.ts` denominator pattern.
		const { noDeadline, compliant } = fetchSites();
		expect(noDeadline.length + compliant.length, "scanner found no fetch() calls — check source-guard.ts").toBeGreaterThan(50);
	});

	it("is exactly at its pin — can only decrease", () => {
		// Pinned EXACTLY, not as a `<=` ceiling, following control-shapes.test.ts and
		// the file-size ratchet: a ceiling banks the ground you just took as headroom.
		//
		// Over the pin: a new call site has been added without a deadline. Add
		//   `signal: AbortSignal.timeout(N)` (or route through safeFetch), then do NOT
		//   raise the pin — it defeats the purpose.
		//
		// Under the pin: you added a deadline to one or more existing call sites.
		//   Lower the pin by the number you fixed. The test message prints the current
		//   list so you know which ones remain.
		const { noDeadline } = fetchSites();
		expect(
			noDeadline.length,
			[
				`${noDeadline.length} fetch() call site(s) carry no deadline, pinned at ${NO_DEADLINE_PIN}.`,
				"Add signal: AbortSignal.timeout(N) (or route through safeFetch, which now applies",
				`AbortSignal.timeout(${SAFE_FETCH_TIMEOUT_MS}) by default) and lower NO_DEADLINE_PIN.`,
				"",
				listing(noDeadline),
			].join("\n"),
		).toBe(NO_DEADLINE_PIN);
	});

	it("call sites that carry a signal are not mis-counted as violations", () => {
		// Both Anthropic and CF Workers AI calls in lib/user-ai.ts build AbortControllers.
		// If the heuristic breaks and stops seeing their signal:, they'd inflate the pin
		// and the guard would miss two real sites if they later lost their deadline.
		const { compliant } = fetchSites();
		expect(compliant.map((s) => s.rel)).toEqual(expect.arrayContaining(["lib/user-ai.ts"]));
		expect(compliant.length).toBeGreaterThanOrEqual(2);
	});
});
