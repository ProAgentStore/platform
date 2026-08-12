/**
 * May an autonomous run START on this repo? (#548)
 *
 * The platform already knew the answer and never asked the question. `~/dev/aipa` holds one
 * subdirectory and no `.git`; #405's machinery had measured that and written it to the row —
 *
 *   clone_status = "needs_attention"
 *   clone_error  = "The configured checkout `/Users/serge-ivo/dev/aipa` has files but is not
 *                   inside a git working tree — it is a plain folder, not a clone of a repository."
 *
 * — twenty seconds after the run's last instruction, and fifteen minutes before that run gave up.
 * `codingDriver.start` checked three things (is there a repo, is a machine reachable, is somebody
 * else driving) and `cloneStatus` was not one of them. Three `git pull` runs were admitted onto
 * that folder, each burning ~15 minutes of BYOK reasoning against an engine exiting 1 every turn,
 * and the word "git" appeared nowhere in what the owner was eventually told ("stuck not resolved
 * in time").
 *
 * ── Only `needs_attention` blocks, and that is the whole rule
 *
 * `needs_attention` is #405's word for a DEFINITE verdict from a machine that looked at the path:
 * it is written only by `cloneStatusForVerdict`, which returns `null` — no write at all — for
 * `unverified`. So it cannot be produced by an offline laptop, a CLI too old for
 * `/coding/repo-check`, or a relay timeout. Every other status is admitted:
 *
 *   - `unknown`      nobody has looked. Refusing would stop every run on a machine that has never
 *                    been up while the console was open.
 *   - `ready`        looked at, and fine.
 *   - `cloning`      a managed clone that has not landed yet; `startSessionOnRunner` clones it.
 *   - `error`        a transport-or-launch failure, NOT a filesystem verdict (see #440 — this
 *                    status is deliberately no longer written for an unreachable runner, but rows
 *                    predating that fix still carry it, and a stale one must not become a wall).
 *   - `missing_url`  no source configured; the open path has its own, better message for it.
 *
 * ── Pure, and separate from `noSessionMessage`
 *
 * The refusal must NOT go through `noSessionMessage`: that wording is tuned for CONNECTIVITY, and
 * a Lead relaying it would tell its owner to run `pags up` for a problem `pags up` cannot fix —
 * the failure mode already fixed twice (#468, #530). This is a different fact and it gets its own
 * sentence, carrying #405's relayable `clone_error` verbatim plus the remedy that actually clears
 * it (fix the folder, then Re-check).
 */
import type { CodingRepo } from "./coding-types.js";

/** The subset of a repo row this decision is made from — so a test needs no `CodingRepo` fixture. */
export type AdmissibleRepo = Pick<CodingRepo, "name" | "cloneStatus"> & {
	workdir?: string;
	cloneError?: string;
};

export type RepoAdmission =
	| { ok: true }
	/** `message` is written to be relayed to the owner verbatim, by an agent or by a 409. */
	| { ok: false; message: string };

/**
 * The remedy, in one place.
 *
 * `POST /v1/instances/:id/coding/repos/:repoId/recheck` is the route behind the Re-check control,
 * and naming it is what keeps this refusal from being a dead end: the block is lifted by the same
 * probe that imposed it, so a repo fixed on the machine is one button from running again. The
 * regression this guards against is a STALE `needs_attention` becoming permanent (#440 is the
 * standing evidence that stale verdicts happen), and the answer to it has to be reachable from the
 * sentence that refuses.
 */
const REMEDY =
	"Fix that folder on the machine, or point this repo at the right path in the Coding tab (repo settings), then press Re-check on the repo — no run will start here until that check passes.";

export function admitRepoForRun(repo: AdmissibleRepo): RepoAdmission {
	if (repo.cloneStatus !== "needs_attention") return { ok: true };
	// #405 wrote `clone_error` explicitly so "an agent can say it to the owner"; it already names
	// the path. The fallback is only for a row whose detail was lost, and it still names the folder
	// rather than describing the repo abstractly — "what is wrong" is useless without "with what".
	const detail =
		(repo.cloneError || "").trim() ||
		`The configured checkout${repo.workdir ? ` \`${repo.workdir}\`` : ""} was checked on the machine and is not usable.`;
	return { ok: false, message: `Not starting on ${repo.name}: ${detail} ${REMEDY}` };
}
