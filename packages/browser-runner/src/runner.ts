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
const APPROVAL_REQUIRED_TASKS = new Set(["browser.open", "job.apply_basic"]);
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
			runtime: "local-browser-runner",
			brainPlacement: "pags",
			runnerRole: "tool-executor",
			capabilities: CAPABILITIES,
			taskTypes: ["echo", "browser.open", "job.apply_basic"],
			approvalRequiredFor: [...APPROVAL_REQUIRED_TASKS],
		};
	}

	createTask(request: CreateTaskRequest): RunnerTask {
		const normalized = normalizeCreateTaskRequest(request);
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
		this.store.addEvent({
			taskId: task.id,
			type: "task.created",
			message: `Task created: ${task.type}`,
			data: { status: task.status },
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
		this.store.addEvent({
			taskId: task.id,
			type: "task.approved",
			message: `Task approved: ${task.type}`,
		});
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
		this.store.addEvent({
			taskId: task.id,
			type: "task.cancelled",
			message: `Task cancelled: ${task.type}`,
		});
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
		this.store.addEvent({
			taskId: task.id,
			type: "task.running",
			message: `Task running: ${task.type}`,
		});

		try {
			const output = await this.execute(task);
			task.status = "completed";
			task.output = output;
			task.updatedAt = new Date().toISOString();
			task.completedAt = task.updatedAt;
			this.store.putTask(task);
			this.store.addEvent({
				taskId: task.id,
				type: "task.completed",
				message: `Task completed: ${task.type}`,
				data: output,
			});
		} catch (error) {
			task.status = "failed";
			task.error = error instanceof Error ? error.message : String(error);
			task.updatedAt = new Date().toISOString();
			task.completedAt = task.updatedAt;
			this.store.putTask(task);
			this.store.addEvent({
				taskId: task.id,
				type: "task.failed",
				message: task.error,
			});
		}
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
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
			return {
				url: page.url(),
				title: await page.title(),
			};
		}
		if (task.type === "job.apply_basic") {
			return this.applyToBasicJob(task.input);
		}
		throw new Error(`Unknown task type: ${task.type}`);
	}

	private async applyToBasicJob(input: Record<string, unknown>): Promise<unknown> {
		const job = normalizeJobApplicationInput(input);
		const context = await this.getBrowserContext();
		const page = context.pages()[0] || (await context.newPage());
		await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

		const filledFields = await fillBasicApplicationForm(page, job);
		const beforeSubmitUrl = page.url();
		const navigation = page.waitForNavigation({
			waitUntil: "domcontentloaded",
			timeout: 15_000,
		}).catch(() => null);
		await submitApplicationForm(page);
		await navigation;
		await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);

		return {
			taskType: "job.apply_basic",
			submitted: true,
			beforeSubmitUrl,
			finalUrl: page.url(),
			title: await page.title(),
			fieldsFilled: filledFields,
			resumeFile: basename(job.resumePath),
			visibleText: (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 2_000),
		};
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
		throw new RunnerInputError("job.apply_basic requires an http(s) url");
	}
	const resumePath = resolve(stringValue(input.resumePath));
	if (!resumePath || !existsSync(resumePath)) {
		throw new RunnerInputError("job.apply_basic requires an existing resumePath");
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

	const resumeInput = page.locator(
		'input[type="file"][name*="resume" i], input[type="file"][name*="cv" i], input[type="file"]',
	).first();
	if (await resumeInput.count() === 0) {
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
	const submit = page.locator(
		'form button[type="submit"], form input[type="submit"], button:has-text("Submit"), input[type="submit"]',
	).first();
	if (await submit.count() > 0) {
		await submit.click({ timeout: 10_000 });
		return;
	}

	const form = page.locator("form").first();
	if (await form.count() === 0) throw new Error("No application form found to submit");
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

export function fileUrl(path: string): string {
	return pathToFileURL(path).toString();
}
