/**
 * run-lifecycle.mjs — the RUN-LIFECYCLE arm of `scripts/docs-drift.mjs` (#601).
 *
 * ── What had no reference page, and why that was held open deliberately
 *
 * `RunHealth`, `waitingUntil`, `lastProgressAt` and `lastAliveAt` are the vocabulary every
 * supervision surface reports a run in, and `grep -rl` over `platform-docs/` returned NOTHING
 * for all four. The absence was not an oversight: #601 was blocked on #596, because
 * `waiting_until` meant "expected to resume" from one producer and "about to give up" from the
 * other, and a reference page defining a field that means two opposite things is worse than no
 * page at all — an absent page misleads nobody. #596 landed in `41cebd1` and the field now has
 * ONE meaning: the instant this park's clock runs out, with the KIND of ending entailed by
 * `waiting_reason`.
 *
 * ── Why this is a renderer and not a third detector
 *
 * The page states two value sets, and a value set written into prose by hand is the exact drift
 * this repo has spent the week removing: #602 fixed four transcribed numbers in one day, #588's
 * "three values" went stale in two MCP descriptions the moment `ended` arrived, and #603/#604
 * were both "a guard whose population silently excludes the thing it exists to catch".
 *
 * So the value sets are not checked, they are GENERATED. A delimited region of the page is
 * rendered from `RUN_HEALTH_STATES` and from `RUN_WAIT_REASONS` × `PARKS`, and the check is a
 * byte comparison against a freshly rendered block. A member added to either enum does not
 * "probably" fail a regex — it changes the rendered text, and the page no longer matches.
 *
 * Note what is deliberately NOT generated: the prose. `wire-surface.mjs` states the rule this
 * follows — "there is deliberately NO prose snapshot here, each fact compares a NAME or a
 * VALUE" — because a golden file over hand-written explanation fails on every honest edit and
 * is deleted within a month. The generated regions hold the value sets and nothing else; the
 * paragraphs around them are ordinary reference material and stay editable.
 *
 * `PARKS.why` IS rendered, and that is a considered trade rather than an oversight: it is the
 * authoritative answer to "what is this run waiting for", it reaches the owner verbatim through
 * `waitClause`, and a page that paraphrased it could disagree with what the platform actually
 * says. The cost is that rewording a park's `why` also regenerates this block. That is the
 * mechanism working.
 *
 * ── ADR 0002 (a guard states what it measured)
 *
 *  - G1: every parser declares a FLOOR with a reason. A regex that silently matches nothing
 *    would render an EMPTY block, and an empty block compared against an empty block passes —
 *    the "found nothing" / "found nothing wrong" collapse that #604 was filed for.
 *  - G2: the success line states both denominators — how many states and reasons were read,
 *    from how many code files, into how many generated regions.
 *  - G3: a declaration whose SHAPE has moved (a bare union, a TS enum, a built list) is
 *    reported as unreadable, never treated as absent. This is the same obligation
 *    `state-vocabulary.test.ts:130` carries against the same declaration, for the same reason.
 *
 * Nothing here touches the filesystem; the caller supplies the sources, so the tests can feed
 * each parser the shape that would break it.
 */

/** An `as const` array of string literals, parsed as a VALUE rather than read as a type.
 *
 *  The type union is erased and this repo does not typecheck its Worker tests, so a guard
 *  written against `RunHealth` compiles nowhere and fails never — the reason both of these
 *  declarations were made `as const` arrays in the first place (#588, #596). Parsing the array
 *  is what `workers/mcp/src/state-vocabulary.test.ts:130` already does with `RUN_HEALTH_STATES`,
 *  and this is that parser, moved somewhere a second reader can share it.
 *
 * @param {string} src
 * @param {string} name
 * @returns {{members: string[], error: string|null}}
 */
export function parseConstArray(src, name) {
	const decl = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`));
	if (!decl) {
		return {
			members: [],
			// G3: "the shape moved" and "the enum is empty" are different facts and must not
			// produce the same empty result. A reshape to a bare union or a computed list is a
			// change this renderer cannot follow, and it says so instead of rendering nothing.
			error: `no \`export const ${name} = [...] as const\` declaration found — if the shape moved (a bare union, a TS enum, a list built at run time) this renderer can no longer read it, and the page it feeds would silently render an empty value set`,
		};
	}
	return { members: [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]), error: null };
}

/**
 * `work-report.ts`'s `PARKS` — every park reason with what it waits for and which KIND of
 * deadline it has. The kind is the load-bearing half: a resume time means sit still, a give-up
 * time means intervene now, and #596 exists because one field carried both under one verb.
 *
 * @param {string} src
 * @returns {{parks: Record<string, {why: string, deadline: string}>, error: string|null}}
 */
export function parseParks(src) {
	const block = src.match(/const PARKS: Record<RunWaitReason, Park> = \{([\s\S]*?)^\};/m);
	if (!block) {
		return {
			parks: {},
			error:
				"no `const PARKS: Record<RunWaitReason, Park> = {…}` table found in work-report.ts — the deadline KIND is derived from this table, so without it the page cannot say which parks resume and which give up",
		};
	}
	/** @type {Record<string, {why: string, deadline: string}>} */
	const parks = {};
	for (const m of block[1].matchAll(/(\w+):\s*\{\s*why:\s*"([^"]*)",\s*deadline:\s*"(\w+)"\s*\}/g)) {
		parks[m[1]] = { why: m[2], deadline: m[3] };
	}
	return { parks, error: null };
}

/**
 * Floors, DERIVED rather than observed.
 *
 * A floor set to today's count is a bound chosen to make today's number pass, which ADR 0002
 * names as the wrong answer to G1. Each of these is read off something already enforced
 * elsewhere:
 *
 *  - health: the enum held three members before `ended` was added (#588), and `runHealth`'s body
 *    returns four distinct literals. Under three is a parser that has stopped parsing, not an
 *    enum that shrank.
 *  - reasons: BOTH deadline kinds must be representable or the distinction this page exists to
 *    state cannot be shown at all. Two is the smallest set that can carry a resume and a give-up.
 */
const FLOORS = { health: 3, reasons: 2 };

/** One clause per deadline kind, so the verb cannot be chosen per row — the same rule
 *  `work-report.ts`'s `DEADLINE_CLAUSE` follows, and for the same reason: the two license
 *  opposite actions from the owner. An unknown kind is rendered as unknown rather than guessed,
 *  because a guessed verb IS the defect #596 was filed for. */
const DEADLINE_MEANING = {
	resume: "**resumes** — the run continues by itself, and the owner does nothing",
	give_up: "**gives up** — the run stops waiting, and the owner has until then to act",
};

/** The comment that opens a generated region. Names the authority so a reader who wants to
 *  change the text knows the page is not where to do it. */
const OPEN = (id, from) => `<!-- generated:${id} — rendered from ${from}. Do not edit by hand; \`pnpm docs:drift\` prints the expected text. -->`;
const CLOSE = (id) => `<!-- /generated:${id} -->`;

/**
 * Render every generated region from the code that defines it.
 *
 * @param {{healthStates: string[], waitReasons: string[], parks: Record<string, {why: string, deadline: string}>}} input
 * @returns {Record<string, string>} region id → the exact text that region must contain
 */
export function renderRegions({ healthStates, waitReasons, parks }) {
	const health = [
		OPEN("run-health", "`RUN_HEALTH_STATES` in `workers/api/src/lib/work-report.ts`"),
		"",
		// The COUNT is rendered, not typed. "three values" is the exact sentence that went stale
		// in two MCP tool descriptions when `ended` arrived (#588) — a hand-written number
		// restating the size of an enum is the same claim as a hand-written list of it.
		`\`health\` has **${healthStates.length}** values: ${healthStates.map((s) => `\`${s}\``).join(", ")}.`,
		"",
		CLOSE("run-health"),
	].join("\n");

	const rows = waitReasons.map((r) => {
		const park = parks[r];
		const why = park ? park.why : "—";
		const meaning = park ? (DEADLINE_MEANING[park.deadline] ?? `\`${park.deadline}\` — unknown kind`) : "—";
		return `| \`${r}\` | ${why} | ${meaning} |`;
	});
	const reasons = [
		OPEN(
			"run-wait-reasons",
			"`RUN_WAIT_REASONS` in `workers/api/src/lib/agent-loop-store.ts` and `PARKS` in `workers/api/src/lib/work-report.ts`",
		),
		"",
		"| `waitingReason` | What the run is waiting for | When `waitingUntil` runs out |",
		"| --- | --- | --- |",
		...rows,
		"",
		CLOSE("run-wait-reasons"),
	].join("\n");

	return { "run-health": health, "run-wait-reasons": reasons };
}

/** Pull a region out of the page by its delimiters, so the comparison is against the region
 *  and not against the whole file — the prose around it is meant to change freely. */
function extractRegion(doc, id) {
	const open = doc.indexOf(`<!-- generated:${id} `);
	const closeTag = CLOSE(id);
	const close = doc.indexOf(closeTag);
	if (open === -1 || close === -1 || close < open) return null;
	return doc.slice(open, close + closeTag.length);
}

/**
 * Assert the published page's value sets are the ones the code emits.
 *
 * @param {{workReport: string, loopStore: string, doc: string|null, docName: string}} input
 * @returns {{failures: {check: string, message: string}[], notes: string[]}}
 */
export function checkRunLifecycle({ workReport, loopStore, doc, docName }) {
	/** @type {{check: string, message: string}[]} */
	const failures = [];
	const notes = [];
	const fail = (message) => failures.push({ check: "run-lifecycle", message });

	if (doc === null) {
		fail(`${docName} does not exist. The run-lifecycle reference is the page these regions are rendered into (#601).`);
		return { failures, notes };
	}

	const health = parseConstArray(workReport, "RUN_HEALTH_STATES");
	const reasons = parseConstArray(loopStore, "RUN_WAIT_REASONS");
	const { parks, error: parksError } = parseParks(workReport);
	for (const e of [health.error, reasons.error, parksError]) if (e) fail(e);
	if (failures.length) return { failures, notes };

	// G1. An empty render compares equal to an empty region, so a parser that quietly matched
	// nothing would produce a PASS — the exact collapse of "found nothing" into "found nothing
	// wrong" that #604 was filed for. Floors are checked before anything is rendered.
	if (health.members.length < FLOORS.health) {
		fail(
			`parsed ${health.members.length} RUN_HEALTH_STATES member(s), expected at least ${FLOORS.health}.\n` +
				"  The enum held three members before `ended` (#588) and `runHealth` returns four distinct\n" +
				"  literals, so this is a parser that has stopped parsing — not an enum that shrank.",
		);
	}
	if (reasons.members.length < FLOORS.reasons) {
		fail(
			`parsed ${reasons.members.length} RUN_WAIT_REASONS member(s), expected at least ${FLOORS.reasons}.\n` +
				"  Two is the smallest set that can carry both a resume and a give-up deadline, which is the\n" +
				"  distinction this page exists to state.",
		);
	}
	if (failures.length) return { failures, notes };

	// Every park reason must have a `PARKS` row, or the page would print a reason with no verb —
	// and a park whose kind is unknown is the one thing `waitClause` refuses to render a deadline
	// for. Checked here so the page cannot document a reason the renderer had to guess about.
	const missing = reasons.members.filter((r) => !parks[r]);
	if (missing.length) {
		fail(
			`park reason(s) with no PARKS row: ${missing.join(", ")}.\n` +
				"  `PARKS` is keyed by `RunWaitReason`, so a reason without a row has no deadline KIND, and\n" +
				"  the page could only state its verb by guessing. Add the row in work-report.ts.",
		);
	}
	const orphan = Object.keys(parks).filter((r) => !reasons.members.includes(r));
	if (orphan.length) {
		fail(
			`PARKS row(s) for reason(s) not in RUN_WAIT_REASONS: ${orphan.join(", ")}.\n` +
				"  The array is what every guard walks; a row outside it is documented but unreachable.",
		);
	}
	if (failures.length) return { failures, notes };

	const regions = renderRegions({
		healthStates: health.members,
		waitReasons: reasons.members,
		parks,
	});
	for (const [id, expected] of Object.entries(regions)) {
		const actual = extractRegion(doc, id);
		if (actual === null) {
			fail(
				`${docName} has no \`generated:${id}\` region. Expected, verbatim:\n\n${expected}\n`,
			);
			continue;
		}
		if (actual !== expected) {
			fail(
				`${docName}'s \`generated:${id}\` region does not match what the code renders.\n` +
					"  This region is GENERATED — the fix is to replace it, not to edit the code to match.\n" +
					`  Expected, verbatim:\n\n${expected}\n\n  Found:\n\n${actual}\n`,
			);
		}
	}

	// The denominator is a SUCCESS line, so it is withheld when anything failed. Emitting it
	// beside a failure prints a ✓ and a ✗ about the same check in one run, which reads as "mostly
	// fine" — the same collapse of "found nothing" into "found nothing wrong" that #604 was filed
	// for, dressed as a summary. Observed doing exactly that before this guard was added.
	if (failures.length) return { failures, notes };

	const kinds = new Set(Object.values(parks).map((p) => p.deadline));
	notes.push(
		`run lifecycle: ${Object.keys(regions).length} generated region(s) in ${docName} == ` +
			`${health.members.length} health state(s) + ${reasons.members.length} park reason(s) ` +
			`(${kinds.size} deadline kind(s)) from 2 code file(s)`,
	);
	return { failures, notes };
}
