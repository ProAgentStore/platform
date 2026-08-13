/**
 * A file path on its way OUT into a durable artifact, checked against the paths this turn's tools
 * actually returned (#528).
 *
 * ── The incident
 *
 * `HeartFull-online/platform` issue #224 was opened by an agent at 2026-08-12 00:02:12Z and ends
 * "**Affected file**: `app/lib/features/events/ui/widgets/event_form_dialog.dart`". That path does
 * not exist — not at the then-HEAD, not on `main`. The only file of that name is
 * `admin/lib/features/events/ui/pages/event_form_dialog.dart`, which the agent's own
 * `repo_read_file` had returned, and whose `SizedBox(width: 480)` it quoted correctly in the same
 * issue body. It then put the same invented path into a `start_work` objective, and the Pilot spent
 * four of a six-step run hunting a file that does not exist.
 *
 * So the correct path was in context and a different one was written into a public issue and into
 * what an autonomous run spends money executing. `lib/fabricated-history.ts` quarantines invented
 * content on the way IN; nothing looked at tool arguments on the way OUT.
 *
 * ── Why this is data in a tool result and not a sentence in the prompt
 *
 * Three fixes on this repository have now measured the same thing: a standing instruction loses to
 * evidence acquired later in the same turn, and a fact stated at the moment it matters wins.
 * `644e5e2` (#493/#494) replaced two prompt rules with a per-call diagnosis of a 404; `7629d24`
 * (#517) made a refusal carry its own account; `8bc3793` (#545) did the same for a dead run. A
 * fourth sentence saying "use the path the tool returned" would be arguing with the model's own
 * reconstruction of a path it half-remembers, and it would fire on every turn instead of the rare
 * one that needs it. The platform, by contrast, HOLDS the paths this turn's results contained and
 * can simply say so.
 *
 * Nothing here blocks or fails a call. `success` is untouched: the call really did what it says,
 * and a refusal delivered as a failure would drop legitimate work — worst of all in the last tool
 * round, where the model has no round left to retry in.
 *
 * ── The distinguisher: a basename collision, not an unknown path
 *
 * Acceptance criterion 2 is the whole design problem. A path no tool returned is USUALLY fine: an
 * objective that asks for a file to be created names a path that does not exist yet, and that is
 * ordinary. So an unknown path is silent.
 *
 * What is NOT ordinary is the same FILENAME under a different directory. `event_form_dialog.dart`
 * exists once in the evidence, at `admin/lib/features/events/ui/pages/`; the argument puts it at
 * `app/lib/features/events/ui/widgets/`. A model creating a genuinely new file picks a name; a
 * model mis-remembering a path it was shown keeps the name and loses the directory. The collision
 * is the signal, and it is exactly the incident's shape (it also catches the second half of it —
 * `app/pubspec.yaml` against the `admin/pubspec.yaml` that was really bumped).
 *
 * The rule is deliberately not "unknown path ⇒ warn". That would fire on every create-a-file
 * objective in the product and would be switched off within a week.
 *
 * ── What it does NOT do, named rather than implied
 *
 *   * **One turn only.** The ledger holds what THIS turn's tool results contained. In the incident
 *     the read was ~43 minutes and several turns earlier, so this would have caught it only if the
 *     read and the write shared a turn (the common shape: read, then file). Seeding the ledger from
 *     conversation history was rejected, not skipped: history's assistant rows are where an invented
 *     path already lives — #224's own chat reply named `app/` four times — so a ledger built from
 *     them would corroborate the fabrication with itself. Cross-turn corroboration needs a source
 *     that can distinguish a tool result from the model's own prose, which history here cannot.
 *   * **It reports what the RESULTS contained, not what exists.** A tool whose result echoes its
 *     own arguments (a memory write, a task title) can put a model-authored path into the ledger.
 *     The notice is therefore worded as "this turn's tool results contain", which stays true either
 *     way, instead of "the real path is".
 *   * **It reads text, not a filesystem.** No I/O, no env; a path is path-SHAPED, which is all a
 *     string in a result can be.
 *   * **The OWNER's pill sees only as much of it as the note fits in.** It is appended to the
 *     result, and a successful result's pill is cut at `TOOL_LOG_MAX_CHARS` (120) with no ellipsis.
 *     `github_create_issue` returns ~74 characters, so the pill shows the note's first clause and
 *     the owner can tell something was flagged; `start_work` echoes the whole objective, so usually
 *     it does not. The model, which is who has to act on it, gets the note in full either way.
 *     Widening the pill would mean either lying about `success` or editing the cap, and the cap is
 *     #517's, with its own reasons.
 *
 * Pure throughout. The ledger is a plain map the caller owns.
 */

/** A sink: an argument that leaves the conversation and becomes something durable. */
interface Sink {
	/** Argument fields whose text is checked. Pinned against the real tool schemas by the test. */
	readonly fields: readonly string[];
	/** How the notice names what already happened, so the remedy clause is about the right object. */
	readonly artifact: string;
}

/**
 * The two sinks, per #528: a filed issue is public and permanent, and an objective is what an
 * autonomous run spends money executing. Both are written from the model's own text, and neither is
 * read back by anything that would notice the path is wrong.
 *
 * A table, so a third sink is a row. It is NOT every write tool: annotating a `write_memory` would
 * put the note where nobody durable reads it, and the check is only worth its noise where the wrong
 * path outlives the turn.
 */
export const CORROBORATED_SINKS: Readonly<Record<string, Sink>> = {
	github_create_issue: { fields: ["title", "body"], artifact: "The issue has already been filed with the text above" },
	start_work: { fields: ["objective"], artifact: "The run has already started with the objective above" },
};

/**
 * basename (lower-cased) → the full paths seen with that basename, exactly as they appeared.
 *
 * Lower-cased key so a case-only difference in the filename still collides and gets reported;
 * the stored paths keep their case, because the notice quotes them back.
 */
export type PathLedger = Map<string, Set<string>>;

export function createPathLedger(): PathLedger {
	return new Map();
}

/**
 * At most this many path-shaped strings are taken from one string.
 *
 * A `repo_tree` of a large repository is thousands of lines, and this runs on every tool result. The
 * cap can only make the ledger SMALLER, and a smaller ledger can only produce silence — never a
 * false accusation — which is the direction an arbitrary bound is allowed to fail in.
 */
const MAX_PATHS_PER_TEXT = 400;

/** Offending paths named in one notice, and known paths listed per offender. Keeps the note bounded. */
const MAX_REPORTED = 3;
const MAX_KNOWN_LISTED = 3;

/**
 * A path-shaped string: two or more segments, and a final segment carrying a 1–8 character
 * extension.
 *
 * The extension is what keeps `owner/repo` (a `github_*` argument, present in every call this
 * annotates) and `and/or` out. It also means a directory path is never a candidate — which is
 * correct here, since the thing being corroborated is a FILE the model claims to have seen.
 *
 * Hand-rolled, so per ADR 0002 what it does not handle is stated rather than left to be discovered:
 * it does not know quoting or comments, it treats a Windows `\` path as no path at all, and it will
 * happily take `v1.2/x.py` out of prose. All three fail toward silence or toward a candidate whose
 * basename matches nothing, which produces no notice.
 */
const PATH_RE = /(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]+\.[A-Za-z0-9]{1,8}/g;

/** URLs are removed first: a URL's path is a location on a server, not a file in the tree, and a
 *  `.../blob/main/app/x.dart` would otherwise enter the ledger with `blob/main` glued to its front. */
const URL_RE = /https?:\/\/\S+/g;

/** Strip the shapes a path is quoted in, so `./a/b.ts` and `a/b.ts` are one path. */
function normalizePath(raw: string): string {
	let p = raw;
	while (p.startsWith("./")) p = p.slice(2);
	while (p.startsWith("/")) p = p.slice(1);
	return p;
}

function basenameOf(path: string): string {
	const i = path.lastIndexOf("/");
	return (i === -1 ? path : path.slice(i + 1)).toLowerCase();
}

/** Every path-shaped string in `text`, normalized, de-duplicated, in first-seen order. */
export function extractPaths(text: string): string[] {
	if (typeof text !== "string" || text.length === 0) return [];
	const withoutUrls = text.replace(URL_RE, " ");
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of withoutUrls.matchAll(PATH_RE)) {
		const p = normalizePath(m[0]);
		if (p.length === 0 || !p.includes("/") || seen.has(p)) continue;
		seen.add(p);
		out.push(p);
		if (out.length >= MAX_PATHS_PER_TEXT) break;
	}
	return out;
}

/**
 * Fold one tool result into the ledger.
 *
 * Failures are excluded (an error message is not evidence of a tree), and so are the sinks
 * themselves: `start_work` echoes its own objective back in its success line, so absorbing it would
 * let a fabricated path corroborate the next call in the same turn.
 */
export function recordToolPaths(ledger: PathLedger, toolName: string, content: string, success: boolean): void {
	if (!success || toolName in CORROBORATED_SINKS) return;
	for (const p of extractPaths(content)) {
		const key = basenameOf(p);
		const set = ledger.get(key);
		if (set) set.add(p);
		else ledger.set(key, new Set([p]));
	}
}

/** True when one path is the other with a directory prefix removed — the same file, quoted relative
 *  to a subdirectory. Corroborated, not contradicted. */
function isSuffixOf(a: string, b: string): boolean {
	return b.endsWith(`/${a}`) || a.endsWith(`/${b}`);
}

/** An argument path the ledger contradicts, with the paths it contradicts. */
export interface Mismatch {
	readonly written: string;
	readonly known: string[];
}

/**
 * The contradictions in one text: a path whose basename IS in the ledger, under a full path that is
 * not.
 *
 * Exported for the test, which is the only way to state the two silent cases as facts rather than as
 * the absence of a string in a notice.
 */
export function findMismatches(ledger: PathLedger, text: string): Mismatch[] {
	const out: Mismatch[] = [];
	for (const written of extractPaths(text)) {
		const known = ledger.get(basenameOf(written));
		if (!known || known.size === 0) continue; // a filename the evidence never mentioned — a new file is normal
		if (known.has(written)) continue; // exactly what a tool returned
		if ([...known].some((k) => isSuffixOf(written, k))) continue; // same file, quoted relative to a subdirectory
		out.push({ written, known: [...known].sort() });
		if (out.length >= MAX_REPORTED) break;
	}
	return out;
}

function describeMismatch(m: Mismatch): string {
	const listed = m.known.slice(0, MAX_KNOWN_LISTED).map((k) => `\`${k}\``);
	const more = m.known.length > listed.length ? ` (and ${m.known.length - listed.length} more)` : "";
	const noun = m.known.length === 1 ? "the only path with that filename is" : "the paths with that filename are";
	return ` You wrote \`${m.written}\`, but ${noun} ${listed.join(", ")}${more}.`;
}

/**
 * The note to append to a sink's result, or `""` when the platform knows nothing the model does not.
 *
 * `""` is overwhelmingly the common case — every non-sink tool, every turn with no path-shaped
 * strings, every path whose filename the evidence never mentioned — so this is two cheap scans and
 * nothing more.
 */
export function pathCorroborationNotice(ledger: PathLedger, toolName: string, args: unknown): string {
	const sink = CORROBORATED_SINKS[toolName];
	if (!sink || ledger.size === 0) return "";
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const text = sink.fields
		.map((f) => record[f])
		.filter((v): v is string => typeof v === "string")
		.join("\n");
	const mismatches = findMismatches(ledger, text);
	if (mismatches.length === 0) return "";
	return (
		"\n\nPLATFORM NOTE — a path in this call contradicts what this turn's tools returned." +
		mismatches.map(describeMismatch).join("") +
		` ${sink.artifact}; nothing was blocked or changed. If you meant the file the tools showed you, this` +
		" argument names the wrong directory: say so plainly and correct it now, rather than leaving a path" +
		" that resolves to nothing in something a person will read later. If you deliberately mean a NEW file" +
		" at that path, that is legitimate — state that you are creating it, so the two cases are told apart."
	);
}

/**
 * Check a call's arguments against the ledger, then fold this result into it — in that order, so a
 * result can never corroborate the very call it came from.
 *
 * Takes and returns the result shape rather than the string so the call site cannot annotate the
 * wrong tool: the sink lookup lives here, once. `success` is deliberately untouched.
 */
export function corroborateToolPaths<T extends { content: string; success: boolean }>(
	ledger: PathLedger,
	result: T,
	toolName: string,
	args: unknown,
): T {
	const note = pathCorroborationNotice(ledger, toolName, args);
	const annotated = note ? { ...result, content: result.content + note } : result;
	recordToolPaths(ledger, toolName, result.content, result.success);
	return annotated;
}
