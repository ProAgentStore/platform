#!/usr/bin/env node
/**
 * check-bare-catch.mjs — a `catch` block that is completely empty is a decision nobody wrote down.
 *
 * ── What this is actually about, because "empty catch" is the wrong headline
 *
 * #291 counted 64 of these and then discovered that most of them were RIGHT. This codebase swallows
 * deliberately and often correctly: `api()` has already written the durable error row before it
 * throws, a chime that will not play loses a sound and no information, and a scanner that asks "was
 * that JSON?" throws once per sentence by design. A gate that demanded every catch do something
 * would have produced 60 mechanical edits and a worse product.
 *
 * The rule that survived triage is not "reads vs writes" and not "log everything". It is:
 *
 *     A fallback that is INDISTINGUISHABLE FROM A REAL ANSWER is the dangerous case,
 *     whichever direction the request went.
 *
 * A list falling back to `[]` qualifies — "Documents (0)" is a claim about the account, not a report
 * about the request. So does a prompt block that is simply omitted, which makes the model answer "I
 * don't see any repositories" about an agent that has four. So does an empty textarea beside a live
 * Save, which does not merely hide the standing rules — it arms the control that overwrites them.
 *
 * A machine cannot tell those apart from the benign ones. What it CAN do is refuse to let the
 * decision be invisible, which is what this checks: **the braces must not be empty.** A comment
 * satisfies it. That is the whole gate, and it is deliberately the weakest rule that still works —
 * it makes the next reviewer read one sentence per silence instead of guessing, and it costs
 * nothing where the silence is correct.
 *
 * ── Why a comment counts, and why that is not a loophole
 *
 * Because the alternative was `console.warn`, and this repo has measured what that produces: a
 * second, earlier, less accurate report of an event the module below already filed properly. Six of
 * the seven swallows in `packages/sdk/src/voice/use-voice.ts` are correct precisely because
 * `stt.ts`, `tts.ts` and `config.ts` each report their own failures — a report at the call site
 * would name the symptom instead of the cause. The sentence is the deliverable there, not a log
 * line. #367's guard is the precedent: a lint that pretends to judge taste teaches people to
 * suppress it.
 *
 * ── Gate where the tree is clean, ratchet where it is not
 *
 * The same rule `check-design-tokens.mjs` and ci.yml's lint step follow. Every tree below is at
 * ZERO except `packages/browser-runner`, which is pinned at 2 rather than fixed: it was owned by a
 * concurrent lane while #291's triage ran, and reaching into another agent's live edits to win a
 * number is how two of this repo's worst afternoons started. A pin is always EXACT, never a `<=`
 * ceiling — a ceiling banks the ground you just took as headroom, which is numerically how the last
 * ratchet in this repo got spent.
 *
 * ── Reading the source rather than the AST, and the two mistakes that makes possible
 *
 * Both are handled, and both were real on this tree when the gate was written:
 *
 *   1. **A `catch {}` inside a COMMENT is not a catch.** Five of them exist — `agent-do.ts`,
 *      `lib/sql.ts`, `lib/d1-sqlite.ts`, `LoadFailed.tsx` and `coding/runtime.ts` all explain, in
 *      prose, a swallow that used to be there. A guard that fired on its own postmortem would be
 *      suppressed within a week. So catches are LOCATED in source with comments and string bodies
 *      blanked out.
 *   2. **An annotated catch must not look empty.** Blanking comments turns `catch { // why }` into
 *      `catch {      }`, so the emptiness test cannot run on the stripped text. Catches are located
 *      in the stripped source and JUDGED on the original.
 *
 * A line-oriented `grep` gets both of these wrong in the other direction as well: it missed
 * `parse-tool-calls.ts`, whose braces were empty across two lines, so the count this gate now holds
 * was never quite the count the issue reported.
 *
 * Run: `node scripts/check-bare-catch.mjs`
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { bareCatches } from "./lib/bare-catch.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * tree -> how many bare catches it may contain. 0 is a gate; anything else is a ratchet that may
 * only go down, and the reason it is not 0 belongs in a comment beside it.
 */
const PINNED = {
	"store/console/src": 0,
	"store/admin/src": 0,
	"agents/coder/web/src": 0,
	"packages/sdk/src": 0,
	"packages/cli/src": 0,
	"workers/api/src": 0,
	"workers/mcp/src": 0,
	// Cleared once the tree was free, so this is a gate rather than a ratchet — and the two sites
	// went opposite ways, which is the triage rule working rather than a formality. `inspect.ts`'s
	// lost `stat` only drops a `size` the renderer never printed, so the sentence IS the fix;
	// `repo-write.ts` was answering `dirty: false` off a failed `git status`, in the one field whose
	// job is to say whether anything came across a checkout. See #291.
	"packages/browser-runner/src": 0,
};

/** Generated, not authored — `build.js` emits it and nobody edits it. */
const SKIP = new Set(["workers/host/src/pages.ts"]);

const isSource = (f) => /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) && !/\.d\.ts$/.test(f);

function sources(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) sources(p, out);
		else if (isSource(entry) && !SKIP.has(relative(ROOT, p))) out.push(p);
	}
	return out;
}

let failed = false;
for (const [tree, pin] of Object.entries(PINNED)) {
	const found = [];
	// ADR 0002 G1: eight of the nine trees below are gated at ZERO, and "no offenders" is exactly
	// what a walk that found no files says too. A renamed directory or a tightened `isSource` would
	// otherwise turn this gate off one tree at a time, in silence.
	const files = sources(resolve(ROOT, tree));
	if (!files.length) {
		failed = true;
		console.error(`\n✗ ${tree}: the walk found no source files. This gate is reporting clean over an empty set (ADR 0002 G1).\n`);
		continue;
	}
	for (const file of files) {
		for (const line of bareCatches(readFileSync(file, "utf-8"))) found.push(`${relative(ROOT, file)}:${line}`);
	}
	if (found.length === pin) {
		// G2: the denominator rides in the passing line, so the next shrink is visible in a green build.
		console.log(`✓ ${tree}: ${pin === 0 ? "no bare catch blocks" : `${pin} bare catch block(s), at its pin`} over ${files.length} source file(s).`);
		continue;
	}
	failed = true;
	console.error(`\n✗ ${tree}: ${found.length} bare catch block(s), ${pin === 0 ? "and this tree is gated at zero" : `pinned at ${pin}`}.\n`);
	for (const f of found) console.error(`    ${f}`);
	console.error(
		found.length > pin
			? "\n  Say why the failure is ignorable, in a comment inside the braces — that is all this asks.\n" +
					"  If it is NOT ignorable, the test is whether the fallback can be mistaken for a real answer:\n" +
					"  an empty list, an omitted prompt block, a blank editor beside a live Save. Those need\n" +
					"  user-visible state, not a comment. See #291.\n"
			: "\n  Under the pin: you fixed some — lower the pin here in the same commit, or the ground you\n" +
					"  took is left as headroom.\n",
	);
}

if (failed) process.exit(1);
console.log("\n✓ Bare-catch gate OK — every remaining silence states why it is right (#291).");
