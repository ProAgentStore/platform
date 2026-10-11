/**
 * What a run's completion claim may assert, judged against what the engine was SEEN to do (#1019).
 *
 * A Pilot `finish(done)` carried whatever the model wrote: "all 812 tests pass, pushed to main". The
 * platform published that sentence as the run's outcome, the completion notice and the board card, and
 * nothing compared it with the run. The claims that went wrong were specific and checkable:
 *
 *   - a green run from BEFORE the last edit, offered as validation of the edited code;
 *   - a focused subset reported as "the full suite";
 *   - a test command that never ran a test — an unsupported option, options swallowed by a bare `--`
 *     a package-manager script did not forward, "No test files found" — reported as passing;
 *   - a count that is not the count the run printed;
 *   - "pushed" over a push that answered "Everything up-to-date", or that predates later commits;
 *   - "CI is green" / "deployed" from a run that never looked.
 *
 * ── The evidence, and why no new record
 *
 * The engine's own tool calls: `⚙ <tool> <input>` / `↳✓|✗ <result>` lines that the runner writes into
 * every Claude Code pane, parsed by `engine-tool-calls.ts` with its cursor so consecutive snapshots are
 * not double-counted. The Pilot already reads a snapshot every step, so the run's evidence is collected
 * from panes it has in hand — no new storage, no second ledger beside `coding_timeline`/`agent_events`.
 * On a Workflow replay the snapshots come back from the journal, so the evidence rebuilds identically.
 *
 * ── What it may and may not conclude
 *
 * It CONTRADICTS a claim only on what it saw (a failed final run, an edit after the green one, a count
 * that differs). It never upgrades: a claim with no observed support is "unverified", never "true".
 * When continuity between two snapshots was lost (`gap`), or the engine is one whose calls are not
 * structured (Codex/Grok), it says the record is incomplete rather than reading absence as nothing.
 * External CI and deploy are reported as their own line: local completion is not their verification.
 */
import { clipMarked } from "./clip-marked.js";
import { type EngineToolCall, toolCallsForSnapshot } from "./engine-tool-calls.js";
import { testInvocations, type TestInvocation } from "./coding-scope-constraints.js";

type Observed =
	| { kind: "edit"; seq: number; path: string | null }
	| { kind: "test"; seq: number; inv: TestInvocation | null; command: string; ok: boolean | null; output: string | null; outputCut: boolean }
	| { kind: "commit"; seq: number; ok: boolean | null; sha: string | null }
	| { kind: "push"; seq: number; ok: boolean | null; effect: "updated" | "up_to_date" | "rejected" | "unknown" }
	| { kind: "ci"; seq: number; ok: boolean | null; output: string | null }
	| { kind: "browser"; seq: number; ok: boolean | null };

/** The run's observed record. Held by the workflow across rounds; fed one snapshot pane at a time. */
export class CompletionEvidence {
	private anchor: EngineToolCall | null = null;
	private seq = 0;
	readonly observed: Observed[] = [];
	/** Calls were seen at all — false on an engine whose calls are not structured. */
	sawCalls = false;
	/** Continuity between two snapshots was lost at least once, so calls may be missing. */
	gap = false;

	observe(pane: string | undefined): void {
		if (!pane) return;
		const r = toolCallsForSnapshot(pane, this.anchor);
		this.anchor = r.anchor;
		if (r.gap) this.gap = true;
		for (const call of r.calls) {
			// An in-flight call (no result yet) is re-delivered by the cursor once it settles.
			if (call.output === null) continue;
			this.sawCalls = true;
			const o = classify(call, ++this.seq);
			if (o) this.observed.push(...o);
		}
	}
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_MUTATION = /\b(?:sed|perl)\s+-i\b|(?:^|[;&|]\s*)(?:rm|mv|cp|tee)\s|\s>>?\s*(?!\/dev\/null|&)[\w./~-]+|\bgit\s+(?:apply|am|checkout\s+--|restore|reset\s+--hard|stash\s+pop|cherry-pick|revert|merge|rebase)\b|\bpatch\s+-p/gm;
/** A tool that drives a real browser — the only kind of observation a "renders correctly" claim can rest on. */
const BROWSER_TOOL = /browser|playwright|puppeteer|screenshot|chrome/i;

/** The tool's argument as text: the `command` / `file_path` field of its JSON when it parses. */
function field(input: string, name: string): string | null {
	try {
		const v = (JSON.parse(input) as Record<string, unknown>)[name];
		return typeof v === "string" ? v : null;
	} catch {
		// Cut at the runner's 160 chars, so not JSON: read the field's leading text, which is all there is.
		const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(input);
		return m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n") : null;
	}
}

function classify(call: EngineToolCall, seq: number): Observed[] | null {
	if (EDIT_TOOLS.has(call.tool)) return [{ kind: "edit", seq, path: field(call.input, "file_path") ?? field(call.input, "notebook_path") }];
	if (call.tool !== "Bash") return BROWSER_TOOL.test(call.tool) ? [{ kind: "browser", seq, ok: call.ok }] : null;
	const command = field(call.input, "command") ?? call.input;
	// ONE call can hold several acts — `pnpm test && sed -i … src/x.ts` tests and THEN edits (#1019). Each
	// act is ordered by where it sits in the command, inside this call's slot, so an edit after the test
	// in the same call is after it in the record, and a green run never vouches for content it preceded.
	const at = (pos: number) => seq + (pos + 1) / (command.length + 2);
	const last = (re: RegExp) => {
		let pos = -1;
		for (const m of command.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) pos = m.index ?? pos;
		return pos;
	};
	const out: Observed[] = [];
	const tests = testInvocations(command);
	if (tests.length) {
		// A cut command may have lost the very arguments that decide its scope.
		const lastInv = tests[tests.length - 1];
		const inv = call.inputCut ? null : lastInv;
		out.push({ kind: "test", seq: at(lastInv.at), inv, command, ok: call.ok, output: call.output, outputCut: !!call.outputCut });
		if (/\bplaywright\s+test\b/.test(lastInv.command)) out.push({ kind: "browser", seq: at(lastInv.at), ok: call.ok });
	}
	const mutation = last(SHELL_MUTATION);
	if (mutation >= 0) out.push({ kind: "edit", seq: at(mutation), path: null });
	const commit = last(/\bgit\s+commit\b/);
	if (commit >= 0) out.push({ kind: "commit", seq: at(commit), ok: call.ok, sha: /\[[^\]\s]+\s+([0-9a-f]{7,40})\]/.exec(call.output ?? "")?.[1] ?? null });
	const push = last(/\bgit\s+push\b/);
	if (push >= 0) out.push({ kind: "push", seq: at(push), ok: call.ok, effect: pushEffect(call) });
	const ci = last(/\bgh\s+(?:run\s+(?:view|watch|list)|pr\s+checks)\b/);
	if (ci >= 0) out.push({ kind: "ci", seq: at(ci), ok: call.ok, output: call.output });
	return out;
}

function pushEffect(call: EngineToolCall): "updated" | "up_to_date" | "rejected" | "unknown" {
	const o = call.output ?? "";
	if (/\[rejected\]|\berror: failed to push|\bfatal:/i.test(o)) return "rejected";
	if (/Everything up-to-date/i.test(o)) return "up_to_date";
	if (/[0-9a-f]{7,}\.\.[0-9a-f]{7,}\s+\S+\s+->\s+\S+|\*\s+\[new branch\]/.test(o)) return "updated";
	return "unknown";
}

/** What a test run's own output says, read only from the text it printed. */
export interface TestOutputReading {
	passed: number | null;
	failed: number | null;
	/** The runner refused an option, or ran nothing at all. */
	invalid: string | null;
}

export function readTestOutput(output: string | null): TestOutputReading {
	const o = output ?? "";
	const invalid = /\b(?:unknown|unrecognized|unsupported|invalid)\s+(?:option|argument|flag)\b|\berror: unknown option\b/i.test(o)
		? "the test runner rejected an option it was given"
		: /\bno test(?: file)?s? found\b|\bcollected 0 items\b|\bno tests? (?:were )?(?:run|executed|ran)\b/i.test(o)
			? "it ran no tests"
			: null;
	// vitest/jest print "Tests  12 passed (12)" / "Tests: 3 failed, 9 passed, 12 total"; pytest "9 passed, 3 failed".
	const testsLine = /^\s*Tests:?\s+(.+)$/im.exec(o)?.[1] ?? o;
	const passed = /(\d[\d,]*)\s+passed/i.exec(testsLine);
	const failed = /(\d[\d,]*)\s+failed/i.exec(testsLine);
	const num = (m: RegExpExecArray | null) => (m ? Number(m[1].replace(/,/g, "")) : null);
	return { passed: num(passed), failed: num(failed), invalid };
}

// ── The claims a finish detail makes ──────────────────────────────────────

const CLAIM_TESTS_PASS = /\b(?:tests?|suite|specs?)\b[^.\n]{0,60}\b(?:pass(?:ed|es|ing)?|green|succeed(?:ed|s)?)\b|\b\d[\d,]*\s+(?:tests?\s+)?pass(?:ed|ing)\b|\ball\s+\d[\d,]*\s+tests?\b/i;
const CLAIM_FULL = /\b(?:full|whole|entire|complete)\s+(?:test\s+)?suite\b|\ball\s+(?:\d[\d,]*\s+)?tests\b(?!\s+(?:in|of|under|for|from))|\btest:full\b/i;
const CLAIM_COUNT = /\b(\d[\d,]*)\s+(?:tests?\s+)?pass(?:ed|ing)\b|\ball\s+(\d[\d,]*)\s+tests?\b|\b(\d[\d,]*)\s+tests?\b[^.\n]{0,20}\bpass/gi;
const CLAIM_PUSHED = /\bpushed\b|\bpush(?:ed)?\s+to\s+(?:main|master|origin|the\s+(?:default|main)\s+branch)\b/i;
/** A claim about what a user SEES — only a browser observation can support it, never reading the source. */
const CLAIM_RENDERED =
	/\b(?:renders?|rendered|rendering|displays?)\b[^.\n]{0,40}\b(?:correctly|properly|fine|as expected)\b|\b(?:verified|confirmed|checked|tested)\b[^.\n]{0,30}\b(?:in the browser|visually|on screen|in the UI)\b|\bscreenshot\b[^.\n]{0,30}\b(?:shows|confirms)\b|\b(?:page|ui|button|modal|dialog|layout|form)\s+(?:now\s+)?(?:shows|displays|renders|appears)\b/i;
const CLAIM_CI = /\bCI\b[^.\n]{0,40}\b(?:green|pass(?:ed|es|ing)?|success(?:ful)?|succeeded)\b|\bdeploy(?:ed|ment)?\b[^.\n]{0,30}\b(?:succeeded|is live|went out|green|successful)\b|\b(?:is|are)\s+(?:now\s+)?(?:live|deployed)\b/i;

export interface ClaimVerdict {
	claim: "tests_pass" | "full_suite" | "test_count" | "pushed" | "external_ci" | "rendered";
	/** `supported`: the record shows it. `unverified`: it does not show it either way. `contradicted`: it shows otherwise. */
	status: "supported" | "unverified" | "contradicted";
	why: string;
}

export interface CompletionJudgement {
	verdicts: ClaimVerdict[];
	/** A contradiction the Pilot can still fix before finishing (re-run on the final revision, …). */
	correctable: ClaimVerdict[];
	/** The record's own limits, stated once. */
	recordNote: string | null;
}

/** Judge a `finish(done)` detail against the run's record. Pure. */
export function judgeCompletion(detail: string, ev: CompletionEvidence): CompletionJudgement {
	const verdicts: ClaimVerdict[] = [];
	const obs = ev.observed;
	const lastOf = <K extends Observed["kind"]>(k: K) => [...obs].reverse().find((o): o is Extract<Observed, { kind: K }> => o.kind === k) ?? null;
	const lastEdit = lastOf("edit");
	const lastTest = lastOf("test");
	const reading = lastTest ? readTestOutput(lastTest.output) : null;
	const unseen = ev.sawCalls ? "no test run appears in this run's record" : "this engine's tool calls are not observable, so no test run could be checked";

	const claimsPass = CLAIM_TESTS_PASS.test(detail);
	// The test command the claim itself names, if it names one: the run must have been THAT command (#1019).
	const named = testInvocations(detail);
	if (claimsPass) {
		if (!lastTest) verdicts.push({ claim: "tests_pass", status: "unverified", why: unseen });
		else if (reading?.invalid) verdicts.push({ claim: "tests_pass", status: "contradicted", why: `the last test command (\`${short(lastTest.command)}\`) is not evidence: ${reading.invalid}` });
		else if (lastTest.ok === false || (reading?.failed ?? 0) > 0) verdicts.push({ claim: "tests_pass", status: "contradicted", why: `the last test run (\`${short(lastTest.command)}\`) failed${reading?.failed ? ` — ${reading.failed} failed` : ""}` });
		else if (lastTest.ok === null) verdicts.push({ claim: "tests_pass", status: "unverified", why: `the last test run's outcome was not recorded (\`${short(lastTest.command)}\`)` });
		else if (lastEdit && lastEdit.seq > lastTest.seq) verdicts.push({ claim: "tests_pass", status: "contradicted", why: `files changed after the last green run${lastEdit.path ? ` (${lastEdit.path})` : ""}, so it does not test the final revision` });
		else if (named.length && !named.some((n) => lastTest.inv && canonical(n.command) === canonical(lastTest.inv.command)))
			verdicts.push({ claim: "tests_pass", status: "unverified", why: `the claim names \`${short(named[named.length - 1].command)}\`, but the last test run was \`${short(lastTest.command)}\` — a different command is not evidence for it` });
		else if (lastTest.inv?.forwardedAfterDashDash) verdicts.push({ claim: "tests_pass", status: "unverified", why: `options after a bare \`--\` in \`${short(lastTest.command)}\` may never have reached the test runner, so what it selected is unknown` });
		else if (reading?.passed === null || reading?.passed === undefined) verdicts.push({ claim: "tests_pass", status: "unverified", why: `the last run exited cleanly but its output${lastTest.outputCut ? " was cut before" : " shows no"} pass count` });
		else verdicts.push({ claim: "tests_pass", status: "supported", why: `\`${short(lastTest.command)}\` passed ${reading.passed} after the last edit` });
	}

	if (CLAIM_FULL.test(detail)) {
		const full = lastTest?.inv?.scope === "full";
		verdicts.push(
			!lastTest
				? { claim: "full_suite", status: "unverified", why: unseen }
				: full
					? { claim: "full_suite", status: lastTest.ok === true ? "supported" : "unverified", why: `\`${short(lastTest.command)}\` selects the whole suite` }
					: { claim: "full_suite", status: lastTest.inv ? "contradicted" : "unverified", why: lastTest.inv ? `the last run was a focused subset (\`${short(lastTest.command)}\`), not the full suite` : "the last test command was cut before its arguments, so its scope is unknown" },
		);
	}

	const counts = [...detail.matchAll(CLAIM_COUNT)].map((m) => Number((m[1] ?? m[2] ?? m[3]).replace(/,/g, ""))).filter((n) => n > 0);
	if (counts.length) {
		const seen = reading?.passed ?? null;
		const claimed = Math.max(...counts);
		verdicts.push(
			seen === null
				? { claim: "test_count", status: "unverified", why: `claims ${claimed}; no count was printed in the record` }
				: seen === claimed
					? { claim: "test_count", status: "supported", why: `the last run printed ${seen} passed` }
					: { claim: "test_count", status: "contradicted", why: `claims ${claimed}; the last run printed ${seen} passed` },
		);
	}

	if (CLAIM_PUSHED.test(detail)) {
		const push = lastOf("push");
		const lastCommit = lastOf("commit");
		if (!push) verdicts.push({ claim: "pushed", status: "unverified", why: ev.sawCalls ? "no push appears in this run's record" : "this engine's tool calls are not observable" });
		else if (push.effect === "rejected" || push.ok === false) verdicts.push({ claim: "pushed", status: "contradicted", why: "the last push was rejected" });
		else if (push.effect === "up_to_date") verdicts.push({ claim: "pushed", status: "contradicted", why: "the last push said \"Everything up-to-date\" — it moved nothing" });
		else if ((lastCommit && lastCommit.seq > push.seq) || (lastEdit && lastEdit.seq > push.seq)) verdicts.push({ claim: "pushed", status: "contradicted", why: "work was committed or edited after the last push, which therefore does not carry the final revision" });
		else if (push.effect === "updated") verdicts.push({ claim: "pushed", status: "supported", why: "the last push updated the remote ref" });
		else verdicts.push({ claim: "pushed", status: "unverified", why: "the last push's output does not show a ref update" });
	}

	if (CLAIM_CI.test(detail)) {
		const ci = lastOf("ci");
		verdicts.push(
			ci && ci.ok === true && /\b(?:success|completed\s+success|✓)\b/i.test(ci.output ?? "")
				? { claim: "external_ci", status: "supported", why: "the run read a successful CI result" }
				: { claim: "external_ci", status: "unverified", why: "external CI/deploy was not observed by this run — it is verified separately, not by local completion" },
		);
	}

	if (CLAIM_RENDERED.test(detail)) {
		const seen = [...obs].reverse().find((o): o is Extract<Observed, { kind: "browser" }> => o.kind === "browser") ?? null;
		verdicts.push(
			!seen
				? { claim: "rendered", status: "unverified", why: "no browser was driven in this run's record — reading the source is not seeing the page" }
				: seen.ok !== true
					? { claim: "rendered", status: "unverified", why: "the last browser observation's outcome was not a success" }
					: lastEdit && lastEdit.seq > seen.seq
						? { claim: "rendered", status: "unverified", why: "files changed after the last browser observation, so it did not see the final revision" }
						: { claim: "rendered", status: "supported", why: "a browser was driven after the last edit" },
		);
	}

	const correctable = verdicts.filter((v) => v.status === "contradicted" && (v.claim === "tests_pass" || v.claim === "full_suite" || v.claim === "pushed"));
	const recordNote = !verdicts.length ? null : !ev.sawCalls ? "the engine's tool calls were not observable" : ev.gap ? "some tool calls scrolled out between snapshots, so the record may be incomplete" : null;
	return { verdicts, correctable, recordNote };
}

/** Two spellings of one test command compare equal: `npx`, spacing and quoting are not a different command. */
function canonical(command: string): string {
	return command.replace(/^npx\s+/, "").replace(/["']/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A command as a label beside its verdict — marked when cut, so it never reads as the whole command. */
function short(command: string): string {
	return clipMarked(command.replace(/\s+/g, " ").trim(), 120, { within: true });
}

/** The note appended to a finish detail: each claim and what the record shows. Empty when no claim was made. */
export function evidenceNote(j: CompletionJudgement): string {
	if (!j.verdicts.length) return "";
	const word = { supported: "verified", unverified: "UNVERIFIED", contradicted: "CONTRADICTED" } as const;
	const label = { tests_pass: "tests pass", full_suite: "full suite", test_count: "test count", pushed: "pushed", external_ci: "CI/deploy", rendered: "rendered in a browser" } as const;
	const lines = j.verdicts.map((v) => `- ${label[v.claim]}: ${word[v.status]} — ${v.why}`);
	if (j.recordNote) lines.push(`- note: ${j.recordNote}`);
	return `Evidence check (the platform's reading of this run's own tool calls):\n${lines.join("\n")}`;
}

/** The step-log line that sends a contradicted finish back to the Pilot once. */
export function finishRefusalNote(j: CompletionJudgement): string {
	return `finish not accepted yet — ${j.correctable.map((v) => v.why).join("; ")}. Have the CLI do it on the FINAL revision (re-run the tests after the last edit, push after the last commit) and finish again, or finish without that claim.`;
}
