import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserContext, CDPSession, Locator, Page } from "playwright";
import { humanApproach } from "./human-mouse.js";
import { captureScreenshotDataUrl, challengeSolved, detectHumanChallenge } from "./challenge.js";
import { resolveRealChromeProfileDir, seedProfileCopy } from "./browser-profile.js";
import { HumanHandoffError, RunnerInputError } from "./errors.js";
import {
	detectAuthRequirement,
	fillBasicApplicationForm,
	fillLoginForm,
	fillRegistrationForm,
	findLoginUrl,
	findRegisterUrl,
	isRecord,
	normalizeAuthenticatedJobInput,
	normalizeJobApplicationInput,
	stringValue,
	submitApplicationForm,
	submitForm,
	type AuthenticatedJobInput,
	type JobApplicationInput,
} from "./apply-form.js";
import { RunnerStore } from "./store.js";
import type {
	BrowserAction,
	CreateTaskRequest,
	RunnerCapability,
	RunnerConfig,
	RunnerTask,
	TakeoverInput,
} from "./types.js";

// Re-exported for back-compat with existing importers (server.ts + tests).
export { HumanHandoffError, RunnerInputError } from "./errors.js";
export { normalizeJobApplicationInput, normalizeAuthenticatedJobInput } from "./apply-form.js";
export type { JobApplicationInput, AuthenticatedJobInput } from "./apply-form.js";

const CAPABILITIES: RunnerCapability[] = [
	"browser.playwright",
	"browser.screenshot",
	"downloads",
	"file.upload",
	"human.approval",
	"human.takeover",
];

/** How many times a task may attempt an action before handing off to a human. */
export const MAX_AUTONOMOUS_ATTEMPTS = 3;

const APPROVAL_REQUIRED_TASKS = new Set(["browser.open", "job.apply_basic", "job.apply_authenticated"]);
const require = createRequire(import.meta.url);


export class LocalRunner {
	private browserContext: BrowserContext | null = null;
	private chromiumInstallChecked = false;
	/**
	 * The single page the brain and the human takeover both act on. Tracked so
	 * that when an ATS opens a new tab/popup, the active page follows it — the
	 * remote brain and the human never diverge onto different pages.
	 */
	private activePage: Page | null = null;
	readonly store: RunnerStore;
	/** Live human-takeover sessions, keyed by task id (the page is kept alive). */
	private takeovers = new Map<
		string,
		{ page: Page; cdp?: CDPSession; latestFrame?: string; width?: number; height?: number; cssW?: number; cssH?: number; screencasting?: boolean; reason?: string; humanDone?: boolean; inputValue?: string }
	>();

	constructor(readonly config: RunnerConfig) {
		mkdirSync(config.dataDir, { recursive: true });
		this.store = new RunnerStore(config.dataDir);
		// Tasks paused/running on a previous process are orphaned now — their
		// pages and takeover sessions are gone. Fail them so the board is clean.
		const expired = this.store.expireInFlightTasks();
		if (expired > 0) console.log(`[runner] expired ${expired} orphaned in-flight task(s) from a previous session`);
	}

	capabilities() {
		return {
			runtime: "fags-browser-runtime",
			brainPlacement: "pags",
			controlPlane: "pags",
			runtimePlane: "fags",
			runnerRole: "tool-executor",
			capabilities: CAPABILITIES,
			taskTypes: ["echo", "browser.open", "job.apply_basic", "job.apply_authenticated", "job.apply_agent"],
			approvalRequiredFor: [...APPROVAL_REQUIRED_TASKS],
		};
	}

	createTask(request: CreateTaskRequest): RunnerTask {
		const normalized = normalizeCreateTaskRequest(request);
		validateTaskInput(normalized.type, normalized.input);
		const now = new Date().toISOString();
		// Agent-driven applications are steered by the remote Workflow brain via the
		// /browser/* endpoints — the runner never auto-executes them. The task exists
		// for the console board, the activity trace, and takeover keying.
		if (normalized.type === "job.apply_agent") {
			const task: RunnerTask = {
				id: `task_${crypto.randomUUID()}`,
				type: normalized.type,
				status: "running",
				input: normalized.input,
				requiresApproval: false,
				createdAt: now,
				updatedAt: now,
			};
			this.store.putTask(task);
			this.addTaskEvent(task, "task.created", "Job application started (agent-driven)", { status: "running", url: normalized.input.url });
			return task;
		}
		const requiresApproval =
			normalized.requiresApproval || APPROVAL_REQUIRED_TASKS.has(normalized.type);
		const task: RunnerTask = {
			id: `task_${crypto.randomUUID()}`,
			type: normalized.type,
			status: requiresApproval ? "needs_approval" : "queued",
			input: normalized.input,
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
		this.addTaskEvent(task, "task.created", `Task created: ${task.type}`, {
			status: task.status,
		});
		if (task.status === "queued") void this.runTask(task.id);
		return task;
	}

	async approveTask(id: string): Promise<RunnerTask> {
		const task = this.requireTask(id);
		if (task.status !== "needs_approval") {
			throw new Error(`Task is not waiting for approval: ${task.status}`);
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
		if (task.status === "completed" || task.status === "failed") return task;
		task.status = "cancelled";
		task.updatedAt = new Date().toISOString();
		task.completedAt = task.updatedAt;
		this.store.putTask(task);
		this.addTaskEvent(task, "task.cancelled", `Task cancelled: ${task.type}`);
		// Tear down any live takeover session for this task (free the page + CDP).
		void this.endTakeover(id).catch(() => undefined);
		return task;
	}

	async close(): Promise<void> {
		await this.browserContext?.close();
		this.browserContext = null;
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
			task.status = "completed";
			task.output = output;
			task.updatedAt = new Date().toISOString();
			task.completedAt = task.updatedAt;
			this.store.putTask(task);
			this.addTaskEvent(task, "task.completed", `Task completed: ${task.type}`, output);
		} catch (error) {
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
		const screenshotBase64 = await captureScreenshotDataUrl(page);
		// Keep this page alive and register a remote-control session so a human
		// can view the screen and solve the challenge from the PAGS console.
		this.takeovers.set(task.id, { page });
		const isApply = task.type === "job.apply_basic" || task.type === "job.apply_authenticated";
		throw new HumanHandoffError(
			`Human verification required (${challenge}). A person must take over to solve it${isApply ? " and submit this application" : ""}.`,
			{ reason: "challenge", challengeType: challenge, url: page.url(), attempts: 1, screenshotBase64 },
		);
	}

	/** Active human-takeover task ids (for status/discovery). */
	listTakeovers(): string[] {
		return [...this.takeovers.keys()];
	}

	private requireTakeover(taskId: string): NonNullable<ReturnType<typeof this.takeovers.get>> {
		const session = this.takeovers.get(taskId);
		if (!session) {
			throw new RunnerInputError("No active human-takeover session for this task");
		}
		return session;
	}

	/** Begin a continuous CDP screencast for a takeover (no viewport disruption). */
	private async ensureScreencast(taskId: string): Promise<void> {
		const session = this.requireTakeover(taskId);
		if (!session.cdp) {
			session.cdp = await session.page.context().newCDPSession(session.page);
		}
		if (session.screencasting) return;
		session.screencasting = true;
		const cdp = session.cdp;
		cdp.on("Page.screencastFrame", (params: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) => {
			session.latestFrame = params.data;
			if (params.metadata?.deviceWidth) session.width = Math.round(params.metadata.deviceWidth);
			if (params.metadata?.deviceHeight) session.height = Math.round(params.metadata.deviceHeight);
			cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
		});
		await cdp.send("Page.startScreencast", { format: "jpeg", quality: 50, everyNthFrame: 1 });
	}

	/**
	 * The latest screencast frame of the taken-over page plus its CSS viewport
	 * size. Uses a continuous CDP screencast (not page.screenshot, which forces
	 * a viewport metrics override and makes the real window flicker/zoom).
	 */
	async takeoverFrame(taskId: string): Promise<{ frame: string; width: number; height: number }> {
		const session = this.requireTakeover(taskId);
		await this.ensureScreencast(taskId);
		// Until the first screencast frame arrives, fall back to a single shot.
		if (!session.latestFrame) {
			const buf = await session.page.screenshot({ type: "jpeg", quality: 55 }).catch(() => null);
			if (buf) session.latestFrame = buf.toString("base64");
			const viewport = await session.page
				.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
				.catch(() => ({ width: 0, height: 0 }));
			session.width = session.width || viewport.width;
			session.height = session.height || viewport.height;
		}
		// Report the page's real CSS viewport — that is exactly the coordinate
		// space CDP Input expects, so a relayed click lands precisely on target on
		// any display (scaled / retina included). Screencast metadata can diverge
		// from innerWidth on fractional-scale displays; innerWidth never lies.
		if (!session.cssW) {
			const vp = await session.page
				.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
				.catch(() => null);
			if (vp?.w) {
				session.cssW = vp.w;
				session.cssH = vp.h;
			}
		}
		return {
			frame: `data:image/jpeg;base64,${session.latestFrame ?? ""}`,
			width: session.cssW ?? session.width ?? 1280,
			height: session.cssH ?? session.height ?? 720,
		};
	}

	/** Relay a human's mouse/keyboard input into the real page via CDP. */
	async takeoverInput(taskId: string, input: TakeoverInput): Promise<void> {
		const session = this.requireTakeover(taskId);
		if (!session.cdp) {
			session.cdp = await session.page.context().newCDPSession(session.page);
		}
		const cdp = session.cdp;
		const x = input.x ?? 0;
		const y = input.y ?? 0;
		switch (input.type) {
			case "move":
				await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
				return;
			case "down":
				await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
				return;
			case "up":
				await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
				return;
			case "click":
				await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
				await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
				return;
			case "scroll":
				await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 });
				return;
			case "text":
				await cdp.send("Input.insertText", { text: input.text ?? "" });
				return;
			case "key": {
				// Special keys (Enter, Backspace, Delete, Escape, Tab, arrows…)
				// need the virtual key code + code to register, not just the name.
				const key = input.key ?? "";
				const base: Record<string, unknown> = { key };
				if (input.code) base.code = input.code;
				if (typeof input.keyCode === "number") {
					base.windowsVirtualKeyCode = input.keyCode;
					base.nativeVirtualKeyCode = input.keyCode;
				}
				const text = key === "Enter" ? "\r" : undefined;
				await cdp.send("Input.dispatchKeyEvent", {
					type: text ? "keyDown" : "rawKeyDown",
					...base,
					...(text ? { text } : {}),
				});
				await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
				return;
			}
		}
	}

	/**
	 * Resume after a human takeover: verify the challenge is actually gone, then
	 * finish the application (submit). If a challenge or an unfilled required
	 * field remains, it does NOT submit — it reports what's left so the human can
	 * fix it in the live view and try again. Completes the task on success.
	 */
	async resumeTakeover(taskId: string): Promise<{ submitted: boolean; resumed?: boolean; reason?: string; output?: unknown }> {
		const session = this.requireTakeover(taskId);
		const task = this.store.getTask(taskId);
		if (!task) throw new RunnerInputError("Task not found");
		const page = session.page;

		// Agent-driven applications are steered by the remote workflow. "Resume"
		// here just signals the human finished the stuck step (or solved a captcha);
		// the workflow polls humanDone and continues driving. Do NOT complete/submit.
		if (task.type === "job.apply_agent") {
			session.humanDone = true;
			this.addTaskEvent(task, "job.resumed", "Human finished the step — handing back to the agent");
			return { submitted: false, resumed: true, reason: "handed back to the agent — the agent is continuing" };
		}

		const challenge = await detectHumanChallenge(page);
		if (challenge && !(await challengeSolved(page))) {
			this.addTaskEvent(task, "job.human_challenge_present", `Challenge not yet solved: ${challenge}`);
			return { submitted: false, reason: `The ${challenge} challenge isn't solved yet — complete it in the live view, then submit again.` };
		}

		this.addTaskEvent(task, "job.resumed", "Human cleared the challenge; resuming");
		const beforeSubmitUrl = page.url();
		// Application tasks finish by submitting the form; other tasks (e.g.
		// browser.open / a captcha test) just need the challenge cleared.
		const submitsForm = task.type === "job.apply_basic" || task.type === "job.apply_authenticated";
		if (submitsForm) {
			try {
				const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
				this.addTaskEvent(task, "job.form.submit.started", "Submitting application form", { url: beforeSubmitUrl });
				await submitApplicationForm(page);
				await navigation;
				await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				this.addTaskEvent(task, "job.resume.blocked", reason);
				return { submitted: false, reason };
			}
		}

		const output = {
			taskType: task.type,
			submitted: submitsForm,
			challengeCleared: true,
			resumedAfterHuman: true,
			beforeSubmitUrl,
			finalUrl: page.url(),
			title: await page.title().catch(() => ""),
			visibleText: (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 1_500),
		};
		this.addTaskEvent(task, submitsForm ? "job.form.submit.completed" : "task.resumed.completed", submitsForm ? "Application submitted after human takeover" : "Challenge cleared after human takeover", output);
		task.status = "completed";
		task.output = output;
		task.error = undefined;
		task.updatedAt = new Date().toISOString();
		task.completedAt = task.updatedAt;
		this.store.putTask(task);
		this.addTaskEvent(task, "task.completed", `Task completed: ${task.type}`, output);
		await this.endTakeover(taskId);
		return { submitted: true, output };
	}

	/**
	 * Always attach files via Playwright, never a native OS dialog: intercept any
	 * file chooser this page opens (e.g. a résumé upload) and set the file
	 * programmatically. Works even when a REMOTE human clicks the upload button
	 * during a takeover — no local file picker is ever needed.
	 */
	private armFileAutoAttach(page: Page, filePath: string): void {
		page.on("filechooser", (chooser) => {
			chooser.setFiles(filePath).catch(() => undefined);
		});
	}

	/** End a takeover session (human finished or gave up). */
	async endTakeover(taskId: string): Promise<void> {
		const session = this.takeovers.get(taskId);
		if (session?.cdp) {
			if (session.screencasting) await session.cdp.send("Page.stopScreencast").catch(() => undefined);
			await session.cdp.detach().catch(() => undefined);
		}
		this.takeovers.delete(taskId);
	}

	private async execute(task: RunnerTask): Promise<unknown> {
		if (task.type === "echo") {
			return task.input;
		}
		if (task.type === "browser.open") {
			const url = String(task.input.url || "");
			if (!url || !/^https?:\/\//.test(url)) {
				throw new Error("browser.open requires an http(s) url");
			}
			const context = await this.getBrowserContext();
			const page = context.pages()[0] || (await context.newPage());
			// Auto-attach a file (e.g. résumé) via Playwright for any upload the
			// human triggers in the takeover — never a native picker.
			const attachPath = stringValue(task.input.resumePath ?? task.input.attachPath);
			if (attachPath && existsSync(resolve(attachPath))) {
				this.armFileAutoAttach(page, resolve(attachPath));
				this.addTaskEvent(task, "browser.file.armed", "File will auto-attach via Playwright", {
					file: basename(resolve(attachPath)),
				});
			}
			this.addTaskEvent(task, "browser.goto.started", "Opening browser page", { url });
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
			// If the page presents an anti-bot challenge, hand off to a human to
			// solve it via takeover (the same path job applications use).
			await this.guardHumanChallenge(task, page);
			// holdForTakeover: hand the page straight to a human to drive — for
			// complex multi-step sites (e.g. a Dayforce/Workday ATS) the agent
			// can't auto-fill, the human completes it in the live view.
			if (task.input.holdForTakeover) {
				const screenshotBase64 = await captureScreenshotDataUrl(page);
				this.takeovers.set(task.id, { page });
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
		if (task.type === "job.apply_basic") {
			return this.applyToBasicJob(task);
		}
		if (task.type === "job.apply_authenticated") {
			return this.applyToAuthenticatedJob(task);
		}
		throw new Error(`Unknown task type: ${task.type}`);
	}

	private async applyToBasicJob(task: RunnerTask): Promise<unknown> {
		const job = normalizeJobApplicationInput(task.input);
		const context = await this.getBrowserContext();
		const page = context.pages()[0] || (await context.newPage());
		// Any file chooser (résumé, supporting docs) auto-attaches via Playwright,
		// including if the flow hands off and a human clicks upload in takeover.
		this.armFileAutoAttach(page, job.resumePath);
		this.addTaskEvent(task, "browser.goto.started", "Opening job application page", {
			url: job.url,
		});
		await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
		this.addTaskEvent(task, "browser.goto.completed", "Job application page loaded", {
			url: page.url(),
			title: await page.title(),
		});

		this.addTaskEvent(task, "job.form.fill.started", "Filling application form", {
			candidate: {
				fullName: job.candidate.fullName,
				email: job.candidate.email,
			},
			resumeFile: basename(job.resumePath),
		});
		const filledFields = await fillBasicApplicationForm(page, job);
		this.addTaskEvent(task, "job.form.filled", "Application form fields completed", {
			fieldsFilled: filledFields,
			resumeFile: basename(job.resumePath),
		});
		await this.guardHumanChallenge(task, page);
		const beforeSubmitUrl = page.url();
		const navigation = page.waitForNavigation({
			waitUntil: "domcontentloaded",
			timeout: 15_000,
		}).catch(() => null);
		this.addTaskEvent(task, "job.form.submit.started", "Submitting application form", {
			url: beforeSubmitUrl,
		});
		await submitApplicationForm(page);
		await navigation;
		await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);

		const output = {
			taskType: "job.apply_basic",
			submitted: true,
			beforeSubmitUrl,
			finalUrl: page.url(),
			title: await page.title(),
			fieldsFilled: filledFields,
			resumeFile: basename(job.resumePath),
			visibleText: (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 2_000),
		};
		this.addTaskEvent(task, "job.form.submit.completed", "Application submission completed", output);
		return output;
	}

	/**
	 * Apply to a job that requires login/registration first.
	 * Flow: navigate → detect login requirement → register or login → fill form → submit
	 */
	private async applyToAuthenticatedJob(task: RunnerTask): Promise<unknown> {
		const input = normalizeAuthenticatedJobInput(task.input);
		const context = await this.getBrowserContext();
		const page = context.pages()[0] || (await context.newPage());

		// Step 1: Navigate to job page
		this.addTaskEvent(task, "browser.goto.started", "Opening job page", { url: input.url });
		await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
		this.addTaskEvent(task, "browser.goto.completed", "Job page loaded", {
			url: page.url(),
			title: await page.title(),
		});

		// Step 2: Check if we need to authenticate
		const needsAuth = await detectAuthRequirement(page);
		if (needsAuth) {
			this.addTaskEvent(task, "job.auth.required", "Authentication required", {
				loginDetected: true,
			});

			// Navigate to login page
			const loginUrl = input.loginUrl || await findLoginUrl(page, input.url);
			if (!loginUrl) throw new Error("Login required but no login URL found");

			await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

			if (input.registration && !input.accountExists) {
				// Register first
				this.addTaskEvent(task, "job.auth.register.started", "Registering new account");
				const registerUrl = await findRegisterUrl(page, loginUrl);
				if (registerUrl && registerUrl !== loginUrl) {
					await page.goto(registerUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
				}
				await fillRegistrationForm(page, input.registration);
				await submitForm(page);
				await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
				this.addTaskEvent(task, "job.auth.register.completed", "Registration submitted", {
					url: page.url(),
				});
			} else if (input.credentials) {
				// Login with existing credentials
				this.addTaskEvent(task, "job.auth.login.started", "Logging in");
				await fillLoginForm(page, input.credentials);
				await submitForm(page);
				await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
				this.addTaskEvent(task, "job.auth.login.completed", "Login submitted", {
					url: page.url(),
				});
			} else {
				throw new Error("Login required but no credentials or registration details provided");
			}

			// Verify we're logged in (check for common indicators)
			const stillNeedsAuth = await detectAuthRequirement(page);
			if (stillNeedsAuth) {
				// Try navigating back to the apply page — some sites redirect after login
				const applyUrl = input.url.includes("/apply") ? input.url : `${input.url}`;
				await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
				const thirdCheck = await detectAuthRequirement(page);
				if (thirdCheck) {
					throw new Error("Authentication failed — still seeing login/register prompts after login attempt");
				}
			}

			// Navigate to apply page (may have been redirected after login)
			if (!page.url().includes("apply")) {
				await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
			}
		}

		// Step 3: Look for the apply form (might be on current page or linked)
		const applyLink = await page.locator('a[href*="apply"], a:has-text("Apply")').first();
		if (await applyLink.count() > 0) {
			await humanApproach(page, await applyLink.boundingBox().catch(() => null));
			await applyLink.click();
			await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
		}

		// Step 4: Fill the application form
		this.addTaskEvent(task, "job.form.fill.started", "Filling application form");
		const filledFields = await fillBasicApplicationForm(page, input);
		this.addTaskEvent(task, "job.form.filled", "Form fields completed", {
			fieldsFilled: filledFields,
			resumeFile: basename(input.resumePath),
		});
		await this.guardHumanChallenge(task, page);

		// Step 5: Submit
		const beforeSubmitUrl = page.url();
		const navigation = page.waitForNavigation({
			waitUntil: "domcontentloaded",
			timeout: 15_000,
		}).catch(() => null);
		this.addTaskEvent(task, "job.form.submit.started", "Submitting application");
		await submitApplicationForm(page);
		await navigation;
		await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);

		const output = {
			taskType: "job.apply_authenticated",
			submitted: true,
			authenticated: needsAuth,
			beforeSubmitUrl,
			finalUrl: page.url(),
			title: await page.title(),
			fieldsFilled: filledFields,
			resumeFile: basename(input.resumePath),
			visibleText: (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 2_000),
		};
		this.addTaskEvent(task, "job.form.submit.completed", "Application submitted", output);
		return output;
	}

	private requireTask(id: string): RunnerTask {
		const task = this.store.getTask(id);
		if (!task) throw new Error(`Task not found: ${id}`);
		return task;
	}

	private async getBrowserContext(): Promise<BrowserContext> {
		if (this.browserContext) return this.browserContext;
		this.ensureChromiumInstalled();
		const profileDir = join(this.config.dataDir, "browser-profile");
		const downloadsPath = join(this.config.dataDir, "downloads");
		mkdirSync(profileDir, { recursive: true });
		mkdirSync(downloadsPath, { recursive: true });
		const playwright = await import("playwright").catch((error) => {
			throw new Error(
				`Playwright is not installed. Run pnpm install in the PAGS platform repo. ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		const baseOpts = {
			headless: this.config.headless,
			acceptDownloads: true,
			downloadsPath,
			// Light anti-detection: drop the most obvious automation tell so fewer
			// CAPTCHAs trigger in the first place (the human still solves the rest).
			args: ["--disable-blink-features=AutomationControlled"],
		};
		// Prefer the real Chrome build (better TLS/fingerprint → fewer CAPTCHAs);
		// fall back to bundled Chromium if Chrome isn't installed. Disable with
		// PAGS_RUNNER_CHROMIUM=1.
		//
		// Real-profile mode (PAGS_RUNNER_REAL_PROFILE=1, or an explicit
		// PAGS_RUNNER_CHROME_USER_DATA_DIR) uses YOUR actual Chrome profile —
		// cookies, logins, browsing history — which is the strongest way to look
		// human to CAPTCHA reputation scoring. Requires your normal Chrome to be
		// CLOSED (Chrome locks a profile to one running instance). Otherwise we
		// use a dedicated chrome-profile so we never fight your open browser.
		const preferChrome = process.env.PAGS_RUNNER_CHROMIUM !== "1";
		const realProfileDir = resolveRealChromeProfileDir();
		try {
			if (!preferChrome) throw new Error("chromium forced");
			if (realProfileDir) {
				// The seed is a snapshot; PAGS_RUNNER_REFRESH_PROFILE=1 re-copies it
				// so logins/cookies pick up changes from your everyday Chrome.
				const seedDir = join(this.config.dataDir, "real-profile-copy");
				if (process.env.PAGS_RUNNER_REFRESH_PROFILE === "1") rmSync(seedDir, { recursive: true, force: true });
				const seededDir = seedProfileCopy(realProfileDir, seedDir);
				if (!seededDir) throw new Error(`could not read your real Chrome profile at ${realProfileDir.userDataDir}`);
				this.browserContext = await playwright.chromium.launchPersistentContext(seededDir, {
					...baseOpts,
					channel: "chrome",
					args: [...baseOpts.args, "--profile-directory=Default"],
				});
				console.log(`[runner] launched a private copy of your real Chrome profile (signed-in sessions seeded from "${realProfileDir.profile}")`);
			} else {
				this.browserContext = await playwright.chromium.launchPersistentContext(
					join(this.config.dataDir, "chrome-profile"),
					{ ...baseOpts, channel: "chrome" },
				);
			}
		} catch (err) {
			if (realProfileDir) {
				const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
				console.warn(`[runner] real-profile launch failed (${msg}); falling back to a dedicated profile. Fully quit Chrome (Cmd+Q) to use your real profile.`);
			}
			this.browserContext = await playwright.chromium.launchPersistentContext(profileDir, baseOpts);
		}
		await this.browserContext
			.addInitScript(() => {
				Object.defineProperty(navigator, "webdriver", { get: () => undefined });
			})
			.catch(() => undefined);
		// Follow the active page: when the ATS opens a new tab/popup it becomes the
		// page both the brain and the human takeover act on. Without this, the
		// runner blindly used pages()[0] and the two could diverge.
		this.browserContext.on("page", (p) => this.trackPage(p));
		const initial = this.browserContext.pages()[0];
		if (initial) this.trackPage(initial);
		return this.browserContext;
	}

	/** Mark a page as the active one; fall back to the newest remaining page when it closes. */
	private trackPage(page: Page): void {
		this.activePage = page;
		page.once("close", () => {
			if (this.activePage === page) {
				this.activePage = this.browserContext?.pages().at(-1) ?? null;
			}
		});
	}

	/** The page the brain drives and the human takes over — created on demand. */
	private async getActivePage(): Promise<Page> {
		const context = await this.getBrowserContext();
		if (this.activePage && !this.activePage.isClosed()) return this.activePage;
		const page = context.pages().at(-1) ?? (await context.newPage());
		this.activePage = page;
		return page;
	}

	/**
	 * What the remote brain "sees": a compact ARIA tree (roles + accessible names
	 * + values + states) of the active page — the same representation the brain
	 * acts on via {@link browserAct}. No raw HTML/screenshots → cheap on tokens.
	 */
	async browserSnapshot(): Promise<{ url: string; title: string; snapshot: string; challenge: string | null; truncated: boolean }> {
		const page = await this.getActivePage();
		await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
		const full = await page.locator("body").ariaSnapshot().catch(() => "");
		const MAX = 16_000;
		const snapshot = full.length > MAX ? `${full.slice(0, MAX)}\n… [snapshot truncated]` : full;
		return {
			url: page.url(),
			title: await page.title().catch(() => ""),
			snapshot,
			challenge: await detectHumanChallenge(page),
			truncated: full.length > MAX,
		};
	}

	/**
	 * Perform one brain-issued action on the active page. Elements are addressed
	 * by ARIA role + accessible name (from the snapshot) via Playwright's
	 * getByRole — robust and selector-free. Returns the resulting page state.
	 */
	async browserAct(action: BrowserAction): Promise<{ ok: boolean; url: string; title: string; challenge: string | null }> {
		const page = await this.getActivePage();
		const locate = () => {
			const role = action.role as Parameters<Page["getByRole"]>[0] | undefined;
			let loc = role
				? page.getByRole(role, action.name ? { name: action.name } : undefined)
				: page.getByText(action.name ?? "", { exact: false });
			loc = typeof action.nth === "number" ? loc.nth(action.nth) : loc.first();
			return loc;
		};
		switch (action.action) {
			case "navigate":
				if (!action.url || !/^https?:\/\//.test(action.url)) throw new RunnerInputError("navigate requires an http(s) url");
				await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
				break;
			case "type": {
				const text = String(action.text ?? "");
				const loc = locate();
				// Plain fill, then combobox/label fill (the field may be a combobox or
				// typeahead, not a bare textbox), then click + keyboard type (typeaheads).
				if (await loc.fill(text, { timeout: 6_000 }).then(() => true).catch(() => false)) break;
				if (action.name && (await page.getByRole("combobox", { name: action.name }).fill(text, { timeout: 3_000 }).then(() => true).catch(() => false))) break;
				if (action.name && (await page.getByLabel(action.name).fill(text, { timeout: 3_000 }).then(() => true).catch(() => false))) break;
				await this.clickRobustly(page, loc);
				await page.keyboard.type(text, { delay: 15 }).catch(() => undefined);
				break;
			}
			case "click":
				if (!(await this.clickRobustly(page, locate()))) throw new RunnerInputError("could not click the target");
				break;
			case "select": {
				const value = String(action.text ?? "");
				const loc = locate();
				const pickOption = async () => {
					const opt = page.getByRole("option", { name: value, exact: false }).first();
					if ((await opt.count().catch(() => 0)) === 0) return false;
					return opt.click({ timeout: 2_500 }).then(() => true).catch(() => false);
				};
				// 1. Native <select>: exact label/value, then a fuzzy (case/punctuation
				//    -insensitive) match so "Decline to self-identify" hits the option
				//    "Decline To Self Identify".
				if (await loc.selectOption({ label: value }, { timeout: 4_000 }).then(() => true).catch(() => false)) break;
				if (await loc.selectOption(value, { timeout: 2_500 }).then(() => true).catch(() => false)) break;
				const fuzzy = await loc.evaluate((el, want) => {
					if (!(el instanceof HTMLSelectElement)) return false;
					const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
					const w = norm(want);
					const opt = Array.from(el.options).find((o) => { const t = norm(o.textContent || ""); return t === w || (w.length > 3 && (t.includes(w) || w.includes(t))); });
					if (!opt) return false;
					el.value = opt.value;
					el.dispatchEvent(new Event("input", { bubbles: true }));
					el.dispatchEvent(new Event("change", { bubbles: true }));
					return true;
				}, value).catch(() => false);
				if (fuzzy) break;
				// 2. Custom combobox / typeahead: open it, try a visible matching option.
				await this.clickRobustly(page, loc);
				await page.waitForTimeout(350).catch(() => undefined);
				if (await pickOption()) break;
				// 3. Typeahead: type to filter, then pick the suggestion — by click, else
				//    keyboard (ArrowDown+Enter), which beats clicking a dropdown that
				//    closes on blur.
				await page.keyboard.type(value, { delay: 15 }).catch(() => undefined);
				await page.waitForTimeout(550).catch(() => undefined);
				if (await pickOption()) break;
				await page.keyboard.press("ArrowDown").catch(() => undefined);
				await page.keyboard.press("Enter").catch(() => undefined);
				break;
			}
			case "check": {
				const loc = locate();
				// Custom checkboxes hide the real <input> (opacity:0 / behind a label /
				// a div[role=checkbox]). Try Playwright's check, then force, then a
				// direct DOM tick matched by the checkbox's label text.
				if (await loc.check({ timeout: 5_000 }).then(() => true).catch(() => false)) break;
				if (await loc.check({ force: true, timeout: 3_000 }).then(() => true).catch(() => false)) break;
				const ticked = await page
					.evaluate((rawName: string) => {
						const norm = (s: string | null | undefined) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
						const needle = norm(rawName).slice(0, 30);
						const boxes = Array.from(document.querySelectorAll<HTMLElement>('input[type="checkbox"], [role="checkbox"]'));
						const labelOf = (b: HTMLElement) => {
							const forId = b.id ? document.querySelector(`label[for="${b.id}"]`)?.textContent : "";
							return norm(b.closest("label")?.textContent || b.getAttribute("aria-label") || forId || b.parentElement?.textContent || "");
						};
						const tick = (b: HTMLElement) => {
							if (b instanceof HTMLInputElement) {
								b.checked = true;
								b.dispatchEvent(new Event("input", { bubbles: true }));
								b.dispatchEvent(new Event("change", { bubbles: true }));
							} else {
								b.setAttribute("aria-checked", "true");
							}
							b.click?.();
						};
						const match = boxes.find((b) => { const l = labelOf(b); return needle && (l.includes(needle) || (l.length > 12 && needle.includes(l.slice(0, 12)))); });
						const target = match || (boxes.length === 1 ? boxes[0] : undefined);
						if (!target) return false;
						tick(target);
						return true;
					}, action.name ?? "")
					.catch(() => false);
				if (ticked) break;
				if (!(await this.clickRobustly(page, locate()))) throw new RunnerInputError("could not find/tick the checkbox");
				break;
			}
			case "upload": {
				// Always attach via Playwright — never a native dialog. Handles both a
				// direct <input type=file> (set files on it) and a styled "Upload"
				// button that opens a native chooser (intercept the filechooser).
				const file = resolve(String(action.file ?? ""));
				if (!file || !existsSync(file)) throw new RunnerInputError("upload requires an existing local file path");
				let done = false;
				// 1. Label-associated input (some forms).
				if (action.name) {
					done = await page.getByLabel(action.name).setInputFiles(file, { timeout: 4_000 }).then(() => true).catch(() => false);
				}
				// 2. The real <input type=file> directly — most ATS (Greenhouse, Lever…)
				//    hide it behind a styled "Attach" button; setInputFiles works on a
				//    hidden input and fires the change event, no native dialog.
				if (!done) {
					done = await page.locator('input[type="file"]').first().setInputFiles(file, { timeout: 4_000 }).then(() => true).catch(() => false);
				}
				// 3. Styled uploader with no input at all: click the trigger + intercept
				//    the native file chooser.
				if (!done) {
					const chooserP = page.waitForEvent("filechooser", { timeout: 8_000 }).catch(() => null);
					await locate().click({ timeout: 8_000 }).catch(() => undefined);
					const chooser = await chooserP;
					if (chooser) await chooser.setFiles(file);
					else throw new RunnerInputError("no file upload control found for upload action");
				}
				break;
			}
			case "key":
				await page.keyboard.press(String(action.key ?? "Enter"));
				break;
			case "scroll":
				await page.mouse.wheel(0, action.dy ?? 600);
				break;
			case "wait":
				await page.waitForTimeout(Math.min(5_000, action.ms ?? 1_000));
				break;
			default:
				throw new RunnerInputError(`Unknown browser action: ${(action as BrowserAction).action}`);
		}
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
		return {
			ok: true,
			url: active.url(),
			title: await active.title().catch(() => ""),
			challenge: await detectHumanChallenge(active),
		};
	}

	/**
	 * Click an element through escalating fallbacks: normal → force (bypass
	 * actionability) → scroll-into-view + click the element's CENTER COORDINATES
	 * with the mouse. The coordinate click defeats custom-styled controls (hidden
	 * inputs, overlays) that swallow locator clicks. Returns false only if the
	 * element can't be located/positioned at all.
	 */
	private async clickRobustly(page: Page, loc: Locator): Promise<boolean> {
		if (await loc.click({ timeout: 6_000 }).then(() => true).catch(() => false)) return true;
		if (await loc.click({ force: true, timeout: 4_000 }).then(() => true).catch(() => false)) return true;
		await loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
		const box = await loc.boundingBox().catch(() => null);
		if (!box) return false;
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
		return true;
	}

	// ── Agent-driven application lifecycle (called by the remote Workflow brain) ──

	/** Append a decision/event to the agent task's activity (the console trace). */
	browserEvent(taskId: string, type: string, message: string, data?: unknown): { ok: boolean } {
		const task = this.store.getTask(taskId);
		if (task) this.addTaskEvent(task, type, message, data);
		return { ok: true };
	}

	/**
	 * Hand off for a CAPTCHA in the SAME session: register the live active page
	 * for remote takeover and flip the task to needs_human so the console shows
	 * the take-over view. The brain pauses; the human solves it on this page.
	 */
	async browserHandoff(taskId: string, label: string, reason = "challenge"): Promise<{ ok: boolean; screenshotBase64?: string }> {
		const page = await this.getActivePage();
		this.takeovers.set(taskId, { page, reason, humanDone: false });
		const screenshotBase64 = await captureScreenshotDataUrl(page);
		const task = this.store.getTask(taskId);
		if (task) {
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
		const page = session?.page ?? (await this.getActivePage());
		if (page.isClosed()) return { solved: true, challenge: null };
		// A needs_input handoff resumes once the user supplies the value.
		if (session?.reason === "needs_input") return { solved: !!session.inputValue, challenge: null, value: session.inputValue };
		// A stuck handoff resumes only when the human explicitly clicks Resume —
		// there's nothing to auto-detect.
		if (session?.reason === "stuck") return { solved: !!session.humanDone, challenge: null };
		// A challenge resumes when the token/widget clears OR the human clicks Done —
		// custom captchas (e.g. PageUp's "not a robot") have no detectable token, so
		// the human's explicit Done is the authority; never strand them.
		const challenge = await detectHumanChallenge(page);
		const solved = !challenge || (await challengeSolved(page)) || !!session?.humanDone;
		return { solved, challenge };
	}

	/** The user supplied the value the agent asked for (ask-and-hold). */
	browserSubmitInput(taskId: string, value: string): { ok: boolean } {
		const session = this.takeovers.get(taskId);
		if (session) session.inputValue = value;
		const task = this.store.getTask(taskId);
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
		if (task) {
			task.status = "running";
			task.updatedAt = new Date().toISOString();
			this.store.putTask(task);
			this.addTaskEvent(task, "job.resumed", "Challenge solved — agent resuming the application.");
		}
		return { ok: true };
	}

	/** Finalize an agent-driven application (submitted/expired → completed; else failed). */
	async browserComplete(taskId: string, outcome: string, detail?: string): Promise<{ ok: boolean }> {
		await this.endTakeover(taskId).catch(() => undefined);
		const task = this.store.getTask(taskId);
		if (task) {
			const success = outcome === "submitted" || outcome === "ready" || outcome === "expired";
			task.status = success ? "completed" : "failed";
			task.output = { outcome, detail };
			if (!success) task.error = detail || outcome;
			task.updatedAt = new Date().toISOString();
			task.completedAt = task.updatedAt;
			this.store.putTask(task);
			this.addTaskEvent(task, success ? "task.completed" : "task.failed", detail || `Application ${outcome}`, { outcome, detail });
		}
		return { ok: true };
	}

	private ensureChromiumInstalled(): void {
		if (this.chromiumInstallChecked) return;
		this.chromiumInstallChecked = true;
		if (process.env.PAGS_SKIP_PLAYWRIGHT_INSTALL === "1") return;

		const cli = join(dirname(require.resolve("playwright")), "cli.js");
		const result = spawnSync(process.execPath, [cli, "install", "chromium"], {
			stdio: "inherit",
			env: process.env,
		});

		if (result.status !== 0) {
			throw new Error(
				"Unable to install Playwright Chromium. Run `npx playwright install chromium` and retry.",
			);
		}
	}
}

function normalizeCreateTaskRequest(request: CreateTaskRequest): Required<CreateTaskRequest> {
	if (!isRecord(request) || typeof request.type !== "string" || !request.type.trim()) {
		throw new RunnerInputError("task type required");
	}
	return {
		type: request.type.trim().slice(0, 120),
		input: isRecord(request.input) ? request.input : {},
		requiresApproval: request.requiresApproval === true,
		approvalPrompt: typeof request.approvalPrompt === "string"
			? request.approvalPrompt.trim().slice(0, 500)
			: "",
	};
}

function validateTaskInput(type: string, input: Record<string, unknown>): void {
	if (type === "job.apply_basic") {
		normalizeJobApplicationInput(input);
		return;
	}
	if (type === "job.apply_authenticated") {
		normalizeAuthenticatedJobInput(input);
	}
}

export function fileUrl(path: string): string {
	return pathToFileURL(path).toString();
}
