/**
 * A run does not get to build on a base it could not confirm (#801).
 *
 * ── What #785 delivered, and where it stopped
 *
 * #785 made a stale checkout audible: `/coding/sync` fetches and counts, `repo-sync.ts` turns the
 * counts into a sentence, and the workflow puts that sentence in the timeline at the start and the
 * end of every run. The design is sound and the code implements it faithfully. What it does NOT do
 * is act on it — every verdict, including "I could not check at all", was logged and stepped over.
 *
 * Two occurrences say what that costs. A HeartFull run (#800) logged
 * `Runner /coding/sync → 404: {"error":"Not found"}` at both ends and worked anyway; it landed, by
 * luck. And this platform's own coder sat six commits behind `origin/main` — in a checkout whose
 * history CONTAINED the #785 fix — with nothing surfaced until a human ran `git status`.
 *
 * ── The root cause, which is not in the sync code
 *
 * `/coding/sync` is served at `packages/browser-runner/src/server.ts` and first shipped in CLI
 * {@link REPO_SYNC_MIN_CLI}. A runner below that release 404s it, exactly as `server.ts` says it
 * will. So the 404 is version skew, and the platform already knows how to say that: `repo-local.ts`
 * routes `/coding/search`'s 404 through `runner-upgrade.ts`, which names the machine, the version
 * it runs, the pin holding the agent there, and a capable machine if one exists.
 *
 * Sync never did. `readRepoSync` caught the 404, stringified it, and `verdictFromSync` rendered it
 * verbatim — so the one sentence the owner saw was an HTTP artefact. Nobody reading
 * `404: {"error":"Not found"}` could tell it meant "upgrade this machine's CLI", which is why two
 * occurrences were logged and neither was acted on. Ask 1 of #801 is that sentence; this module
 * supplies it from the machinery that already exists.
 *
 * ── Two halves, for the reason `repo-sync.ts` has two
 *
 * {@link syncGateDecision} is PURE — whether to block, why, and what the remedy is, asserted
 * without a runner, a database or an env. {@link gateRunOnSync} is the half that needs the world:
 * it names the machine and it RECORDS, and it is the only part a test has to mock.
 *
 * ── The self-heal (#802), and the one case it is allowed in
 *
 * The gate above traded #785's "make `git pull --ff-only` your first instruction" for "never start
 * on a stale base" — and the day it deployed, this platform's own coder was stopped twice in a row,
 * 19 commits behind, with a human told to go and type the pull on the machine. An objective saying
 * "pull first" cannot help: the gate runs before the objective is read.
 *
 * So the platform now does the ONE thing it refused a run for not doing. {@link syncSelfHealEligible}
 * is the pure test for the only case where that is safe — `behind`, AND the tree is clean, AND it
 * is on the branch the verdict is about. `diverged` is never healed (a merge or rebase is a decision
 * about somebody's commits, and #785's standing rule is that the human makes it); `unverified` is
 * never healed (there is nothing to heal TO). {@link attemptSyncSelfHeal} asks the machine, which
 * checks every precondition again at the hands (`repo-write.ts`), then CONFIRMS with an independent
 * re-read: the gate decides on what the checkout IS afterwards, never on the pull's own account of
 * itself. A heal that did not happen is reported inside the refusal, so the owner learns both that
 * it was tried and why it could not be.
 */
import { REPO_SYNC_MIN_CLI, readRepoSync, type RepoSyncVerdict } from "./repo-sync.js";
import { runnerUpgradeClause, runnerUpgradeRefusal } from "./runner-upgrade.js";
import { isRunnerUnreachable } from "./runner-unreachable.js";
import { callRunner, type RunnerConn } from "./runner-client.js";
import { logError } from "./error-log.js";
import type { RepoWorkingState } from "./repo-observation.js";
import type { CodingRepo } from "./coding-types.js";
import type { Env } from "../types.js";

/**
 * Why a run was stopped. `old_runner` is a PLATFORM fault and the others are facts about the
 * checkout — the distinction decides both the remedy sentence and the severity the block is filed
 * at, so it is a value rather than a boolean.
 */
export type SyncBlockReason = "old_runner" | "unverified" | "behind" | "diverged";

export interface SyncGateDecision {
	block: boolean;
	reason: SyncBlockReason | null;
	/** The fact, for the record and for the owner. Empty when nothing is wrong. */
	detail: string;
	/** What to DO about it. Empty when nothing is wrong. */
	remedy: string;
}

const PASS: SyncGateDecision = { block: false, reason: null, detail: "", remedy: "" };

/**
 * Is this failure an endpoint the runner does not serve, rather than a machine that did not answer?
 *
 * The same predicate `runnerTooOld` (connectors/repo-local.ts) matches on, against the same string
 * `runner-client.ts` builds: `Runner ${path} → ${status}: ${body}`. Deliberately duplicated rather
 * than shared — the two call sites answer for different endpoints with different minimum releases,
 * and a single "is the runner old" helper would invite a single minimum version, which is the thing
 * `REPO_SEARCH_MIN_CLI` and `REPO_SYNC_MIN_CLI` exist to keep apart.
 */
export function syncFailureIsOldRunner(error: string | null | undefined): boolean {
	return Boolean(error) && /→ 404|not found/i.test(String(error));
}

/**
 * Should this run proceed? Pure.
 *
 * `null` is a verdict too: the workflow reads the sync inside a `.catch(() => null)`, so a check
 * that threw arrives here as nothing at all. That is the strongest possible case for the gate, not
 * an excuse to skip it.
 *
 * Three states pass, and the third is the one worth defending:
 *
 *   `in_sync`     — confirmed current. The whole point.
 *   `ahead`       — unpushed local commits. A run's base is not stale because work sits on top of
 *                   it; #785 already says a reader is not even told about this.
 *   `no_upstream` — there is no remote to be behind. Blocking here would stop every local-only
 *                   checkout from ever running, to protect them from a staleness that cannot
 *                   exist. The verdict is still reported by `describeRepoSync`, as before.
 */
export function syncGateDecision(v: RepoSyncVerdict | null | undefined): SyncGateDecision {
	if (!v) {
		return {
			block: true,
			reason: "unverified",
			detail: "Whether this checkout is up to date could not be checked at all — the sync check itself failed.",
			remedy: "Check that the machine running this agent is connected, then start the run again.",
		};
	}
	if (v.state === "in_sync" || v.state === "ahead" || v.state === "no_upstream") return PASS;
	if (v.state === "behind" || v.state === "diverged") {
		return {
			block: true,
			reason: v.state,
			detail: v.detail,
			// `--ff-only` for `behind` because that is the case it is safe for, and NOT for a
			// divergence — a run that cannot fast-forward has local commits a merge would have to
			// reconcile, and #785's standing rule is that the human decides that, never the platform.
			remedy:
				v.state === "behind"
					? `Run \`git pull --ff-only\` in ${v.branch ? `\`${v.branch}\`` : "that checkout"} on the machine running this agent, then start the run again.`
					: "Reconcile the local commits with the remote on that machine (nothing here will merge or rebase for you), then start the run again.",
		};
	}
	// `unverified`. Which KIND decides the remedy, and only one of the two has an owner-actionable
	// fix that does not involve the machine being off.
	const old = syncFailureIsOldRunner(v.error);
	return {
		block: true,
		reason: old ? "old_runner" : "unverified",
		detail: v.detail,
		// Left empty for `old_runner`: the caller replaces it with `runner-upgrade.ts`'s sentence,
		// which names the machine. Inventing a machine-less remedy here would be the #524 defect
		// ("that machine", resolved by the owner to the wrong one) reintroduced one module over.
		remedy: old ? "" : "Check that the machine running this agent is connected and that its checkout is a git repository, then start the run again.",
	};
}

/**
 * Is the gate ARMED?
 *
 * Default on, which is what #801 asked for and is the opposite of this codebase's `PAYWALL_ENFORCE`
 * / `BUDGET_ENFORCE` soft-launch convention. Said plainly because the asymmetry is deliberate and
 * the blast radius is real: every runner below {@link REPO_SYNC_MIN_CLI} 404s this endpoint, so on
 * the day this deploys those machines stop running coding sessions rather than running them on an
 * unconfirmed base. That is the trade #801 chose after the alternative — log it and carry on — was
 * measured twice and worked neither time.
 *
 * `CODING_SYNC_GATE=off` is the way back, one variable, no redeploy of logic. The observation half
 * does NOT switch off with it: an operator still gets the `error_log` row, which is the only reason
 * a disarmed gate is worth keeping rather than reverting.
 */
export function syncGateArmed(env: { CODING_SYNC_GATE?: string }): boolean {
	const raw = String(env.CODING_SYNC_GATE ?? "").trim().toLowerCase();
	return !(raw === "off" || raw === "0" || raw === "false");
}

/** Where `logError` files these, and therefore what an operator filters `list_errors` on. */
export const SYNC_GATE_SOURCE = "coding:sync-gate";

export interface SyncGateOutcome {
	/** The run must not proceed. `decision.block` AND the gate is armed. */
	blocked: boolean;
	decision: SyncGateDecision;
	/** The whole sentence — fact, remedy, and the machine's name when one is known. Empty on a pass. */
	message: string;
}

export interface SyncGateCtx {
	instanceId: string;
	userId: string;
	sessionId: string;
	/** Which machine answered, for the record. The MESSAGE gets its name from `runner-upgrade.ts`. */
	node?: string | null;
	repo?: string | null;
	/** What the self-heal did first, when one was attempted (#802) — folded into the refusal. */
	heal?: SyncHealOutcome | null;
	/**
	 * This is a REPAIR run (#804): its whole objective is to bring the checkout back in sync, so the
	 * gate records its verdict and lets it start — blocking the one run that exists to fix the
	 * block would be the dead end #804 was filed about.
	 */
	repair?: boolean;
}

/**
 * The impure half: name the machine, write the operator's record, and decide.
 *
 * ── Ask 3 of #801, and why it is a table rather than a log prefix
 *
 * The issue asks for "a distinct tag/prefix like `[SYNC-404]` so it can be grepped". A `console`
 * line in a Worker reaches `wrangler tail` and nowhere else — nobody is tailing at 03:13 UTC, which
 * is when #800 happened, and that is precisely why it took a human reading a raw run log to find
 * it. This platform already has the durable answer: `error_log`, read by `GET /v1/errors` and by
 * the `list_errors` MCP tool, with {@link SYNC_GATE_SOURCE} as the filter. `logError` collapses
 * repeats within its window onto one row carrying `repeat_count` and `last_seen_at`, so "this
 * machine has 404ed forty times since Tuesday" is one row an operator can actually see — which is
 * the ask, better served.
 *
 * Written whether or not the gate is ARMED. A disarmed gate that also stopped observing would put
 * us back exactly where #785 left us.
 *
 * ── Severity
 *
 * `old_runner` is `error`: an endpoint that does not exist on a machine we are shipping against is
 * a platform fault, and it is the one an operator must chase. Everything else is `warn`, which
 * `error-log.ts` defines as "recorded without being counted as a bug" — a checkout that is behind
 * is a true fact about someone's laptop, not a defect in the platform, even though it now stops a
 * run. Filing those as `error` would drown the 404s in the very query meant to surface them.
 *
 * Never throws. A gate that 500s on its own bookkeeping would fail runs for a reason that has
 * nothing to do with their base.
 */
export async function gateRunOnSync(env: Env, ctx: SyncGateCtx, v: RepoSyncVerdict | null | undefined): Promise<SyncGateOutcome> {
	const decision = syncGateDecision(v);
	if (!decision.block) return { blocked: false, decision, message: "" };
	// A repair run is let through ON PURPOSE, and says so (#804). Not filed to `error_log`: the
	// block it would have been is the very thing the owner just asked the agent to fix, and a row
	// for it would count the remedy as another occurrence of the fault.
	if (ctx.repair) {
		return {
			blocked: false,
			decision,
			message: `The base could not be confirmed (${decision.detail}) — this is a REPAIR run, so it is starting in order to fix exactly that, and nothing else.`,
		};
	}
	// The machine's name, from the module that already knows how to find it (#524). Only for the
	// version skew — for a checkout that is merely behind, the remedy is a git command and naming
	// the node adds nothing a `git pull` instruction does not already imply.
	const remedy =
		decision.reason === "old_runner"
			? await runnerUpgradeRefusal(env, ctx.instanceId, ctx.userId, {
					what: "check whether this checkout is up to date",
					minCli: REPO_SYNC_MIN_CLI,
				}).catch(() => `This machine's runner is too old to check whether this checkout is up to date — it needs CLI ${REPO_SYNC_MIN_CLI} or newer.`)
			: decision.remedy;
	const armed = syncGateArmed(env);
	// The heal's own sentence comes BEFORE the remedy: "we tried the pull and it was refused because
	// the tree is dirty" is the fact that makes "run `git pull --ff-only`" the wrong instruction —
	// the owner has to commit or move the diff first, and the sentence says so.
	const healed = ctx.heal && ctx.heal.status !== "healed" && ctx.heal.status !== "noop" ? describeSyncHeal(ctx.heal) : "";
	// The way out that needs no hands on the machine (#804). Only where a repair run can do
	// anything: a checkout that is behind or diverged. An old runner needs an upgrade and an
	// unreachable one needs to come back — a run cannot fix either.
	const repairHint = armed && (decision.reason === "behind" || decision.reason === "diverged") ? REPAIR_RUN_HINT : "";
	const message = [
		armed
			? "This run was stopped before it started because the base it would build on could not be confirmed (#801)."
			: "The base this run builds on could not be confirmed (#801); the sync gate is disarmed, so it is proceeding anyway.",
		decision.detail,
		healed,
		remedy,
		repairHint,
	]
		.filter(Boolean)
		.join(" ");
	await logError(env, {
		source: SYNC_GATE_SOURCE,
		level: decision.reason === "old_runner" || decision.reason === "unverified" ? "error" : "warn",
		// `status` participates in `collapseRepeat`'s key, so the 404 class buckets separately from
		// a checkout that is behind even when the message happens to match.
		status: decision.reason === "old_runner" ? 404 : undefined,
		userId: ctx.userId,
		message: `${decision.reason}: ${decision.detail || "sync could not be checked"}`,
		context: {
			instanceId: ctx.instanceId,
			sessionId: ctx.sessionId,
			node: ctx.node ?? null,
			repo: ctx.repo ?? null,
			reason: decision.reason,
			state: v?.state ?? null,
			minCli: REPO_SYNC_MIN_CLI,
			armed,
			// Verbatim, so an operator can tell a 404 from a timeout without re-deriving the class.
			error: v?.error ?? null,
			// Whether the platform tried to fix it first, and how that went (#802).
			heal: ctx.heal ? { status: ctx.heal.status, detail: ctx.heal.detail } : null,
		},
	}).catch(() => undefined);
	return { blocked: armed, decision, message };
}

// ─── The self-heal (#802) ────────────────────────────────────────────────────────────────────────

/** The CLI release whose `/coding/git-write` serves the `fast-forward` verb. Named in the refusal. */
export const FAST_FORWARD_MIN_CLI = "0.4.59";

/** Above the runner's own 30s pull cap, so a slow fetch is reported rather than cut off mid-answer. */
export const SYNC_HEAL_TIMEOUT_MS = 35_000;

export type SyncHealStatus =
	/** The pull ran AND an independent re-read says the checkout is now current. */
	| "healed"
	/** The machine found nothing to bring in — a race with someone's own pull. Re-read is authoritative. */
	| "noop"
	/** The runner has no `fast-forward` verb (a CLI below {@link FAST_FORWARD_MIN_CLI}). */
	| "unsupported"
	/** The machine declined a precondition it checks for itself — dirty tree, off-branch, no upstream. Nothing touched. */
	| "refused"
	/** git itself said no — a divergence `--ff-only` caught, a network or auth failure. Nothing touched. */
	| "failed"
	/** The cloud asked and could not corroborate — socket gone, or the re-read disagrees. */
	| "unconfirmed"
	/** Not attempted: `behind`, but the tree is dirty or off its branch. `detail` says which, so the refusal can. */
	| "skipped";

export interface SyncHealOutcome {
	status: SyncHealStatus;
	/** One clause in the owner's language. Empty for `healed`/`noop`. */
	detail: string;
	/** The branch that was fast-forwarded. */
	branch: string;
	/** Short SHAs, for the sentence and for the undo. Null when the machine did not say. */
	from: string | null;
	to: string | null;
	/** Commits brought in. Null when unknown. */
	commits: number | null;
	/** The INDEPENDENT re-read after the attempt — the verdict the gate must now decide on. Null when it failed. */
	sync: RepoSyncVerdict | null;
}

export interface SyncHealEligibility {
	eligible: boolean;
	/** The branch the heal would act on: the configured one, else the one the verdict is about. */
	branch: string | null;
	/** Why NOT, in the owner's language, so a refusal can say the heal was not even tried and why. Empty when eligible. */
	why: string;
}

/**
 * Is this the one case a fast-forward is safe with nobody in the room? Pure.
 *
 * Every clause is a precondition the RUNNER re-checks at the hands (`repo-write.ts`), so this is
 * not the safety — it is the decision not to ask when the answer is already known to be no, and
 * the sentence that explains it.
 */
export function syncSelfHealEligible(
	v: RepoSyncVerdict | null | undefined,
	state: RepoWorkingState | null | undefined,
	configuredBranch: string | null | undefined,
): SyncHealEligibility {
	const branch = (configuredBranch || "").trim() || v?.branch || null;
	if (v?.state !== "behind") return { eligible: false, branch, why: "" };
	if (!state) return { eligible: false, branch, why: "the working tree's state could not be read, so it was not fast-forwarded unattended" };
	if (state.notAGitRepo) return { eligible: false, branch, why: "the path is not a git working tree" };
	// A DIRTY tree is deliberately not a reason to skip (#804). It was, and the first checkout it
	// met was 18 commits behind with one untracked `.claude/` folder — refused, with a human sent to
	// delete it by hand. A fast-forward carries nothing across; git itself refuses, naming the
	// file, when an incoming commit would overwrite a local change. So the machine is asked, and
	// git's answer — not a count of porcelain lines — decides. The runner reports `dirty` back so
	// the owner is still told what was there.
	if (!state.branch) return { eligible: false, branch, why: "the checkout's branch could not be read, so it was not fast-forwarded unattended" };
	if (!branch) return { eligible: false, branch, why: "no branch is configured for this repo and the verdict named none" };
	if (state.branch !== branch) {
		return { eligible: false, branch, why: `it was not fast-forwarded because the checkout is on \`${state.branch}\`, not \`${branch}\`` };
	}
	return { eligible: true, branch, why: "" };
}

/** The outcome a run records when the heal was NOT tried, so the refusal can say why. Null when there was nothing to say. */
export function skippedSyncHeal(e: SyncHealEligibility): SyncHealOutcome | null {
	if (e.eligible || !e.why) return null;
	return { status: "skipped", detail: e.why, branch: e.branch ?? "", from: null, to: null, commits: null, sync: null };
}

/**
 * The runner's reply, redeclared because `workers/api` does not depend on the runner package.
 * Structurally `FastForwardResult` in `packages/browser-runner/src/coding/repo-write.ts`; every
 * field optional, because a runner of a different vintage is exactly the case this must survive.
 */
interface FastForwardWire {
	ok?: boolean;
	changed?: boolean;
	branch?: string | null;
	upstream?: string | null;
	from?: string | null;
	to?: string | null;
	commits?: number | null;
	dirty?: boolean | null;
	refused?: string;
	error?: string;
}

const HEAL_REFUSAL_TEXT: Record<string, string> = {
	dirty: "the working tree has uncommitted changes — commit or move that work first",
	"off-branch": "the checkout is not on the branch the verdict was about",
	detached: "the checkout is on a detached HEAD, not a branch",
	"no-upstream": "the branch has no upstream to pull from",
	"not-a-repo": "the path is not a git checkout",
	"unknown-head": "git could not say which commit the checkout is on",
};

const short = (sha: unknown): string | null => (typeof sha === "string" && sha ? sha.slice(0, 8) : null);

/**
 * Ask the machine to fast-forward, then CONFIRM with the same read-only sync call the gate uses.
 *
 * Never throws. Every failure is a status with a sentence, because the caller is about to fold it
 * into a refusal the owner reads — and a heal that crashed the run it was trying to rescue would
 * be strictly worse than the block it replaced.
 */
export async function attemptSyncSelfHeal(
	conn: RunnerConn,
	input: { repo: CodingRepo; sessionId: string | null; branch: string },
): Promise<SyncHealOutcome> {
	const { repo, sessionId, branch } = input;
	const base = { branch, from: null as string | null, to: null as string | null, commits: null as number | null, sync: null as RepoSyncVerdict | null };
	let wire: FastForwardWire;
	try {
		wire = await callRunner<FastForwardWire>(
			conn,
			"/coding/git-write",
			{ sessionId: sessionId || undefined, workDir: repo.workdir || undefined, cmd: "fast-forward", branch },
			{ timeoutMs: SYNC_HEAL_TIMEOUT_MS },
		);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		// A 0.4.58 runner HAS the endpoint and 400s the verb it does not know; a pre-0.4.48 one
		// 404s the endpoint. Both are "upgrade this machine", and both name the same floor.
		if (/→ 404|not found|unsupported git write command/i.test(message)) {
			return { ...base, status: "unsupported", detail: runnerUpgradeClause({ what: "fast-forward this checkout itself", minCli: FAST_FORWARD_MIN_CLI, node: conn.runnerNode }) };
		}
		if (isRunnerUnreachable(e)) return { ...base, status: "unconfirmed", detail: "the machine went away before it answered the fast-forward" };
		return { ...base, status: "failed", detail: `the fast-forward failed: ${message.slice(0, 160)}` };
	}
	const from = short(wire.from);
	const to = short(wire.to);
	const commits = typeof wire.commits === "number" && Number.isFinite(wire.commits) ? wire.commits : null;
	if (wire.refused) {
		return { ...base, from, to: from, status: "refused", detail: `the fast-forward was refused: ${HEAL_REFUSAL_TEXT[wire.refused] ?? `the machine declined (${String(wire.refused).slice(0, 40)})`}` };
	}
	if (wire.error) return { ...base, from, to: from, status: "failed", detail: `the fast-forward failed: ${wire.error.slice(0, 160)}` };

	// The independent read. `forceFetch: false` — the pull just fetched, and the counts are
	// recomputed on every call regardless; what this confirms is where HEAD is now.
	const sync = await readRepoSync(conn, { workDir: repo.workdir, sessionId, branch }).catch(() => null);
	if (sync && (sync.state === "in_sync" || sync.state === "ahead")) {
		return { ...base, from, to, commits, sync, status: wire.changed === false ? "noop" : "healed", detail: "" };
	}
	return {
		...base,
		from,
		to,
		commits,
		sync,
		status: "unconfirmed",
		detail: sync ? `the fast-forward ran, but the checkout still reads: ${sync.detail || sync.state}` : "the fast-forward ran, but the checkout could not be read back",
	};
}

/**
 * One sentence for the timeline and the chat. Pure.
 *
 * For a heal that happened it states what arrived AND the undo — a pointer moved on somebody's
 * checkout unattended, and the record has to let them put it back. For one that did not, it is
 * the clause the refusal carries.
 */
export function describeSyncHeal(h: SyncHealOutcome): string {
	if (h.status === "healed") {
		const n = h.commits !== null ? `${h.commits} commit${h.commits === 1 ? "" : "s"}` : "the missing commits";
		const shas = h.from && h.to ? ` (${h.from} → ${h.to})` : "";
		const undo = h.from ? ` Undo: \`git reset --keep ${h.from}\`.` : "";
		return `Fast-forwarded \`${h.branch}\` by ${n}${shas} before starting, because the checkout was behind and the tree was clean.${undo}`;
	}
	if (h.status === "noop") return `\`${h.branch}\` was already current when the fast-forward ran; nothing was brought in.`;
	if (h.status === "skipped") return `A fast-forward was not attempted: ${h.detail}.`;
	return `A fast-forward was attempted first and did not happen: ${h.detail}.`;
}

// ─── The repair run (#804) ───────────────────────────────────────────────────────────────────────

/**
 * The objective an owner sees on the run record when they start a repair run without words of
 * their own. The Pilot gets {@link repairCheckoutObjective}, not this — this is the label.
 */
export const REPAIR_RUN_OBJECTIVE = "Repair the checkout: bring it onto its branch and in sync with upstream, without discarding any work.";

/** The sentence every block ends with, so a remote owner is never at a dead end. */
export const REPAIR_RUN_HINT =
	"Or let the agent fix it: start a REPAIR run — `coding_loop_start` with `repair_checkout: true` (API: `POST …/loop` with `repairCheckout: true`). A repair run may only bring the checkout back in sync; it does no other work.";

export interface RepairBriefInput {
	repoLabel: string;
	/** The branch the checkout is supposed to be on — configured, else the verdict's. */
	branch: string | null;
	sync: RepoSyncVerdict | null;
	state: RepoWorkingState | null;
	heal: SyncHealOutcome | null;
	/** What the owner typed when starting the run, if anything — carried, never a licence to do more. */
	ownerNote?: string | null;
}

/**
 * The objective a REPAIR run is given. Pure.
 *
 * ── Why the platform writes it
 *
 * #804's ask 2 is to separate "may this run do ticket work" from "may this run bring the checkout
 * up to date". A flag on its own would only let an owner's free text through the gate — and the
 * gate exists because free text has no guarantee in it. So the flag REPLACES the objective with
 * this brief: the facts the platform just read, the one goal, and the rules. The owner's own words
 * ride along as a note and cannot widen the goal.
 *
 * ── The standing rule, kept
 *
 * #785 says a divergence or a dirty tree is the human's decision, never the platform's. This does
 * not change that. The human makes the decision by starting the run; what the run may then do is
 * bounded the same way `repo-write.ts` is: nothing is discarded. Work that blocks the sync is
 * PARKED on a `wip/` branch the report names, so every commit and every uncommitted change that
 * existed when the run began still exists, somewhere it can be found, when it ends. That is the
 * invariant the Pilot is told to hold, in those words, above every other instruction.
 */
export function repairCheckoutObjective(i: RepairBriefInput): string {
	const branch = i.branch || i.state?.branch || i.sync?.branch || "its configured branch";
	const upstream = i.sync?.upstream || `origin/${branch}`;
	const found: string[] = [];
	if (i.sync?.detail) found.push(i.sync.detail);
	else if (i.sync?.state === "in_sync") found.push(`The checkout reads in sync with ${upstream}.`);
	if (i.state?.notAGitRepo) found.push("The path is not a git working tree.");
	else if (i.state) {
		if (i.state.branch && i.branch && i.state.branch !== i.branch) found.push(`It is on branch \`${i.state.branch}\`, not \`${i.branch}\`.`);
		if (i.state.dirty) found.push(`The working tree has ${i.state.changedFiles} uncommitted file${i.state.changedFiles === 1 ? "" : "s"} (tracked edits and/or untracked paths).`);
	}
	if (i.heal && i.heal.status !== "healed" && i.heal.status !== "noop") found.push(describeSyncHeal(i.heal));
	const lines = [
		`REPAIR THE CHECKOUT. This is a repair run: the ONLY thing you may do is bring the checkout of "${i.repoLabel}" back to a confirmed-current state. No feature or ticket work, no edits to project files, no pushes.`,
		"",
		`GOAL: the checkout is on branch \`${branch}\`, \`git status -sb\` reports \`${branch}...${upstream}\` with no [ahead N] and no [behind N], and the working tree is clean.`,
		"",
		`WHAT THE PLATFORM FOUND JUST NOW: ${found.length ? found.join(" ") : "the checkout could not be read."}`,
		"",
		"THE ONE INVARIANT: every commit and every uncommitted change that exists now must still exist somewhere — a branch or a commit — when you finish. You may MOVE work; you may never delete it.",
		"- Forbidden, no exceptions: `git reset --hard`, `git checkout -- <path>`, `git checkout .`, `git restore`, `git clean`, `git stash drop`, `git branch -D`, any `--force`, and any `git push`.",
		`- Uncommitted edits or untracked paths in the way (tooling folders such as \`.claude/\` count): park them — \`git checkout -b wip/<YYYY-MM-DD>-<short-reason>\`, \`git add -A\`, \`git commit -m "wip: parked by repair run"\`, then \`git checkout ${branch}\`. Never delete them.`,
		`- Local commits on \`${branch}\` that are not on \`${upstream}\` (ahead or diverged): save them first with \`git branch wip/<YYYY-MM-DD>-<short-reason>\`, then move the branch with \`git reset --keep ${upstream}\`. Never merge or rebase them on your own initiative.`,
		`- If the checkout is on another branch, leave that branch as it is and \`git checkout ${branch}\` (park uncommitted work first, as above).`,
		`- Then \`git fetch\` and \`git pull --ff-only\`.`,
		"",
		`FINISH: call finish(status:'done') ONLY when \`git status -sb\` shows \`${branch}...${upstream}\` with neither [ahead] nor [behind] and no changed files. In the report name every \`wip/\` branch you created and what it holds, so the owner can recover it. If something cannot be resolved without deleting work or deciding about a conflict, stop there and call finish(status:'failed') saying exactly what and why — do not guess.`,
	];
	const note = (i.ownerNote || "").trim();
	if (note && note !== REPAIR_RUN_OBJECTIVE) lines.push("", `OWNER'S NOTE (context only — it does not widen what this run may do): ${note}`);
	return lines.join("\n");
}
