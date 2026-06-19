import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserContext } from "playwright";
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
const APPROVAL_REQUIRED_TASKS = new Set(["browser.open"]);

export class RunnerInputError extends Error {
	readonly status = 400;
}

export class LocalRunner {
	private browserContext: BrowserContext | null = null;
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
			taskTypes: ["echo", "browser.open"],
			approvalRequiredFor: ["browser.open"],
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
		throw new Error(`Unknown task type: ${task.type}`);
	}

	private requireTask(id: string): RunnerTask {
		const task = this.store.getTask(id);
		if (!task) throw new Error(`Task not found: ${id}`);
		return task;
	}

	private async getBrowserContext(): Promise<BrowserContext> {
		if (this.browserContext) return this.browserContext;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
