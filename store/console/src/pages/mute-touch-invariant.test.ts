/**
 * ADR 0001 M1, the TOUCH half — the on-screen mute, on every surface that ships hands-free (#388).
 *
 * `packages/sdk/src/voice/mute-invariant.test.ts` holds the VOICE half: it proves that in every
 * phase the ADR names, something a user can say reaches `mute` along the path the hook really
 * takes. It could not hold this half. M1 requires TWO channels, and the second one is JSX in two
 * other packages — which were mid-refactor under #389/#390 when that file landed, so an assertion
 * here would have gone red on a sibling's work rather than on a violation.
 *
 * This is the half that matters most where the first one does not exist. The ADR records a known
 * hole: the control listener is built on the browser Web Speech API, `ensureControlStt` returns
 * `null` where the constructor is absent, and on such a browser there is no voice channel at all —
 * mute rests ENTIRELY on the control asserted here. A change that renders it disabled during TTS,
 * or tucks it into an overflow menu, removes the only way to mute on Safari and Firefox, and does
 * it without failing a type-check, a lint, or any other test.
 *
 * ── What is asserted, and what deliberately is not
 *
 * NOT "a button with this label exists". That passes a refactor that renders it disabled, hides it
 * behind a disclosure, or drops it off the bottom of a phone — every one of which is a dead zone,
 * which is the exact thing M1 forbids. What is asserted instead is the SHAPE that makes it
 * reachable:
 *
 *   1. Its visibility depends on the interaction MODE and nothing else. Stated as an allowlist over
 *      the identifiers in its render guard, not a blocklist of today's phase flags: a guard on
 *      `voice.speaking` is the regression we know about, and a guard on `menuOpen`,
 *      `scrolledToBottom` or a flag nobody has invented yet is the same defect wearing a name this
 *      file cannot enumerate in advance. Anything conditional is state, and state has a name.
 *   2. It is never `disabled`. A disabled control is present, legible, and a dead zone.
 *   3. It delegates to `voice.toggleMute` — the ONE implementation whose M2/M4 semantics (close the
 *      mic AND cancel the speech, reopen the mic rather than clear a flag) the SDK file pins. A
 *      local re-implementation here would satisfy every label assertion and silence nothing.
 *   4. It carries BOTH directions, so the muted phase is not a room you can enter and not leave.
 *
 * The rendered, hit-tested half of this — present, enabled and clickable at a phone width, walked
 * through listening → processing → speaking → muted with the status pill read back as proof of
 * which phase the app is actually in — is `e2e/console.spec.ts`, which runs it in Chromium AND in
 * WebKit, an engine with no Web Speech API at all. This file is the cheap one that fails first.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readAdr } from "../../../../scripts/lib/adr.mjs";

const ROOT = resolve(__dirname, "../../../..");
const CONSOLE_SRC = resolve(ROOT, "store/console/src");
const CODER_WEB_SRC = resolve(ROOT, "agents/coder/web/src");

/** Shared with the voice half — one parse of the document, so the two cannot drift apart. */
const adr = readAdr(1);

/**
 * Which rules this file answers, and in what form. Keyed to the ADR's own ids and compared against
 * what the document states, so a fifth rule fails here until the touch channel covers it too.
 */
const COVERED: Record<string, string> = {
	M1: "the control's visibility depends on the mode and nothing else, and it is never disabled",
	M2: "it delegates to the one toggleMute whose both-directions semantics are pinned in the SDK",
	M3: "no phase signal appears in its render guard — 'not while speaking' cannot be expressed",
	M4: "the same control carries the unmute direction, so muted is not a room without a door",
	M5: "the press takes the recover default — the #228 send carve-out is not reachable from a button",
};

/** The tag that identifies a hands-free mode control in the segmented interaction picker. */
const SHIPS_HANDS_FREE = 'id: "handsfree"';
/** The single mute implementation every surface must delegate to. */
const TOGGLE = "voice.toggleMute";

interface Surface {
	/** What the user calls it. */
	name: string;
	path: string;
}

/**
 * Every surface that ships hands-free, discovered rather than listed.
 *
 * A hardcoded pair would go quietly stale the day a third view grows a Hands-free button — which
 * is how the touch channel came to be "the one that is assumed" in the first place. The sweep and
 * the table are cross-checked below, so a new surface fails this file until it is named here.
 */
const SURFACES: Surface[] = [
	{ name: "the Assistant tab", path: resolve(CONSOLE_SRC, "pages/InstanceDetail.tsx") },
	{ name: "the Coder Co-pilot", path: resolve(CODER_WEB_SRC, "CopilotView.tsx") },
];

function tsxFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) tsxFiles(p, out);
		else if (entry.endsWith(".tsx")) out.push(p);
	}
	return out;
}

/** Source with string literals and comments blanked, for asking WHICH IDENTIFIERS appear. */
function identifiers(code: string): string[] {
	const bare = code
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/.*$/gm, " ")
		.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, " ");
	return [...new Set(bare.match(/[A-Za-z_$][\w$]*/g) ?? [])];
}

/**
 * The end of an element's OPENING tag: the first `>` that is not inside a quote and not inside a
 * `{…}` attribute value. `size={16}`, a template-literal `className`, and an inline `=>` all live
 * at depth ≥ 1 and are stepped over rather than mistaken for the end of the tag.
 */
function openTagEnd(src: string, start: number): number {
	let depth = 0;
	let quote = "";
	for (let i = start; i < src.length; i++) {
		const c = src[i];
		if (quote) {
			if (c === quote && src[i - 1] !== "\\") quote = "";
			continue;
		}
		if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "{") depth++;
		else if (c === "}") depth--;
		else if (c === ">" && depth === 0) return i;
	}
	return -1;
}

/**
 * The JSX expression container that decides whether the element renders — everything between the
 * `{` that opens it and the element itself.
 *
 * This is the claim the whole file rests on, so it is sliced rather than grepped: "the file does
 * not mention `voice.speaking` near the mute button" is not the same statement as "the mute button
 * does not render conditionally on it", and only the second one is M1.
 */
function renderGuard(src: string, elementStart: number): string {
	let depth = 0;
	for (let i = elementStart - 1; i >= 0; i--) {
		const c = src[i];
		if (c === "}") depth++;
		else if (c === "{") {
			if (depth === 0) return src.slice(i + 1, elementStart);
			depth--;
		}
	}
	return "";
}

interface Control {
	/** The whole element, opening tag through `</button>`. */
	element: string;
	/** The opening tag alone — where `disabled` and the root's own classes live. */
	openTag: string;
	/** The expression that decides whether it renders at all. */
	guard: string;
	/** The prose immediately above it, where the pointer to the ADR has to be to be one hop away. */
	preamble: string;
}

/** The on-screen mute control on one surface, located by the implementation it must delegate to. */
function muteControl(surface: Surface): Control {
	const src = readFileSync(surface.path, "utf8");
	const hits = [...src.matchAll(/voice\.toggleMute/g)].map((m) => m.index ?? -1);
	// Exactly one: with two, every claim below would describe whichever came first and say nothing
	// about the other, which is the failure mode of a structural test that looks like it passed.
	expect(hits.length, `${surface.name}: expected exactly one ${TOGGLE} call site, found ${hits.length}. Every assertion in this file describes ONE control.`).toBe(1);
	const anchor = hits[0];
	const start = src.lastIndexOf("<button", anchor);
	expect(start, `${surface.name}: ${TOGGLE} is no longer wired to a <button> — this guard is looking at nothing.`).toBeGreaterThan(-1);
	const tagEnd = openTagEnd(src, start);
	expect(tagEnd, `${surface.name}: cannot find the end of the mute control's opening tag — fix the slice before trusting the assertions.`).toBeGreaterThan(start);
	const close = src.indexOf("</button>", tagEnd);
	expect(close, `${surface.name}: the mute control has no closing tag`).toBeGreaterThan(tagEnd);
	return {
		element: src.slice(start, close + "</button>".length),
		openTag: src.slice(start, tagEnd + 1),
		guard: renderGuard(src, start),
		preamble: src.slice(Math.max(0, start - 700), start),
	};
}

describe("ADR 0001 — the touch half of M1 (#388)", () => {
	it("answers every rule the ADR states, in the channel the voice half cannot reach", () => {
		expect(adr.rules, `${adr.file} states a rule this file does not answer for the on-screen control, or answers one it no longer states`).toEqual(Object.keys(COVERED));
	});

	/**
	 * "Everywhere hands-free ships" is the issue's own wording, and it is the part a fixed list
	 * cannot keep true. A third view that grows a Hands-free button inherits the whole invariant,
	 * and nothing would have said so.
	 */
	it("names every surface that ships hands-free, and no others", () => {
		const found = [...tsxFiles(CONSOLE_SRC), ...tsxFiles(CODER_WEB_SRC)]
			.filter((p) => readFileSync(p, "utf8").includes(SHIPS_HANDS_FREE))
			.map((p) => relative(ROOT, p))
			.sort();
		expect(found, "a surface offers hands-free that this file does not check. It inherits ADR 0001 M1 in full — add it to SURFACES (and give it a mute control).").toEqual(SURFACES.map((s) => relative(ROOT, s.path)).sort());
	});
});

describe.each(SURFACES)("$name", (surface) => {
	/**
	 * M1 + M3, as one statement about shape rather than a list of today's flags.
	 *
	 * The mute control may depend on WHICH INTERACTION MODE is active — the ADR blesses that
	 * placement explicitly ("Mute remains a sub-control of hands-free in the UI… the on-screen
	 * control is one of the two required channels"). It may depend on nothing else, because
	 * everything else is a phase, a disclosure, or a scroll position, and each of those is a moment
	 * in which the control is gone.
	 */
	it("renders on the interaction mode and on nothing else — no phase, no menu, no disclosure", () => {
		const { guard } = muteControl(surface);
		expect(guard.trim().length, `${surface.name}: the mute control has no render guard at all — the slice is wrong, not the code.`).toBeGreaterThan(0);
		const allowed = new Set(["voice", "mode"]);
		const extra = identifiers(guard).filter((w) => !allowed.has(w));
		expect(extra, `${surface.name}: the on-screen mute renders conditionally on ${extra.join(", ")} — guard: \`${guard.trim()}\`. ADR 0001 M1: no phase may be a dead zone, and anything but the interaction mode is a moment in which mute is unreachable.`).toEqual([]);
	});

	it("is never disabled — a disabled mute is present, legible, and a dead zone", () => {
		expect(muteControl(surface).openTag, `${surface.name}: the mute control takes a disabled attribute. ADR 0001 M1.`).not.toMatch(/\bdisabled\b/);
	});

	/**
	 * The control has to survive the smallest screen, and hands-free is the mode where the phone is
	 * the whole product. The text label is allowed to collapse (`hidden sm:inline` on the inner
	 * span) — the icon and the box are not.
	 */
	it("keeps its box on a phone: the label may collapse, the control may not", () => {
		const { openTag } = muteControl(surface);
		expect(openTag, `${surface.name}: the mute control itself is hidden at some breakpoint. Collapse the LABEL, never the control (ADR 0001 M1).`).not.toMatch(/\bhidden\b|\bsr-only\b/);
	});

	/**
	 * M2 lives in `muteFromCommand`, and the SDK file pins it there: close the mic AND cancel the
	 * speech it is interrupting. The button's whole obligation is to route into that, because a
	 * local `setMuted(true)` here would look right, read right, and leave the agent talking.
	 */
	it("delegates to the one toggleMute whose both-directions semantics are pinned", () => {
		expect(muteControl(surface).openTag, `${surface.name}: the mute control no longer calls ${TOGGLE} directly. A local implementation would not cancel in-flight speech (ADR 0001 M2).`).toMatch(/onClick=\{voice\.toggleMute\}/);
	});

	/** M4 with the sign flipped: the same control, while muted, is how you get back out. */
	it("carries the unmute direction, so muted is not a room without a door", () => {
		const { element } = muteControl(surface);
		expect(element, `${surface.name}: nothing on the mute control says Unmute while muted (ADR 0001 M4).`).toMatch(/Unmute/);
		expect(element, `${surface.name}: the control reads on \`voice.muted\`, or it cannot show both directions (ADR 0001 M4).`).toMatch(/voice\.muted/);
	});

	/**
	 * M5, in the only form the touch channel can break it.
	 *
	 * What happens to the turn a mute interrupts is a PARAMETER now (#420): `pendingTurn: "send"`
	 * keeps #228's "run the tests, mute" working, and it belongs to exactly two call sites inside
	 * the hook, both of which have the transcript in hand. A button never does — a press carries no
	 * words with it — so a surface that reached for that argument would be sending the agent a
	 * request the user had just withdrawn, which is the outcome M5 names as the wrong one.
	 *
	 * Asserted as "hands over a bare reference", because that is the shape that cannot pass an
	 * argument at all, rather than a blocklist of the one argument that exists today.
	 */
	it("passes nothing of its own — a press cannot opt the interrupted turn into being sent", () => {
		const { openTag } = muteControl(surface);
		expect(openTag, `${surface.name}: the mute control wraps ${TOGGLE} instead of handing it over, which is how an argument gets added to it (ADR 0001 M5).`).toMatch(/onClick=\{voice\.toggleMute\}/);
		expect(openTag, `${surface.name}: the mute control CALLS toggleMute with something. The turn's destination is the hook's decision, not a button's (ADR 0001 M5).`).not.toMatch(/toggleMute\(/);
	});

	/**
	 * The ADR's own third enforcement item. The constraint is not discoverable from the code being
	 * changed — that sentence is in the ADR because it is the reason the ADR exists — so the
	 * pointer has to sit where someone deleting this control would read it.
	 */
	it("keeps ADR 0001 one hop from the place it would be broken", () => {
		expect(muteControl(surface).preamble, `${surface.name}: nothing near the mute control points at the ADR that forbids gating it.`).toContain("docs/adr/0001-mute-is-always-available.md");
	});
});
