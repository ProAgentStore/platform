import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { RunnerInputError } from "../errors.js";
import { defaultStatePath, HeadlessSession } from "./headless.js";
import type { EngineTurnReport } from "./engine-turn.js";
import type { EngineActRecord } from "./engine-acts.js";
import type { EngineUsageRecord } from "./engine-usage.js";
import type { ClientType } from "./handlers.js";
import type { EngineAuthResolved } from "./engine-auth.js";
import { type GitCmd, InspectError, readGitRemoteOrigin, readRepoFile, type RepoSearchMode, repoSearch, repoTree, runRepoGit } from "./inspect.js";
import { type GitWriteCmd, switchRepoBranch } from "./repo-write.js";
import { checkWorkdir, ensureRepo, sanitizeSessionName } from "./repo.js";
import { asTurnAuthor, type TurnAuthor } from "./turn-author.js";
import type { GhGuardReport } from "./gh-guard.js";

/**
 * The coding runtime: the local "hands" that hold live coding-engine sessions — CLI child
 * processes ({@link HeadlessSession}), NOT tmux panes — the counterpart of the browser
 * runtime's Playwright page management (#247).
 *
 * The remote brain (CodingSessionWorkflow) drives sessions through the
 * `/coding/*` HTTP surface: start a session, `capture` what the CLI shows, `act`
 * (send a message), and `end`. A human can attach via the takeover helpers for the
 * "stuck" handoff. Keystrokes are NOT part of that surface — see `act` (#448).
 *
 * Kept separate from `LocalRunner` (Playwright) so the two runtimes share the
 * runner harness — registration, tunnel, auth — without entangling their guts.
 */

export interface StartCodingInput {
	sessionId: string;
	repoId: string;
	clientType: ClientType;
	/** Explicit working dir (tests / already-cloned). When omitted, derived under the repos base dir. */
	workDir?: string;
	/** Clone source — fetched on first start if the working dir is absent. */
	cloneUrl?: string;
	branch?: string;
	/** Clone credential for a private repo (GitHub App installation token, GitLab PAT, …). */
	token?: string;
	/** Username half of that credential — provider-specific (#221). Default `x-access-token`. */
	tokenUsername?: string;
	env?: Record<string, string>;
	/** Override the agent binary (tests / a custom `claude` path). */
	bin?: string;
	/** The exact CLI launch command for this session's engine (e.g. `claude --dangerously-skip-permissions`, `codex`). */
	command?: string;
	/**
	 * A previous coding-session id whose engine conversation this one should continue (#408).
	 * Optional and additive: a runner published before #408 ignores it and starts clean, which is
	 * exactly what every re-open did before this existed.
	 */
	resumeFrom?: string;
	/**
	 * Repositories a `gh` WRITE from this session may name (#679).
	 *
	 * Comes from the CLOUD, never from the checkout: the Engine has a shell in that checkout and
	 * could rewrite `git remote origin`, so a scope derived locally would be a scope the Engine can
	 * widen itself. Absent (an older cloud) means the guard is not installed — "not said" is not
	 * "allow nothing", and refusing every write on an absent field would break those sessions.
	 */
	ghScope?: string[];
}

/**
 * What `/coding/start` answers: the first snapshot, plus the one fact only this side knows —
 * whether the engine actually launched with a conversation to continue (#408).
 *
 * On the snapshot rather than beside it because every other "the machine decided this, not the
 * cloud" field (`authResolved`, `engineRuntime`) rides there too, and because the cloud reads the
 * start response and the capture response through the same shape.
 */
export interface StartCodingResult extends CodingSnapshot {
	resumed: boolean;
}

export type CodingAction =
	/**
	 * `author` is who WROTE this turn (#505). `/coding/act` is a shared door — the console's
	 * manual `/message`, MCP, the Overseer's delegation and the Pilot all arrive through it — and
	 * the Engine sees every one of them as `role: "user"`. Optional because a caller that does not
	 * declare an author has said nothing, and `turn-author.ts` renders that as nothing.
	 */
	| { kind: "message"; text: string; author?: TurnAuthor }
	/**
	 * Still in the union, and refused by `act` (#448). The cloud no longer constructs it — the
	 * kind is gone from `CodingActionKind` there — but this runner is a published npm package
	 * that any caller can POST to, so the shape has to be RECOGNISED in order to be refused.
	 * Dropping it from the union would make an old client's keystroke fall into `default` as an
	 * "Unknown coding action", which is a worse sentence for the one thing it definitely is.
	 */
	| { kind: "keys"; keys: string }
	| { kind: "interrupt" };

export interface CodingSnapshot {
	sessionId: string;
	pane: string;
	ready: boolean;
	runState: "idle" | "thinking" | "responding";
	alive: boolean;
	/**
	 * What credential the engine actually got, and what the engine actually is (#248). Rides on
	 * the snapshot because this is the ONLY side that can know the first one — the cloud picks a
	 * mode, the machine's own shell decides the outcome. Enum only, never a key or token.
	 */
	authResolved: EngineAuthResolved;
	engineRuntime: "child-process";
	/**
	 * How the last COMPLETED turn ended (#545) — the outcome the pane used to hold only as prose.
	 *
	 * Rides beside `alive`/`runState` rather than changing either: this session can still take a
	 * turn (`alive`) and is not taking one right now (`runState: "idle"`) even when the last turn
	 * exited 1. Both of those were true and correct in the production capture that filed this
	 * issue; what was missing is this field, so nothing in the platform could see three consecutive
	 * exit-1s that were printed in the pane each time.
	 *
	 * Absent = not measured (no turn has finished, or the runner predates the field). Never "fine".
	 */
	lastTurn?: EngineTurnReport;
	/**
	 * Measured engine spend since the last drain (#267) — present ONLY when the caller asked to
	 * drain, so the many read-only capture callers (chat context, sign-in detection, repo status)
	 * cannot consume records the ledgering caller needs. Absent for a raw engine, which reports
	 * nothing measurable; absent is the honest answer there, a zero would not be.
	 */
	usage?: EngineUsageRecord[];
	/**
	 * Consequential acts observed since the last drain (#294) — a PR opened or merged, a push, a
	 * force-push, a delete, a deploy. Present under the SAME `drainUsage` opt-in as spend: the two
	 * cloud callers that pass it are exactly the two that persist what a run did, and letting a
	 * read-only capture drain either one would silently discard records the recorder needed.
	 *
	 * Absent for a raw engine — nothing parses its stdout, so an empty list means "not observed",
	 * never "nothing happened".
	 */
	acts?: EngineActRecord[];
}

/** Hard cap on a pane returned to the brain/console (matches the worker MAX_PANE_CHARS). */
const MAX_PANE = 64 * 1024;

export class CodingRuntime {
	private sessions = new Map<string, HeadlessSession>();
	/**
	 * Active human handoffs keyed by session id. `resolved` flips when the human
	 * finishes (console "Resume" / submits a value); the brain workflow polls
	 * {@link takeoverStatus} and continues once it does — the coding-session analogue of
	 * the browser runtime's handoff-status machinery.
	 */
	private takeovers = new Map<string, { reason: string; label: string; resolved: boolean; value?: string }>();

	/** Base directory under which repos are cloned (one subdir per repo). */
	constructor(private readonly reposBaseDir: string = join(homedir(), ".config", "proagentstore", "repos")) {}

	/** Capabilities advertised to PAGS at registration. `coding.inspect` signals the
	 *  read-only code-inspection endpoints exist, so the cloud offers the grounding tools
	 *  (older runners omit it → the cloud degrades to terminal-only). */
	static capabilities(): string[] {
		// `coding.repo-write` announces the ONE write verb (#322). Advertised rather than probed, so
		// a reader of the registration can see which machines can restore a branch invariant; the
		// cloud still never trusts it, because an older runner simply 404s and the policy reports
		// that it asked and was not answered.
		return ["coding.sessions", "coding.stream", "human.takeover", "coding.inspect", "coding.repo-write"];
	}

	/**
	 * Resolve the workDir for a read-only inspection. Prefer the tracked session's real
	 * workDir (authoritative even for managed clone dirs); fall back to an explicit path
	 * (the cloud passes the D1 `repo.workdir` when the session map is empty after a runner
	 * restart). Expands a leading `~` the same way start() does.
	 */
	private resolveWorkDir(input: { sessionId?: string; workDir?: string }): string {
		if (input.sessionId) {
			const s = this.sessions.get(input.sessionId);
			if (s) return s.config.workDir;
		}
		if (input.workDir) return resolve(input.workDir.replace(/^~(?=$|\/)/, homedir()));
		throw new InspectError("no session or workDir to inspect");
	}

	/** Read one file inside the session's repo (traversal-guarded, size-capped). */
	readFile(input: { sessionId?: string; workDir?: string; path: string; maxBytes?: number }) {
		return readRepoFile(this.resolveWorkDir(input), input.path, input.maxBytes);
	}

	/** Run a whitelisted read-only git command in the session's repo. */
	git(input: { sessionId?: string; workDir?: string; cmd: GitCmd; path?: string; n?: number }) {
		return runRepoGit(this.resolveWorkDir(input), input.cmd, { path: input.path, n: input.n });
	}

	/**
	 * The ONE write the platform may make in a checkout by itself (#322) — put it back on a branch
	 * it declared, or refuse. See `repo-write.ts`: fixed argv, clean tree required, nothing in the
	 * `checkout .`/`reset`/`clean`/`stash` family exists to be reached.
	 */
	gitWrite(input: { sessionId?: string; workDir?: string; cmd: GitWriteCmd; branch: string }) {
		if (input.cmd !== "switch-branch") throw new InspectError(`unsupported git write command: ${String(input.cmd)}`);
		return switchRepoBranch(this.resolveWorkDir(input), input.branch);
	}

	/**
	 * Find something in the repo — by file CONTENT or by file NAME (#508).
	 *
	 * The one capability the read-only inspection surface never had. Without it, locating a file
	 * meant walking `tree` by hand, and a path deeper than the tree's four-level cap was not
	 * reachable in any number of calls that did not already know the answer.
	 */
	search(input: { sessionId?: string; workDir?: string; pattern: string; path?: string; mode?: RepoSearchMode; maxResults?: number }) {
		return repoSearch(this.resolveWorkDir(input), input);
	}

	/** Bounded recursive file tree of the session's repo (names/type/size only). */
	tree(input: { sessionId?: string; workDir?: string; path?: string; maxDepth?: number; maxEntries?: number }) {
		return repoTree(this.resolveWorkDir(input), input.path, input.maxDepth, input.maxEntries);
	}

	/** Read the local checkout's `origin` remote URL — lets PAGS auto-associate a
	 *  local-path repo with its GitHub owner/repo (so build status can query Actions). */
	gitRemote(input: { sessionId?: string; workDir?: string }) {
		return { remote: readGitRemoteOrigin(this.resolveWorkDir(input)) };
	}

	/**
	 * Is the configured workdir usable AT ALL — present, non-empty, a checkout (#405)?
	 *
	 * The only endpoint here that answers a question about the PATH rather than about its
	 * contents, and the one the cloud needs before it may call a repo `ready`. Reports the
	 * resolved path so a message can name the thing the owner actually typed, `~` and all.
	 */
	checkRepo(input: { sessionId?: string; workDir?: string }) {
		return checkWorkdir(this.resolveWorkDir(input));
	}

	static taskTypes(): string[] {
		return ["coding.session"];
	}

	/** Start (or return the existing) session and report its first snapshot. */
	start(input: StartCodingInput): StartCodingResult {
		let session = this.sessions.get(input.sessionId);
		if (!session) {
			// Resolve the working dir and ensure the repo is present (clone on first
			// start). A user-supplied local path may use ~ — expand it; otherwise
			// clone into a managed dir. Without this the CLI would launch nowhere.
			const workDir = input.workDir
				? resolve(input.workDir.replace(/^~(?=$|\/)/, homedir()))
				: join(this.reposBaseDir, sanitizeSessionName(input.repoId));
			ensureRepo(workDir, { cloneUrl: input.cloneUrl, branch: input.branch, token: input.token, tokenUsername: input.tokenUsername });
			session = new HeadlessSession({
				id: input.sessionId,
				workDir,
				clientType: input.clientType,
				command: input.command,
				env: input.env,
				statePath: defaultStatePath(this.reposBaseDir),
				resumeFrom: input.resumeFrom,
				ghScope: input.ghScope,
				bin: input.bin,
			});
			this.sessions.set(input.sessionId, session);
		}
		// Read BEFORE `start()`: a bad `--resume` can kill the process on spawn, and the engine
		// clears its own key on that exit. Reporting after would say "started clean" about a launch
		// that did carry a conversation, and the transcript (which shows the crash) would disagree.
		const resumed = session.resumedConversation;
		session.start();
		return { ...this.snapshot(input.sessionId), resumed };
	}

	/**
	 * The pane the brain reasons over + the inferred run state.
	 *
	 * `drainUsage` is opt-in because draining is destructive: nine cloud call sites hit
	 * `/coding/capture` and only the two that actually write the ledger may consume the records.
	 */
	snapshot(sessionId: string, opts: { drainUsage?: boolean } = {}): CodingSnapshot {
		const session = this.require(sessionId);
		const alive = session.alive;
		// ALWAYS return the transcript — it holds the produced output AND the
		// `[exited with code N]` / `[error]` lines recorded on exit. Blanking it when the
		// process is dead lost exactly the output + failure reason the brain/console needs
		// to diagnose a crash or read a one-shot CLI's final result.
		const pane = clip(session.snapshot());
		return {
			sessionId,
			pane,
			alive,
			ready: alive ? session.ready : false,
			runState: alive ? session.runState() : "idle",
			// Reported even when the process is not alive: "what would this session bill?" is
			// exactly the question asked about a session that just stopped.
			authResolved: session.authResolved,
			engineRuntime: session.engineRuntime,
			// Reported on EVERY capture, including one where the session is not alive: "how did the
			// last turn end" is exactly the question asked about a session that just stopped, and
			// the omitted-when-null shape keeps "not measured" distinguishable from a verdict.
			...(session.lastTurn ? { lastTurn: session.lastTurn } : {}),
			...(opts.drainUsage ? { usage: session.takeUsage(), acts: session.takeActs() } : {}),
		};
	}

	/** Perform one action, then return the fresh snapshot (non-blocking, like browser act). */
	act(sessionId: string, action: CodingAction): CodingSnapshot {
		const session = this.require(sessionId);
		switch (action.kind) {
			case "message":
				// Narrowed rather than trusted: this runner is a published package any caller can
				// POST to, and an unrecognised author must read as "unstated", not become a label.
				session.input(action.text, { author: asTurnAuthor(action.author) });
				break;
			case "keys": {
				// A snapshot is no longer the whole answer (#448). `key()` records the attempt and
				// reports that it was not delivered; answering 200 with a pane that simply did not
				// change is the defect this replaces — a caller cannot tell it apart from success.
				// `RunnerInputError` (400) is the honest class: with no PTY, asking this runner for
				// a keystroke is a bad request, not a runner fault. The cloud refuses it a step
				// earlier with a 409, so in practice this only catches a direct runner caller.
				const { reason } = session.key(action.keys);
				throw new RunnerInputError(`Keystrokes are not deliverable: ${reason} — send an instruction instead, or take the session over.`);
			}
			case "interrupt":
				session.interrupt();
				break;
			default:
				throw new Error(`Unknown coding action: ${(action as { kind: string }).kind}`);
		}
		return this.snapshot(sessionId);
	}

	/** Tear down a session. */
	/**
	 * Stop and forget a session.
	 *
	 * Returns any un-drained spend (#267) rather than discarding it with the session: the last
	 * turn of a session very often runs after the final capture poll, and ending is where that
	 * record would otherwise be lost — silently, and only for the turns at the end of every
	 * session, which is a bias rather than noise.
	 *
	 * …and, since #554, WHO PAID for it. The spend was already returned here; the observation that
	 * makes it attributable was one field away on the session object in hand, so every closing turn
	 * of every session reached the ledger with `payer` NULL even when the credential was known. The
	 * bias is the same one the paragraph above describes, which is why the omission mattered: it
	 * did not lose a random sample of turns, it lost the last turn of every session.
	 *
	 * `null` is a REAL answer here, not a default. `end()` tolerates a `sessionId` it has never
	 * heard of, and the honest report for a session this runner does not have is that it cannot say
	 * what the engine authenticated with — not a guess derived from the preset (see
	 * `usage-payer.ts`, and the alternative #554 rejected).
	 */
	end(sessionId: string): { ok: true; usage: EngineUsageRecord[]; acts: EngineActRecord[]; authResolved: EngineAuthResolved | null } {
		const session = this.sessions.get(sessionId);
		const usage = session ? session.takeUsage() : [];
		// Acts drain here too, and for a sharper version of the same reason (#294): the LAST thing a
		// coding run does is very often the consequential one — push, open the PR, merge it — and it
		// happens after the final capture poll. Discarding the tail would systematically lose exactly
		// the acts this record exists for.
		const acts = session ? session.takeActs() : [];
		// Read BEFORE `stop()`: `authResolved` is a live getter over the merged spawn env
		// (`headless.ts`), so it must be taken while the session is still the object that spawned
		// the process rather than after it has been torn down and dropped from the map.
		const authResolved = session ? session.authResolved : null;
		if (session) {
			session.stop();
			this.sessions.delete(sessionId);
		}
		this.takeovers.delete(sessionId);
		return { ok: true, usage, acts, authResolved };
	}

	list(): Array<{ sessionId: string; alive: boolean; engineLabel: string }> {
		return [...this.sessions.entries()].map(([sessionId, s]) => ({
			sessionId,
			alive: s.alive,
			engineLabel: s.engineLabel,
		}));
	}

	/** Rich diagnostics for every tracked session — the console's transparency view. */
	diagnostics(): Array<{
		sessionId: string;
		engineLabel: string;
		alive: boolean;
		runState: "idle" | "thinking" | "responding";
		ready: boolean;
		paneLines: number;
		clientType: string;
		workDir: string;
		takeover: boolean;
		authResolved: EngineAuthResolved;
		engineRuntime: "child-process";
		/** What the `gh` write guard did on this machine (#679) — including what it does NOT stop. */
		ghGuard: GhGuardReport;
	}> {
		return [...this.sessions.entries()].map(([sessionId, s]) => ({
			sessionId,
			engineLabel: s.engineLabel,
			alive: s.alive,
			runState: s.alive ? s.runState() : "idle",
			ready: s.alive ? s.ready : false,
			paneLines: s.alive ? (s.snapshot().split("\n").length) : 0,
			clientType: s.config.clientType,
			workDir: s.config.workDir,
			takeover: this.takeovers.has(sessionId),
			authResolved: s.authResolved,
			engineRuntime: s.engineRuntime,
			ghGuard: s.ghGuard,
		}));
	}

	// ── Human takeover (the "stuck" handoff) ────────────────────────────────
	// A text-frame equivalent of the browser takeover: the console shows the live
	// pane and forwards the human's keystrokes until they Resume.

	/** Begin a handoff (the brain calls this with why it's pausing). */
	beginTakeover(sessionId: string, opts: { reason?: string; label?: string } = {}): CodingSnapshot {
		this.require(sessionId);
		this.takeovers.set(sessionId, { reason: opts.reason ?? "stuck", label: opts.label ?? "this step", resolved: false });
		return this.snapshot(sessionId);
	}

	takeoverFrame(sessionId: string): CodingSnapshot {
		return this.snapshot(sessionId);
	}

	/** Forward a human keystroke/message during takeover. */
	takeoverInput(sessionId: string, value: { text?: string; keys?: string }): CodingSnapshot {
		const session = this.require(sessionId);
		if (value.keys) session.key(value.keys);
		else if (value.text != null) session.input(value.text);
		return this.snapshot(sessionId);
	}

	/** The human finished — mark resolved so the brain workflow can resume. */
	resolveTakeover(sessionId: string, value?: string): { ok: true } {
		const t = this.takeovers.get(sessionId);
		if (t) {
			t.resolved = true;
			t.value = value;
		}
		return { ok: true };
	}

	/**
	 * Polled by the brain workflow: has the human resolved the handoff? Defaults to
	 * NOT resolved when there's no live entry — if the runner restarted mid-handoff
	 * we must NOT auto-resume (the brain would proceed without the value it was told
	 * to wait for); the workflow's poll loop times out safely instead.
	 */
	takeoverStatus(sessionId: string): { resolved: boolean; value?: string } {
		const t = this.takeovers.get(sessionId);
		return { resolved: t?.resolved ?? false, value: t?.value };
	}

	endTakeover(sessionId: string): { ok: true } {
		this.takeovers.delete(sessionId);
		return { ok: true };
	}

	isUnderTakeover(sessionId: string): boolean {
		return this.takeovers.has(sessionId);
	}

	/**
	 * Stop every session (runner shutdown).
	 *
	 * Each `stop()` is isolated (#274 lineage). `stop()` kills a child process, and killing an
	 * already-dead or wedged one throws — so a single bad session used to abort the loop, leaving
	 * every LATER session's engine running and skipping `sessions.clear()` entirely. The caller
	 * (`LocalRunner.close`) wraps this in a `catch {}`, so that escape was silent: the runner
	 * reported a clean shutdown while orphaned CLI processes kept editing the user's repo with
	 * nothing left holding their ids. Same shape as the `browserContext.close()` leak — a throw
	 * on the teardown path is what MAKES the leak, so every session is stopped independently and
	 * the maps always clear.
	 */
	closeAll(): void {
		const failures: unknown[] = [];
		for (const s of this.sessions.values()) {
			try {
				s.stop();
			} catch (e) {
				failures.push(e);
			}
		}
		this.sessions.clear();
		this.takeovers.clear();
		if (failures.length) {
			// Cleared the state, then report: teardown completed as far as it could, but the
			// operator needs to know a child process may have survived it.
			throw new AggregateError(failures, `${failures.length} coding session(s) failed to stop`);
		}
	}

	/** True if any session this runtime owns still has a live agent process. */
	hasLiveSessions(): boolean {
		return [...this.sessions.values()].some((s) => s.alive);
	}

	private require(sessionId: string): HeadlessSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`No coding session: ${sessionId}`);
		return session;
	}
}

function clip(pane: string): string {
	return pane.length > MAX_PANE ? pane.slice(pane.length - MAX_PANE) : pane;
}
