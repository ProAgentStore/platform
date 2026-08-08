import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { matchLines, stripCommentsAndLiterals } from "../../../../workers/api/src/lib/source-guard.js";
import { resolveComposer } from "./composer.js";
import type { Dictation } from "./machine.js";

const dictating = (text: string): Dictation => ({ text, status: "dictating", startedAt: 1, heard: "", transcribingAt: 0 });
const transcribing = (text: string): Dictation => ({ text, status: "transcribing", startedAt: 1, heard: text, transcribingAt: 2 });
const failed = (text: string): Dictation => ({ text, status: "failed", startedAt: 1, heard: text, transcribingAt: 0, note: "Whisper failed" });

describe("the composer never displays what voice produced (#364)", () => {
	it("shows the typed draft while the user is speaking — the words belong to the thread bubble", () => {
		// The regression this file exists for: speech was rendered in the thread (#281) and the
		// composer went on advertising itself as the live surface, so the user watched an empty box.
		const c = resolveComposer({ draft: "half a typed thought", dictation: dictating("what's the deploy status"), notice: "" });
		expect(c.value).toBe("half a typed thought");
	});

	it("shows the typed draft when a notice is up — a mic error is not a message", () => {
		const c = resolveComposer({ draft: "typed", notice: "⚠ Microphone unavailable", dictation: null });
		expect(c.value).toBe("typed");
		expect(c.notice).toBe("⚠ Microphone unavailable");
	});

	it("does not lock the box for a notice — the user must be able to type what voice could not hear", () => {
		// Locking on a notice is how a transient mic warning made the composer read-only for
		// several seconds with no way to dismiss it.
		expect(resolveComposer({ draft: "", notice: "⚠ Microphone unavailable", dictation: null }).readOnly).toBe(false);
	});

	it("locks the box only while words are landing live", () => {
		// The mic is open and the bubble is filling; a typed send here would race the one the
		// transcript is about to make.
		expect(resolveComposer({ draft: "", notice: "", dictation: dictating("hello") }).readOnly).toBe(true);
	});

	/**
	 * #421, and this is the assertion that changed rather than one that was added.
	 *
	 * `readOnly` used to hold through `transcribing` on the reading that voice owns a turn "from
	 * first word to final transcript". By then the mic is CLOSED and the only thing still happening
	 * is a network call — so the rule was locking the user out of the product for the duration of
	 * someone else's latency, and when a transcription stalled it locked them out permanently: no
	 * Dismiss on a `transcribing` bubble, no timeout, reload the only escape.
	 *
	 * The race it was guarding against is real but visible and deliberate on the user's part, and a
	 * transcript that lands after they typed goes to the composer rather than auto-sending
	 * (`classifyResult`), so the worst case is two visible drafts rather than a silent double-send.
	 */
	it("does NOT hold the box on a turn that is only waiting on the network (#421)", () => {
		expect(resolveComposer({ draft: "", notice: "", dictation: transcribing("hello") }).readOnly).toBe(false);
	});

	it("releases the box on a FAILED utterance", () => {
		// The words are on screen in the failed bubble and nothing else is coming — typing them
		// out is the recovery, so this is the one status that must not hold the input.
		expect(resolveComposer({ draft: "", notice: "", dictation: failed("hello") }).readOnly).toBe(false);
	});

	it("never leaves the composer unreachable — no status holds it that the user cannot end", () => {
		// The property, not the table: a status that holds the box must be one the user can leave
		// on their own. `dictating` ends when they stop talking; every other status is either the
		// network's problem or already resolved, so none of them may hold it. This is the shape of
		// the #421 lockout stated so it fails for a status nobody has added yet.
		const held = (["dictating", "transcribing", "failed"] as const).filter(
			(status) => resolveComposer({ draft: "", notice: "", dictation: { text: "x", status, startedAt: 1, heard: "x", transcribingAt: 2 } }).readOnly,
		);
		expect(held, "a status other than `dictating` holds the composer. Only the user closing their own mouth may release the input (#421).").toEqual(["dictating"]);
	});
});

/**
 * The other half: a pure resolver only holds the rule if every consumer goes through it. The
 * binding this bug was made of (`value={voice.interim || input}`) type-checks, renders, and looks
 * deliberate — nothing but a scan catches it coming back. Same approach as `safe-html-guard`.
 */
describe("no front-end binds voice text into an input value (#364)", () => {
	const REPO = resolve(__dirname, "../../../..");
	const TREES = ["store/console/src", "store/admin/src", "agents/coder/web/src"];

	const sources = (): { rel: string; code: string }[] => {
		const out: { rel: string; code: string }[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const p = join(dir, entry);
				if (statSync(p).isDirectory()) {
					walk(p);
					continue;
				}
				if (!/\.tsx?$/.test(p) || /\.test\.tsx?$/.test(p) || p.endsWith(".d.ts")) continue;
				out.push({ rel: relative(REPO, p), code: stripCommentsAndLiterals(readFileSync(p, "utf-8")) });
			}
		};
		for (const t of TREES) walk(join(REPO, t));
		return out;
	};

	/** A voice string reaching an input's value, in the two shapes it has ever taken here. */
	const BINDINGS: [label: string, re: RegExp][] = [
		["voice text as an input value", /value=\{[^}]*\bvoice\.(?:interim|notice|dictation)/],
		["voice text OR'd over the draft", /\bvoice\.(?:interim|notice)\s*\|\|/],
	];

	const ALL = sources();

	it("is pointed at real files", () => {
		// Without this, a mistyped tree path makes every assertion below a vacuous pass.
		expect(ALL.length).toBeGreaterThan(30);
		expect(ALL.some((s) => s.code.includes("resolveComposer"))).toBe(true);
	});

	it("finds nothing", () => {
		const hits = ALL.flatMap((s) => BINDINGS.flatMap(([label, re]) => matchLines(s.code, re).map((h) => `${s.rel}:${h.line}  ${label}: ${h.excerpt}`)));
		expect(
			hits,
			`the composer is bound to voice text again:\n${hits.join("\n")}\n\nSpeech renders as the pending dictation bubble in the thread; a notice renders as its own banner. The composer's value is the typed draft — see resolveComposer.`,
		).toEqual([]);
	});

	it("would find the binding that caused #364", () => {
		// A guard that cannot fail is decoration. This is the exact line that shipped.
		const sample = stripCommentsAndLiterals(`<textarea value={voice.interim || input} readOnly={voiceBusy} />`);
		expect(BINDINGS.flatMap(([, re]) => matchLines(sample, re))).not.toHaveLength(0);
	});
});
