import { parseBrowserWebsiteAccess, refreshWebsiteAccess, websiteAccessBlock, websiteResumePolicy, type BrowserWebsiteAccess, type WebsiteAccessBlock } from "./browser-website-access.js";
import { CrashLog, crashReport, describeError, runtimeCrashIdentity } from "./crash-reports.js";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserContext, Page } from "playwright";
import { captureScreenshotDataUrl, challengeSolved, detectHumanChallenge } from "./challenge.js";
import { launchRunnerBrowser } from "./browser-launch.js";
import { isTerminalTaskStatus, settleTaskOutcome } from "./apply-outcome.js";
import { McpRuntime } from "./mcp-runtime.js";
import type { BrowserCallsPage } from "./browser-call-recorder.js";
import type { CommitGuardSpec } from "./commit-guard.js";
import { taskCommitGuard } from "./mcp-call-policy.js";
import { HumanHandoffError, RunnerInputError } from "./errors.js";
import { type NativeTakeoverSession, nativeTakeoverFrame, nativeTakeoverInput, stopNativeTakeover } from "./takeover-native.js";
import { resolveHandoffStatus } from "./handoff-status.js";
import { RunnerStore } from "./store.js";
import { CodingRuntime } from "./coding/runtime.js";
import { LocalBrowserRuntime } from "./local-browser/runtime.js";
import { LOCAL_BROWSER_TASK_TYPE } from "./local-browser/contract.js";
import { capturePageScreenshot } from "./local-browser/replay.js";
import { LocalArtifactRuntime } from "./local-artifact/runtime.js";
import { LOCAL_ARTIFACT_TASK_TYPE } from "./local-artifact/contract.js";
import { LocalApplyRuntime } from "./local-apply/runtime.js";
import { LocalApplyReconciliationRuntime } from "./local-apply/reconciliation-runtime.js";
import { LocalApplySignInRuntime } from "./local-apply/sign-in-runtime.js";
import { LOCAL_APPLY_TASK_TYPE } from "./local-apply/contract.js";
import { BrowserSessions } from "./browser-sessions.js";
import { ResumeFiles } from "./resume-files.js";
import { createLocalApplyTakeoverAdapter, isLocalApplyTakeover } from "./local-apply/takeover-adapter.js";
import { WORKFLOW_DRIVEN_TASKS } from "./task-types.js";
import { SITE_BUILDER_TASK_TYPE, SiteBuilderRuntime } from "./site-builder/runtime.js";
/** True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Coerce a value to a trimmed string ("" for non-strings). */
function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
import type {
	BrowserAction,
	CreateTaskRequest,
	RunnerCapability,
	RunnerConfig,
	RunnerTask,
	TakeoverInput,
} from "./types.js";
export { HumanHandoffError, RunnerInputError } from "./errors.js";
const CAPABILITIES: RunnerCapability[] = [
	"browser.playwright",
	"browser.screenshot",
	"downloads",
	"file.upload",
	"human.approval",
	"human.takeover",
	"tmux.control",
	"native.preflight",
	"native.read",
	"native.act",
];
/** How many times a task may attempt an action before handing off to a human. */
export const MAX_AUTONOMOUS_ATTEMPTS = 3;

const APPROVAL_REQUIRED_TASKS = new Set(["browser.open"]);

/**
 * Tasks steered by a remote durable Workflow rather than executed by the runner.
 *
 * ONE list, because the two places that need it drifted: task creation already treated
 * `browser.task` like `job.apply_agent`, but `resumeTakeover` did not — so a human resolving a
 * stuck browse handoff destroyed the takeover session instead of handing control back, and the
 * workflow then polled a dead session for 15 minutes before failing a run it had already
 * completed.
 */

export class LocalRunner {
	readonly browsers: BrowserSessions;
	private readonly fileAttachArmed = new WeakSet<Page>();
	readonly store: RunnerStore;
	private readonly websitePolicies = new Map<string, BrowserWebsiteAccess>();
	private readonly websiteOpenResumes = new Map<string, Page>();
	private readonly websiteOpenPages = new Map<string, Page>();
	private readonly taskGuards = new Map<string, CommitGuardSpec>();
	/** This runtime's crash reports (#1087) — delivered to the platform by the CLI that runs it. */
	readonly crashLog: CrashLog;
	/** Local tmux coding sessions (the second runtime — AgentCoder port). */
	readonly coding: CodingRuntime;
	/** Local CLI browser research (#944): a signed-in Codex / Claude Code CLI researching through the policy bridge. */
	readonly localBrowser: LocalBrowserRuntime;
	/** Local artifact generation (#956): the Application Tailor's résumé + cover letter, from the owner's own files. */
	readonly localArtifact: LocalArtifactRuntime;
	/** Local application execution (#957): a signed-in CLI filling one application through the apply bridge. */
	readonly localApply: LocalApplyRuntime;
	/** Browser-only, no-bridge reconciliation for an ended uncertain apply attempt. */
	readonly localApplyReconciliation: LocalApplyReconciliationRuntime;
	/** A site sign-in in the application profile after a fill ended blocked on it (#1100): no run, no bridge. */
	readonly localApplySignIn: LocalApplySignInRuntime;
	/** The Website Builder's local author (#841): the signed-in CLI drafting through the PAGS broker. */
	readonly siteBuilder: SiteBuilderRuntime;
	/** This runner's own local URL, once the server listens — the bridge forwarder calls back to it. */
	selfUrl: string | null = null;
	/** Live human-takeover sessions, keyed by task id (the page is kept alive). */
	private takeovers = new Map<
		string,
		NativeTakeoverSession & { requestId: string; reason?: string; humanDone?: boolean; inputValue?: string }
	>();

	constructor(readonly config: RunnerConfig) {
		mkdirSync(config.dataDir, { recursive: true });
		this.store = new RunnerStore(config.dataDir);
		this.browsers = new BrowserSessions(config.dataDir, config.headless, (id) => { const task = this.store.getTask(id); return !!task && !isTerminalTaskStatus(task.status); }, (id) => !!id && (this.localBrowser.browserBusy(id) || this.localApply.browserBusy(id)));
		this.crashLog = new CrashLog(join(config.dataDir, "crash-reports.json"), runtimeCrashIdentity());
		this.coding = new CodingRuntime(join(config.dataDir, "repos"));
		const browserFor = (profile: "default" | "isolated", dir: string) => this.browsers.browserFor(profile, dir, false, () => this.getMcp(), () => this.getBrowserContext());
		const applyBrowserFor = (profile: "default" | "isolated", dir: string) => this.browsers.browserFor(profile, dir, true, () => this.getMcp(), () => this.getBrowserContext());
		this.localBrowser = new LocalBrowserRuntime({ dataDir: config.dataDir, selfUrl: () => this.selfUrl, browserFor, managedBrowser: () => this.browsers.managed(), onSweepFailure: (dir, error) => this.crashLog.record(crashReport({ ...runtimeCrashIdentity(), kind: "request_failure", ...describeError(error), route: `sweep ${dir}` })) });
		this.localArtifact = new LocalArtifactRuntime({ dataDir: config.dataDir });
		const localApplyTakeover = createLocalApplyTakeoverAdapter({ get: (id) => this.takeovers.get(id), set: (id, page) => this.takeovers.set(id, { page, requestId: crypto.randomUUID(), reason: "local_apply", humanDone: false }), frame: (id) => this.takeoverFrame(id), input: (id, input) => this.takeoverInput(id, input), end: (id) => this.endTakeover(id) });
		this.localApply = new LocalApplyRuntime({
			dataDir: config.dataDir,
			selfUrl: () => this.selfUrl,
			browserFor: applyBrowserFor,
			takeover: localApplyTakeover,
		});
		this.localApplyReconciliation = new LocalApplyReconciliationRuntime({ dataDir: config.dataDir, browserFor: applyBrowserFor, takeover: localApplyTakeover });
		this.localApplySignIn = new LocalApplySignInRuntime({
			dataDir: config.dataDir,
			browserFor: applyBrowserFor,
			takeover: localApplyTakeover,
			busy: () => this.localApply.liveWork().length + this.localApplyReconciliation.liveWork().length + this.localBrowser.liveWork().length > 0,
		});
		this.siteBuilder = new SiteBuilderRuntime({ dataDir: config.dataDir, selfUrl: () => this.selfUrl, onEvent: (id, type, message, data) => this.addTaskEvent(this.requireTask(id), type, message, data) });
		// Tasks paused/running on a previous process are orphaned now — their
		// pages and takeover sessions are gone. Fail them so the board is clean.
		const expired = this.store.expireInFlightTasks();
		if (expired > 0) console.log(`[runner] expired ${expired} orphaned in-flight task(s) from a previous session`);
	}

	/**
	 * What this process is doing that a restart would destroy (#896).
	 *
	 * `close()` stops every local runtime it owns, so "restart the runner" is not a free action: a
	 * Claude coding session resumes, but a Codex or Grok turn, a browser research run, a tailoring
	 * run and an application fill are each lost, and the cloud only reports them `runner_lost`
	 * minutes later. `pags up --replace` reads this and refuses while anything is live unless the
	 * owner passes `--now`, which is the whole reason it is reported rather than counted silently.
	 */
	liveWork(): { codingTurns: number; localRuns: number; detail: string[] } {
		const coding = this.coding.liveWork();
		const local = [...this.coding.cloneWork(), ...this.localBrowser.liveWork(), ...this.localArtifact.liveWork(), ...this.localApply.liveWork(), ...this.localApplyReconciliation.liveWork(), ...this.localApplySignIn.liveWork(), ...this.siteBuilder.liveWork()];
		return { codingTurns: coding.length, localRuns: local.length, detail: [...coding, ...local].slice(0, 10) };
	}

	capabilities() {
		return {
			runtime: "pags-browser-runtime",
			brainPlacement: "pags",
			controlPlane: "pags",
			runtimePlane: "pags",
			runnerRole: "tool-executor",
			capabilities: [...CAPABILITIES, ...CodingRuntime.capabilities()],
			taskTypes: ["echo", "browser.open", "job.apply_agent", "site_builder_runtime", LOCAL_BROWSER_TASK_TYPE, LOCAL_ARTIFACT_TASK_TYPE, LOCAL_APPLY_TASK_TYPE, ...CodingRuntime.taskTypes()],
			approvalRequiredFor: [...APPROVAL_REQUIRED_TASKS],
		};
	}

	createTask(request: CreateTaskRequest, websitePolicy?: BrowserWebsiteAccess): RunnerTask {
		const normalized = normalizeCreateTaskRequest(request);
		normalized.input = { ...normalized.input };
		delete normalized.input._pagsWebsitePolicy;
		validateTaskInput(normalized.type, normalized.input);
		if (["browser.open", "browser.task", "job.apply_agent", "browser.handoff"].includes(normalized.type)) {
			normalized.input = { ...normalized.input, blurFormFields: normalized.input.blurFormFields !== false };
		}
		const now = new Date().toISOString();
		// Optional card presentation for the console kanban (only set when provided).
		const card: Pick<RunnerTask, "title" | "subtitle" | "description"> = {};
		if (normalized.title) card.title = normalized.title;
		if (normalized.subtitle) card.subtitle = normalized.subtitle;
		if (normalized.description) card.description = normalized.description;
		// Agent-driven browser tasks (job applications AND generic browser tasks) are
		// steered by the remote Workflow brain via the /browser/* endpoints — the runner
		// never auto-executes them. The task exists for the console board, the activity
		// trace, and takeover keying.
		// The broker credential never becomes part of a task this runner returns (#841).
		if (normalized.type === SITE_BUILDER_TASK_TYPE) normalized.input = this.siteBuilder.accept(normalized.input);
		if (WORKFLOW_DRIVEN_TASKS.has(normalized.type)) {
			const task: RunnerTask = {
				id: `task_${crypto.randomUUID()}`,
				type: normalized.type,
				status: "running",
				input: normalized.input,
				...card,
				requiresApproval: false,
				createdAt: now,
				updatedAt: now,
			};
			this.store.putTask(task);
			this.bindWebsitePolicy(task.id, websitePolicy);
			if (["browser.task", "job.apply_agent", "browser.handoff"].includes(normalized.type)) this.browsers.current.taskIds.add(task.id);
			const startedMsg = normalized.type === "browser.task" ? "Browser task started (agent-driven)" : normalized.type === SITE_BUILDER_TASK_TYPE ? "Website Builder draft registered (workflow-driven); starting the local author" : "Job application started (agent-driven)";
			this.addTaskEvent(task, "task.created", startedMsg, { status: "running", url: normalized.input.url });
			// The one workflow-driven type the runner DOES start work for (#841): its local author CLI.
			if (normalized.type === SITE_BUILDER_TASK_TYPE) {
				try {
					this.siteBuilder.launch(task);
				} catch (err) {
					// Not left `running` with no author: failed, with the reason PAGS records on the run.
					Object.assign(task, { status: "failed", error: err instanceof Error ? err.message : String(err), updatedAt: new Date().toISOString() });
					this.store.putTask(task);
					throw err;
				}
			}
			return task;
		}
		const requiresApproval =
			normalized.requiresApproval || APPROVAL_REQUIRED_TASKS.has(normalized.type);
		const task: RunnerTask = {
			id: `task_${crypto.randomUUID()}`,
			type: normalized.type,
			status: requiresApproval ? "needs_approval" : "queued",
			input: normalized.input,
			...card,
			requiresApproval,
			approval: requiresApproval
				? {
						prompt: normalized.approvalPrompt || `Approve task ${normalized.type}`,
					}
				: undefined,
			createdAt: now,
			updatedAt: now,
		};
		this.store.putTask(task);
		this.bindWebsitePolicy(task.id, websitePolicy);
		if (normalized.type === "browser.open") this.browsers.current.taskIds.add(task.id);
		this.addTaskEvent(task, "task.created", `Task created: ${task.type}`, {
			status: task.status,
		});
		if (task.status === "queued") void this.runTask(task.id);
		return task;
	}

	/** An owner's refinement of a Website Builder draft (#841): one more author turn, never an approval. */
	refineSiteBuilder(id: string, refinement: unknown): { accepted: true } {
		const task = this.requireTask(id);
		if (task.type !== SITE_BUILDER_TASK_TYPE) throw new RunnerInputError("Only a Website Builder task can be refined");
		return this.siteBuilder.refine(task, typeof refinement === "string" ? refinement : "");
	}

	async approveTask(id: string, websitePolicy?: BrowserWebsiteAccess): Promise<RunnerTask> {
		this.bindWebsitePolicy(id, websitePolicy);
		const task = this.requireTask(id);
		if (task.status !== "needs_approval") {
			throw new RunnerInputError(`Task is not waiting for approval: ${task.status}`, 409);
		}
		task.status = "queued";
		task.updatedAt = new Date().toISOString();
		task.approval = {
			prompt: task.approval?.prompt || `Approve task ${task.type}`,
			approvedAt: task.updatedAt,
		};
		this.store.putTask(task);
		this.addTaskEvent(task, "task.approved", `Task approved: ${task.type}`);
		await this.runTask(task.id);
		return this.requireTask(id);
	}

	cancelTask(id: string): RunnerTask {
		const task = this.requireTask(id);
		// Already finished, whichever way — the old `completed || failed` pair missed `cancelled`, so
		// a second Stop rewrote the timestamps and appended a duplicate event (#636). A run that
		// genuinely completed or failed is NOT relabelled: it ended before the Stop arrived. Off THIS
		// return the cloud mirrored `task.cancelled` carrying `{status:"failed"}` — fixed in the cloud.
		if (isTerminalTaskStatus(task.status)) return task;
		task.status = "cancelled";
		task.updatedAt = new Date().toISOString();
		task.completedAt = task.updatedAt;
		this.store.putTask(task);
		this.addTaskEvent(task, "task.cancelled", `Task cancelled: ${task.type}`);
		// Tear down any live takeover session for this task (stop native frame streaming).
		void this.endTakeover(id).then(() => this.browsers.finish()).catch(() => undefined);
		return task;
	}

	/**
	 * Receive a bounded FWS capture manifest from the PAGS broker. The pixels remain behind the
	 * job-scoped signed URLs; keeping the manifest on the durable local task lets Claude/Codex
	 * inspect both layouts after a relay reconnect without ever receiving FWS OAuth material.
	 */
	appendCaptureArtifacts(id: string, artifacts: unknown[]): RunnerTask {
		const task = this.requireTask(id);
		if (task.type !== "site_builder_runtime") throw new RunnerInputError("Capture artifacts are only valid for Website Builder tasks");
		if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > 2) throw new RunnerInputError("Expected one or two capture artifacts");
		const valid = artifacts.map((item) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) throw new RunnerInputError("Invalid capture artifact");
			const a = item as Record<string, unknown>;
			if (typeof a.id !== "string" || !/^[a-f0-9]{64}$/.test(a.id) || (a.device !== "desktop" && a.device !== "mobile") ||
				typeof a.contentType !== "string" || typeof a.bytes !== "number" || !Number.isInteger(a.bytes) || a.bytes <= 0 || a.bytes > 4 * 1024 * 1024 ||
				typeof a.url !== "string" || a.url.length > 4_000 || !a.url.startsWith("https://api.proagentstore.online/")) {
				throw new RunnerInputError("Invalid capture artifact");
			}
			return a;
		});
		const prior = Array.isArray(task.input.captureArtifacts) ? task.input.captureArtifacts.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
		const merged = new Map<string, Record<string, unknown>>();
		for (const artifact of [...prior, ...valid]) if (typeof artifact.id === "string") merged.set(artifact.id, artifact);
		task.input = { ...task.input, captureArtifacts: [...merged.values()].slice(-8) };
		task.updatedAt = new Date().toISOString();
		this.store.putTask(task);
		this.addTaskEvent(task, "site_builder.capture_received", `FWS ${valid.map((artifact) => artifact.device).join(" + ")} capture received`, { artifacts: valid.map(({ id, device, contentType, bytes }) => ({ id, device, contentType, bytes })) });
		return task;
	}

	/**
	 * Tear everything down, and never let one failure strand the rest (#274).
	 *
	 * `browserContext.close()` rejects routinely — the browser crashed, or was
	 * already killed. It used to reject straight out of here, which skipped the
	 * state reset AND rejected the caller's shutdown, so the process stayed up
	 * holding a live browser until someone `kill -9`ed it. That kill is exactly
	 * what orphans the browser, so an unswallowed error here MADE the leak.
	 */
	/**
	 * Stop because somebody with the lock asked (#896) — the same teardown a signal runs.
	 *
	 * Deliberately not a second shutdown path: `index.ts`'s handler is idempotent and time-boxed
	 * (#274), so raising SIGTERM on ourselves reuses it rather than re-implementing it, which is
	 * what keeps "asked to stop" and "signalled to stop" from drifting apart.
	 */
	async requestShutdown(reason: string): Promise<void> {
		console.log(`[runner] stopping on request (${reason.slice(0, 60)})`);
		process.kill(process.pid, "SIGTERM");
	}

	async close(): Promise<void> {
		this.localBrowser.closeAll();
		this.localArtifact.closeAll();
		this.localApply.closeAll();
		this.localApplyReconciliation.closeAll();
		this.localApplySignIn.closeAll();
		try {
			this.coding.closeAll();
		} catch (e) {
			// A stuck coding session must not block the browser teardown below — but it must not
			// vanish either. `closeAll` now stops every session independently and only throws to
			// report which ones refused, so reaching here means a child process may have outlived
			// the runner. Silence here is what let that read as a clean shutdown.
			console.warn(`[runner] ${e instanceof Error ? e.message : String(e)} — a CLI process may still be running; check \`ps\` if a repo keeps changing`);
		}
		await Promise.all([...this.takeovers.values()].map((session) => stopNativeTakeover(session).catch(() => undefined)));
		await this.browsers.close();
	}

	private async runTask(id: string): Promise<void> {
		const task = this.requireTask(id);
		if (task.status !== "queued") return;
		task.status = "running";
		task.updatedAt = new Date().toISOString();
		this.store.putTask(task);
		this.addTaskEvent(task, "task.running", `Task running: ${task.type}`);

		try {
			const output = await this.execute(task);
			if (this.store.getTask(task.id)?.status === "cancelled") { await this.endTakeover(task.id); return; }
			if (isRecord(output) && isRecord(output.websiteAccess)) {
				const block = output.websiteAccess;
				task.status = block.decision === "ask" ? "needs_human" : "failed";
				task.output = { websiteAccess: { ...block, pauseKey: crypto.randomUUID() } };
				task.updatedAt = new Date().toISOString();
				if (task.status === "failed") task.completedAt = task.updatedAt;
				this.store.putTask(task);
				this.addTaskEvent(task, "browser.website_access", "Website access requires an owner decision", task.output);
				return;
			}
			task.status = "completed";
			task.output = output;
			task.updatedAt = new Date().toISOString();
			task.completedAt = task.updatedAt;
			this.store.putTask(task);
			this.addTaskEvent(task, "task.completed", `Task completed: ${task.type}`, output);
		} catch (error) {
			if (this.store.getTask(task.id)?.status === "cancelled") { await this.endTakeover(task.id); return; }
			if (error instanceof HumanHandoffError) {
				// Not a failure — the autonomous attempt is paused for a human to
				// take over (solve a challenge, finish a step the model can't).
				task.status = "needs_human";
				task.error = error.message;
				task.updatedAt = new Date().toISOString();
				this.store.putTask(task);
				this.addTaskEvent(task, "job.human_handoff_required", error.message, error.handoff);
				return;
			}
			task.status = "failed";
			task.error = error instanceof Error ? error.message : String(error);
			task.updatedAt = new Date().toISOString();
			task.completedAt = task.updatedAt;
			this.store.putTask(task);
			this.addTaskEvent(task, "task.failed", task.error);
		}
		await this.browsers.finish();
	}

	private addTaskEvent(
		task: RunnerTask,
		type: string,
		message: string,
		data?: unknown,
	): void {
		this.store.addEvent({
			taskId: task.id,
			type,
			message,
			data,
		});
	}

	/**
	 * Before submitting, bail to a human if the page shows an anti-bot challenge.
	 * The model can't solve CAPTCHAs, so retrying is pointless — hand off instead.
	 */
	private async guardHumanChallenge(task: RunnerTask, page: Page): Promise<void> {
		const challenge = await detectHumanChallenge(page);
		if (!challenge) return;
		this.addTaskEvent(task, "job.human_challenge_detected", `Human challenge detected: ${challenge}`, {
			challengeType: challenge,
			url: page.url(),
		});
		const screenshotBase64 = task.input.screenshots === false ? undefined : await captureScreenshotDataUrl(page, task.input.blurFormFields);
		// Keep this page alive and register a remote-control session so a human
		// can view the screen and solve the challenge from the PAGS console.
		this.takeovers.set(task.id, { page, requestId: crypto.randomUUID() });
		throw new HumanHandoffError(
			`Human verification required (${challenge}). A person must take over to solve it.`,
			{ reason: "challenge", challengeType: challenge, url: page.url(), attempts: 1, screenshotBase64 },
		);
	}

	/** Active human-takeover task ids (for status/discovery). */
	listTakeovers(): string[] {
		return [...this.takeovers.keys()].filter((id) => !isLocalApplyTakeover(id));
	}

	/** Opaque identities distinguish successive handoffs on the same task (#1442). */
	listTakeoverRequests(): Array<{ taskId: string; requestId: string }> {
		return this.listTakeovers().map((taskId) => ({ taskId, requestId: this.takeovers.get(taskId)!.requestId }));
	}

	private requireTakeover(taskId: string): NonNullable<ReturnType<typeof this.takeovers.get>> {
		const session = this.takeovers.get(taskId);
		if (!session) {
			throw new RunnerInputError("No active human-takeover session for this task");
		}
		return session;
	}

	/** Native Playwright streaming and input work with every supported browser engine (#1431). */
	async takeoverFrame(taskId: string): Promise<{ frame: string; width: number; height: number; url: string }> {
		return nativeTakeoverFrame(this.requireTakeover(taskId));
	}
	async takeoverInput(taskId: string, input: TakeoverInput): Promise<void> {
		await nativeTakeoverInput(this.requireTakeover(taskId), input);
	}

	/**
	 * Resume after a human takeover: verify the challenge is actually gone, then
	 * finish the application (submit). If a challenge or an unfilled required
	 * field remains, it does NOT submit — it reports what's left so the human can
	 * fix it in the live view and try again. Completes the task on success.
	 */
	async resumeTakeover(taskId: string): Promise<{ submitted: boolean; resumed?: boolean; reason?: string; output?: unknown }> {
		const task = this.store.getTask(taskId);
		if (!task) throw new RunnerInputError("Task not found");
		if (isTerminalTaskStatus(task.status)) return { submitted: false, resumed: false, reason: "This task has ended and cannot be resumed." };
		const session = this.requireTakeover(taskId);
		const page = session.page;

		// Agent-driven runs are steered by the remote workflow. "Resume" here just signals the
		// human finished the stuck step (or solved a captcha); the workflow polls humanDone and
		// continues driving. Do NOT complete/submit.
		//
		// `browser.task` belongs here too, and its omission made a stuck handoff UNRESOLVABLE:
		// `humanDone` is set ONLY in this branch, so a browse task fell through to the path below,
		// which sets `status = "completed"` and calls `endTakeover()` — destroying the session.
		// `browserHandoffStatus` then returns `{solved:false}` forever (no session), so the
		// workflow polled for the full 15 minutes and closed the run "failed — stuck not resolved
		// in time", on a task it had already marked completed. The console's Resume button is
		// agent-agnostic, so the user pressing it was what broke the run.
		if (WORKFLOW_DRIVEN_TASKS.has(task.type)) {
			session.humanDone = true;
			this.addTaskEvent(task, "job.resumed", "Human finished the step — handing back to the agent");
			return { submitted: false, resumed: true, reason: "handed back to the agent — the agent is continuing" };
		}

		const challenge = await detectHumanChallenge(page);
		if (challenge && !(await challengeSolved(page))) {
			this.addTaskEvent(task, "job.human_challenge_present", `Challenge not yet solved: ${challenge}`);
			return { submitted: false, reason: `The ${challenge} challenge isn't solved yet — complete it in the live view, then submit again.` };
		}

		// Only browser.open reaches here now (workflow-driven tasks return above) — it just
		// needs the challenge cleared, no form submit.
		this.addTaskEvent(task, "job.resumed", "Human cleared the challenge; resuming");
		const output = {
			taskType: task.type,
			submitted: false,
			challengeCleared: true,
			resumedAfterHuman: true,
			finalUrl: page.url(),
			title: await page.title().catch(() => ""),
			visibleText: (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 1_500),
		};
		if (isTerminalTaskStatus(this.requireTask(taskId).status)) return { submitted: false, resumed: false, reason: "This task ended while its challenge was being checked." };
		this.addTaskEvent(task, "task.resumed.completed", "Challenge cleared after human takeover", output);
		task.status = "completed";
		task.output = output;
		task.error = undefined;
		task.updatedAt = new Date().toISOString();
		task.completedAt = task.updatedAt;
		this.store.putTask(task);
		this.addTaskEvent(task, "task.completed", `Task completed: ${task.type}`, output);
		await this.endTakeover(taskId);
		await this.browsers.finish();
		// This path only CLEARED a challenge — the form was NOT submitted (output.submitted
		// is false). Report it accurately so the console doesn't show a false "submitted".
		return { submitted: false, resumed: true, output };
	}

	/**
	 * Always attach files via Playwright, never a native OS dialog: intercept any
	 * file chooser this page opens (e.g. a résumé upload) and set the file
	 * programmatically. Works even when a REMOTE human clicks the upload button
	 * during a takeover — no local file picker is ever needed.
	 */
	// Auto-attach the résumé to ANY file chooser on the page — whether the brain uses
	// the `upload` tool or just CLICKS a styled upload widget (SuccessFactors, Workday…
	// render the real <input type=file> hidden behind a button/drop-zone). Playwright's
	// filechooser event fires BEFORE the native OS dialog, so the file attaches without
	// a blocking dialog, regardless of the upload DOM. Idempotent per page.
	private armFileAutoAttach(page: Page): void {
		if (this.fileAttachArmed.has(page)) return;
		this.fileAttachArmed.add(page);
		const browserState = this.browsers.current;
		page.on("filechooser", (chooser) => {
			// Read the current run's attachment at event time. A reused tab must never
			// retain a previous application's résumé in the listener's closure.
			if (browserState.suppressAutoAttach || !browserState.applyResumePath) return;
			if (browserState.resumeTaskId) {
				const task = this.store.getTask(browserState.resumeTaskId);
				if (!task || isTerminalTaskStatus(task.status)) return;
			}
			const websitePolicy = this.websitePolicies.get(browserState.resumeTaskId || browserState.dataDir);
			if (websitePolicy && websiteAccessBlock(websitePolicy, page.url())) return;
			chooser.setFiles(browserState.applyResumePath).catch(() => undefined);
		});
	}

	private readonly resumeFiles = new ResumeFiles();
	private async prepareResumeFile(page: Page, ref?: string, taskId?: string, uploadAllowed = true): Promise<void> {
		const state = this.browsers.current;
		// Taskless calls carry no durable owner: only an explicit attachment on this
		// call grants upload access. Within one task the chosen file survives its steps.
		if (!taskId || state.resumeTaskId !== taskId) state.applyResumePath = null;
		state.resumeTaskId = taskId;
		if (!uploadAllowed) { state.applyResumePath = null; return; }
		if (ref) {
			state.applyResumePath = null;
			state.applyResumePath = await this.resumeFiles.resolve(ref, state.dataDir, taskId);
			if (!state.applyResumePath) throw new RunnerInputError("The requested résumé could not be loaded; no previous attachment was reused.");
		}
		if (state.applyResumePath) this.armFileAutoAttach(page);
	}

	/** End a takeover session (human finished or gave up). */
	async endTakeover(taskId: string): Promise<void> {
		const session = this.takeovers.get(taskId);
		if (session) await stopNativeTakeover(session);
		this.takeovers.delete(taskId);
	}

	private async execute(task: RunnerTask): Promise<unknown> {
		if (task.type === "echo") {
			return task.input;
		}
		if (task.type === "browser.open") {
			const url = String(task.input.url || "");
			if (!url || !/^https?:\/\//.test(url)) {
				throw new RunnerInputError("browser.open requires an http(s) url");
			}
			const websitePolicy = this.websitePolicies.get(task.id);
			const inspectionPage = this.websiteOpenResumes.get(task.id);
			this.websiteOpenResumes.delete(task.id);
			const inspecting = !!inspectionPage;
			const before = websitePolicy && !inspecting ? websiteAccessBlock(websitePolicy, url) : null;
			if (before) return { websiteAccess: before };
			const context = await this.getBrowserContext();
			const page = inspectionPage || context.pages()[0] || (await context.newPage());
			if (page.isClosed()) throw new RunnerInputError("The paused website page was closed; start a new browser task", 409);
			this.websiteOpenPages.set(task.id, page);
			// Auto-attach a file (e.g. résumé) via Playwright for any upload the
			// human triggers in the takeover — never a native picker.
			const attachPath = stringValue(task.input.resumePath ?? task.input.attachPath);
			if (attachPath && existsSync(resolve(attachPath))) {
				this.browsers.current.applyResumePath = resolve(attachPath);
				this.browsers.current.resumeTaskId = task.id;
				this.armFileAutoAttach(page);
				this.addTaskEvent(task, "browser.file.armed", "File will auto-attach via Playwright", {
					file: basename(resolve(attachPath)),
				});
			}
			this.addTaskEvent(task, "browser.goto.started", "Opening browser page", { url });
			if (!inspecting) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
			const after = websitePolicy ? websiteAccessBlock(websitePolicy, page.url(), true) : null;
			if (after) return { websiteAccess: after };
			// If the page presents an anti-bot challenge, hand off to a human to
			// solve it via takeover (the same path job applications use).
			await this.guardHumanChallenge(task, page);
			// holdForTakeover: hand the page straight to a human to drive — for
			// complex multi-step sites (e.g. a Dayforce/Workday ATS) the agent
			// can't auto-fill, the human completes it in the live view.
			if (task.input.holdForTakeover) {
				const screenshotBase64 = task.input.screenshots === false ? undefined : await captureScreenshotDataUrl(page, task.input.blurFormFields);
				this.takeovers.set(task.id, { page, requestId: crypto.randomUUID() });
				this.addTaskEvent(task, "browser.takeover.ready", "Page ready for human takeover", { url: page.url() });
				throw new HumanHandoffError("Ready for you to take over and complete this page.", {
					reason: "assist",
					url: page.url(),
					attempts: 0,
					screenshotBase64,
				});
			}
			const output = {
				url: page.url(),
				title: await page.title(),
			};
			this.addTaskEvent(task, "browser.goto.completed", "Browser page loaded", output);
			return output;
		}
		throw new RunnerInputError(`Unknown task type: ${task.type}`);
	}

	private requireTask(id: string): RunnerTask {
		const task = this.store.getTask(id);
		if (!task) throw new RunnerInputError(`Task not found: ${id}`, 404);
		return task;
	}

	private async getBrowserContext(): Promise<BrowserContext> {
		const state = this.browsers.current;
		if (state.context) return state.context;
		if (!state.launching) state.launching = this.launchBrowserContext().finally(() => { state.launching = undefined; });
		return state.launching;
	}
	private async launchBrowserContext(): Promise<BrowserContext> {
		const state = this.browsers.current;
		const launched = await launchRunnerBrowser({ headless: state.headless, engine: state.engine, profilePolicy: state.profilePolicy ?? "persistent", preference: "default", profileRoot: state.dataDir, ...(!state.engine && !state.profilePolicy ? { legacy: { rootDir: this.config.dataDir, instanceDir: state.dataDir } } : {}), onLaunch: (receipt) => {
			state.launch = receipt;
			for (const id of state.taskIds) { const task = this.store.getTask(id); if (task && !isTerminalTaskStatus(task.status)) this.addTaskEvent(task, "browser.launched", `${receipt.engine} launched in ${receipt.mode} mode`, receipt); }
		} });
		state.context = launched.context;
		state.stopBrowser = launched.stop;
		launched.context.on("close", () => {
			if (state.context !== launched.context) return;
			const staleMcp = state.mcp;
			Object.assign(state, { context: null, activePage: null, mcp: null, stopBrowser: undefined, applyResumePath: null, resumeTaskId: undefined });
			void staleMcp?.stop().catch(() => undefined);
		});
		await launched.context
			.addInitScript(() => {
				Object.defineProperty(navigator, "webdriver", { get: () => undefined });
			})
			.catch(() => undefined);
		// Follow the active page: when the ATS opens a new tab/popup it becomes the
		// page both the brain and the human takeover act on. Without this, the
		// runner blindly used pages()[0] and the two could diverge.
		launched.context.on("page", this.browsers.bind((p: Page) => this.trackPage(p)));
		const initial = launched.context.pages()[0];
		if (initial) this.trackPage(initial);
		// A seeded real profile can restore MANY tabs on launch; keep a single clean
		// workspace tab so the agent's page is unambiguous and visible (not lost among
		// restored blank tabs — the "why is the window blank?" symptom).
		await this.closeStalePages().catch(() => undefined);
		await this.browsers.current.activePage?.bringToFront().catch(() => undefined);
		return launched.context;
	}

	/** Mark a page as the active one; fall back to the newest remaining page when it closes. */
	private trackPage(page: Page): void {
		const state = this.browsers.current;
		state.activePage = page;
		page.once("crash", () => { if (state.context === page.context()) void state.stopBrowser?.().catch(() => undefined); });
		if (this.browsers.current.applyResumePath) this.armFileAutoAttach(page);
		page.once("close", this.browsers.bind(() => {
			if (this.browsers.current.activePage === page) {
				this.browsers.current.activePage = this.browsers.current.context?.pages().at(-1) ?? null;
			}
		}));
	}

	/** Close every page except the active one. ATS forms open popups/extra tabs that
	 *  otherwise stay open in the persistent context until shutdown; over many
	 *  applications they accumulate (memory/handles). Called when a task finishes. */
	private async closeStalePages(): Promise<void> {
		const state = this.browsers.current;
		// Cleanup never steals a page from a task or local engine that still owns it.
		if (state.leases > 0 || [...state.taskIds].some((id) => { const task = this.store.getTask(id); return task && !isTerminalTaskStatus(task.status); })) return;
		const ctx = state.context;
		if (!ctx) return;
		for (const p of ctx.pages()) {
			if (p !== this.browsers.current.activePage && !p.isClosed()) {
				await p.close().catch(() => undefined);
			}
		}
	}

	/** The page the brain drives and the human takes over — created on demand. */
	private async getActivePage(): Promise<Page> {
		const context = await this.getBrowserContext();
		if (!this.browsers.current.activePage || this.browsers.current.activePage.isClosed()) {
			this.browsers.current.activePage = context.pages().at(-1) ?? (await context.newPage());
		}
		// Keep the agent's working tab in the FOREGROUND so the user actually SEES what
		// the agent is doing (and can act on it during a takeover). Without this, on a
		// real Chrome profile that restores several tabs, the agent may drive a
		// background tab while the user stares at a blank foreground tab.
		await this.browsers.current.activePage.bringToFront().catch(() => undefined);
		return this.browsers.current.activePage;
	}

	/** Standard MCP receives the runner-owned native context; no Chromium-only CDP attachment. */
	private async getMcp(): Promise<McpRuntime> {
		const state = this.browsers.current;
		if (state.mcp) return state.mcp;
		if (!state.startingMcp) state.startingMcp = this.startMcp().finally(() => { state.startingMcp = undefined; });
		return state.startingMcp;
	}
	private async startMcp(): Promise<McpRuntime> {
		const context = await this.getBrowserContext();
		const mcp = new McpRuntime(this.browsers.current.calls);
		const state = this.browsers.current;
		await mcp.start({ context, activePage: () => state.activePage, onPageSelected: (page) => { state.activePage = page; } });
		if (state.context !== context) {
			await mcp.stop();
			throw new RunnerInputError("The browser closed while its tools were starting; start a fresh browser session.");
		}
		state.mcp = mcp;
		return mcp;
	}

	/** Pull the aria tree (with [ref=eNN]) out of a standard browser_snapshot result. */
	private extractSnapshot(text: string): string {
		const yaml = text.match(/```yaml\n([\s\S]*?)```/);
		if (yaml) return yaml[1].trimEnd();
		const i = text.indexOf("Page Snapshot:");
		return i >= 0 ? text.slice(i + "Page Snapshot:".length).trim() : text.trim();
	}

	/** Concise feedback from a tool result — drop the big page snapshot (the brain
	 *  gets a fresh one next turn); keep the action confirmation / any error text. */
	private conciseFeedback(text: string): string {
		const cut = text.search(/###\s*Page state|- Page Snapshot:|```yaml/);
		const head = (cut >= 0 ? text.slice(0, cut) : text).replace(/```[a-z]*\n?|```/g, " ").replace(/\s+/g, " ").trim();
		return head.slice(0, 400);
	}

	/** A small JPEG screenshot (base64, no data: prefix) of the page — one per action,
	 *  so the cloud can store it per step and the whole run can be replayed visually.
	 *  The frozen run policy masks form controls by default; only explicit false keeps rendered values.
	 *  A capture failure stores no frame.
	 *  scale:"css" avoids 2× retina bloat; a short timeout means a stuck page never delays the
	 *  action (the screenshot is best-effort, not the point). */
	private async shot(page: Page, blurFormFields: unknown = true): Promise<string | undefined> {
		return capturePageScreenshot(page, { quality: 45, timeout: 8_000, blurFormFields });
	}

	/** A task's saved policy wins over later requests/settings; absent and invalid values mask. */
	private screenshotPolicy(taskId?: string, request: { blurFormFields?: unknown; screenshot?: unknown } = {}) {
		const task = taskId ? this.store.getTask(taskId) : undefined;
		return {
			blurFormFields: (task ? task.input.blurFormFields : request.blurFormFields) !== false,
			enabled: task?.input.screenshots !== false && request.screenshot !== false,
		};
	}

	/**
	 * After a WRITE action, read the field's REAL value back via the standard
	 * browser_evaluate tool (evaluates on the element by ref — no reinvented DOM
	 * traversal). Masked/intl fields transform input (e.g. "0404453580" → "+61404453580"),
	 * so without this signal the brain can't tell the value "took" and oscillates
	 * between formats. Returns the prompt's expected "…now reads…" / "REJECTED…" line.
	 * Never throws — best-effort feedback.
	 */
	private async readBackField(mcp: McpRuntime, action: BrowserAction): Promise<string> {
		if (!action.ref) return "";
		const fn =
			"el => ({ v: el.value !== undefined ? String(el.value) : (el.getAttribute('aria-checked') ?? el.textContent ?? '').trim(), " +
			"bad: el.getAttribute('aria-invalid') === 'true' || !!(el.validity && !el.validity.valid), " +
			"msg: el.validationMessage || '' })";
		const res = await mcp.callTool("browser_evaluate", { element: action.name || "field", target: action.ref, function: fn }, { internal: true }).catch(() => null);
		if (!res || res.isError) return "";
		const txt = mcp.textOf(res);
		const i = txt.indexOf("### Result");
		if (i < 0) return "";
		const after = txt.slice(i + "### Result".length).trim();
		const end = after.indexOf("\n###");
		const block = (end >= 0 ? after.slice(0, end) : after).trim();
		let parsed: { v?: string; bad?: boolean; msg?: string };
		try { parsed = JSON.parse(block); } catch { return ""; }
		if (typeof parsed?.v !== "string") return "";
		const name = action.name || "field";
		const shown = parsed.v.length > 80 ? `${parsed.v.slice(0, 80)}…` : parsed.v;
		if (parsed.bad) return `⚠ "${name}" REJECTED: now reads "${shown}"${parsed.msg ? ` — ${parsed.msg.slice(0, 80)}` : ""}`;
		return `"${name}" now reads "${shown}"`;
	}

	/** Read a checkbox/radio's checked state via the standard evaluate tool so `check`
	 *  can be made idempotent (a raw click would toggle). Returns true/false, or null when
	 *  the state can't be determined (then we fall back to clicking). Never throws. */
	private async isChecked(mcp: McpRuntime, ref: string, label: string): Promise<boolean | null> {
		const fn =
			"el => { if (el.checked !== undefined && el.checked !== null) return !!el.checked; " +
			"const a = el.getAttribute('aria-checked'); return a === 'true' ? true : a === 'false' ? false : null; }";
		const res = await mcp.callTool("browser_evaluate", { element: label, target: ref, function: fn }, { internal: true }).catch(() => null);
		if (!res || res.isError) return null;
		const txt = mcp.textOf(res);
		const i = txt.indexOf("### Result");
		if (i < 0) return null;
		const after = txt.slice(i + "### Result".length).trim();
		const end = after.indexOf("\n###");
		const block = (end >= 0 ? after.slice(0, end) : after).trim().replace(/^["']|["']$/g, "");
		if (/^true$/i.test(block)) return true;
		if (/^false$/i.test(block)) return false;
		return null;
	}

	/** The snapshot ref the brain must target the element by (standard-tool `target`). */
	private refOf(action: BrowserAction): string {
		const ref = (action.ref || "").trim();
		if (!ref) throw new RunnerInputError(`the "${action.action}" action needs the element's snapshot ref (e.g. "e42")`);
		return ref;
	}

	/** Map one brain BrowserAction onto the industry-standard @playwright/mcp tool. */
	private async callBrowserTool(mcp: McpRuntime, a: BrowserAction) {
		const label = a.name || a.role || a.action;
		switch (a.action) {
			case "navigate":
				return mcp.callTool("browser_navigate", { url: a.url });
			case "type":
				return mcp.callTool("browser_type", { element: label, target: this.refOf(a), text: a.text ?? "" });
			case "click":
				return mcp.callTool("browser_click", { element: label, target: this.refOf(a) });
			case "check": {
				const ref = this.refOf(a);
				// A checkbox/radio click is a TOGGLE at the standard-tool level — clicking an
				// ALREADY-checked control unchecks it, silently reversing a pre-ticked consent
				// or a default-selected radio before submit. Make `check` idempotent
				// (ensure-checked): read the current state and only click when it isn't set.
				if ((await this.isChecked(mcp, ref, label)) === true) {
					return { isError: false, content: [{ type: "text", text: `"${label}" already checked` }] };
				}
				return mcp.callTool("browser_click", { element: label, target: ref });
			}
			case "upload": {
				if (!this.browsers.current.applyResumePath) throw new RunnerInputError("no résumé file available to upload");
				// Standard two-step FIRST (respects the brain's target): clicking the upload
				// control opens the file chooser → browser_file_upload attaches the résumé.
				// Suppress the global auto-attach handler for the duration so the résumé isn't
				// attached twice (the click below can itself open a chooser the handler grabs).
				this.browsers.current.suppressAutoAttach = true;
				try {
					const ref = (a.ref || "").trim();
					if (ref) {
						const clicked = await mcp.callTool("browser_click", { element: label, target: ref });
						if (clicked.isError) return clicked;
					}
					const res = await mcp.callTool("browser_file_upload", { paths: [this.browsers.current.applyResumePath] });
					if (!res.isError || !/modal state|file chooser/i.test(mcp.textOf(res))) return res;
					// The target was a LABEL / DROP-ZONE, not the chooser trigger, so no file
					// chooser opened. Fall back to setting the résumé directly on the page's
					// file input — robust across hidden inputs, drop-zones and custom upload
					// widgets (the semantically-correct upload field the brain clicks is often
					// a container, not the button that fires the chooser).
					const page = await this.getActivePage();
					await page.locator('input[type="file"]').first().setInputFiles(this.browsers.current.applyResumePath, { timeout: 8_000 });
					return { content: [{ type: "text", text: "résumé attached directly to the file input" }] };
				} finally {
					this.browsers.current.suppressAutoAttach = false;
				}
			}
			case "select":
				return mcp.callTool("browser_select_option", { element: label, target: this.refOf(a), values: [a.text ?? ""] });
			case "key":
				return mcp.callTool("browser_press_key", { key: a.key || "Enter" });
			// scroll is handled before this mapper (mouse-wheel on the live page).
			case "wait":
				return mcp.callTool("browser_wait_for", { time: Math.min(5, Math.max(0.1, (a.ms ?? 1000) / 1000)) });
			default:
				throw new RunnerInputError(`unknown action: ${a.action}`);
		}
	}

	/**
	 * What the remote brain "sees": the standard `@playwright/mcp` page snapshot — a
	 * compact ARIA tree with roles, accessible names, values, states, and a stable
	 * [ref=eNN] on each interactive element. The brain targets elements by that ref;
	 * because {@link browserAct} routes through the SAME mcp server, the refs resolve.
	 */
	async browserSnapshot(taskId?: string, incomingWebsitePolicy?: BrowserWebsiteAccess): Promise<{ websiteAccess?: WebsiteAccessBlock; url: string; title: string; snapshot: string; challenge: string | null; truncated: boolean; cancelled?: boolean; commitGuard?: { supported: true; dispatchSafe: true } }> {
		// If the user pressed Stop, the task is cancelled — tell the brain to halt.
		if (taskId && this.store.getTask(taskId)?.status === "cancelled") {
			return { url: "", title: "", snapshot: "", challenge: null, truncated: false, cancelled: true };
		}
		this.browsers.assertTaskAccess(taskId);
		const websitePolicy = this.bindWebsitePolicy(taskId, incomingWebsitePolicy);
		const page = await this.getActivePage();
		await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
		const mcp = await this.getMcp();
		// #1409: the legacy workflows (and the chat connector, which has no taskId of its own yet —
		// #1424) share this one mcp across tasks; the subject follows whichever task is live now.
		mcp.setSubject(taskId ? { kind: "runtime_task", id: taskId } : null);
		mcp.setCallPolicy({ guard: taskCommitGuard(taskId ? this.store.getTask(taskId)?.input : undefined, undefined, taskId ? this.taskGuards.get(taskId) : undefined), websiteAccess: () => websitePolicy, isCancelled: () => !!taskId && this.store.getTask(taskId)?.status === "cancelled" });
		await mcp.selectPage(page);
		const res = await mcp.callTool("browser_snapshot");
		if (res.websiteAccess) return { url: res.websiteAccess.url, title: "", snapshot: "", challenge: null, truncated: false, websiteAccess: res.websiteAccess, commitGuard: { supported: true, dispatchSafe: true } };
		const full = this.extractSnapshot(mcp.textOf(res));
		// The brain must see the WHOLE form or it can't finish. Real ATS forms are big
		// (a single Coles step is ~31k chars); the old 16k cap cut the page in half, so
		// the brain never saw the Submit button or the bottom required/EEO fields and
		// scroll-looped hunting for controls that were truncated out of its view. Claude
		// Sonnet's context easily holds a full page per turn (the accumulating action log
		// is what's bounded, not the one-shot snapshot). Keep a generous ceiling only to
		// guard against a pathological megapage.
		const MAX = 60_000;
		const snapshot = full.length > MAX ? `${full.slice(0, MAX)}\n… [snapshot truncated]` : full;
		return {
			url: page.url(),
			title: await page.title().catch(() => ""),
			snapshot,
			challenge: await detectHumanChallenge(page),
			truncated: full.length > MAX,
			commitGuard: { supported: true, dispatchSafe: true },
		};
	}

 private bindWebsitePolicy(taskId: string | undefined, incoming?: BrowserWebsiteAccess): BrowserWebsiteAccess | undefined {
  const key = taskId || this.browsers.current.dataDir;
  const task = taskId ? this.store.getTask(taskId) : undefined;
  const bound = this.websitePolicies.get(key) ?? parseBrowserWebsiteAccess(task?.input._pagsWebsitePolicy);
  const policy = !taskId && incoming ? incoming : refreshWebsiteAccess(bound, incoming);
  if (policy) {
   this.websitePolicies.set(key, policy);
   if (task) { task.input._pagsWebsitePolicy = policy; this.store.putTask(task); }
  }
  return policy;
 }
 private websiteRefusal(websiteAccess: WebsiteAccessBlock) {
  return { ok: false, url: websiteAccess.url, title: "", challenge: null, feedback: "Website access blocked. Take a fresh snapshot after the owner decision; do not replay the previous action.", websiteAccess, commitGuard: { supported: true as const, dispatchSafe: true as const }, completedOutcome: true as const };
 }
 async resumeWebsiteAccess(taskId: string, pauseKey: unknown, decision: unknown, incoming?: BrowserWebsiteAccess): Promise<RunnerTask> {
  const task = this.requireTask(taskId);
  const block = isRecord(task.output) && isRecord(task.output.websiteAccess) ? task.output.websiteAccess : undefined;
  if (task.type !== "browser.open" || task.status !== "needs_human" || !task.approval?.approvedAt || !block || typeof block.hostname !== "string" || typeof block.pauseKey !== "string") throw new RunnerInputError("No approved browser.open website pause matches this task", 409);
  const policy = websiteResumePolicy(this.bindWebsitePolicy(taskId), incoming, { hostname: block.hostname, pauseKey: block.pauseKey }, pauseKey, decision);
  if (policy) { this.websitePolicies.set(taskId, policy); task.input._pagsWebsitePolicy = policy; }
  if (decision === "deny") {
   task.status = "failed";
   task.error = "The owner denied website access";
   task.updatedAt = new Date().toISOString();
   task.completedAt = task.updatedAt;
   this.store.putTask(task);
   this.addTaskEvent(task, "task.failed", task.error);
   return task;
  }
  if (block.actionDispatched === true) {
			const heldPage = this.websiteOpenPages.get(taskId);
			if (!heldPage || heldPage.isClosed()) throw new RunnerInputError("The paused website page is unavailable; start a new browser task", 409);
			this.websiteOpenResumes.set(taskId, heldPage);
		}
  task.status = "queued";
  task.output = undefined;
  this.store.putTask(task);
  await this.runTask(taskId);
  return this.requireTask(taskId);
 }

	private assertTaskMayAct(taskId?: string): void {
		if (taskId && this.store.getTask(taskId)?.status === "cancelled") throw new RunnerInputError("BLOCKED by the runner — this task was stopped; no further browser action is permitted.");
		this.browsers.assertTaskAccess(taskId);
	}

	/**
	 * Perform one brain-issued action via the standard `@playwright/mcp` tools
	 * (browser_click / browser_type / browser_select_option / …), targeting the
	 * element by its snapshot ref. A tool-level failure is thrown so the workflow
	 * surfaces it to the brain as an `error` (which drives its self-correction).
	 */
	async browserAct(action: BrowserAction, resumePath?: string, guard?: CommitGuardSpec, taskId?: string, incomingWebsitePolicy?: BrowserWebsiteAccess): Promise<{ websiteAccess?: WebsiteAccessBlock; ok: boolean; url: string; title: string; challenge: string | null; feedback?: string; screenshot?: string; commitGuard: { supported: true; dispatchSafe: true; mode?: string }; completedOutcome: true }> {
		this.assertTaskMayAct(taskId);
		const websitePolicy = this.bindWebsitePolicy(taskId, incomingWebsitePolicy);
		guard = taskCommitGuard(taskId ? this.store.getTask(taskId)?.input : undefined, guard, taskId ? this.taskGuards.get(taskId) : undefined);
		if (taskId && guard) this.taskGuards.set(taskId, guard);
		const policy = this.screenshotPolicy(taskId, action);
		const page = await this.getActivePage();
		// #1409: the legacy workflows (and the chat connector, which has no taskId of its own yet —
		// #1424) share this one mcp across tasks; the subject follows whichever task is live now.
		const mcp = await this.getMcp();
		mcp.setSubject(taskId ? { kind: "runtime_task", id: taskId } : null);
		mcp.setCallPolicy({ guard, websiteAccess: () => websitePolicy, isCancelled: () => !!taskId && this.store.getTask(taskId)?.status === "cancelled" });
		await mcp.selectPage(page);
		await this.prepareResumeFile(page, resumePath, taskId, guard?.mode !== "read_only");
		this.assertTaskMayAct(taskId);
		// Scroll is a VIEWPORT primitive, not an element action — no ref, no standard
		// tool in @playwright/mcp 0.0.77. Use the mouse wheel on the live page (as the
		// prior runtime did): it scrolls the actual hovered/inner scroll container,
		// whereas window.scrollBy is a no-op on sites that scroll an inner panel (e.g.
		// PageUp/Coles), which made the brain scroll-loop forever.
		if (action.action === "scroll") {
			const blocked = websitePolicy ? websiteAccessBlock(websitePolicy, page.url()) : null;
			if (blocked) return this.websiteRefusal(blocked);
			// A raw Playwright call, not a standard tool — recorded directly (#1409), as tool `page.scroll`,
			// since it never reaches `McpRuntime.callTool` to be recorded there.
			const startedAt = Date.now();
			const scrollArgs = { dy: Math.round(action.dy ?? 600) };
			const wheeled = await page.mouse.wheel(0, scrollArgs.dy).then(() => true).catch(() => false);
			mcp.recordExternal("page.scroll", scrollArgs, wheeled ? "ok" : "thrown", { startedAt });
			await page.waitForTimeout(300).catch(() => undefined);
			const active = await this.getActivePage();
			const redirected = websitePolicy ? websiteAccessBlock(websitePolicy, active.url(), true) : null;
			if (redirected) return this.websiteRefusal(redirected);
			return {
				ok: true,
				url: active.url(),
				title: await active.title().catch(() => ""),
				challenge: await detectHumanChallenge(active),
				screenshot: !policy.enabled ? undefined : await this.shot(active, policy.blurFormFields),
				commitGuard: { supported: true, dispatchSafe: true, mode: guard?.mode },
			completedOutcome: true,
			};
		}
		const res = await this.callBrowserTool(mcp, action);
		if (res.websiteAccess) return this.websiteRefusal(res.websiteAccess);
		const text = mcp.textOf(res).trim();
		// A native page dialog (alert/confirm/beforeunload) puts the standard server
		// into a modal state that blocks EVERY other tool until it's handled. The brain
		// has no dialog vocabulary (the old runtime relied on Playwright's default
		// auto-dismiss, which @playwright/mcp overrides), so clear it transparently and
		// report it as a successful, informative step — the brain proceeds on the next
		// snapshot instead of thrashing into a needless human handoff.
		// #1420 (0.0.84): a dialog opened BY the action itself (e.g. an alert() the
		// action's own script triggers) now rides on a SUCCESSFUL response — the modal
		// state is reported informationally ("### Modal state — … can be handled by
		// browser_handle_dialog"), not as an error. `res.isError` no longer distinguishes
		// "this call failed because a dialog is blocking" from "this call succeeded and
		// a dialog is now open"; the text pattern is the only reliable signal either way,
		// and the dialog blocks the NEXT tool call regardless of which case this was.
		if (/modal state/i.test(text) && /dialog/i.test(text)) {
			if (guard) throw new RunnerInputError("BLOCKED by the runner — a page dialog needs the owner. Resolving it could continue a submission, so the guarded run left it open.");
			const dialogMsg = (text.match(/dialog with message "([^"]*)"/)?.[1] || "").slice(0, 160);
			await mcp.callTool("browser_handle_dialog", { accept: true }, { internal: true }).catch(() => undefined);
			await page.waitForTimeout(400).catch(() => undefined);
			const settled = await this.getActivePage();
			await settled.waitForLoadState("domcontentloaded", { timeout: 6_000 }).catch(() => undefined);
			const redirected = websitePolicy ? websiteAccessBlock(websitePolicy, settled.url(), true) : null;
			if (redirected) return this.websiteRefusal(redirected);
			return {
				ok: true,
				url: settled.url(),
				title: await settled.title().catch(() => ""),
				challenge: await detectHumanChallenge(settled),
				feedback: dialogMsg ? `a native dialog was accepted: "${dialogMsg}"` : "a native dialog was accepted",
				screenshot: !policy.enabled ? undefined : await this.shot(settled, policy.blurFormFields),
				commitGuard: { supported: true, dispatchSafe: true },
				completedOutcome: true,
			};
		}
		if (res.isError) throw new RunnerInputError(this.conciseFeedback(text) || `${action.action} failed`);
		// A click may trigger SPA navigation or open a new tab/popup. Give it a beat
		// to settle and follow the (possibly new) active page, so the next snapshot
		// reflects the new state — not the element the brain just clicked.
		await page.waitForTimeout(700).catch(() => undefined);
		const active = await this.getActivePage();
		await active.waitForLoadState("domcontentloaded", { timeout: 6_000 }).catch(() => undefined);
		// SPA route changes (Dayforce/Workday) swap the view via XHR without a full
		// load, so domcontentloaded fires instantly and the snapshot can catch the
		// PRE-swap DOM (still showing the button just clicked → a wasted re-click).
		// Wait for the network to go idle after navigation-ish actions.
		if (action.action === "click" || action.action === "navigate" || action.action === "key") {
			await active.waitForLoadState("networkidle", { timeout: 3_500 }).catch(() => undefined);
		}
		const redirected = websitePolicy ? websiteAccessBlock(websitePolicy, active.url(), true) : null;
		if (redirected) return this.websiteRefusal(redirected);
		// For a WRITE, read the field's real value back (masked/intl fields transform
		// input, e.g. "0404453580" → "+61404453580") so the brain knows it took and
		// stops oscillating between formats — the signal inspectField used to give.
		await mcp.selectPage(active);
		let feedback = this.conciseFeedback(text);
		if (action.action === "type" || action.action === "select" || action.action === "check") {
			const rb = await this.readBackField(mcp, action);
			if (rb) feedback = rb;
		}
		return {
			ok: true,
			url: active.url(),
			title: await active.title().catch(() => ""),
			challenge: await detectHumanChallenge(active),
			feedback: feedback || undefined,
			screenshot: !policy.enabled ? undefined : await this.shot(active, policy.blurFormFields),
			commitGuard: { supported: true, dispatchSafe: true, mode: guard?.mode },
			completedOutcome: true,
		};
	}

	// ── Agent-driven application lifecycle (called by the remote Workflow brain) ──

	/** Append a decision/event to the agent task's activity (the console trace). */
	browserEvent(taskId: string, type: string, message: string, data?: unknown): { ok: boolean } {
		const task = this.store.getTask(taskId);
		if (task) this.addTaskEvent(task, type, message, data);
		return { ok: true };
	}

	/** This task's recorded browser calls after `afterSeq` (#1409), for the shared `/browser-calls` pull route. */
	async browserCalls(taskId: string, afterSeq: number): Promise<BrowserCallsPage> {
		return this.browsers.current.calls.page({ kind: "runtime_task", id: taskId }, afterSeq);
	}

	/**
	 * Hand off for a CAPTCHA in the SAME session: register the live active page
	 * for remote takeover and flip the task to needs_human so the console shows
	 * the take-over view. The brain pauses; the human solves it on this page.
	 */
	async browserHandoff(taskId: string, label: string, reason = "challenge", options: { blurFormFields?: unknown; screenshot?: unknown } = {}): Promise<{ ok: boolean; screenshotBase64?: string }> {
		this.assertTaskMayAct(taskId);
		this.browsers.current.taskIds.add(taskId);
		const page = await this.getActivePage();
		this.takeovers.set(taskId, { page, requestId: crypto.randomUUID(), reason, humanDone: false });
		const policy = this.screenshotPolicy(taskId, options);
		const screenshotBase64 = policy.enabled ? await captureScreenshotDataUrl(page, policy.blurFormFields) : undefined;
		if (this.store.getTask(taskId)?.status === "cancelled") { await this.endTakeover(taskId); throw new RunnerInputError("This task was stopped during the handoff."); }
		// The takeover is registered ABOVE, unconditionally — that is what makes the live view work.
		// Everything below is the task's own bookkeeping, and it used to be skipped whenever no
		// LOCAL task existed. The engine sign-in relay mints its own id (`signin-<sessionId>`) for
		// a coding session that has no runner task at all, so the handoff registered silently and
		// none of the status flip, the message or the screenshot ever happened: the console
		// reported success and offered "take over the browser", while the takeover it pointed at
		// carried no context. A task row is created for it here rather than requiring the caller
		// to have made one, so the handoff is complete for every caller.
		let task = this.store.getTask(taskId);
		if (!task) {
			const now = new Date().toISOString();
			task = { id: taskId, type: "browser.handoff", status: "needs_human", input: { blurFormFields: policy.blurFormFields, ...(policy.enabled ? {} : { screenshots: false }) }, requiresApproval: false, createdAt: now, updatedAt: now };
			this.store.putTask(task);
		}
		{
			task.status = "needs_human";
			task.updatedAt = new Date().toISOString();
			this.store.putTask(task);
			const message =
				reason === "needs_input"
					? `The agent needs a value from you: ${label}. Enter it and the agent continues.`
					: reason === "stuck"
						? `Take over: the agent is stuck on "${label}". Do that one step (e.g. tick the box / click continue) in the live view, then click Resume.`
						: `Take over to solve the ${label} — the agent will continue once it's solved.`;
			this.addTaskEvent(task, "job.human_handoff_required", message, {
				reason,
				challengeType: reason === "challenge" ? label : undefined,
				stuckOn: reason === "stuck" ? label : undefined,
				inputField: reason === "needs_input" ? label : undefined,
				url: page.url(),
				screenshotBase64,
			});
		}
		return { ok: true, screenshotBase64 };
	}

	/** Whether the brain can resume: a solved captcha (auto), a human "Resume" for a stuck step, or a provided value. */
	async browserHandoffStatus(taskId: string): Promise<{ solved: boolean; challenge: string | null; value?: string }> {
		const session = this.takeovers.get(taskId);
		// No live takeover session (the runner restarted mid-handoff, or it expired): stay
		// UNRESOLVED. The old code fell through and relaunched a blank page via
		// getActivePage(), which detected no challenge and reported solved:true — so the
		// brain resumed the application WITHOUT the human's captcha/value. A status poll
		// must never relaunch the browser or claim a lost handoff is done.
		if (!session) return { solved: false, challenge: null };
		const page = session.page;
		// Every answer that needs no live DOM — including a GONE page, which used to report
		// solved:true and resume past an unsolved challenge (#641) — comes from
		// handoff-status.ts; null means only an open challenge's own DOM can answer.
		const offline = resolveHandoffStatus({ reason: session.reason, pageClosed: page.isClosed(), inputValue: session.inputValue, humanDone: session.humanDone });
		if (offline) return offline;
		// A challenge resumes when the token/widget clears OR the human clicks Done —
		// custom captchas (e.g. PageUp's "not a robot") have no detectable token, so
		// the human's explicit Done is the authority; never strand them.
		try {
			const challenge = await detectHumanChallenge(page);
			const solved = !challenge || (await challengeSolved(page)) || !!session.humanDone;
			return { solved, challenge };
		} catch {
			// A navigation/detachment/crash during the probe proves nothing about the
			// challenge. Keep the handoff pending so a later poll can inspect it again.
			return { solved: false, challenge: null };
		}
	}

	/** The user supplied the value the agent asked for (ask-and-hold). */
	browserSubmitInput(taskId: string, value: string): { ok: boolean } {
		const task = this.store.getTask(taskId);
		if (!task || isTerminalTaskStatus(task.status)) return { ok: false };
		const session = this.takeovers.get(taskId);
		// No live takeover (session expired / runner restarted): the value can't be
		// delivered. Don't discard it silently AND resurrect the already-terminal task as
		// "running" — report failure so the console can say "session expired, re-run".
		if (!session) return { ok: false };
		// Reject an empty value: browserHandoffStatus reports needs_input as solved only when
		// inputValue is a real string, so accepting "" would flip the task to "running" yet
		// never resolve → the workflow polls until it times out (15-min wedge, "failed").
		// Report failure so the caller (API/MCP) learns it wasn't accepted, like the
		// no-session branch. (The console already blocks empty; this closes the API path.)
		if (!value?.trim()) return { ok: false };
		session.inputValue = value;
		if (task) {
			task.status = "running";
			task.updatedAt = new Date().toISOString();
			this.store.putTask(task);
			this.addTaskEvent(task, "job.input_provided", "You provided the requested value — the agent is continuing");
		}
		return { ok: true };
	}

	/** End the takeover and return the task to running so the brain drives again. */
	async browserResume(taskId: string): Promise<{ ok: boolean }> {
		await this.endTakeover(taskId).catch(() => undefined);
		const task = this.store.getTask(taskId);
		if (!task || isTerminalTaskStatus(task.status)) return { ok: false };
		if (task) {
			task.status = "running";
			task.updatedAt = new Date().toISOString();
			this.store.putTask(task);
			this.addTaskEvent(task, "job.resumed", "Challenge solved — agent resuming the application.");
		}
		return { ok: true };
	}

	/** Finalize an agent-driven application — the outcome→status table lives in apply-outcome.ts. */
	async browserComplete(taskId: string, outcome: string, detail?: string): Promise<{ ok: boolean }> {
		await this.endTakeover(taskId).catch(() => undefined);
		const task = this.store.getTask(taskId);
		if (task && (!isTerminalTaskStatus(task.status) || task.status === "cancelled" && outcome === "cancelled")) {
			// A TOTAL table, not a chain of string comparisons: `cancelled` matched none of
			// them and fell through to `failed`, so a run the owner stopped was filed as an
			// error with a Retry button on it (#636). See apply-outcome.ts.
			const { event } = settleTaskOutcome(task, outcome, detail);
			this.store.putTask(task);
			this.addTaskEvent(task, event, detail || `Application ${outcome}`, { outcome, detail });
		}
		await this.closeStalePages().catch(() => undefined);
		await this.browsers.finish();
		return { ok: true };
	}

}

function normalizeCreateTaskRequest(request: CreateTaskRequest): Required<CreateTaskRequest> {
	if (!isRecord(request) || typeof request.type !== "string" || !request.type.trim()) {
		throw new RunnerInputError("task type required");
	}
	const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
	return {
		type: request.type.trim().slice(0, 120),
		input: isRecord(request.input) ? request.input : {},
		title: str(request.title, 200),
		subtitle: str(request.subtitle, 200),
		description: str(request.description, 500),
		requiresApproval: request.requiresApproval === true,
		approvalPrompt: typeof request.approvalPrompt === "string"
			? request.approvalPrompt.trim().slice(0, 500)
			: "",
	};
}

function validateTaskInput(_type: string, _input: Record<string, unknown>): void {
	// The agent-driven apply (job.apply_agent) validates inputs in the workflow;
	// no runner-side schema validation needed for the remaining task types.
}

export function fileUrl(path: string): string {
	return pathToFileURL(path).toString();
}
