/**
 * The "## Attached Repositories" block of the chat prompt (#416).
 *
 * #405 wrote a real diagnosis for a checkout the machine found unusable — one sentence, phrased
 * deliberately "to be RELAYED: an agent can say it to the owner verbatim and it is both true and
 * actionable" (`lib/coding-workdir.ts`). It is persisted next to the status, in the same
 * `updateRepoClone` call, on the same row.
 *
 * The chat prompt then dropped it. The builder was a ternary chain that predated the statuses
 * #405 introduced, read `cloneError` on exactly one branch (`error`), and let everything it did
 * not enumerate fall through as the raw enum token. So the model was told
 *
 *     - apps/chess-academy — needs_attention
 *
 * while the platform held, one field away, "The configured checkout `…` exists but is EMPTY —
 * nothing was ever cloned into it … There is no code at that path to read." A bare enum token is
 * not something an agent can say out loud, and relaying the sentence was the point of the ticket.
 *
 * Two things live here, and the second is the actual deliverable:
 *
 *   1. the fix — render `cloneError` for every non-`ready` status, not just `error`;
 *   2. the defence — a phrase TABLE typed `satisfies Record<CloneStatus, string>`, so adding a
 *      `CloneStatus` value without writing a sentence for it is a COMPILE error rather than a
 *      token quietly leaking into a prompt again. A ternary chain cannot be made exhaustive; a
 *      table is exhaustive by construction.
 *
 * Pure, so both can be pinned without a DO, a runner or a database.
 */
import type { CloneStatus } from "./coding-types.js";

/**
 * What each `clone_status` MEANS, in words a model can relay.
 *
 * Every phrase is a clause an agent can say to the owner as-is. `needs_attention` and `unknown`
 * are the two states #405 created and the two the old chain leaked verbatim: "needs_attention" is
 * an internal token, and "unknown" read as vague when it in fact says something precise and
 * important — nobody has looked, so the absence of a complaint is not evidence the code is there.
 *
 * `satisfies` rather than a type annotation: the object keeps its literal type (so a lookup is
 * still `string`), while a missing key fails typecheck. That is the entire guard this file exists
 * for — do not replace it with `Record<CloneStatus, string>` as the declared type, and do not
 * widen the key type to `string`.
 */
export const CLONE_STATUS_PHRASE = {
	ready: "ready",
	cloning: "cloning…",
	missing_url: "NOT CLONED — no clone URL is configured, so nothing was ever fetched and there is no code to read",
	error: "clone FAILED",
	needs_attention: "UNUSABLE",
	unknown: "not checked (no machine connected) — nobody has looked at this path, so its state is genuinely unknown; do not assume the code is there",
} satisfies Record<CloneStatus, string>;

/**
 * `clone_status` is a TEXT column, so a row can hold a value this build has never heard of — an
 * older/newer API writing the same table, or a hand-edited row. The table makes the *code* path
 * exhaustive; this keeps the *data* path honest, by saying "unrecognised" instead of printing the
 * raw token as though it were English.
 */
const UNRECOGNISED_PHRASE = "state unrecognised by this build — treat it as unchecked and do not assume the code is there";

/** A repository as this block needs it — deliberately narrower than `CodingRepo`. */
export interface RepoStatusInput {
	name: string;
	githubRepo?: string | null;
	cloneStatus: string;
	cloneError?: string | null;
}

/**
 * How many broken repos get their full diagnosis before the rest are summarised.
 *
 * The regression risk #416 raises: each sentence is ~120-200 characters and there is one per
 * broken repo, unbounded by anything but how many repos are attached. A cross-repo Lead can hold
 * a dozen. Six full diagnoses is ~1.2KB — a rounding error next to the retrieved-context block —
 * and past six the marginal sentence stops informing the answer and starts crowding it. The
 * remainder is not hidden: it is counted and named, so the agent can still say "four more are
 * unusable" truthfully.
 */
export const MAX_DIAGNOSED = 6;

/**
 * Hard cap on one diagnosis. `verdictFromCheck` can embed a runner-supplied `error` string of
 * unbounded length into `detail`, which is the one input here that no code path limits.
 */
export const MAX_DETAIL_CHARS = 240;

function truncate(s: string, max: number): string {
	const t = s.trim().replace(/\s+/g, " ");
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * The phrase for one status, without its per-repo detail.
 *
 * Exported for the console/tests to share one vocabulary — the failure #405 designed against is
 * two surfaces describing one directory two different ways.
 */
export function cloneStatusPhrase(status: string): string {
	return CLONE_STATUS_PHRASE[status as CloneStatus] ?? UNRECOGNISED_PHRASE;
}

/** One line of the block: the repo, what state it is in, and — when there is one — why. */
export function repoStatusLine(repo: RepoStatusInput, opts: { withDetail?: boolean } = {}): string {
	const phrase = cloneStatusPhrase(repo.cloneStatus);
	// `ready` never carries a detail: `updateRepoClone` clears `clone_error` on every write, so a
	// leftover string on a healthy repo would be stale by construction. Every OTHER status may —
	// this is the one-line fix, previously spelt `r.cloneStatus === "error" ? …`.
	const detail = repo.cloneStatus === "ready" || opts.withDetail === false ? "" : (repo.cloneError ?? "").trim();
	const label = `${repo.name}${repo.githubRepo ? ` (${repo.githubRepo})` : ""}`;
	return `- ${label} — ${phrase}${detail ? ` — ${truncate(detail, MAX_DETAIL_CHARS)}` : ""}`;
}

/**
 * How fresh this block is — stated, because it is a real limit on what the agent may claim.
 *
 * DECISION (#416), not an accident: this is the LAST PERSISTED verdict, read by `listRepos` as a
 * plain SELECT. It is refreshed when the console's repos route or add-repo last ran
 * `verifyLocalWorkdir` — i.e. by the surface the owner is looking at — and NOT by this chat turn.
 * Running the check here was considered and rejected: it is a relay round-trip on the latency path
 * of every message, for a fact that changes rarely and that the repos list already re-checks on
 * every read.
 *
 * The cost of that decision is that the agent cannot tell "it is broken" from "it was broken when
 * someone last looked", so the block says which one it is holding. There is deliberately no
 * timestamp: `updated_at` is bumped by any edit to the row (rename, launch URLs, merge policy),
 * so rendering it as "checked 3 minutes ago" would be a precise-looking claim the platform cannot
 * actually support — and inventing confidence about a path nobody looked at is the whole of #405.
 * A real `clone_checked_at` column would fix that; it needs a migration and a write in the repos
 * route, and is not this ticket.
 */
const FRESHNESS_NOTE =
	"Each status below is the LAST RECORDED verdict for that path, not a live check made for this message." +
	" Report it as such, and if it matters right now say the owner can re-check by opening the repository list.";

/**
 * The whole block, header included. Returns "" for no repos so the caller stays a single `+=`.
 */
export function attachedReposPrompt(repos: readonly RepoStatusInput[]): string {
	if (repos.length === 0) return "";
	// Broken repos are diagnosed first, so the cap can never spend its budget on healthy rows and
	// then truncate the one repo the user is asking about.
	const broken = repos.filter((r) => r.cloneStatus !== "ready" && (r.cloneError ?? "").trim().length > 0);
	const diagnosed = new Set(broken.slice(0, MAX_DIAGNOSED));
	const lines = repos.map((r) => repoStatusLine(r, { withDetail: diagnosed.has(r) }));
	const omitted = broken.slice(MAX_DIAGNOSED);
	const tail = omitted.length
		? `${omitted.length} further ${omitted.length === 1 ? "repository is" : "repositories are"} in a bad state and their diagnoses are omitted here (${omitted
				.map((r) => r.name)
				.join(", ")}). Say so rather than implying they are fine.\n`
		: "";
	return `\n\n## Attached Repositories\n${FRESHNESS_NOTE}\n${lines.join("\n")}\n${tail}`;
}
