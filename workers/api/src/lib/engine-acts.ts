/**
 * Consequential acts arriving from a runner (#294) — the cloud half.
 *
 * A delegated run wrote down its objective and its outcome and nothing in between. Run `73ffc073`
 * merged its own PRs to `main` unattended and `subordinate_status` said "done". The delegation
 * model rests on a supervisor being able to REVIEW what a subordinate did; without a record of the
 * irreversible acts, all it can review is whether the subordinate claimed success.
 *
 * ── NO FIFTH RECORD OF "WHAT HAPPENED" ──
 *
 * These go into `agent_events` (migration 0038), the unified trace already read by
 * `GET /v1/instances/:id/trace` and the MCP `agent_trace` tool. The #150 P2 agent explicitly
 * refused to add storage for a similar need and reused `instance_runtime_task_events`; the same
 * reasoning holds, and it buys more here than it costs — an act is visible in the trace, in MCP and
 * filterable by run, on day one, with nothing new to teach anybody.
 *
 * ── WHY THE EVENT NAME IS GENERIC ──
 *
 * `event: "act.consequential"` with `source` naming the subsystem, NOT `coding.act`. Supervision
 * reads these (see `instance-work.ts`), and that module is deliberately forbidden from importing a
 * domain module — the coupling migration 0063 removed and a first attempt at supervision
 * re-introduced. A generic event name keeps that intact: supervision reads "consequential acts",
 * and a pipeline that deploys or an MCP write tool can start writing the same record and appear in
 * the supervisor's view with no change to supervision at all.
 *
 * ── WHY EVERY CLAIM IS READ FROM THE COMMAND, NOT FROM THE KIND (#582) ──
 *
 * The label and `irreversible` are RECOMPUTED here rather than taken from the runner, and that
 * posture is right: they decide how loudly an act is surfaced, so a runner reporting `pr.merge`
 * with `irreversible: false` could otherwise downgrade the one act this whole feature exists to
 * make loud. What was wrong was the INPUT. Both were computed from `kind` alone, which made
 * `"file.delete" → "deleted files recursively", irreversible: true` a constant — `rm -f one.txt`
 * and `rm -rf /` byte-identical in the record, and 100% of file deletions mislabelled by
 * construction. Live: `cd /tmp && rm -rf pas-sdk-check && mkdir pas-sdk-check && …`, a scratch
 * directory the agent made in the same command to unpack and READ a published tarball, was recorded
 * as an irreversible recursive deletion under an INVESTIGATION-ONLY objective. The owner's own
 * agent escalated it as a safety breach, and a human investigation was spent confirming a non-event.
 *
 * The asymmetry is the point. Distrusting the runner's VERDICT protects against an act being
 * under-reported. Deriving the claim from `kind` alone guarantees it is OVER-reported — and a
 * classifier that has cried wolf is no longer evidence, which is the entire reason it exists.
 *
 * So each claim is derived from `act.command`. That is not a return to trusting the runner: the
 * command is the EVIDENCE of record — the text a human reads in the trace and the same field
 * `coding-authority.ts` gates a run on. A runner could falsify it, but then the row visibly states
 * a command that was never run and the audit trail is void by inspection; a runner falsifying
 * `irreversible: false` over a truthful command is an INVISIBLE downgrade. Only one of the two is a
 * claim a reader can check, and the derivation runs on the STORED (already truncated) text so that
 * they can: the sentence and the `command` in the same row cannot disagree.
 *
 * Where the command does not corroborate the kind — no segment matches it, or the evidence was cut
 * at {@link MAX_COMMAND} — the rule falls back to a claim-free sentence at the kind's consequence
 * floor. Unverifiable evidence never downgrades an act, and never adds a qualifier to one.
 */
import { logEvent } from "./events.js";
import type { Env } from "../types.js";

/** One act as the runner reports it. Mirrors `EngineActRecord` in the browser-runner package. */
export interface EngineActReport {
	id: string;
	kind: string;
	command: string;
	target: string | null;
	irreversible: boolean;
	ok: boolean | null;
	at: string;
}

/** Cap per drain — a compromised or buggy runner must not be able to bulk-insert into D1. */
const MAX_RECORDS = 100;
const MAX_COMMAND = 400;

// ── Reading the command ─────────────────────────────────────────────────────────────────────
//
// A hand-rolled shell reader, and ADR 0002 is the reason the next few functions are unit-tested
// and the reason `engine-acts.test.ts` has a test NAMING what they do not handle. This is not a
// shell: it never expands a variable, never enters a subshell, never resolves an alias and does no
// quote-aware word splitting. It answers exactly one question per rule, and every unanswerable
// input resolves to "not proven", which is the conservative direction in all of them.

/**
 * Split a command into the pieces that each RUN something.
 *
 * Deliberately as aggressive as the runner's own `splitSegments`, and deliberately a COPY of it:
 * `workers/api` must not import `@proagentstore/browser-runner` (a Node/Playwright package) into a
 * Worker bundle, and vendoring rather than depending is this workspace's stated convention. Over-
 * splitting costs nothing — a fragment simply matches no rule — and the shape that matters here is
 * exactly a compound line: `cd /tmp && rm -rf scratch && npm pack …`.
 */
function segments(command: string): string[] {
	return String(command ?? "")
		.split(/\|\||&&|[;|\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function words(segment: string): string[] {
	return segment.split(/\s+/).filter(Boolean);
}

function unquote(word: string): string {
	return word.replace(/^["']/, "").replace(/["']$/, "");
}

/** Is this exact long flag present? `--force` must not match inside `--force-with-lease`. */
function hasFlag(segment: string, flag: string): boolean {
	return new RegExp(`(?:^|\\s)${flag}(?:=|\\s|$)`).test(segment);
}

/** Does any short flag CLUSTER carry this letter? `-rf` carries both `r` and `f`. */
function clusterHas(segment: string, letter: string): boolean {
	return words(segment).some((w) => /^-[A-Za-z]+$/.test(w) && w.slice(1).includes(letter));
}

/** A token that is exactly the trunk, not a branch merely containing the word (`feature/main-fix`). */
const TRUNK_TOKEN = /(?:^|\s)(?:HEAD:)?(?:refs\/heads\/)?(?:main|master)(?:\s|$)/;

function pushesToTrunk(segment: string): boolean {
	return TRUNK_TOKEN.test(segment.split(/\bgit\s+push\b/)[1] ?? "");
}

/**
 * The scratch roots. A path under one of these is not the working tree, and deleting it is not a
 * deletion in any sense the owner asked to be told about.
 *
 * `$TMPDIR` is matched LITERALLY, unexpanded, because the recorded command carries the variable
 * rather than its value; `/var/folders/…` is what macOS expands it to, so both spellings appear in
 * real transcripts. Every root ends in a slash and a match must be strictly longer than it, so
 * `rm -rf /tmp` — the whole shared scratch area, other processes' state included — stays
 * consequential while `rm -rf /tmp/mine` does not.
 */
const SCRATCH_ROOTS = [
	"/tmp/",
	"/private/tmp/",
	"/var/tmp/",
	"/private/var/tmp/",
	"/var/folders/",
	"/private/var/folders/",
	"$TMPDIR/",
];

function scratchRootOf(path: string): string | null {
	return SCRATCH_ROOTS.find((r) => path.startsWith(r) && path.length > r.length) ?? null;
}

/**
 * Resolve one operand against the working directory the command has established for itself.
 *
 * Returns null for anything this cannot resolve EXACTLY — a glob, a variable, `~`, a `..` that
 * could climb out of the directory it appears to be in, or a relative path with no known `cwd`.
 * Null means "not proven to be scratch", never "safe": the only thing a null is ever allowed to do
 * downstream is keep an act consequential.
 */
function resolvePath(cwd: string | null, raw: string): string | null {
	// The braced and bare spellings are the same variable, so they are normalised to one form here
	// rather than listed twice in SCRATCH_ROOTS.
	const p = unquote(raw).replace(/^\$\{TMPDIR\}/, "$TMPDIR");
	if (!p || p.includes("*") || p.includes("?") || p.includes("..")) return null;
	if (p.startsWith("$TMPDIR")) return p;
	if (p.startsWith("$") || p.startsWith("~") || p.startsWith("`")) return null;
	if (p.startsWith("/")) return p;
	if (!cwd) return null;
	return `${cwd.replace(/\/+$/, "")}/${p}`;
}

/** One thing an `rm` in this command was pointed at. */
interface DeleteOperand {
	/** The absolute path, when it could be resolved exactly. Null = unresolvable, so unproven. */
	path: string | null;
	recursive: boolean;
}

interface DeleteFacts {
	operands: DeleteOperand[];
	recursive: boolean;
	/** An `rm` whose operands could not be read at all (`… | xargs rm -rf`) — extent unknown. */
	unbounded: boolean;
}

/**
 * What the `rm`s in this command actually delete.
 *
 * ── HOW "A PATH THE SAME COMMAND CREATED" IS DETERMINED, AND WHY NOT THE OBVIOUS WAY ──
 *
 * #582 asks for that test or for a reason a `/tmp` prefix test alone would do. A prefix test alone
 * does NOT do: the live command is `cd /tmp && rm -rf pas-sdk-check && …` and its `rm` operand is
 * RELATIVE — no prefix of it is `/tmp`. So this tracks `cd` across the segments and resolves each
 * operand against the working directory the command established, which is what makes that operand
 * `/tmp/pas-sdk-check`.
 *
 * The literal "created earlier in the same command" test — excuse an `rm` whose target the command
 * also `mkdir`s — is REJECTED as unsound, and the counterexample is one line: `rm -rf src && mkdir
 * src` inside a repository re-creates the path it just destroyed and would be excused by it. It is
 * also unnecessary, since in the reported command the `mkdir` comes AFTER the `rm` (clean-then-make,
 * not make-then-clean), so the rule the issue describes would not even have fired on its own
 * example. Scratch-ness is decided by WHERE the path is, which is a fact about the command, not by
 * guessing who owns it.
 *
 * A scratch directory somewhere else — `rm -rf ./build-check` inside a checkout — stays
 * consequential. That is the conservative side of the same decision and it is deliberate.
 */
function deleteFacts(command: string): DeleteFacts | null {
	let cwd: string | null = null;
	const operands: DeleteOperand[] = [];
	let recursive = false;
	let unbounded = false;
	let sawRm = false;
	for (const seg of segments(command)) {
		const w = words(seg);
		if (w[0] === "cd") {
			// An unreadable `cd` (no argument, two arguments, a variable) makes the working directory
			// UNKNOWN rather than unchanged — a wrong `cwd` would resolve a relative operand to a
			// path the command never touched.
			cwd = w.length === 2 ? resolvePath(cwd, w[1]) : null;
			continue;
		}
		const at = w.indexOf("rm");
		if (at < 0) continue;
		sawRm = true;
		const rest = w.slice(at + 1);
		const end = rest.indexOf("--");
		const flags = end < 0 ? rest : rest.slice(0, end);
		const here =
			flags.some((t) => t === "--recursive") || flags.some((t) => /^-[A-Za-z]+$/.test(t) && /[rR]/.test(t.slice(1)));
		recursive = recursive || here;
		const targets = [...flags.filter((t) => !t.startsWith("-")), ...(end < 0 ? [] : rest.slice(end + 1))];
		if (!targets.length) unbounded = true;
		for (const t of targets) operands.push({ path: resolvePath(cwd, t), recursive: here });
	}
	return sawRm ? { operands, recursive, unbounded } : null;
}

/**
 * The claim a `file.delete` act is entitled to make.
 *
 * `irreversible` here answers one measurable question: **could this have removed more than the
 * command names?** Recursion is what makes the removed set unbounded — `rm -rf dir` takes whatever
 * happens to be inside it — and it is right there in the flags. A non-recursive `rm` removes
 * exactly the files it lists, so the whole extent of it is legible in the record itself, which is
 * the opposite of what the `warn` band exists to escalate.
 *
 * It deliberately does NOT claim to know whether the bytes are recoverable. Whether a deleted file
 * was tracked by git is not in the command, and per #582's AC3 a field that cannot be derived
 * states nothing rather than something unmeasured.
 */
function describeDelete(command: string): ActClaim | null {
	const facts = deleteFacts(command);
	if (!facts) return null;
	if (facts.unbounded) {
		return { phrase: facts.recursive ? "deleted files recursively" : "deleted files", irreversible: true };
	}
	const root = facts.operands.length && facts.operands.every((o) => o.path && scratchRootOf(o.path));
	if (root) {
		return { phrase: `deleted a scratch path under ${scratchRootOf(facts.operands[0].path as string)}`, irreversible: false };
	}
	if (facts.recursive) return { phrase: "deleted files recursively", irreversible: true };
	const n = facts.operands.length;
	return { phrase: n === 1 ? "deleted a named file" : `deleted ${n} named files`, irreversible: false };
}

// ── The label table ─────────────────────────────────────────────────────────────────────────

/** What one act is entitled to say about itself, and how loudly. */
export interface ActClaim {
	phrase: string;
	irreversible: boolean;
}

/** One kind's rule: what it may claim, and which text is allowed to settle it. */
export interface ActRule {
	/**
	 * The sentence when the command corroborates NOTHING. It names the kind and adds no qualifier,
	 * so an unverifiable record can never carry a claim — the guard asserts this for every entry.
	 */
	base: string;
	/** The consequence when nothing could be verified. Unverifiable evidence never downgrades. */
	floor: boolean;
	/** The segments that could BE this act. A claim may read no other text. */
	match?: RegExp;
	/**
	 * Read the claim off the command. Returning null falls back to `base`/`floor`.
	 *
	 * Given the matching segments AND the whole command, because one rule genuinely needs the rest:
	 * `file.delete` resolves its operands against the `cd`s around it. Every other rule reads only
	 * its own segments, so `git clean -fdx && npm publish --dry-run` cannot let one act's flags
	 * answer for another's — the failure a whole-command scan would introduce.
	 */
	from?: (command: string, segs: string[]) => ActClaim | null;
}

/**
 * The act kinds the platform will record, and what each may claim.
 *
 * A CLOSED list, checked rather than passed through, because `kind` is rendered into a supervisor's
 * prompt and read by a model. An open string field would let a runner (or anything that can
 * impersonate one) inject a sentence into that prompt through a field the reader treats as an enum.
 *
 * Every entry states its claim-free `base` and its `floor`; the ones whose sentence would otherwise
 * assert something only the command knows also carry a `from`. `engine-acts.test.ts` walks all
 * {@link ACT_KIND_COUNT} of them and fails on any entry that qualifies its label without reading
 * the command — the guard #582 asks for, over the whole vocabulary rather than the one row it was
 * reported on.
 */
export const ACT_RULES: Record<string, ActRule> = {
	// A merge is a merge; the command adds nothing the kind does not already say.
	"pr.merge": { base: "merged a pull request", floor: true },
	"pr.open": { base: "opened a pull request", floor: false },
	push: {
		base: "pushed a branch",
		floor: false,
		match: /\bgit\s+push\b/,
		from: (_c, segs) => (segs.some((s) => hasFlag(s, "--dry-run")) ? DRY_PUSH : null),
	},
	"push.trunk": {
		base: "pushed a branch",
		floor: true,
		match: /\bgit\s+push\b/,
		from: (_c, segs) =>
			segs.some((s) => hasFlag(s, "--dry-run"))
				? DRY_PUSH
				: segs.some(pushesToTrunk)
					? { phrase: "pushed directly to the trunk", irreversible: true }
					: { phrase: "pushed a branch", irreversible: false },
	},
	"push.force": {
		base: "pushed a branch",
		floor: true,
		match: /\bgit\s+push\b/,
		from: (_c, segs) => {
			if (segs.some((s) => hasFlag(s, "--dry-run"))) return DRY_PUSH;
			const lease = segs.some((s) => hasFlag(s, "--force-with-lease"));
			const forced = segs.some((s) => hasFlag(s, "--force") || clusterHas(s, "f"));
			// The old sentence claimed the push "rewrote published history". Whether anything had
			// been published, or pulled by anyone, is not in the command — what IS in it is the flag,
			// and `--force-with-lease` is a materially weaker act than a bare force: it refuses
			// outright if the remote moved since the last fetch.
			if (lease && !forced) return { phrase: "force-pushed under a lease (refused if the remote had moved)", irreversible: true };
			if (lease || forced) return { phrase: "force-pushed (overwrote the remote branch)", irreversible: true };
			return { phrase: "pushed a branch", irreversible: false };
		},
	},
	"branch.delete": {
		base: "deleted a branch",
		floor: true,
		match: /\bgit\s+(?:push|branch)\b/,
		from: (_c, segs) =>
			// This kind covers two very different acts: `git push origin --delete x` destroys a ref
			// other people fetch, while `git branch -d x` deletes a pointer whose commits remain in
			// the reflog and in whatever merged them. Recording both as irreversible made routine
			// post-merge tidying read like the destructive one.
			segs.some((s) => /\bgit\s+push\b/.test(s))
				? { phrase: "deleted a remote branch", irreversible: true }
				: { phrase: "deleted a local branch", irreversible: false },
	},
	"reset.hard": {
		base: "reset the working tree",
		floor: true,
		match: /\bgit\s+reset\b/,
		from: (_c, segs) =>
			segs.some((s) => hasFlag(s, "--hard"))
				? { phrase: "hard-reset the working tree", irreversible: true }
				: { phrase: "reset the working tree", irreversible: false },
	},
	clean: {
		base: "cleaned the working tree",
		floor: true,
		match: /\bgit\s+clean\b/,
		from: (_c, segs) => {
			// `-n`/`--dry-run` PRINTS what it would remove; `git clean` without `-f` refuses to do
			// anything at all. Both were recorded as a destructive clean.
			if (segs.some((s) => hasFlag(s, "--dry-run") || clusterHas(s, "n"))) {
				return { phrase: "listed what a clean would remove (nothing was deleted)", irreversible: false };
			}
			if (!segs.some((s) => hasFlag(s, "--force") || clusterHas(s, "f"))) {
				return { phrase: "cleaned the working tree", irreversible: false };
			}
			return segs.some((s) => clusterHas(s, "x"))
				? { phrase: "force-cleaned the working tree, including ignored files", irreversible: true }
				: { phrase: "force-cleaned the working tree", irreversible: true };
		},
	},
	"file.delete": {
		base: "deleted files",
		floor: true,
		match: /(?:^|\s)rm(?:\s|$)/,
		from: (command) => describeDelete(command),
	},
	"release.publish": {
		base: "published a release",
		floor: true,
		match: /\bgh\s+release\s+create\b/,
		from: (_c, segs) =>
			segs.some((s) => hasFlag(s, "--draft"))
				? { phrase: "created a draft release (nothing was published)", irreversible: false }
				: { phrase: "published a release", irreversible: true },
	},
	"package.publish": {
		base: "published a package",
		floor: true,
		match: /\b(?:npm|pnpm|yarn|bun)\s+publish\b/,
		from: (_c, segs) =>
			segs.some((s) => hasFlag(s, "--dry-run"))
				? { phrase: "ran a publish dry-run (nothing was published)", irreversible: false }
				: { phrase: "published a package", irreversible: true },
	},
	"repo.delete": { base: "deleted a repository", floor: true },
	deploy: {
		base: "deployed",
		floor: true,
		match: /\b(?:wrangler|vercel|netlify)\b/,
		from: (_c, segs) =>
			segs.some((s) => hasFlag(s, "--dry-run"))
				? { phrase: "ran a deploy dry-run (nothing was deployed)", irreversible: false }
				: { phrase: "deployed", irreversible: true },
	},
};

/** `git push --dry-run` connects to the remote and updates nothing. Shared by the three push kinds. */
const DRY_PUSH: ActClaim = { phrase: "ran a push dry-run (nothing was pushed)", irreversible: false };

/** The size of the vocabulary, asserted by the guard rather than counted by it (ADR 0002 G1). */
export const ACT_KIND_COUNT = 13;

/**
 * The words a label is not allowed to use unless the command settles them.
 *
 * This is the guard's vocabulary, kept HERE rather than in the test because this is where someone
 * writing a new label will be standing. Every one of these says something about HOW an act was
 * done — a property of the command, never of the category — so a `base` containing one is a claim
 * made about a command nobody read, which is the defect #582 reported.
 */
export const QUALIFIER_LEXICON = [
	"recursive",
	"recursively",
	"scratch",
	"named",
	"directly",
	"trunk",
	"force",
	"overwrote",
	"lease",
	"hard",
	"ignored",
	"remote",
	"local",
	"draft",
	"dry-run",
];

/** The closed set of kinds, derived from the table so the two can never disagree. */
const KNOWN_KINDS = new Set(Object.keys(ACT_RULES));

/**
 * What this act may claim, read from the command it reports.
 *
 * Runs on the command as STORED — already redacted and truncated — so the sentence in the trace and
 * the evidence beside it are computed from the same text a reader will check it against.
 */
export function deriveAct(kind: string, command: string): ActClaim {
	const rule = ACT_RULES[kind];
	if (!rule) return { phrase: kind, irreversible: false };
	const fallback: ActClaim = { phrase: rule.base, irreversible: rule.floor };
	if (!rule.from || !rule.match) return fallback;
	const segs = segments(command).filter((s) => (rule.match as RegExp).test(s));
	if (!segs.length) return fallback;
	return rule.from(command, segs) ?? fallback;
}

/**
 * Validate a runner's reported acts into records worth writing.
 *
 * The payload crosses the relay from a machine the platform does not control, so it is treated as
 * input rather than as truth about types — the same posture as `sanitizeEngineUsage`.
 *
 * `irreversible` is RECOMPUTED rather than trusted: it is the field that decides how loudly an act
 * is surfaced, so a runner that reported `pr.merge` with `irreversible: false` could otherwise
 * downgrade the one act this whole feature exists to make loud. It is recomputed from the KIND AND
 * THE COMMAND (#582) — see the module header for why deriving it from the kind alone was itself a
 * defect, and why reading the evidence field is not a return to trusting the runner's verdict.
 */
export function sanitizeEngineActs(raw: unknown): EngineActReport[] {
	if (!Array.isArray(raw)) return [];
	const out: EngineActReport[] = [];
	const seen = new Set<string>();
	for (const item of raw.slice(0, MAX_RECORDS)) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		const id = typeof r.id === "string" ? r.id.trim().slice(0, 200) : "";
		// No id means no dedup key, and a duplicated "merged to main" reads as a second merge that
		// never happened. Drop it rather than write something a supervisor could double-count.
		if (!id || seen.has(id)) continue;
		const kind = typeof r.kind === "string" ? r.kind.trim() : "";
		if (!KNOWN_KINDS.has(kind)) continue;
		const command = typeof r.command === "string" ? r.command.trim().slice(0, MAX_COMMAND) : "";
		if (!command) continue;
		seen.add(id);
		out.push({
			id,
			kind,
			command,
			target: typeof r.target === "string" && r.target.trim() ? r.target.trim().slice(0, 120) : null,
			irreversible: deriveAct(kind, command).irreversible,
			// Anything that is not literally true/false is UNKNOWN. Coercing a missing value to
			// `true` would be the platform inventing a successful merge.
			ok: r.ok === true ? true : r.ok === false ? false : null,
			at: typeof r.at === "string" && r.at.trim() ? r.at.trim().slice(0, 40) : new Date().toISOString(),
		});
	}
	return out;
}

/**
 * One sentence naming the act, its subject and whether it worked.
 *
 * The outcome is stated explicitly in all three states. "merged a pull request #42" with no
 * qualifier would be read as a completed merge, so a failed one says so and an unobserved one says
 * that too — the distinction between "it merged" and "we did not see whether it merged" is the
 * whole difference between an audit trail and a guess.
 *
 * The `command` is a required input, not an optional refinement (#582): without it the sentence is
 * a constant keyed on the category, and a constant cannot be honest about a command it never read.
 */
export function describeEngineAct(act: Pick<EngineActReport, "kind" | "target" | "ok" | "command">): string {
	const base = deriveAct(act.kind, act.command).phrase;
	const subject = act.target ? ` ${act.target}` : "";
	const outcome = act.ok === false ? " — FAILED" : act.ok === null ? " — outcome not observed" : "";
	return `${base}${subject}${outcome}`;
}

/** How many acts a one-line run summary names before it says "and N more". */
const MAX_SUMMARY_ACTS = 4;

/**
 * One line naming what a run DID, for the places a supervisor reads without asking a second
 * question — the delegated run's `detail` and its board card.
 *
 * The trace holds the full record, but a supervisor's default read is `check_delegation` /
 * `subordinate_status`, and #294's acceptance says they must see it "without opening the repo".
 * Making them fetch the trace to discover a merge would rebuild the same gap one call further out.
 *
 * IRREVERSIBLE ACTS COME FIRST and the reversible tail is only counted. When a run pushes eleven
 * branches and merges one, the merge is the sentence — ordering by time would bury it.
 *
 * Returns null for a run with no observed acts. A padded "no consequential acts" would be a claim
 * this cannot make: a raw engine reports nothing, so silence means "not observed".
 */
export function summarizeActs(acts: ReadonlyArray<{ summary: string; irreversible: boolean }>): string | null {
	if (!acts.length) return null;
	const ordered = [...acts].sort((a, b) => Number(b.irreversible) - Number(a.irreversible));
	const named = ordered.slice(0, MAX_SUMMARY_ACTS).map((a) => a.summary);
	const rest = ordered.length - named.length;
	return `Acts: ${named.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}.`;
}

/**
 * The trace row's primary key for an act.
 *
 * Deterministic for the same reason the usage ledger's is: several cloud paths can drain and write
 * the same act (a console capture poll racing the Pilot's own capture, or a retried workflow step),
 * and `INSERT OR IGNORE` on this key turns that into a no-op. Namespaced by session so two sessions
 * cannot collide on an engine-supplied tool_use id.
 */
export function engineActRowId(sessionId: string, recordId: string): string {
	return `act:${sessionId}:${recordId}`.slice(0, 300);
}

/**
 * Write acts to the unified trace.
 *
 * `level` is `warn` for an irreversible act. That is not "something went wrong" — in this trace the
 * levels are the only queryable severity band, and `warn` is the "a human should look at this" one.
 * An unattended merge to `main` is precisely that, and it means `GET /trace?level=warn` and the MCP
 * `agent_trace` tool surface it with no new filter dimension.
 */
export async function recordEngineActs(
	env: Env,
	ctx: { userId: string; instanceId: string; sessionId: string; traceId?: string | null },
	acts: EngineActReport[],
): Promise<void> {
	for (const act of acts) {
		await logEvent(env, {
			id: engineActRowId(ctx.sessionId, act.id),
			source: "coding",
			event: "act.consequential",
			level: act.irreversible ? "warn" : "info",
			userId: ctx.userId,
			instanceId: ctx.instanceId,
			// The RUN when one is driving, so `/trace?trace_id=<runId>` reconstructs exactly what
			// that delegation did; the session otherwise. Never both, and never a guess.
			traceId: ctx.traceId || ctx.sessionId,
			message: describeEngineAct(act),
			context: {
				act: act.kind,
				command: act.command,
				target: act.target,
				irreversible: act.irreversible,
				ok: act.ok,
				sessionId: ctx.sessionId,
			},
			ts: Date.parse(act.at) || Date.now(),
		});
	}
}
