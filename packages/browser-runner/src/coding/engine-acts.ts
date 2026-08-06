/**
 * What the Engine actually DID — the consequential-act record (#294).
 *
 * A delegated run recorded its objective and its terminal outcome and nothing in between. Live,
 * run `73ffc073` merged its own PRs to `main` unattended and the supervisor view said "done". For
 * a read-only goal that is fine; for a goal that merges to the trunk it is trust, not review.
 *
 * ── WHERE THE SIGNAL COMES FROM, AND WHY IT IS NOT THE OTHER ONE ──
 *
 * The obvious alternative was a repo-state delta: snapshot branch/HEAD/refs before and after a run
 * and diff them. #276 already reads `git status --short --branch` through the runner, so it is
 * nearly free. It was rejected on a fact, not a preference: **a pull request is not a git object.**
 * `gh pr create` changes nothing in the local repository at all, and `gh pr merge` changes a ref on
 * GitHub that the local checkout does not learn about until somebody fetches. So the delta design
 * cannot satisfy the one thing the issue asks for by name — "a run that opens or merges a PR leaves
 * a record naming that act" — and would report a clean tree on `main` for the exact run that
 * prompted the issue.
 *
 * What it CAN see (branch moved, tree dirty) is already reported by #276, so building it here would
 * have duplicated the covered half and missed the uncovered one.
 *
 * The worry the issue actually raises about this side — "parsing terminal output is unreliable, the
 * model's prose is not an audit trail" — does not apply to what is parsed here. This does not read
 * the Engine's prose. Claude Code's stream-json protocol emits a `tool_use` block per tool
 * invocation carrying the literal command string it is about to run, and a `tool_result` carrying
 * whether it failed. `{"command":"gh pr merge 42 --squash"}` is a protocol event, the same class of
 * fact as the `result` event #267 takes its cost figures from. It is what the Engine RAN, not what
 * it later said about what it ran.
 *
 * ── THE HONEST GAP ──
 *
 * Only a stream-json engine (Claude Code) produces these. A raw Codex/Grok session emits nothing
 * parseable, so it records no acts — the same gap, for the same reason, as engine usage (#267). An
 * empty act list therefore means "nothing observed", never "nothing happened", and every consumer
 * has to say so rather than render it as an all-clear.
 */

/** The kinds of act worth writing down. Anything not here is ordinary work and is not recorded. */
export type EngineActKind =
	| "pr.merge"
	| "pr.open"
	| "push"
	| "push.trunk"
	| "push.force"
	| "branch.delete"
	| "reset.hard"
	| "clean"
	| "file.delete"
	| "release.publish"
	| "package.publish"
	| "repo.delete"
	| "deploy";

/** One consequential act, as the runner reports it. The wire shape between runner and cloud. */
export interface EngineActRecord {
	/**
	 * Stable id, derived from the engine's own `tool_use` id.
	 *
	 * The cloud inserts on a deterministic primary key and ignores conflicts, so a retried step or
	 * two capture callers racing cannot write the same merge twice — a duplicated "merged to main"
	 * is not a harmless duplicate, it is a second unattended merge that never happened.
	 */
	id: string;
	kind: EngineActKind;
	/** The literal command, secret-redacted and capped. This is the evidence, not a paraphrase. */
	command: string;
	/** Best-effort subject: the PR number, the branch, the remote. Null when it isn't stated. */
	target: string | null;
	/** Is this act one that cannot simply be undone? Drives how loudly it is surfaced. */
	irreversible: boolean;
	/**
	 * Did the command succeed?
	 *
	 * `false` when the engine's `tool_result` came back flagged as an error, `null` when no result
	 * was ever observed (the turn or the process ended first). Null is NOT "probably fine": a failed
	 * `gh pr merge` reported as a merge would put a merge to `main` in the audit trail that never
	 * happened, which corrodes the record exactly as badly as missing one.
	 */
	ok: boolean | null;
	/** ISO timestamp (runner wall-clock) of the moment the command was issued. */
	at: string;
}

/** Acts whose consequences reach outside the machine, or cannot be walked back locally. */
const IRREVERSIBLE: ReadonlySet<EngineActKind> = new Set<EngineActKind>([
	"pr.merge",
	"push.trunk",
	"push.force",
	"branch.delete",
	"reset.hard",
	"clean",
	"file.delete",
	"release.publish",
	"package.publish",
	"repo.delete",
	"deploy",
]);

/** Hard cap on the recorded command text. Long enough to read, short enough not to be a log dump. */
const MAX_COMMAND = 400;

/**
 * Strip anything that looks like a credential before the command is stored or shown.
 *
 * A command line is the single most common place a token is pasted in the open
 * (`GH_TOKEN=… git push`, `https://x-access-token:…@github.com/…`), and this record travels from
 * the user's machine into D1 and then into a supervisor's model prompt. Redacting at the point of
 * capture is the only place that covers all three.
 */
export function redactCommand(command: string): string {
	let s = String(command ?? "");
	// Credentials embedded in a clone/push URL.
	s = s.replace(/(https?:\/\/)[^/\s@]+@/g, "$1***@");
	// Known token shapes, whatever they are assigned to.
	s = s.replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, "$1***");
	s = s.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-***");
	s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "xox-***");
	// Anything ASSIGNED to a secret-shaped name, whatever the value looks like.
	s = s.replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|KEY|PAT))=(\S+)/gi, "$1=***");
	return s.trim().slice(0, MAX_COMMAND);
}

/**
 * Split a shell command into the pieces that each run something.
 *
 * Deliberately aggressive — `&&`, `||`, `;`, `|` and newlines all split, regardless of quoting.
 * Over-splitting costs nothing (a fragment simply matches no rule); under-splitting loses an act,
 * and the real-world shape of the case this exists for is exactly a compound line:
 * `cd repo && git push -u origin fix && gh pr create --fill && gh pr merge --squash`.
 */
export function splitSegments(command: string): string[] {
	return String(command ?? "")
		.split(/\|\||&&|[;|\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** A token that is exactly the trunk, not a branch merely containing the word (`feature/main-fix`). */
const TRUNK_TOKEN = /(?:^|\s)(?:HEAD:)?(?:refs\/heads\/)?(?:main|master)(?:\s|$)/;

function prRef(segment: string): string | null {
	// `gh pr merge 42 --squash`, `gh pr merge --squash 42`, or a full URL.
	const url = segment.match(/https?:\/\/\S*?\/pull\/(\d+)/);
	if (url) return `#${url[1]}`;
	const num = segment.match(/\bgh\s+pr\s+(?:merge|create)\b(?:\s+-{1,2}\S+(?:=\S+)?)*\s+(\d+)\b/);
	return num ? `#${num[1]}` : null;
}

function pushTarget(segment: string): string | null {
	// `git push [flags] <remote> <refspec>` — take the first two non-flag words after `push`.
	const after = segment.split(/\bgit\s+push\b/)[1] ?? "";
	const words = after.split(/\s+/).filter((w) => w && !w.startsWith("-"));
	return words.length ? words.slice(0, 2).join(" ") : null;
}

/** One classified act (without the identity/outcome the caller supplies). */
export interface ClassifiedAct {
	kind: EngineActKind;
	target: string | null;
	irreversible: boolean;
}

/**
 * Classify ONE shell segment. Returns null for ordinary work, which is nearly everything.
 *
 * The rules are matched in order of consequence, so `git push --force origin main` is recorded as
 * the force-push it is rather than as an ordinary push.
 */
export function classifySegment(segment: string): ClassifiedAct | null {
	const s = String(segment ?? "");
	const hit = (kind: EngineActKind, target: string | null = null): ClassifiedAct => ({
		kind,
		target,
		irreversible: IRREVERSIBLE.has(kind),
	});

	if (/\bgh\s+pr\s+merge\b/.test(s)) return hit("pr.merge", prRef(s));
	if (/\bgh\s+pr\s+create\b/.test(s)) return hit("pr.open", prRef(s));
	if (/\bgh\s+release\s+create\b/.test(s)) return hit("release.publish");
	if (/\bgh\s+repo\s+delete\b/.test(s)) return hit("repo.delete");

	if (/\bgit\s+push\b/.test(s)) {
		if (/(?:^|\s)(?:--force|--force-with-lease|-f)(?:=|\s|$)/.test(s)) return hit("push.force", pushTarget(s));
		// `git push origin --delete x` and the older `git push origin :x` both delete a REMOTE
		// branch — the one push that destroys rather than adds.
		if (/(?:^|\s)--delete(?:\s|$)/.test(s) || /\s:\S+/.test(s)) return hit("branch.delete", pushTarget(s));
		if (TRUNK_TOKEN.test(s.split(/\bgit\s+push\b/)[1] ?? "")) return hit("push.trunk", pushTarget(s));
		return hit("push", pushTarget(s));
	}
	// `-d` as well as `-D`: a supervisor asking "what did it delete" does not care that one of them
	// refused on unmerged commits.
	if (/\bgit\s+branch\s+(?:-\S*[dD]\b|--delete\b)/.test(s)) return hit("branch.delete");
	if (/\bgit\s+reset\s+(?:\S+\s+)*--hard\b/.test(s)) return hit("reset.hard");
	if (/\bgit\s+clean\b[^\n]*(?:^|\s)-\S*[fdx]/.test(s)) return hit("clean");

	// Only a RECURSIVE or FORCED rm. Plain `rm scratch.txt` is housekeeping, and recording it would
	// bury the acts that matter under noise — the record is only useful if it stays dense.
	if (/\brm\s+(?:\S+\s+)*-\S*[rf]/.test(s)) return hit("file.delete");

	if (/\b(?:npm|pnpm|yarn|bun)\s+publish\b/.test(s)) return hit("package.publish");
	if (/\bwrangler\s+(?:\S+\s+)*deploy\b/.test(s)) return hit("deploy");
	if (/\b(?:vercel|netlify)\s+(?:\S+\s+)*deploy\b/.test(s)) return hit("deploy");
	if (/\bvercel\b[^\n]*--prod\b/.test(s)) return hit("deploy");
	return null;
}

/**
 * Classify a whole command into zero or more acts.
 *
 * `id` is the engine's `tool_use` id; a compound command yielding two acts gets `id:0`/`id:1` so
 * each still has its own stable dedup key. Every act carries the FULL original command as evidence,
 * not just the segment that matched — a supervisor reading "force-pushed" needs to see what else
 * was on that line.
 */
export function classifyCommand(id: string, command: string, at: string = new Date().toISOString()): EngineActRecord[] {
	const full = redactCommand(command);
	if (!full) return [];
	const out: EngineActRecord[] = [];
	for (const seg of splitSegments(command)) {
		const c = classifySegment(seg);
		if (!c) continue;
		out.push({
			id: `${id}:${out.length}`,
			kind: c.kind,
			command: full,
			target: c.target,
			irreversible: c.irreversible,
			ok: null,
			at,
		});
	}
	return out;
}

/**
 * Pull the command string out of a `tool_use` block's input.
 *
 * Keyed on the INPUT SHAPE rather than the tool name: Claude Code calls it `Bash`, but a session
 * launched with a custom agent/tool set can present the same shell capability under another name,
 * and matching the name would silently record nothing for it. Anything handing a tool a `command`
 * string is running a command.
 */
export function commandFromToolInput(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	const cmd = (input as { command?: unknown }).command;
	return typeof cmd === "string" && cmd.trim() ? cmd : null;
}
