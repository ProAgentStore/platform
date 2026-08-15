/**
 * Every durable row the voice stack writes is classified, and the set is asserted (#571, ADR 0002).
 *
 * ## What this defends
 *
 * The server derives a row's level from its source (`deriveClientLevel`, `workers/api/src/lib/error-log.ts`).
 * So the classification of a call site IS its source argument, and a site added without thinking about
 * it lands wherever its author's copy-paste came from. Production 2026-08-15 is what that costs: 19 of
 * the 40 newest rows were `client:voice`, all at `level: "error"`, and eight of them were designed
 * discards — the noise gate correctly rejecting Whisper's "Thank you for watching." off a silent mic.
 *
 * A test that checked one example would pass the day it was written and say nothing about the
 * twenty-fourth call site. So this asserts the WHOLE set: how many reports the voice tree makes, which
 * source each uses, and — for the eight reclassified sites — the exact expression each reports. Adding
 * a report anywhere under `voice/` fails here until it is classified, which is the only property that
 * survives the next feature.
 *
 * ## What the scanner does NOT handle (ADR 0002, G3)
 *
 * It does not strip comments or strings before matching, so a literal `reportClientError(` written
 * inside a comment or a template literal would be counted as a call site. That is deliberate rather
 * than overlooked: this repository already carries eight partial JS strippers at four fidelities (see
 * ADR 0002's closing section) and a ninth is worse than the exposure. The exposure is bounded by
 * {@link TOTAL_REPORTS} — a miscount cannot pass, it can only fail and send a human to look. Every
 * argument that fails to parse is counted and asserted to zero rather than skipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VOICE_DECISION, VOICE_FAILURE } from "./report-source.js";

const VOICE_DIR = new URL(".", import.meta.url);
const ERROR_LOG = new URL("../../../../workers/api/src/lib/error-log.ts", import.meta.url);

/** One `reportClientError(...)` call found in the tree. */
interface Site {
	file: string;
	line: number;
	/** The RAW first argument — `"voice-tts"` (quotes included) or an identifier like `VOICE_DECISION`. */
	source: string;
	/** The second argument, trimmed, with template placeholders quoted — see {@link quoteExpr}. */
	message: string;
}

/**
 * A call site's expression as this file may quote it: `${x}` becomes `⟨x⟩`.
 *
 * Purely so the expected values below can hold a template literal verbatim without embedding a live
 * interpolation in a plain string, which Biome's `noTemplateCurlyInString` rightly objects to — that
 * rule catches a real bug class and suppressing it to write a fixture would be the wrong trade.
 */
const quoteExpr = (raw: string) => raw.replace(/\$\{([^}]*)\}/g, "⟨$1⟩");

/** Split a call's arguments from just after its `(`. Null when the parse never closes. */
function splitArgs(src: string, open: number): string[] | null {
	const args: string[] = [];
	let depth = 0;
	let start = open;
	let quote: string | null = null;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
		if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
		if (ch === ")" && depth === 0) { args.push(src.slice(start, i)); return args; }
		if (ch === ")" || ch === "]" || ch === "}") { depth--; continue; }
		if (ch === "," && depth === 0) { args.push(src.slice(start, i)); start = i + 1; }
	}
	return null;
}

function scanFile(file: string, src: string): { sites: Site[]; unparsed: number } {
	const sites: Site[] = [];
	let unparsed = 0;
	const needle = "reportClientError(";
	for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
		// A call, not a longer identifier ending in the same characters.
		if (/[\w$.]/.test(src[i - 1] ?? "")) continue;
		const args = splitArgs(src, i + needle.length);
		if (!args || args.length < 2) { unparsed++; continue; }
		sites.push({
			file,
			line: src.slice(0, i).split("\n").length,
			source: args[0].trim(),
			message: quoteExpr(args[1].trim()),
		});
	}
	return { sites, unparsed };
}

const FILES = readdirSync(VOICE_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
const SCANS = FILES.map((f) => ({ file: f, ...scanFile(f, readFileSync(new URL(f, VOICE_DIR), "utf-8")) }));
const SITES = SCANS.flatMap((s) => s.sites);
const UNPARSED = SCANS.reduce((n, s) => n + s.unparsed, 0);

/**
 * Every report the voice tree makes, by the source it files under. A new call site changes this
 * number, which is the point — the classification decision is made here or the build is red.
 *
 * The bare literal `"voice"` is deliberately ABSENT and asserted to zero. It is the ambiguous name:
 * before #571 it carried designed discards and genuine failures on one string, which is why a blanket
 * allowlist on it would have hidden real failures. Both halves now go through a named constant.
 */
const EXPECTED_BY_SOURCE: Record<string, number> = {
	VOICE_DECISION: 8,
	VOICE_FAILURE: 4,
	'"voice-gate"': 1,
	'"voice-control"': 1,
	'"voice-transcript"': 1,
	'"voice-tts"': 5,
	'"voice-audio"': 3,
	'"voice-config"': 2,
};
const TOTAL_REPORTS = Object.values(EXPECTED_BY_SOURCE).reduce((a, b) => a + b, 0);

/**
 * The eight sites reclassified by #571, by the expression each reports — so a site cannot move
 * between the two classes unnoticed, in either direction.
 *
 * Each one is the output of a DECISION function that ran to completion with nothing broken:
 * `planTurnClose` (the end-of-turn gate), `planSend` (noise / language / repetition before sending),
 * `planNoiseRejection` on the four paths that can destroy an utterance (mute, recover, hands-free,
 * agent switch), `planClipGate` (upload or discard, plus the unmeasured-clip note — which reports
 * precisely BECAUSE that path now succeeds), and `classifyResult`'s echo-tail ignore.
 */
const DECISION_MESSAGES = [
	"close.report", // planTurnClose — the end-of-turn gate discarded the clip
	"`voice turn dropped before sending — ⟨plan.reason⟩`", // planSend — noise / language / repetition
	"noise.report", // planNoiseRejection, mute path
	"noise.report", // planNoiseRejection, recover path
	"noise.report", // planNoiseRejection, hands-free path
	"noise.report", // planNoiseRejection, agent-switch path
	'"result ignored (echo tail or a turn already abandoned)"', // classifyResult — the agent's own voice
	"r", // clipGateReport — discarded before upload, or uploaded unmeasured
].sort();

describe("voice telemetry — the reporting set is classified, and the set is asserted (#571)", () => {
	it("scans the real voice tree and parses every call", () => {
		// G1: an empty or halved input set is a guard that stopped measuring, not a clean tree.
		// 20 modules today. The floor is well below that on purpose: it must fail on a scan that has
		// stopped seeing the tree, not on an honest consolidation of two files into one.
		expect(FILES.length, "the voice directory scan found almost nothing — has the tree moved?").toBeGreaterThanOrEqual(15);
		expect(SCANS.filter((s) => s.sites.length).map((s) => s.file)).toEqual(["config.ts", "tts.ts", "use-voice.ts", "voice-audio.ts"]);
		// G3: an argument the splitter could not close is a scanner bug, never a silent skip.
		expect(UNPARSED, "reportClientError call(s) whose arguments would not parse — the scanner is wrong, not the code").toBe(0);
		// G2: state the denominator in the passing run.
		console.log(`✓ voice telemetry: ${SITES.length} reportClientError call sites across ${FILES.length} files`);
	});

	it("files every report under a declared source, in the declared quantity", () => {
		const counts: Record<string, number> = {};
		for (const s of SITES) counts[s.source] = (counts[s.source] ?? 0) + 1;
		expect(counts).toEqual(EXPECTED_BY_SOURCE);
		expect(SITES.length).toBe(TOTAL_REPORTS);
	});

	it("never writes the ambiguous bare source by hand", () => {
		// `"voice"` carried both classes at once, which is the whole defect. Reaching it now requires
		// naming VOICE_FAILURE, i.e. asserting that something actually failed.
		const bare = SITES.filter((s) => s.source === '"voice"');
		expect(bare, `a voice report went back to the literal "voice": ${bare.map((s) => `${s.file}:${s.line}`).join(", ")}`).toEqual([]);
	});

	it("reports exactly the eight designed decisions under the observation source", () => {
		const decisions = SITES.filter((s) => s.source === "VOICE_DECISION");
		expect(decisions.map((s) => s.message).sort()).toEqual(DECISION_MESSAGES);
		// All eight are in the hook, where the side effects live; the decisions themselves are pure.
		expect(new Set(decisions.map((s) => s.file))).toEqual(new Set(["use-voice.ts"]));
	});

	it("routes failures — a dead recognizer, a bad provider answer, a missed deadline — to the error source", () => {
		const failures = SITES.filter((s) => s.source === "VOICE_FAILURE").map((s) => s.message);
		expect(failures.sort()).toEqual(
			[
				'"audio monitor failed to start — end-of-turn falls back to the max-dictation cap"',
				"String(err)",
				"plan.report", // hands-free bailed out: the microphone stopped responding
				"`⟨TRANSCRIBE_TIMEOUT_MESSAGE⟩ (watchdog)`",
			].sort(),
		);
	});

	it("agrees with the server about which source name means 'observation'", () => {
		// The two halves live in different packages and a rename on either side would silently put
		// every gate discard back at `level: "error"` — the exact bug, restored with no test red.
		// Read as TEXT, not imported: this is a guard, not a dependency of the SDK on the Worker.
		const src = readFileSync(ERROR_LOG, "utf-8");
		const decl = /OBSERVATION_SOURCES[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(src);
		expect(decl, "OBSERVATION_SOURCES is no longer a `new Set([...])` literal — this guard has stopped measuring").not.toBeNull();
		const declared = [...(decl?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
		expect(declared).toContain(`client:${VOICE_DECISION}`);
		expect(declared, "the failure source must never be declared observational — that hides real voice failures").not.toContain(`client:${VOICE_FAILURE}`);
	});
});
