import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserContext, Page } from "playwright";
import { RunnerStore } from "./store.js";
import type {
	CreateTaskRequest,
	RunnerCapability,
	RunnerConfig,
	RunnerTask,
} from "./types.js";

const CAPABILITIES: RunnerCapability[] = [
	"browser.playwright",
	"browser.screenshot",
	"downloads",
	"file.upload",
	"human.approval",
];
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

	constructor(readonly config: RunnerConfig) {
		mkdirSync(config.dataDir, { recursive: true });
		this.store = new RunnerStore(config.dataDir);
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
			this.addTaskEvent(task, "browser.goto.started", "Opening browser page", { url });
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
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
		this.browserContext = await playwright.chromium.launchPersistentContext(profileDir, {
			headless: this.config.headless,
			acceptDownloads: true,
			downloadsPath,
		});
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
		await submit.click({ timeout: 10_000 });
		return;
	}
	await form.evaluate((node) => {
		const htmlForm = node as HTMLFormElement;
		if (typeof htmlForm.requestSubmit === "function") htmlForm.requestSubmit();
		else htmlForm.submit();
	});
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
