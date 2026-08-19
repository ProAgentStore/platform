/**
 * Every turn the cloud sends an Engine names its author — or is on this file's allowlist (#505).
 *
 * ── The defect this exists to stop recurring
 *
 * `HeadlessSession.input` writes every turn to the Engine as `{ role: "user" }`. That is the only
 * value the stream-json input protocol accepts, so the framing cannot be fixed by changing the
 * role — the Engine calls whoever drives it "the user", and whoever drives it is usually a machine.
 * On 2026-08-11 that produced a completion message telling the owner he had "explicitly chosen" a
 * change he was never asked about. Nothing lied: the Engine said "the user", the Pilot read that
 * back, and "the user" was the only word the protocol gave it.
 *
 * `f503b254` fixed it by ANNOTATING rather than relabelling — the caller declares
 * `author: "pilot"`, and `packages/browser-runner/src/coding/turn-author.ts` prepends one sentence
 * before the instruction, which then follows verbatim. The instruction is the evidence; rewriting
 * it would destroy the only record of what was actually sent.
 *
 * That fix was applied to ONE call site, the Pilot's. Two other machine drivers — the Overseer's
 * delegation and the chat brain's `drive_claude` — kept sending unlabelled, and the whole point of
 * the change is that an unlabelled machine turn is indistinguishable from a human one. That is a
 * LIST-of-known-sites fix, the shape #554 records this repo paying for twice. This file is the
 * general form: any site, including one added tomorrow.
 *
 * ── Why source-level and not driven
 *
 * The three drivers reach the runner through three different transports and two of them are only
 * reachable with a live relay, so a driven test would cover the one site that is already correct.
 * What a scan cannot check is that the label is TRUE — that a `"pilot"` really was a machine. What
 * it can check is that the question was answered at all, which is the omission that has now been
 * made three times.
 *
 * ── Why unlabelled is allowed at all, and why it is an allowlist rather than a rule
 *
 * The author vocabulary is closed at one member (`"pilot"`) on purpose — see `turn-author.ts`. An
 * absent author means "nobody said", and the runner renders that as nothing. A `"human"` member
 * would turn silence into a claim: it could only ever be set by callers that bothered to be
 * explicit, so an unlabelled human turn and an unlabelled machine turn would STILL be
 * indistinguishable while the labelling implied otherwise. So the console's manual route stays
 * unlabelled, deliberately — and the reason it is unlabelled has to be written somewhere a person
 * adding the next call site will read, which is here rather than in a commit message.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripCommentsAndLiterals } from "./source-guard.js";

// `.pathname` + `join`, never `readFileSync(new URL(…))`: the Worker tsconfig's
// `@cloudflare/workers-types` supplies a `URL` that matches no node overload, which compiles
// nowhere and is caught only by CI's separate test-typecheck step (#599, then #627).
const SRC = new URL("../", import.meta.url).pathname; // workers/api/src

/** Every non-test .ts file under workers/api/src, raw and with comments/literals blanked. */
function sources(): Array<{ rel: string; raw: string; code: string }> {
	const out: Array<{ rel: string; raw: string; code: string }> = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d)) {
			const p = join(d, entry);
			if (statSync(p).isDirectory()) {
				walk(p);
				continue;
			}
			if (!p.endsWith(".ts") || p.endsWith(".test.ts") || p.endsWith(".d.ts")) continue;
			const raw = readFileSync(p, "utf-8");
			out.push({ rel: p.slice(SRC.length), raw, code: stripCommentsAndLiterals(raw) });
		}
	};
	walk(SRC);
	return out;
}

/**
 * The object literal enclosing the character at `i`, as a [start, end) span.
 *
 * Walked over the comment-and-literal-blanked source so a brace inside a string cannot unbalance
 * it — the same reason `metering-callsites.test.ts` walks its arguments there. `stripCommentsAndLiterals`
 * preserves LENGTH, so the span it returns indexes the raw source identically.
 */
function enclosingBraces(code: string, i: number): [number, number] | null {
	let depth = 0;
	let open = -1;
	for (let j = i - 1; j >= 0; j--) {
		if (code[j] === "}") depth++;
		else if (code[j] === "{") {
			if (depth === 0) {
				open = j;
				break;
			}
			depth--;
		}
	}
	if (open === -1) return null;
	depth = 1;
	for (let j = open + 1; j < code.length; j++) {
		if (code[j] === "{") depth++;
		else if (code[j] === "}" && --depth === 0) return [open, j + 1];
	}
	return null;
}

interface Site {
	rel: string;
	line: number;
	/** The enclosing object literal, from the RAW source (so the author's value is readable). */
	text: string;
	/** An `author` key is present — as a literal, a shorthand, or a threaded variable. */
	hasAuthor: boolean;
	/**
	 * The author's value when it is written inline as a string; `null` when it is threaded from a
	 * parameter, which the scanner cannot follow. `routes/coding-brains.ts` is threaded on purpose —
	 * one helper carries turns from both a machine and a person — so "there is an author key" and
	 * "the author is `pilot`" have to be separable questions.
	 */
	literal: string | null;
	/**
	 * True for `author?: "pilot"` in the TYPE rather than `author: …` in a value.
	 *
	 * Kept apart because the declaration is itself a `{kind:"message"}` construction and would
	 * otherwise count as a labelled call site — which let a mutation that stripped the Pilot's own
	 * label pass the by-module assertion, since both live in `coding-loop.ts`.
	 */
	declaration: boolean;
}

/**
 * Every `{ kind: "message", … }` construction in non-test source.
 *
 * Matched on the RAW text — the scanner blanks string literals, so `"message"` is not visible in
 * the stripped copy — and then confirmed to be live code by checking that the same offset in the
 * stripped copy still reads `kind`. A match inside a comment or inside a string is blanked to
 * spaces there and drops out, which is what stops this file reporting the prose that explains it.
 */
function messageSites(): Site[] {
	const out: Site[] = [];
	for (const { rel, raw, code } of sources()) {
		for (const m of raw.matchAll(/\bkind\s*:\s*["']message["']/g)) {
			const i = m.index ?? 0;
			if (code.slice(i, i + 4) !== "kind") continue; // comment or string literal
			const span = enclosingBraces(code, i);
			if (!span) continue;
			const text = raw.slice(span[0], span[1]);
			const decl = /\bauthor\s*\?\s*:/.test(text);
			out.push({
				rel,
				line: raw.slice(0, i).split("\n").length,
				text,
				// The key, in any of the three forms it is written: `author: "pilot"`, the shorthand
				// `author`, or `author?: "pilot"` in the type.
				hasAuthor: /(?:^|[{,\s])author\s*[?:,}]/.test(text),
				literal: text.match(/\bauthor\s*\??\s*:\s*["']([^"']*)["']/)?.[1] ?? null,
				declaration: decl,
			});
		}
	}
	return out;
}

/**
 * The call sites that deliberately send NO author, with the reason each one is exempt.
 *
 * Keyed by module and pinned by COUNT, so a second unlabelled construction added to an
 * already-listed file fails too. A file-level exemption would have let `routes/coding.ts` — the
 * module that also holds `/run`, `/resume` and `/restart` — absorb a new machine driver silently.
 */
const UNLABELLED_BY_DESIGN: Record<string, { count: number; why: string }> = {
	"routes/coding.ts": {
		count: 1,
		why:
			"POST …/coding/sessions/:sid/message — the console's MANUAL box and MCP's `coding_session_message`, " +
			"which passes its argument straight through. A person typed this text. It stays unlabelled because " +
			"the vocabulary is closed at `\"pilot\"`: absent means 'nobody said', and a `\"human\"` member could only " +
			"ever be set by the callers that bothered, so it would label some human turns and not others while " +
			"implying it labelled all of them. See `packages/browser-runner/src/coding/turn-author.ts`.",
	},
};

describe("every machine driver names itself on the turns it sends an Engine (#505)", () => {
	const SITES = messageSites();

	it("finds the constructions at all — a rename must fail loudly, not silently pass", () => {
		// Zero hits is the failure mode where a source-level guard reports success forever. The
		// count is the four production constructions plus the type declaration in `coding-loop.ts`.
		expect(SITES.length).toBeGreaterThanOrEqual(5);
	});

	it("labels all three brains that compose an instruction", () => {
		// Named explicitly, because "no unlabelled sites" also passes if all three were deleted.
		// These are the three places a MODEL writes the words: the Pilot at the point its decision
		// becomes an action (`coding-loop.ts`), the Agent chat's delegate path (`coding-brains.ts`),
		// and the chat brain's `drive_claude` tool (`storage-tools.ts`). In every one of them the
		// owner asked for an outcome and the model chose the sentence.
		const labelled = SITES.filter((s) => s.hasAuthor && !s.declaration).map((s) => s.rel);
		expect(labelled).toContain("lib/coding-loop.ts");
		expect(labelled).toContain("routes/coding-brains.ts");
		expect(labelled).toContain("lib/storage-tools.ts");
	});

	it("declares no author the runner would silently drop", () => {
		// `asTurnAuthor` narrows an unrecognised value to `undefined` — correctly, since the runner
		// is a published package anyone can POST to. The consequence is that a typo or an invented
		// member degrades to "unstated" with no error anywhere: the field is present, the code
		// reads as labelled, and the preamble never reaches the Engine. That is the #570/#591 class
		// this repo keeps paying for, so the vocabulary is asserted from the sending side too.
		const bad = SITES.filter((s) => s.literal !== null && s.literal !== "pilot").map((s) => `${s.rel}:${s.line} → ${s.literal}`);
		expect(bad).toEqual([]);
	});

	it("has no unlabelled construction outside the reasoned allowlist", () => {
		// The invariant. An unlabelled turn is indistinguishable from one a person typed, which is
		// the entire defect — the Engine's reply comes back as "you asked me to…" about a decision
		// no human made, and the owner has no way to tell that apart from one he did make.
		const actual: Record<string, number> = {};
		for (const s of SITES.filter((x) => !x.hasAuthor)) actual[s.rel] = (actual[s.rel] ?? 0) + 1;
		const expected = Object.fromEntries(Object.entries(UNLABELLED_BY_DESIGN).map(([rel, e]) => [rel, e.count]));
		expect(
			actual,
			"An unlabelled `{kind:\"message\"}` reaches the Engine as `role:\"user\"`. If a MACHINE wrote the text, add " +
				"`author: \"pilot\"`. If a PERSON typed it, add an entry to UNLABELLED_BY_DESIGN in this file saying so.",
		).toEqual(expected);
	});

	it("has a caller that actually supplies the author `driveClaude` threads", () => {
		// `routes/coding-brains.ts` is the one site whose author is a PARAMETER, because the same
		// helper carries both a model-composed instruction and the owner's own `@claude` words.
		// That makes the label invisible to the scan above: `{ …, author }` reads as named whatever
		// the callers pass, and an optional parameter nobody ever passes is exactly the state
		// `ownerTurns` was left in on this same ticket — the field exists, the column reads as
		// implemented, and nothing populates it. So the caller is asserted, not just the signature.
		const src = sources().find((s) => s.rel === "routes/coding-brains.ts");
		expect(src, "routes/coding-brains.ts moved — this assertion is now measuring nothing").toBeTruthy();
		const supplies = [...(src?.raw ?? "").matchAll(/\bdriveClaude\s*\(([^;]*?)\)\s*\)/g)].filter((m) => /["']pilot["']/.test(m[1]));
		expect(supplies.length, "no driveClaude call passes `\"pilot\"` — every turn it sends is now unstated").toBeGreaterThanOrEqual(1);
		// And the human path still passes nothing. Stamping the owner's own `@claude` message
		// `"pilot"` is this defect inverted, and it is the cheap mistake to make while fixing it.
		expect([...(src?.raw ?? "").matchAll(/\bdriveClaude\s*\(([^;]*?)\)\s*\)/g)].length).toBeGreaterThan(supplies.length);
	});

	it("keeps the type's optional author, which is what makes the field expressible", () => {
		// The declaration in `coding-loop.ts` is a `{kind:"message"}` construction too, and it is
		// the one that has to carry `author` for any of the others to compile. Dropping it from the
		// type would fail the call sites, but with a type error rather than with the reason — so it
		// is asserted here, where the reason is.
		const decl = SITES.find((s) => s.rel === "lib/coding-loop.ts" && s.declaration);
		expect(decl, "CodingActionKind no longer declares `author?` — no caller can name itself").toBeTruthy();
	});
});
