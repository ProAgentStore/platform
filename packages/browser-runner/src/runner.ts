import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { humanApproach } from "./human-mouse.js";
import { RunnerStore } from "./store.js";
import type {
	CreateTaskRequest,
	RunnerCapability,
	RunnerConfig,
	RunnerTask,
	TakeoverInput,
} from "./types.js";

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

/** Raised when the model/runner cannot proceed and a human must take over. */
export class HumanHandoffError extends Error {
	constructor(
		message: string,
		readonly handoff: {
			reason: "challenge" | "exhausted_attempts" | "assist";
			challengeType?: string;
			url: string;
			attempts: number;
			screenshotBase64?: string;
		},
	) {
		super(message);
		this.name = "HumanHandoffError";
	}
}
const APPROVAL_REQUIRED_TASKS = new Set(["browser.open", "job.apply_basic", "job.apply_authenticated"]);
const require = createRequire(import.meta.url);

export class RunnerInputError extends Error {
	readonly status = 400;
}

export interface JobApplicationInput {
	url: string;
	resumePath: string;
	candidate: {
		fullName: string;
		email: string;
		phone?: string;
		location?: string;
		linkedin?: string;
		portfolio?: string;
		workAuthorization?: string;
	};
	coverNote?: string;
}

export interface AuthenticatedJobInput extends JobApplicationInput {
	/** Site credentials — if the job board requires login */
	credentials?: {
		email: string;
		password: string;
	};
	/** URL to the login page (auto-detected if not provided) */
	loginUrl?: string;
	/** Skip registration and assume account exists */
	accountExists?: boolean;
	/** Registration details if account needs to be created */
	registration?: {
		fullName: string;
		email: string;
		password: string;
	};
}

export class LocalRunner {
	private browserContext: BrowserContext | null = null;
	private chromiumInstallChecked = false;
	readonly store: RunnerStore;
	/** Live human-takeover sessions, keyed by task id (the page is kept alive). */
	private takeovers = new Map<
		string,
		{ page: Page; cdp?: CDPSession; latestFrame?: string; width?: number; height?: number; cssW?: number; cssH?: number; screencasting?: boolean }
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
			taskTypes: ["echo", "browser.open", "job.apply_basic", "job.apply_authenticated"],
			approvalRequiredFor: [...APPROVAL_REQUIRED_TASKS],
		};
	}

	createTask(request: CreateTaskRequest): RunnerTask {
		const normalized = normalizeCreateTaskRequest(request);
		validateTaskInput(normalized.type, normalized.input);
		const now = new Date().toISOString();
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
	async resumeTakeover(taskId: string): Promise<{ submitted: boolean; reason?: string; output?: unknown }> {
		const session = this.requireTakeover(taskId);
		const task = this.store.getTask(taskId);
		if (!task) throw new RunnerInputError("Task not found");
		const page = session.page;

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
		return this.browserContext;
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

export function normalizeJobApplicationInput(input: Record<string, unknown>): JobApplicationInput {
	const url = stringValue(input.url);
	if (!url || !/^https?:\/\//.test(url)) {
		throw new RunnerInputError("job application requires an http(s) url");
	}
	const resumePath = resolve(stringValue(input.resumePath));
	if (!resumePath || !existsSync(resumePath)) {
		throw new RunnerInputError("job application requires an existing local resumePath");
	}
	const candidate = isRecord(input.candidate) ? input.candidate : {};
	const fullName = stringValue(candidate.fullName);
	const email = stringValue(candidate.email);
	if (!fullName) throw new RunnerInputError("candidate.fullName is required");
	if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
		throw new RunnerInputError("candidate.email must be a valid email address");
	}
	return {
		url,
		resumePath,
		candidate: {
			fullName,
			email,
			phone: optionalString(candidate.phone),
			location: optionalString(candidate.location),
			linkedin: optionalString(candidate.linkedin),
			portfolio: optionalString(candidate.portfolio),
			workAuthorization: optionalString(candidate.workAuthorization),
		},
		coverNote: optionalString(input.coverNote),
	};
}

async function fillBasicApplicationForm(
	page: Page,
	job: JobApplicationInput,
): Promise<string[]> {
	const filled: string[] = [];
	const candidate = job.candidate;

	// Modern ATS forms (Lever, Greenhouse, Ashby) render their fields client-side
	// after load. Wait for the form to actually appear before scanning, instead
	// of failing in a few hundred ms against an empty DOM.
	await page
		.waitForSelector('input[type="file"], form input, form textarea', {
			state: "attached",
			timeout: 20_000,
		})
		.catch(() => undefined);

	const fillSpecs: Array<[string, string | undefined, string[]]> = [
		["fullName", candidate.fullName, [
			'input[name="fullName"]',
			'input[name="full_name"]',
			'input[name="name"]',
			'input[autocomplete="name"]',
		]],
		["email", candidate.email, [
			'input[name="email"]',
			'input[type="email"]',
			'input[autocomplete="email"]',
		]],
		["phone", candidate.phone, [
			'input[name="phone"]',
			'input[name="mobile"]',
			'input[autocomplete="tel"]',
		]],
		["location", candidate.location, [
			'input[name="location"]',
			'input[autocomplete="address-level2"]',
			'input[autocomplete="address-level1"]',
		]],
		["linkedin", candidate.linkedin, [
			'input[name="linkedin"]',
			'input[name="linkedIn"]',
			'input[placeholder*="LinkedIn" i]',
		]],
		["portfolio", candidate.portfolio, [
			'input[name="portfolio"]',
			'input[name="website"]',
			'input[placeholder*="Portfolio" i]',
			'input[placeholder*="Website" i]',
		]],
		["coverNote", job.coverNote, [
			'textarea[name="coverNote"]',
			'textarea[name="cover_letter"]',
			'textarea[name="coverLetter"]',
			'textarea[placeholder*="cover" i]',
			'textarea[placeholder*="message" i]',
		]],
	];

	for (const [name, value, selectors] of fillSpecs) {
		if (value && await fillFirst(page, selectors, value)) filled.push(name);
	}

	if (candidate.workAuthorization && await selectOrFillFirst(page, [
		'select[name="workAuthorization"]',
		'select[name="work_authorization"]',
		'select[name*="authorization" i]',
	], candidate.workAuthorization)) {
		filled.push("workAuthorization");
	}

	// The résumé input is often hidden (a styled button proxies it), so wait for
	// it to be ATTACHED rather than visible — setInputFiles works on hidden inputs.
	const resumeInput = page.locator(
		'input[type="file"][name*="resume" i], input[type="file"][name*="cv" i], input[type="file"][accept*="pdf" i], input[type="file"]',
	).first();
	try {
		await resumeInput.waitFor({ state: "attached", timeout: 15_000 });
	} catch {
		throw new Error("No resume upload field found on the application form");
	}
	await resumeInput.setInputFiles(job.resumePath);
	filled.push("resume");

	return filled;
}

async function fillFirst(
	page: Page,
	selectors: string[],
	value: string,
): Promise<boolean> {
	for (const selector of selectors) {
		const locator = page.locator(selector).first();
		if (await locator.count() === 0) continue;
		try {
			await locator.fill(value, { timeout: 5_000 });
			return true;
		} catch {
			/* try next selector */
		}
	}
	return false;
}

async function selectOrFillFirst(
	page: Page,
	selectors: string[],
	value: string,
): Promise<boolean> {
	for (const selector of selectors) {
		const locator = page.locator(selector).first();
		if (await locator.count() === 0) continue;
		try {
			await locator.selectOption({ label: value }, { timeout: 5_000 });
			return true;
		} catch {
			try {
				await locator.fill(value, { timeout: 5_000 });
				return true;
			} catch {
				/* try next selector */
			}
		}
	}
	return false;
}

async function submitApplicationForm(page: Page): Promise<void> {
	const form = page.locator("form").first();
	if (await form.count() === 0) throw new Error("No application form found to submit");

	// Never report a false success: if native validation would block the submit
	// (e.g. an unfilled required field, or a required <select> whose options
	// don't match the candidate's value), surface exactly which fields failed
	// instead of clicking into a no-op.
	const invalidFields = await form.evaluate((node) => {
		const f = node as HTMLFormElement;
		if (typeof f.checkValidity !== "function" || f.checkValidity()) return [] as string[];
		return Array.from(f.elements)
			.filter((el): el is HTMLInputElement => {
				const candidate = el as Partial<HTMLInputElement>;
				return typeof candidate.checkValidity === "function" && !candidate.checkValidity();
			})
			.map((el) => el.name || el.getAttribute("aria-label") || el.type || "field")
			.filter(Boolean);
	});
	if (Array.isArray(invalidFields) && invalidFields.length > 0) {
		throw new Error(
			`Application not submitted — these required fields could not be completed: ${invalidFields.join(", ")}`,
		);
	}

	const submit = page.locator(
		'form button[type="submit"], form input[type="submit"], button:has-text("Submit"), button:has-text("Apply"), input[type="submit"]',
	).first();
	if (await submit.count() > 0) {
		// Humanize the approach: arrive at the button along a natural arc before
		// the real click, so behavioral anti-bot scoring sees a hand, not a jump.
		await humanApproach(page, await submit.boundingBox().catch(() => null));
		await submit.click({ timeout: 10_000 });
		return;
	}
	await form.evaluate((node) => {
		const htmlForm = node as HTMLFormElement;
		if (typeof htmlForm.requestSubmit === "function") htmlForm.requestSubmit();
		else htmlForm.submit();
	});
}

/**
 * Detect an anti-bot human challenge on the page (reCAPTCHA, hCaptcha,
 * Cloudflare Turnstile, generic captcha). These can't be solved by the model,
 * so they trigger a handoff to a human rather than wasted retries.
 */
async function detectHumanChallenge(page: Page): Promise<string | null> {
	// Specific widget classes first so the label is accurate (hCaptcha ships a
	// reCAPTCHA-compat shim, so a generic reCAPTCHA check would mislabel it).
	const checks: Array<[string, string]> = [
		["hcaptcha", 'iframe[src*="hcaptcha"], .h-captcha'],
		["cloudflare-turnstile", 'iframe[src*="challenges.cloudflare.com"], .cf-turnstile'],
		["recaptcha", 'iframe[src*="recaptcha"], .g-recaptcha'],
		["captcha", 'iframe[title*="captcha" i], [class*="captcha" i], [id*="captcha" i]'],
	];
	for (const [type, selector] of checks) {
		if ((await page.locator(selector).count().catch(() => 0)) > 0) return type;
	}
	return null;
}

/**
 * Whether a detected challenge has actually been solved — i.e. the widget has
 * produced a response token. A solved captcha keeps its widget in the DOM, so
 * presence alone isn't "still blocked"; the token is the real signal.
 */
async function challengeSolved(page: Page): Promise<boolean> {
	return page
		.evaluate(() => {
			const names = ["h-captcha-response", "g-recaptcha-response", "cf-turnstile-response"];
			for (const n of names) {
				const el = document.querySelector(`textarea[name="${n}"], input[name="${n}"]`) as
					| HTMLInputElement
					| HTMLTextAreaElement
					| null;
				if (el && typeof el.value === "string" && el.value.length > 0) return true;
			}
			return false;
		})
		.catch(() => false);
}

/** Capture a downscaled JPEG screenshot as a data URL for the human-takeover UI. */
async function captureScreenshotDataUrl(page: Page): Promise<string | undefined> {
	try {
		const buf = await page.screenshot({ type: "jpeg", quality: 55 });
		return `data:image/jpeg;base64,${buf.toString("base64")}`;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the user's real Chrome profile when real-profile mode is enabled
 * (PAGS_RUNNER_REAL_PROFILE=1 or an explicit PAGS_RUNNER_CHROME_USER_DATA_DIR),
 * so the runner reuses their cookies/logins/history. Returns null otherwise.
 */
/**
 * Seed a dedicated profile directory with a copy of the user's real Chrome
 * profile — cookies, logins, history, local storage. This gives the runner the
 * user's signed-in sessions and a human browsing reputation WITHOUT attaching to
 * the live profile, so it never fights Chrome's single-instance lock and the
 * user can keep their normal Chrome open. Seeds once; delete the dir to refresh.
 * Returns the seeded user-data-dir, or null if the source profile is unreadable.
 */
function seedProfileCopy(real: { userDataDir: string; profile: string }, destUserDataDir: string): string | null {
	if (existsSync(destUserDataDir)) return destUserDataDir; // already seeded
	const srcProfile = join(real.userDataDir, real.profile);
	if (!existsSync(srcProfile)) return null;
	const destProfile = join(destUserDataDir, "Default");
	mkdirSync(destProfile, { recursive: true });
	try {
		// "Local State" holds the os_crypt key (Keychain-wrapped) that decrypts
		// cookies + saved passwords — without it the copied cookies are unreadable.
		copyFileSync(join(real.userDataDir, "Local State"), join(destUserDataDir, "Local State"));
	} catch {
		// best-effort
	}
	const items = [
		"Cookies",
		"Cookies-journal",
		"Login Data",
		"Login Data-journal",
		"Web Data",
		"History",
		"Preferences",
		"Bookmarks",
		"Favicons",
		"Network",
		"Local Storage",
		"Session Storage",
		"Sessions",
		"IndexedDB",
	];
	for (const item of items) {
		try {
			cpSync(join(srcProfile, item), join(destProfile, item), { recursive: true });
		} catch {
			// best-effort per item
		}
	}
	return destUserDataDir;
}

function resolveRealChromeProfileDir(): { userDataDir: string; profile: string } | null {
	const explicit = process.env.PAGS_RUNNER_CHROME_USER_DATA_DIR;
	if (process.env.PAGS_RUNNER_REAL_PROFILE !== "1" && !explicit) return null;
	const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
	const profile = process.env.PAGS_RUNNER_CHROME_PROFILE || "Default";
	if (explicit) return { userDataDir: expand(explicit), profile };
	let userDataDir: string;
	if (process.platform === "darwin") {
		userDataDir = join(homedir(), "Library", "Application Support", "Google", "Chrome");
	} else if (process.platform === "win32") {
		userDataDir = join(homedir(), "AppData", "Local", "Google", "Chrome", "User Data");
	} else {
		userDataDir = join(homedir(), ".config", "google-chrome");
	}
	return existsSync(userDataDir) ? { userDataDir, profile } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return String(value || "").trim();
}

function optionalString(value: unknown): string | undefined {
	const text = stringValue(value);
	return text || undefined;
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

// ── Authenticated job application helpers ─────────────────────────────────

export function normalizeAuthenticatedJobInput(input: Record<string, unknown>): AuthenticatedJobInput {
	const base = normalizeJobApplicationInput(input);
	const credentials = isRecord(input.credentials) ? input.credentials : undefined;
	const registration = isRecord(input.registration) ? input.registration : undefined;

	return {
		...base,
		credentials: credentials ? {
			email: stringValue(credentials.email),
			password: stringValue(credentials.password),
		} : undefined,
		loginUrl: optionalString(input.loginUrl),
		accountExists: input.accountExists === true,
		registration: registration ? {
			fullName: stringValue(registration.fullName),
			email: stringValue(registration.email),
			password: stringValue(registration.password),
		} : undefined,
	};
}

async function detectAuthRequirement(page: Page): Promise<boolean> {
	const body = await page.locator("body").innerHTML({ timeout: 5_000 }).catch(() => "");
	const lower = body.toLowerCase();
	// Check for login/register prompts
	const hasLoginForm = await page.locator(
		'input[type="password"], form[action*="login"], form[action*="signin"]',
	).count() > 0;
	const hasLoginText = /sign\s*in|log\s*in|create\s*(an\s*)?account|register\s*to\s*apply/i.test(lower);
	const hasLoginLink = await page.locator(
		'a[href*="login"], a[href*="signin"], a[href*="register"]',
	).count() > 0;
	return hasLoginForm || (hasLoginText && hasLoginLink);
}

async function findLoginUrl(page: Page, baseUrl: string): Promise<string | null> {
	const loginLink = page.locator(
		'a[href*="login"], a[href*="signin"], a:has-text("Sign in"), a:has-text("Log in")',
	).first();
	if (await loginLink.count() > 0) {
		const href = await loginLink.getAttribute("href");
		if (href) return new URL(href, baseUrl).toString();
	}
	return null;
}

async function findRegisterUrl(page: Page, baseUrl: string): Promise<string | null> {
	const regLink = page.locator(
		'a[href*="register"], a[href*="signup"], a:has-text("Create account"), a:has-text("Sign up")',
	).first();
	if (await regLink.count() > 0) {
		const href = await regLink.getAttribute("href");
		if (href) return new URL(href, baseUrl).toString();
	}
	return null;
}

async function fillLoginForm(
	page: Page,
	credentials: { email: string; password: string },
): Promise<void> {
	await fillFirst(page, [
		'input[name="email"]',
		'input[type="email"]',
		'input[autocomplete="email"]',
		'input[autocomplete="username"]',
		'input[name="username"]',
	], credentials.email);
	await fillFirst(page, [
		'input[name="password"]',
		'input[type="password"]',
		'input[autocomplete="current-password"]',
	], credentials.password);
}

async function fillRegistrationForm(
	page: Page,
	registration: { fullName: string; email: string; password: string },
): Promise<void> {
	await fillFirst(page, [
		'input[name="fullName"]',
		'input[name="full_name"]',
		'input[name="name"]',
		'input[autocomplete="name"]',
	], registration.fullName);
	await fillFirst(page, [
		'input[name="email"]',
		'input[type="email"]',
		'input[autocomplete="email"]',
	], registration.email);
	await fillFirst(page, [
		'input[name="password"]',
		'input[type="password"]',
		'input[autocomplete="new-password"]',
	], registration.password);
}

async function submitForm(page: Page): Promise<void> {
	const submit = page.locator(
		'button[type="submit"], input[type="submit"]',
	).first();
	if (await submit.count() > 0) {
		// Humanize the approach: arrive at the button along a natural arc before
		// the real click, so behavioral anti-bot scoring sees a hand, not a jump.
		await humanApproach(page, await submit.boundingBox().catch(() => null));
		await submit.click({ timeout: 10_000 });
		return;
	}
	const form = page.locator("form").first();
	if (await form.count() > 0) {
		await form.evaluate((node) => {
			const f = node as HTMLFormElement;
			if (typeof f.requestSubmit === "function") f.requestSubmit();
			else f.submit();
		});
	}
}
