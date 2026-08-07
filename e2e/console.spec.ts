import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const API = "https://api.proagentstore.online";
const TEST_TOKEN = "test-pags-token";

interface OpsMockOptions {
	agents?: Array<Record<string, unknown>>;
	instances?: Array<Record<string, unknown>>;
	runtime?: Record<string, unknown> | null;
	runtimeTasks?: Array<Record<string, unknown>>;
	runtimeEvents?: Array<Record<string, unknown>>;
	board?: Record<string, unknown>;
	appRecords?: Array<Record<string, unknown>>;
	instanceChatStatus?: number;
	instanceChatBody?: Record<string, unknown>;
	boardConfig?: Record<string, unknown> | null;
	ops?: Record<string, unknown>;
	verifyStatus?: number;
	verifyBody?: Record<string, unknown>;
	deployStatus?: number;
	deployBody?: Record<string, unknown>;
	/**
	 * Real-shaped account data. The defaults below are deliberately tiny ("user-1", "tester", no
	 * profile fields, no providers), which is why the mobile-overflow guard passed on a Profile
	 * page that overflows in production: three of that page's sections never rendered under the
	 * fixture, and the two that did held strings a real account never has (#235).
	 */
	user?: Record<string, unknown>;
	profile?: { fields: Array<Record<string, unknown>>; profile: Record<string, string> };
	providers?: Array<Record<string, unknown>>;
}

function defaultOpsPayload() {
	return {
		agent: {
			id: "agent-1",
			slug: "ops-agent",
			name: "Ops Agent",
			model: "@cf/meta/llama-3.2-3b-instruct",
			visibility: "draft",
			status: "inactive",
			workerUrl: "https://ops-agent.proagentstore.online/",
		},
		billing: {
			provider: "cloudflare",
			mode: "user-owned",
			hasCloudflareKey: true,
			createdAt: "2026-06-10T01:00:00Z",
			lastUsedAt: "2026-06-10T02:00:00Z",
		},
		deploy: {
			configured: true,
			org: "ProAgentStore",
			repo: "ops-agent",
			runs: [
				{
					id: 1,
					name: "Deploy",
					status: "completed",
					conclusion: "success",
					url: "https://github.com/ProAgentStore/ops-agent/actions/runs/1",
					createdAt: "2026-06-10T03:00:00Z",
					updatedAt: "2026-06-10T03:01:00Z",
				},
			],
		},
		executions: [
			{
				id: "exec-1",
				model: "@cf/meta/llama-3.2-3b-instruct",
				duration_ms: 123,
				error: null,
				created_at: "2026-06-10T04:00:00Z",
			},
		],
	};
}

async function mockSignedInConsole(page: Page, options: OpsMockOptions = {}) {
	await page.addInitScript((token) => {
		window.localStorage.setItem("pags:session", token);
	}, TEST_TOKEN);

	let verifyCalls = 0;
	let deployCalls = 0;
	let approvedTaskId: string | null = null;
	let cancelledTaskId: string | null = null;
	const profileUpdates: unknown[] = [];
	let savedPreferences: unknown = null;
	const loopStarts: unknown[] = [];
	const systemMessages: string[] = [];
	const persistedMessages: Array<Record<string, unknown>> = [];
	let loopPolls = 0;
	let voiceOverrideCleared = false;
	const builderPlans: unknown[] = [];
	const builderExecutes: unknown[] = [];

	await page.route(`${API}/**`, async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		const method = route.request().method();

		const json = (data: unknown, status = 200) =>
			route.fulfill({
				status,
				contentType: "application/json",
				body: JSON.stringify(data),
			});

		if (path === "/health") return json({ ok: true, service: "proagentstore-api" });
		if (path.startsWith("/v1/")) {
			expect(route.request().headers().authorization).toBe(`Bearer ${TEST_TOKEN}`);
		}
		if (path === "/v1/auth/me" && method === "PUT") {
			profileUpdates.push(route.request().postDataJSON());
			return json({ success: true });
		}
		if (path === "/v1/auth/me") {
			return json({
				id: "user-1",
				login: "tester",
				name: "Test User",
				display_name: "Test User",
				avatar: "https://example.com/avatar.png",
				roles: ["user", "creator"],
				boardConfig: options.boardConfig ?? null,
				...(options.user ?? {}),
			});
		}
		if (path === "/v1/notifications") return json({ notifications: [], unreadCount: 0 });
		if (path === "/v1/agent-builder/plan" && method === "POST") {
			builderPlans.push(route.request().postDataJSON());
			return json({
				plan: {
					intent: "Create an agent that reviews Google Docs in a project folder and summarizes contract risks.",
					action: "create_agent",
					agent: {
						slug: "contract-review-agent",
						name: "Contract Review Agent",
						description: "Reviews Google Docs in a project folder and summarizes contract risks.",
						category: "productivity",
						model: "@cf/meta/llama-3.2-3b-instruct",
						personality: "Careful and explicit about assumptions.",
						goal: "Review project documents and summarize contract risks.",
					},
					runtime: { kind: "hosted", reason: "Can run as a hosted knowledge agent." },
					connectors: [
						{ provider: "google_drive", reason: "Needs Google Docs access.", requiredGrant: "folder" },
					],
					suggestedSurfaces: ["chat", "knowledge", "settings"],
					warnings: ["Connector access is not granted automatically."],
					dryRun: { endpoint: "/v1/agents", method: "POST", body: {} },
				},
			});
		}
		if (path === "/v1/agent-builder/execute" && method === "POST") {
			builderExecutes.push(route.request().postDataJSON());
			return json({ result: { agentId: "agent-1", slug: "contract-review-agent", action: "create_agent", connectors: [], nextSteps: [] } }, 201);
		}
		if (path === "/v1/agents/my/agents") {
			return json({
				agents: options.agents ?? [
					{
						id: "agent-1",
						slug: "ops-agent",
						name: "Ops Agent",
						description: "Agent with ops controls",
						category: "general",
						visibility: "draft",
						status: "inactive",
						model: "@cf/meta/llama-3.2-3b-instruct",
					},
				],
			});
		}
		if (path === "/v1/agents/agent-1") {
			return json({
				id: "agent-1",
				slug: "ops-agent",
				name: "Ops Agent",
				description: "Agent with ops controls",
				category: "general",
				visibility: "draft",
				status: "inactive",
				model: "@cf/meta/llama-3.2-3b-instruct",
			});
		}
		if (path === "/v1/agents/agent-1/state") {
			return json({
				name: "Ops Agent",
				model: "@cf/meta/llama-3.2-3b-instruct",
				guardrails: {},
			});
		}
		if (path === "/v1/agents/agent-1/messages") return json({ messages: [] });
		if (path === "/v1/agents/agent-1/knowledge") return json({ documents: [] });
		if (path === "/v1/agents/agent-1/memory") return json({ memory: [] });
		if (path === "/v1/agents/agent-1/tasks") return json({ tasks: [] });
		if (path === "/v1/agents/agent-1/analytics") {
			return json({
				totalSubscribers: 0,
				totalChats: 0,
				totalExecutions: 1,
				dailyUsage: [],
				recentExecutions: [],
			});
		}
		if (path === "/v1/agents/agent-1/versions") return json({ versions: [] });
		if (path === "/v1/agents/agent-1/ops") {
			return json(options.ops ?? defaultOpsPayload());
		}
		if (path === "/v1/keys/cloudflare/verify" && method === "POST") {
			verifyCalls += 1;
			return json(
				options.verifyBody ?? { ok: true, provider: "cloudflare" },
				options.verifyStatus ?? 200,
			);
		}
		if (path === "/v1/agents/agent-1/deploy" && method === "POST") {
			deployCalls += 1;
			return json(
				options.deployBody ?? { queued: true, repo: "ops-agent", org: "ProAgentStore" },
				options.deployStatus ?? 200,
			);
		}
		if (path === "/v1/instances/my/instances") {
			return json({
				instances: options.instances ?? [
					{
						id: "inst-1",
						name: "Job Application Assistant",
						description: "Apply to jobs through a local browser runtime",
						slug: "job-application-assistant",
						category: "productivity",
						icon_bg: "#7c3aed",
						capabilities: { surfaces: ["apply"], runtime: "browser", workflow: "apply" },
					},
				],
			});
		}
		if (path === "/v1/instances/inst-1/messages") return json({ messages: persistedMessages });
		// #358: the action vocabulary, judged against THIS instance. The console renders its
		// picker from this and holds no list of its own — the old hardcoded one offered "Run
		// browser task" on every agent, including the 25 of 26 that would refuse it.
		if (path === "/v1/triggers/actions" && method === "GET") {
			const reason = 'This agent cannot drive a browser: doing that needs an agent declaring capabilities.workflow = "BROWSER_TASK", and this one declares "JOB_APPLY". Declare it on the agent, or pick an action this agent can run.';
			return json({
				actions: [
					{ action: "create_task", label: "Create task", available: true, reason: null, requires: null },
					{ action: "add_knowledge", label: "Add knowledge", available: true, reason: null, requires: null },
					{ action: "sync_connector", label: "Sync folder", available: true, reason: null, requires: null },
					{ action: "run_pipeline", label: "Run pipeline", available: true, reason: null, requires: null },
					{ action: "insert_record", label: "Insert record", available: true, reason: null, requires: null },
					{ action: "run_browse", label: "Run browser task", available: false, reason, requires: 'capabilities.workflow = "BROWSER_TASK"' },
					{ action: "log_event", label: "Log event", available: true, reason: null, requires: null },
				],
			});
		}
		if (path === "/v1/triggers" && method === "GET") {
			return json({
				triggers: [
					{
						id: "trigger-1",
						name: "Daily digest",
						type: "cron",
						action: "create_task",
						enabled: true,
						schedule: "@daily",
						nextRunAt: "2026-07-13T00:00:00.000Z",
					},
					// A row saved before the create-time gate existed: a schedule wired to an action
					// this agent can never perform. It used to look exactly as healthy as the others.
					{
						id: "trigger-browse",
						name: "Nightly portal check",
						type: "cron",
						action: "run_browse",
						enabled: true,
						schedule: "@daily",
						config: { url: "https://portal.test/jobs" },
						unavailable: 'This agent cannot drive a browser: doing that needs an agent declaring capabilities.workflow = "BROWSER_TASK", and this one declares "JOB_APPLY". Declare it on the agent, or pick an action this agent can run.',
					},
					{
						id: "trigger-sync",
						name: "Drive sync",
						type: "cron",
						action: "sync_connector",
						enabled: true,
						schedule: "@hourly",
						config: { provider: "google_drive", grantId: "grant-drive" },
						lastRunAt: "2026-07-12T23:30:00.000Z",
						nextRunAt: "2026-07-13T00:30:00.000Z",
					},
				],
			});
		}
		// #18: the next-run preview is computed by the SERVER (there is deliberately no client-side
		// scheduler), so the console cannot render one without this call. #16: the same response
		// carries the config problems that would otherwise be silently swallowed.
		if (path === "/v1/triggers/preview" && method === "POST") {
			const body = route.request().postDataJSON() as { type?: string; action?: string; schedule?: string; config?: Record<string, unknown> };
			const issues: string[] = [];
			if (body.type === "cron" && body.action === "run_pipeline" && !body.config?.pipeline) {
				issues.push("A scheduled pipeline run needs the pipeline name.");
			}
			return json({
				schedule: body.schedule ?? null,
				timezone: (body.config?.timezone as string) ?? null,
				jitterMinutes: (body.config?.jitterMinutes as number) ?? null,
				runs: body.type === "cron" ? ["2026-07-13T22:00:00.000Z", "2026-07-14T22:00:00.000Z"] : [],
				issues,
				error: null,
			});
		}
		if (path === "/v1/triggers" && method === "POST") {
			// Mirror the API's validator (#16): a CRON run_pipeline without a pipeline name can
			// only ever fail at 3am, so it is refused at the save instead.
			const body = route.request().postDataJSON() as { type?: string; action?: string; config?: Record<string, unknown> };
			if (body.type === "cron" && body.action === "run_pipeline" && !body.config?.pipeline) {
				return json({ error: "A scheduled pipeline run needs the pipeline name." }, 400);
			}
			return json({ trigger: { id: "trigger-2" } }, 201);
		}
		if (path === "/v1/triggers/trigger-1/events" && method === "GET") {
			return json({
				events: [
					{
						id: "ev-fail",
						trigger_id: "trigger-1",
						type: "cron",
						status: "failed",
						message: null,
						payload: { schedule: "@daily" },
						error: "task dispatch failed (500)",
						created_at: "2026-07-12T00:00:00.000Z",
					},
					{
						id: "ev-ok",
						trigger_id: "trigger-1",
						type: "manual",
						status: "succeeded",
						message: "create_task dispatched",
						payload: { title: "Yesterday's digest" },
						error: null,
						created_at: "2026-07-11T00:00:00.000Z",
					},
				],
			});
		}
		if (path === "/v1/triggers/trigger-sync/events" && method === "GET") {
			return json({
				events: [
					{
						id: "sync-event-1",
						trigger_id: "trigger-sync",
						type: "cron",
						status: "succeeded",
						message: "connector sync imported 1 file(s), skipped 2",
						payload: { provider: "google_drive", grantId: "grant-drive", scanned: 3, imported: 1, skipped: 2, errors: [] },
						error: null,
						created_at: "2026-07-12T23:30:00.000Z",
					},
				],
			});
		}
		if (path === "/v1/triggers/trigger-1/run" && method === "POST") return json({ success: true });
		if (path === "/v1/triggers/trigger-1" && method === "DELETE") return json({ success: true });
		// Server-driven Loop (#158/#210): start returns the DRIVER it dispatched to, and the poll
		// reports the run. A coding agent's loop drives the engine, not this chat.
		if (path === "/v1/instances/inst-1/loop" && method === "POST") {
			loopStarts.push(route.request().postDataJSON());
			return json({ runId: "run-1", driver: "coding", maxIterations: 10, status: "running" }, 201);
		}
		if (path === "/v1/instances/inst-1/loop/run-1") {
			// First poll: still running. After that: done, so the completion message renders.
			loopPolls += 1;
			if (loopPolls < 2) return json({ status: "running", iteration: 1 });
			// The workflow already appended the outcome to the thread, exactly as the real one does.
			const done = "**Loop complete**\n\nFixed it on `fix/80` (commit `e599f2b`). **All 758 tests pass.**";
			if (!persistedMessages.some((m) => String(m.content).includes("Loop complete"))) {
				persistedMessages.push({ role: "system", content: done, createdAt: new Date().toISOString() });
			}
			return json({ status: "completed", iteration: 2, stopReason: "done", detail: "outcome: done — Fixed it." });
		}
		if (path === "/v1/instances/inst-1/system-message" && method === "POST") {
			// The real DO PERSISTS it, so the next /messages read returns it. Without that here the
			// loop's own poll — which refetches the transcript — would wipe the optimistic message
			// the client just added, and the test would be asserting against a mock that behaves
			// differently from the server in exactly the way that matters.
			const content = (route.request().postDataJSON() as { content: string }).content;
			systemMessages.push(content);
			persistedMessages.push({ role: "system", content, createdAt: new Date().toISOString() });
			return json({ ok: true });
		}
		if (path === "/v1/instances/inst-1/chat" && method === "POST") {
			return json(
				options.instanceChatBody ?? {
					message: { role: "assistant", content: "Mock assistant reply" },
				},
				options.instanceChatStatus ?? 200,
			);
		}
		if (path === "/v1/instances/inst-1/knowledge") {
			return json({
				documents: [
					{
						id: "doc-indexed",
						title: "Profile summary",
						content: "Candidate profile summary for search.",
						source: "paste",
						addedAt: "2026-07-12T22:00:00.000Z",
					},
					{
						id: "doc-pending",
						title: "Pending contract notes",
						content: "Contract notes waiting to be embedded.",
						source: "drive",
						addedAt: "2026-07-12T23:00:00.000Z",
					},
				],
			});
		}
		if (path === "/v1/instances/inst-1/memory") return json({ memory: [] });
		if (path === "/v1/instances/inst-1/files") {
			return json({
				files: [
					{
						id: "file-indexed",
						name: "Resume.pdf",
						mimeType: "application/pdf",
						size: 184000,
						extractionStatus: "extracted",
						extractedTextLength: 12000,
						createdAt: "2026-07-12T21:30:00.000Z",
					},
				],
			});
		}
		if (path === "/v1/instances/inst-1/vectors") {
			return json({
				totalSources: 2,
				totalChunks: 6,
				totalChars: 14320,
				sources: [
					{
						sourceType: "knowledge",
						sourceId: "doc-indexed",
						name: "Profile summary",
						chunks: 2,
						chars: 1320,
						lastIndexed: "2026-07-12T22:01:00.000Z",
						preview: "Candidate profile summary for search.",
					},
					{
						sourceType: "file",
						sourceId: "file-indexed",
						name: "Resume.pdf",
						chunks: 4,
						chars: 13000,
						lastIndexed: "2026-07-12T21:31:00.000Z",
						preview: "Resume extract with skills and roles.",
					},
				],
			});
		}
		// Stats (#311). One card of every kind, plus the two states that must LOOK different from
		// data: a gap inside a trend, and a card that failed.
		if (path === "/v1/stats/sources") {
			return json({
				maxCards: 12,
				sources: [
					{
						id: "runs.count",
						label: "Agent runs",
						describes: "Durable agent-loop runs started.",
						caveat: "Counts runs STARTED in the period, including ones still running.",
						unit: "count",
						kinds: ["number", "line"],
						families: ["point_in_time", "trend"],
						params: [],
					},
				],
			});
		}
		if (path === "/v1/instances/inst-1/stats" && method === "GET") {
			return json({
				window: 30,
				throughDay: "2026-08-06",
				historyStart: "2026-08-02",
				cards: [
					{
						id: "runs",
						title: "Agent runs",
						kind: "number",
						source: "runs.count",
						family: "point_in_time",
						caveat: "Counts runs STARTED in the period, including ones still running.",
						data: { type: "scalar", value: 12, unit: "count" },
					},
					{
						id: "daily-runs",
						title: "Runs per day",
						kind: "line",
						source: "runs.count",
						family: "trend",
						caveat: "Counts runs STARTED in the period, including ones still running.",
						data: {
							type: "series",
							unit: "count",
							points: [
								{ day: "2026-08-02", value: 3 },
								{ day: "2026-08-03", value: 0 },
								{ day: "2026-08-04", value: null },
								{ day: "2026-08-05", value: 5 },
								{ day: "2026-08-06", value: 4 },
							],
						},
					},
					{
						id: "outcomes",
						title: "Runs by outcome",
						kind: "bar",
						source: "runs.outcome",
						family: "point_in_time",
						caveat: "Groups by current status.",
						data: { type: "groups", rows: [{ label: "done", value: 9 }, { label: "failed", value: 0 }] },
					},
					{
						id: "broken",
						title: "Leads by suburb",
						kind: "table",
						source: "collection.group_by",
						family: "point_in_time",
						caveat: "Scans at most 500 records.",
						error: "no such collection: leads",
					},
				],
			});
		}
		if (path === "/v1/instances/inst-1/credentials") return json({ credentials: [] });
		if (path === "/v1/instances/inst-1/instructions") return json({ instructions: "" });
		if (path === "/v1/instances/inst-1/apply-tips") return json({ tips: [] });
		if (path === "/v1/instances/inst-1/runtime") {
			return json({
				runtime: options.runtime ?? {
					instanceId: "inst-1",
					status: "online",
					placement: "local",
					endpointUrl: "https://runner.example.com",
				},
			});
		}
		if (path === "/v1/instances/inst-1/runtime/status") {
			return json(options.runtime ?? { connected: true, node: "my-machine" });
		}
		if (path === "/v1/instances/inst-1/tasks") {
			return json({
				tasks: options.runtimeTasks ?? [
					{
						id: "task-approval",
						type: "job.apply_basic",
						status: "needs_approval",
						title: "Job application",
						requiresApproval: true,
						approval: { prompt: "Submit application to Acme?" },
						createdAt: "2026-06-20T01:00:00Z",
						updatedAt: "2026-06-20T01:01:00Z",
					},
					{
						id: "task-done",
						type: "job.apply_basic",
						status: "completed",
						title: "Job application",
						requiresApproval: true,
						output: { submitted: true, finalUrl: "https://example.com/success" },
						createdAt: "2026-06-20T00:00:00Z",
						updatedAt: "2026-06-20T00:02:00Z",
					},
				],
			});
		}
		if (path === "/v1/instances/inst-1/board") {
			return json(options.board ?? {
				columns: [
					{ id: "waiting", title: "Waiting", color: "#eab308", statuses: ["queued", "needs_approval"] },
					{ id: "applying", title: "Applying", color: "#3b82f6", statuses: ["running"] },
					{ id: "submitted", title: "Submitted", color: "#22c55e", statuses: ["completed"] },
				],
				items: [
					{ jobKey: "job-approval", latestTaskId: "task-approval", title: "Job application", subtitle: "", description: "", url: "", runStatus: "needs_approval", userStatus: null, status: "needs_approval", attempts: [{ id: "task-approval", status: "needs_approval", updatedAt: "2026-06-20T01:01:00Z" }], updatedAt: "2026-06-20T01:01:00Z" },
					{ jobKey: "job-done", latestTaskId: "task-done", title: "Job application", subtitle: "", description: "", url: "", runStatus: "completed", userStatus: null, status: "completed", attempts: [{ id: "task-done", status: "completed", updatedAt: "2026-06-20T00:02:00Z" }], updatedAt: "2026-06-20T00:02:00Z" },
				],
				truncated: false,
			});
		}
		if (path === "/v1/instances/inst-1/task-events") {
			return json({
				events: options.runtimeEvents ?? [
					{
						id: "event-1",
						taskId: "task-approval",
						type: "task.needs_approval",
						message: "Waiting for approval before submit",
						timestamp: "2026-06-20T01:01:00Z",
						createdAt: "2026-06-20T01:01:00Z",
					},
				],
			});
		}
		if (path === "/v1/instances/inst-1/collections/applications/records") {
			return json({ records: options.appRecords ?? [] });
		}
		if (path === "/v1/instances/inst-1/tasks/task-approval/approve" && method === "POST") {
			approvedTaskId = "task-approval";
			return json({ id: "task-approval", status: "running" });
		}
		if (path === "/v1/instances/inst-1/tasks/task-approval/cancel" && method === "POST") {
			cancelledTaskId = "task-approval";
			return json({ id: "task-approval", status: "cancelled" });
		}
		if (path === "/v1/keys/status") return json({ providers: options.providers ?? [] });
		// Account preferences (#211) — voice/translation defaults shared by every agent.
		if (path === "/v1/preferences") {
			if (method === "PUT") { savedPreferences = JSON.parse(route.request().postData() || "{}"); return json({ preferences: savedPreferences }); }
			return json({ preferences: { voice: { speed: 130, sttMode: "openai" } }, languages: [{ name: "Chinese", tag: "zh-CN" }, { name: "English", tag: "en-US" }] });
		}
		if (path === "/v1/profile") return json(options.profile ?? { fields: [], profile: {} });
		if (path === "/v1/instances/inst-1/voice-settings") {
			if (method === "DELETE") { voiceOverrideCleared = true; return json({ voiceSettings: { speed: 130, sttMode: "openai" }, hasOverride: false }); }
			return json({ voiceSettings: { speed: 130, sttMode: "openai" }, hasOverride: false });
		}
		if (path === "/v1/instances/inst-1/translation") return json({ translation: { enabled: false, target: "English" }, languages: [], hasOverride: false });
		if (path === "/v1/dashboard/creator") return json({ totalAgents: 1, totalSubscribers: 0, totalUsage: 0, agents: [] });
		if (path === "/v1/dashboard/usage") return json({ activeInstances: 1, dailyUsage: [] });

		return json({ error: `Unhandled mock route ${method} ${path}` }, 500);
	});

	await page.route("https://mcp.proagentstore.online/mcp", (route) =>
		route.fulfill({ status: 401, body: "authentication required" }),
	);
	await page.route("https://ops-agent.proagentstore.online/", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ agent: "ops-agent", status: "ok" }),
		}),
	);

	return {
		get verifyCalls() {
			return verifyCalls;
		},
		get deployCalls() {
			return deployCalls;
		},
		get profileUpdates() {
			return profileUpdates;
		},
		get loopStarts() {
			return loopStarts;
		},
		get systemMessages() {
			return systemMessages;
		},
		get savedPreferences() {
			return savedPreferences;
		},
		get voiceOverrideCleared() {
			return voiceOverrideCleared;
		},
		get approvedTaskId() {
			return approvedTaskId;
		},
		get cancelledTaskId() {
			return cancelledTaskId;
		},
		get builderPlans() {
			return builderPlans;
		},
		get builderExecutes() {
			return builderExecutes;
		},
	};
}

test.describe("ProAgentStore Console smoke", () => {
	test("console loads without page errors", async ({ page }) => {
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(String(e)));
		await mockSignedInConsole(page);
		await page.goto("/console/");
		await page.waitForLoadState("networkidle");
		expect(errors).toEqual([]);
	});

	test("console root renders the sign-in screen", async ({ page }) => {
		await page.goto("/console/");

		await expect(page).toHaveTitle(/Creator Console/);
		await expect(
			page.getByRole("heading", { name: "Creator Console" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Sign in with GitHub/i }),
		).toBeVisible();
	});

	test("console route also serves the console shell", async ({ page }) => {
		await page.goto("/console");

		await expect(page).toHaveTitle(/Creator Console/);
		await expect(
			page.getByRole("heading", { name: "Creator Console" }),
		).toBeVisible();
	});

	test("React bundle is served as inline script in the console HTML", async ({
		page,
	}) => {
		const res = await page.request.get("/console/");
		expect(res.ok()).toBe(true);
		const html = await res.text();
		// The bundle is inlined — no external JS references
		expect(html).toContain('<div id="root">');
		expect(html).toContain('<script type="module">');
		// Key strings from the React app
		expect(html).toContain("Creator Console");
	});

	test("console HTML uses short cache headers", async ({ page }) => {
		const res = await page.request.get("/console/");
		expect(res.ok()).toBe(true);
		expect(res.headers()["cache-control"]).toContain("max-age=300");
	});

	test("signed-in creator console shows agents grid", async ({ page }) => {
		await mockSignedInConsole(page, {
			agents: [
				{
					id: "draft-agent",
					slug: "draft-agent",
					name: "Draft Agent",
					description: "Still being configured",
					category: "general",
					visibility: "draft",
					status: "inactive",
				},
				{
					id: "live-agent",
					slug: "live-agent",
					name: "Live Agent",
					description: "Available in the store",
					category: "chat",
					visibility: "published",
					status: "active",
				},
			],
		});

		await page.goto("/console/agents");

		await expect(page.getByText("Agents you've built")).toBeVisible();
		await expect(page.getByText("Draft Agent")).toBeVisible();
		await expect(page.getByText("Live Agent")).toBeVisible();
	});

	test("agent builder plans and executes from a prompt", async ({ page }) => {
		const mock = await mockSignedInConsole(page);
		await page.goto("/console/agents/new");

		await expect(page.getByRole("heading", { name: "Create Agent" })).toBeVisible();
		await page.getByLabel("Agent prompt").fill("Create an agent that reviews Google Docs in a project folder and summarizes contract risks.");
		await page.getByRole("button", { name: "Plan Agent" }).click();

		await expect(page.getByText("Review plan")).toBeVisible();
		await expect(page.locator("#agent-builder-slug")).toHaveValue("contract-review-agent");
		await expect(page.getByText("google_drive", { exact: true })).toBeVisible();

		await page.getByRole("button", { name: "Approve and Create" }).click();
		await page.waitForURL(/\/console\/agents\/agent-1$/);
		expect(mock.builderPlans).toHaveLength(1);
		expect(mock.builderExecutes).toHaveLength(1);
	});

	/**
	 * The instance tab bar actually switches tabs (#309).
	 *
	 * This was broken on main for hours and shipped to production: the tabs RENDERED, so the UI
	 * looked correct in a screenshot, but clicking one did nothing — the only way to reach a tab
	 * was a full page load. Three specs caught it, and all three named something else ("apply
	 * tab", "coding terminal"), so the failure read as three unrelated feature regressions
	 * rather than "navigation is dead". This one names the invariant.
	 *
	 * It walks EVERY tab the instance shows rather than a sampled one, because the cause was a
	 * render loop above the router — the whole bar dies at once, so any single tab is as good a
	 * probe as any other, and the cheap thing is to assert the property everywhere.
	 */
	test("every instance tab actually switches when clicked", async ({ page }) => {
		await mockSignedInConsole(page);
		await page.goto("/console/instances/inst-1");

		// The bar is injected into the Layout header once the instance loads, so wait for a tab
		// that always exists before enumerating — otherwise the list is empty and the walk below
		// passes without clicking anything.
		await expect(page.getByRole("button", { name: "Assistant", exact: true })).toBeVisible();
		const labels = (await page.getByRole("banner").getByRole("button").allInnerTexts())
			.map((t) => t.trim())
			.filter(Boolean);
		// Guard the guard: if the bar stops rendering, an empty list would make this vacuously pass.
		expect(labels).toContain("Assistant");
		expect(labels.length).toBeGreaterThan(2);

		for (const label of labels) {
			await page.getByRole("button", { name: label, exact: true }).click();
			// The active tab is the one carrying the accent style. Polled, not read on the next
			// tick: switching re-renders through the router, not synchronously in the handler.
			await expect
				.poll(async () => (await page.locator("button.bg-accent-soft").allInnerTexts()).map((t) => t.trim()))
				.toContain(label);
		}
	});

	/**
	 * Deep-linking a tab and clicking to it must land in the same place. During #309 they diverged:
	 * a full load of /instances/:id/apply worked perfectly while the click did nothing, which is
	 * exactly why the bug survived manual checking — anyone who reloaded saw a working console.
	 */
	test("a tab reached by deep link matches the tab reached by clicking", async ({ page }) => {
		await mockSignedInConsole(page);

		await page.goto("/console/instances/inst-1/apply");
		await expect(page.getByText(/2 jobs/)).toBeVisible();

		await page.goto("/console/instances/inst-1");
		await page.getByRole("button", { name: "Apply", exact: true }).click();
		await expect(page.getByText(/2 jobs/)).toBeVisible();
		expect(page.url()).toContain("/instances/inst-1/apply");
	});

	test("signed-in user can open an instance and see the apply tab", async ({
		page,
	}) => {
		const mock = await mockSignedInConsole(page);
		await page.goto("/console/");

		// Navigate to instances
		await page.getByRole("link", { name: "Instances" }).click();
		await page.getByText("Job Application Assistant").click();

		// Apply agents get their own Apply tab (the single agent-configurable work board).
		await page.getByRole("button", { name: "Apply", exact: true }).click();

		// The board shows one card per job (2 jobs from the mock /board).
		await expect(page.getByText(/2 jobs/)).toBeVisible();
		await expect(page.getByText("Job application").first()).toBeVisible();
		// The waiting-for-approval job's card has an Approve button.
		await page.getByRole("button", { name: "Approve" }).click();
		// Polled, not a bare expect: the click fires a fetch the route handler answers
		// asynchronously, so reading the mock on the very next tick is a race that only loses on a
		// slow machine — which is how it flaked in CI while passing every time locally.
		await expect.poll(() => mock.approvedTaskId).toBe("task-approval");
	});

	test("Preferences holds the account-wide voice settings, not Profile", async ({ page }) => {
		// The split (#211): Profile is identity + money; Preferences is how you speak, hear and read.
		// Appearance moved with it, because a text-size preference is not an identity.
		const mock = await mockSignedInConsole(page);
		await page.goto("/console/preferences");
		await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Voice" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
		// The account value is what renders — Whisper, from the mocked /v1/preferences.
		await expect(page.locator("#voice-stt-mode")).toHaveValue("openai");

		// …and Profile no longer carries Appearance.
		await page.goto("/console/profile");
		await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Appearance" })).toHaveCount(0);
		// Nothing SETTABLE is saved just by looking. The one write a page load may make is the
		// timezone seed (#345) — the mocked account has no stored zone, and seeding it once when
		// empty is the whole point; re-asserting it on every load is what would be wrong.
		expect(Object.keys((mock.savedPreferences as Record<string, unknown> | null) ?? {})).not.toContain("voice");
		expect(Object.keys((mock.savedPreferences as Record<string, unknown> | null) ?? {})).not.toContain("translation");
	});

	test.describe("timezone (#345)", () => {
		// PINNED, not inherited. CI runners are UTC, and a browser resolving to UTC is deliberately
		// treated as a non-answer (see `timezoneSeed`) — so a test reading the runner's own zone
		// would assert nothing on the machine that matters. This is also the honest setup: the
		// feature is about a user who is somewhere.
		test.use({ timezoneId: "Australia/Sydney" });

		test("is seeded from this machine once, and an override then wins", async ({ page }) => {
			// #329 taught agents to speak the owner's local time — and nothing ever wrote the field,
			// so "unset" was the standing case and every agent kept saying UTC. Seeding makes unset
			// transient. Seed, do NOT bind: the browser value changes when you travel, is absent on
			// cron/pump/MCP paths, and cannot be corrected by the owner, so it may only fill an
			// EMPTY field — which the mocked account is.
			const mock = await mockSignedInConsole(page);
			await page.goto("/console/preferences");
			await expect(page.getByRole("heading", { name: "Timezone" })).toBeVisible();
			await expect
				.poll(() => (mock.savedPreferences as { timezone?: string } | null)?.timezone)
				.toBe("Australia/Sydney");
			// And an explicit override beats the machine — the two-clock defect this closes.
			await page.getByLabel("Your timezone").selectOption("Europe/London");
			await expect.poll(() => (mock.savedPreferences as { timezone?: string } | null)?.timezone).toBe("Europe/London");
		});
	});

	test("an agent shows 'Using your defaults' until you customise it", async ({ page }) => {
		// The override control is ONE per section, deliberately not one per field — a per-field
		// toggle would rebuild the per-agent sprawl this change exists to remove.
		await mockSignedInConsole(page);
		await page.goto("/console/instances/inst-1/settings");
		// Wait for the control to EXIST — it renders "Loading your voice settings…" until the GET
		// lands, because clicking before then let the response overwrite the choice.
		const usingDefaults = page.getByRole("radio", { name: /Using your defaults/ }).first();
		await expect(usingDefaults).toBeChecked();
		// The fields stay hidden while the agent follows the account.
		await expect(page.locator("#voice-stt-mode")).toHaveCount(0);
		// pageerror only — the settings page also fetches connector endpoints this mock doesn't
		// cover, and those 500s are pre-existing noise, not a signal about this control.
		const crashes: string[] = [];
		page.on("pageerror", (e) => crashes.push(String(e)));
		const customise = page.getByRole("radio", { name: /Customise for this agent/ }).first();
		// click(), not check(): check() asserts the input reflects the new state SYNCHRONOUSLY, which
		// a controlled React radio never does — it flips only after the state round-trip. The
		// toBeChecked below is the assertion, and it auto-retries.
		await customise.click();
		await expect(customise).toBeChecked();
		await expect(page.locator("#voice-stt-mode")).toBeVisible();
		expect(crashes).toEqual([]);
	});

	test("a slow settings load cannot silently revert your choice", async ({ page }) => {
		// The real bug behind a "flaky" test: the initial GET /voice-settings resolves AFTER the
		// user clicks, then calls setVoiceOverride(hasOverride) and springs the radio back. On CI
		// the delay was enough to hit it every other run; for a user on a slow connection it is a
		// setting that refuses to change and never says why. The control is now inert until the
		// current value is known.
		await mockSignedInConsole(page);
		// Delay ONLY the voice-settings read, so the page renders while it is still in flight.
		await page.route("**/v1/instances/inst-1/voice-settings", async (route) => {
			await new Promise((r) => setTimeout(r, 1200));
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ voiceSettings: { speed: 130, sttMode: "openai" }, hasOverride: false }),
			});
		});
		await page.goto("/console/instances/inst-1/settings");
		// While in flight the radios do not exist, so there is nothing to click too early.
		await expect(page.getByRole("radio", { name: /Customise for this agent/ }).first()).toHaveCount(0);
		await expect(page.getByText(/Loading your voice settings/)).toBeVisible();
		// Once loaded, the choice sticks — the late response has already landed.
		const customise = page.getByRole("radio", { name: /Customise for this agent/ }).first();
		await expect(customise).toBeVisible({ timeout: 5000 });
		await customise.click();
		await expect(customise).toBeChecked();
		// Give any straggling response the chance to clobber it; it must not.
		await page.waitForTimeout(500);
		await expect(customise).toBeChecked();
	});

	test("a Loop announces that it started, and says where the work happens", async ({ page }) => {
		// Three real complaints from one run: nothing said the loop had begun; the result came back
		// as raw markdown in a yellow pill built for six words; and on a coding agent the Loop
		// drives the ENGINE (#210), so the Assistant thread stays silent while it works — which
		// reads as "the button did nothing" until a commit appears out of nowhere.
		const mock = await mockSignedInConsole(page);
		await page.goto("/console/instances/inst-1");
		await page.getByRole("button", { name: "Loop" }).click();
		await page.getByPlaceholder("What should the agent work on?").fill("Fix bugs");
		await page.getByRole("button", { name: "Start Loop" }).click();

		// Did the start request even reach the server?
		await expect.poll(() => mock.loopStarts.length).toBe(1);
		// It said it started, and named the objective.
		await expect(page.getByText(/Loop started/)).toBeVisible();
		await expect(page.getByText(/Fix bugs/).first()).toBeVisible();
		// …and that this thread is NOT where the work will show up.
		await expect(page.getByText(/Coding.*tab, not here/)).toBeVisible();

		// The completion renders as MARKDOWN, not literal backticks and asterisks. For a CODING
		// loop the workflow writes it (so it survives a closed tab); the client must not add a
		// second copy — the mock returns it from /messages, as the server would.
		await expect(page.getByText(/Loop complete/)).toBeVisible({ timeout: 15000 });
		await expect(page.getByText(/Loop complete/)).toHaveCount(1);
		const md = page.locator(".msg-md").filter({ hasText: "Loop complete" });
		await expect(md.locator("strong").filter({ hasText: "758" })).toHaveCount(1);
		await expect(md.locator("code").first()).toContainText("fix/80");
		await expect(page.getByText("**All 758 tests pass.**")).toHaveCount(0);
	});

	test("replaying a message shows it loading, then which one is speaking", async ({ page }) => {
		// Fetching the saved recording from R2 is not instant. The button used to sit unchanged
		// through it, so a tap looked like nothing happened and people tapped again — cutting off
		// the load already running. And once audio started, nothing said WHICH message you were
		// hearing, which matters most in the long thread replay exists for.
		await mockSignedInConsole(page);
		let releaseAudio: (() => void) | null = null;
		await page.route("**/v1/instances/inst-1/voice-audio/**", async (route) => {
			// Hold the response open so the loading state is observable rather than a flash.
			await new Promise<void>((r) => { releaseAudio = r; setTimeout(r, 4000); });
			await route.fulfill({ status: 200, contentType: "audio/webm", body: "not-real-audio" });
		});
		await page.route("**/v1/instances/inst-1/messages*", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					messages: [{ id: "m1", role: "assistant", content: "Hello there", createdAt: "2026-08-05T10:00:00.000Z", audioKey: "a1" }],
				}),
			}),
		);
		await page.goto("/console/instances/inst-1");

		const play = page.getByRole("button", { name: "Play this message" });
		await expect(play).toBeVisible();
		await play.click();
		// Spinner while the blob downloads — the tap was acknowledged.
		await expect(page.locator("button .animate-spin")).toBeVisible();
		releaseAudio?.();
		// Then the equaliser marks the message being spoken. (The fake blob cannot decode, so the
		// element errors and clears — either bars or a return to idle proves the state advanced
		// past loading, which is the thing that was missing.)
		await expect(page.locator("button .animate-spin")).toHaveCount(0, { timeout: 10000 });
	});

	test("a voice turn can be read as the transcript OR as what was heard live (#319)", async ({ page }) => {
		// The two recognizers — browser dictation live, Whisper on the clip — disagree, and until
		// the dictation was persisted beside the transcript there was no way to see that they had.
		// "It isn't capturing everything I say" was a report the platform could not answer.
		await mockSignedInConsole(page);
		await page.route("**/v1/instances/inst-1/messages*", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					messages: [
						{ id: "m1", role: "user", content: "open the deploy log", createdAt: "2026-08-05T10:00:00.000Z", dictation: "open the deploy log for the api worker" },
						{ id: "m2", role: "user", content: "a message I typed", createdAt: "2026-08-05T10:01:00.000Z" },
					],
				}),
			}),
		);
		await page.goto("/console/instances/inst-1");

		// The transcript is what the bubble reads by default — what was SENT is still the message.
		await expect(page.getByText("open the deploy log", { exact: true })).toBeVisible();
		// The count is visible without a tap: the flag is the point, the words are one tap away.
		await expect(page.getByText("4 words not in the transcript")).toBeVisible();

		// Exactly one toggle: the typed turn does not sprout a dead affordance.
		const toggle = page.getByRole("button", { name: "Show what was heard" });
		await expect(toggle).toHaveCount(1);
		await toggle.click();
		await expect(page.getByText("open the deploy log for the api worker")).toBeVisible();
		await page.getByRole("button", { name: "Heard live — show sent" }).click();
		await expect(page.getByText("open the deploy log", { exact: true })).toBeVisible();
	});

	test("console deep links restore instance tabs after refresh", async ({ page }) => {
		await mockSignedInConsole(page);

		// Navigate directly to an instance's knowledge tab
		await page.goto("/console/instances/inst-1/knowledge");

		// The knowledge tab should load — sub-tabs and heading are visible
		await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
	});

	test("root restores the last visited top-level screen, else defaults to Instances (#161)", async ({ page }) => {
		await mockSignedInConsole(page);

		// First visit with nothing stored → the default is Instances.
		await page.goto("/console/");
		await expect(page).toHaveURL(/\/console\/instances$/);

		// Client-side nav to a top-level section records it as the last route (Layout effect).
		await page.getByRole("link", { name: "My Agents" }).click();
		await expect(page).toHaveURL(/\/console\/agents$/);

		// The URL changing and the route being PERSISTED are two different events —
		// rememberRoute runs in a Layout effect. Navigating on the URL alone raced the write and
		// made this test fail roughly two runs in three.
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("console:lastRoute")))
			.toBe("agents");

		// Re-opening the root now restores Agents instead of the fixed default.
		await page.goto("/console/");
		await expect(page).toHaveURL(/\/console\/agents$/);
	});

	test("instance indexing page shows indexed, pending, and sync status", async ({ page }) => {
		await mockSignedInConsole(page);

		await page.goto("/console/instances/inst-1/indexing");

		await expect(page.getByRole("heading", { name: "Indexing" })).toBeVisible();
		await expect(page.getByText("Profile summary", { exact: true })).toBeVisible();
		await expect(page.getByText("Pending contract notes", { exact: true })).toBeVisible();
		await expect(page.getByText("Drive sync", { exact: true })).toBeVisible();
		await expect(page.getByText("Imported", { exact: true })).toBeVisible();
	});

	/**
	 * The Stats surface (#311). What is asserted here is the honesty, not the pixels: a card that
	 * FAILED, a card with a GAP in its trend, and the three page-level disclosures.
	 *
	 * The gap is the load-bearing one. The server keeps a stored `0` and an absent day different
	 * end to end, and the last place that chain can be undone is a renderer that draws `null` on
	 * the axis. The mocked series has both — 0 on 08-03 and null on 08-04 — so a `?? 0` anywhere
	 * would erase the sentence this asserts.
	 */
	test("stats cards disclose their caveat, their gaps and their failures (#311)", async ({ page }) => {
		await mockSignedInConsole(page);
		await page.goto("/console/instances/inst-1/stats");

		await expect(page.getByRole("heading", { name: "Stats", exact: true })).toBeVisible();

		// The caveat travels with the number and is rendered verbatim, not summarized.
		await expect(page.getByText(/Counts runs STARTED in the period/).first()).toBeVisible();

		// A gap says it is missing data, and says it is not a zero.
		await expect(page.getByText(/1 day has no recorded run/)).toBeVisible();
		await expect(page.getByText(/That is missing data, not a zero/)).toBeVisible();

		// Today is absent on purpose, and the page says where it went.
		await expect(page.getByText(/Trends end 2026-08-06, the last complete UTC day/)).toBeVisible();
		// No backfill: history starts inside the window, so a short series explains itself.
		await expect(page.getByText(/Daily history starts 2026-08-02/)).toBeVisible();

		// A failed card says WHAT failed — never an empty chart, which would be a claim.
		await expect(page.getByText("Couldn’t be read")).toBeVisible();
		await expect(page.getByText("no such collection: leads")).toBeVisible();

		// Narrow screen: cards stack and the chart scales to the container. #235 (Profile scrolling
		// sideways) and #227 (issues list crushed) are both this, and a fixed-width SVG is the
		// easiest way to reintroduce it.
		await page.setViewportSize({ width: 390, height: 780 });
		await expect(page.getByText(/1 day has no recorded run/)).toBeVisible();
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow).toBeLessThanOrEqual(0);
	});

	test("profile and notifications have refreshable routes", async ({ page }) => {
		await mockSignedInConsole(page);

		await page.goto("/console/profile");
		await expect(
			page.getByRole("heading", { name: "Profile", exact: true }),
		).toBeVisible();
		await expect(page.getByText("@tester")).toBeVisible();

		await page.goto("/console/notifications");
		await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
		await expect(page.getByText("No notifications")).toBeVisible();
	});

	test("instance settings show webhook and cron triggers", async ({ page }) => {
		await mockSignedInConsole(page);

		await page.goto("/console/instances/inst-1/settings");
		await expect(page.getByRole("heading", { name: "Triggers" })).toBeVisible();
		await expect(page.getByText("Daily digest")).toBeVisible();
		await expect(page.getByRole("button", { name: "Run now" }).first()).toBeVisible();
	});

	test("trigger form exposes run_pipeline + insert_record with their config inputs (#134)", async ({ page }) => {
		await mockSignedInConsole(page);
		await page.goto("/console/instances/inst-1/settings");
		await expect(page.getByRole("heading", { name: "Triggers" })).toBeVisible();

		// Scope to the Triggers card. Teamwork (#182) also offers run_pipeline and also has an
		// add button, so both locators silently depended on this being the only such card.
		const triggersCard = page
			.locator("div")
			.filter({ has: page.getByRole("heading", { name: "Triggers" }) })
			.last();
		const action = triggersCard.locator("select").filter({ has: page.locator('option[value="run_pipeline"]') });
		const typeSelect = triggersCard.locator("select").filter({ has: page.locator('option[value="webhook"]') });
		const addBtn = triggersCard.getByRole("button", { name: "Add trigger", exact: true });

		// run_pipeline → a pipeline-name input appears.
		await action.selectOption("run_pipeline");
		const pipelineInput = page.getByPlaceholder("a pipeline configured on this agent");
		await expect(pipelineInput).toBeVisible();

		// A SCHEDULED pipeline run with no pipeline name can only ever fail, so the API refuses it
		// and the console shows that refusal verbatim rather than flattening it to "Failed" (#16).
		// (A webhook one is allowed — its payload may legitimately carry the pipeline name.)
		await typeSelect.selectOption("cron");
		await addBtn.click();
		await expect(page.getByText(/needs the pipeline name/i).first()).toBeVisible();

		// With the name filled, the create succeeds.
		await pipelineInput.fill("lead-sweep");
		await addBtn.click();
		await expect(page.getByText("Trigger created.")).toBeVisible();

		// insert_record → a target-collection input appears.
		await action.selectOption("insert_record");
		await expect(page.getByPlaceholder("collection name")).toBeVisible();
	});

	test("an action this agent cannot perform is offered as disabled, with the reason (#358)", async ({ page }) => {
		await mockSignedInConsole(page);
		await page.goto("/console/instances/inst-1/settings");
		await expect(page.getByRole("heading", { name: "Triggers" })).toBeVisible();

		const triggersCard = page
			.locator("div")
			.filter({ has: page.getByRole("heading", { name: "Triggers" }) })
			.last();
		const action = triggersCard.locator("select").filter({ has: page.locator('option[value="run_pipeline"]') });

		// Still LISTED — hiding it would leave "why can't I schedule a browser run here?"
		// unanswered — but not selectable, because this agent declares JOB_APPLY, not BROWSER_TASK.
		const browse = action.locator('option[value="run_browse"]');
		await expect(browse).toHaveCount(1);
		// `toBeDisabled` does not read an <option>, so assert the attribute the browser honours.
		await expect(browse).toHaveAttribute("disabled", "");
		await expect(browse).toHaveText(/not supported by this agent/);

		// And the row saved before the gate existed no longer looks healthy: it says, on the row,
		// that it can never run — without deleting a trigger the user wrote.
		const stale = page.locator("div.bg-paper").filter({ hasText: "Nightly portal check" }).first();
		await expect(stale.getByText("This trigger can never run.")).toBeVisible();
		await expect(stale.getByText(/BROWSER_TASK/)).toBeVisible();
	});

	test("schedule editor previews the next runs in local time AND UTC (#18)", async ({ page }) => {
		await mockSignedInConsole(page);
		await page.goto("/console/instances/inst-1/settings");
		await expect(page.getByRole("heading", { name: "Triggers" })).toBeVisible();

		const triggersCard = page
			.locator("div")
			.filter({ has: page.getByRole("heading", { name: "Triggers" }) })
			.last();
		const typeSelect = triggersCard.locator("select").filter({ has: page.locator('option[value="webhook"]') });
		await typeSelect.selectOption("cron");

		// Presets, not cron: "Daily at…" is the default mode, so a time field and a timezone
		// picker are both present without anyone typing an expression.
		await expect(triggersCard.locator('input[type="time"]')).toBeVisible();
		await expect(triggersCard.locator("select").filter({ has: page.locator('option[value="UTC"]') })).toBeVisible();

		// The preview comes from the server, and shows both clocks — a timezone mistake is only
		// ever visible when you can see the two side by side.
		const previewBlock = page.getByText(/^Next runs/).locator("xpath=..");
		await expect(previewBlock).toBeVisible();
		await expect(previewBlock.getByText(/UTC/).first()).toBeVisible();
	});

	test("payload mapping is offered for the actions that have mappable fields (#16)", async ({ page }) => {
		await mockSignedInConsole(page);
		await page.goto("/console/instances/inst-1/settings");
		const triggersCard = page
			.locator("div")
			.filter({ has: page.getByRole("heading", { name: "Triggers" }) })
			.last();

		await expect(triggersCard.getByRole("button", { name: /Payload mapping/ })).toBeVisible();
		await triggersCard.getByRole("button", { name: /Payload mapping/ }).click();
		await expect(page.getByPlaceholder("lead.name")).toBeVisible();

		// An action with nothing mappable does not offer the control at all.
		const action = triggersCard.locator("select").filter({ has: page.locator('option[value="run_pipeline"]') });
		await action.selectOption("run_pipeline");
		await expect(triggersCard.getByRole("button", { name: /Payload mapping/ })).toHaveCount(0);
	});

	test("trigger run history shows what ran, what failed and the sync counts (#19)", async ({ page }) => {
		await mockSignedInConsole(page);
		await page.goto("/console/instances/inst-1/settings");
		await expect(page.getByText("Daily digest")).toBeVisible();

		const digest = page.locator("div.bg-paper").filter({ hasText: "Daily digest" }).first();
		await digest.getByRole("button", { name: "History" }).click();

		// The failure that the definitions list could only ever summarise as "last error".
		await expect(page.getByText("task dispatch failed (500)").first()).toBeVisible();
		await expect(digest.getByText("Failed", { exact: true })).toBeVisible();
		await expect(digest.getByText("create_task dispatched")).toBeVisible();

		// Payloads stay collapsed until asked for — a webhook body is attacker-influenced.
		await expect(page.getByText("Yesterday's digest")).toHaveCount(0);
		await digest.getByRole("button", { name: "payload" }).last().click();
		await expect(page.getByText(/Yesterday's digest/)).toBeVisible();

		// A connector sync reports its numbers, not just "succeeded".
		const sync = page.locator("div.bg-paper").filter({ hasText: "Drive sync" }).first();
		await sync.getByRole("button", { name: "History" }).click();
		await expect(page.getByText(/1 imported · 2 skipped · 3 scanned/)).toBeVisible();
	});

	test("Teamwork makes the pump visible: routing filter, dead letter, replay (#182)", async ({ page }) => {
		await mockSignedInConsole(page, {
			instances: [
				{ id: "inst-1", name: "Lead Finder", slug: "lead-finder", category: "productivity", capabilities: { surfaces: [] } },
				{ id: "inst-2", name: "Website Builder", slug: "site-builder", category: "productivity", capabilities: { surfaces: [] } },
			],
		});

		let replayed: string | null = null;
		await page.route("**/v1/instances/inst-1/connections**", async (route) => {
			const url = new URL(route.request().url());
			const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
			if (url.pathname.includes("/replay")) {
				replayed = url.pathname;
				return json({ ok: true, status: "pending" });
			}
			if (url.pathname.endsWith("/deliveries")) {
				return json({
					deliveries: [
						{
							id: "del-dead",
							connectionId: "conn-1",
							source: "connection",
							eventType: "lead.created",
							action: "run_pipeline",
							sourceInstanceId: "inst-1",
							targetInstanceId: "inst-2",
							status: "dead",
							attempts: 5,
							nextAttemptAt: null,
							lastError: "builder MCP unreachable",
							traceId: "run-42",
							createdAt: "2026-07-12T23:30:00.000Z",
						},
					],
				});
			}
			return json({
				connections: [
					{
						id: "conn-1",
						eventType: "lead.created",
						targetInstanceId: "inst-2",
						action: "run_pipeline",
						enabled: true,
						config: {
							pipeline: "site-builder",
							filter: [
								{ field: "suburb", op: "eq", value: "Sydney" },
								{ field: "rating", op: "gte", value: 4 },
							],
						},
					},
					// The silent failure the outbox exists to expose: a filter that has never once
					// matched looks exactly like a healthy connection in any plain list.
					{ id: "conn-2", eventType: "lead.enriched", targetInstanceId: "inst-2", action: "create_task", enabled: true, config: { filter: [{ field: "email", op: "exists" }] } },
				],
			});
		});

		await page.goto("/console/instances/inst-1/settings");
		await expect(page.getByRole("heading", { name: "Teamwork" })).toBeVisible();

		// The wired predicate is on the row, not buried in a config blob.
		await expect(page.getByText('only when suburb eq "Sydney" and rating gte 4')).toBeVisible();
		await expect(page.getByText("1 undelivered")).toBeVisible();
		await expect(page.getByText("nothing has matched this filter yet")).toBeVisible();

		// The account-wide headline says something is stuck before you open anything.
		await expect(page.getByText("1 event never arrived")).toBeVisible();

		await page.getByRole("button", { name: /Show delivery log/ }).click();
		await expect(page.getByText("gave up after 5 attempts", { exact: false })).toBeVisible();
		await expect(page.getByText("builder MCP unreachable")).toBeVisible();

		await page.getByRole("button", { name: "Replay", exact: true }).click();
		await expect.poll(() => replayed).toContain("/connections/deliveries/del-dead/replay");
	});

	test("a direction the AGENT proposed is confirmed, not silently adopted (#330)", async ({ page }) => {
		// The Lead's epic for one subordinate. What this asserts is the security boundary made
		// visible: an agent may propose a direction, and only the owner pressing Confirm sends it
		// through the one route that stamps `setBy: "user"`. Rendered identically to a set
		// direction, the owner would have no way to notice that a repo's standing brief is text
		// their agent lifted out of an issue body.
		await mockSignedInConsole(page, {
			instances: [
				{ id: "inst-1", name: "Coder Lead", slug: "coder-lead", category: "code", capabilities: { surfaces: [] } },
				{ id: "inst-2", name: "FWS platform", slug: "coder-repo", category: "code", capabilities: { surfaces: ["coding"] } },
			],
		});

		let confirmed: unknown = null;
		await page.route("**/v1/instances/inst-1/supervision**", async (route) => {
			const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
			if (route.request().method() === "PUT") {
				confirmed = route.request().postDataJSON();
				return json({ ok: true });
			}
			return json({
				supervision: [
					{
						id: "link-1",
						supervisorInstanceId: "inst-1",
						subordinateInstanceId: "inst-2",
						enabled: true,
						direction: { text: "Finish the voice port.", setBy: "agent", updatedAt: "2026-08-07T00:00:00.000Z" },
					},
				],
			});
		});

		await page.goto("/console/instances/inst-1/settings");
		await expect(page.getByRole("heading", { name: "Teamwork" })).toBeVisible();
		await expect(page.getByText("Proposed by the agent — it carries no authority until you confirm it.")).toBeVisible();

		// The button SAYS Confirm, because pressing it is an act of authorship, not a save.
		await page.getByRole("button", { name: "Confirm", exact: true }).click();
		await expect.poll(() => confirmed).toEqual({ direction: "Finish the voice port." });
	});

	test("instance chat sends messages and shows responses", async ({
		page,
	}) => {
		await mockSignedInConsole(page);

		await page.goto("/console/instances/inst-1");
		// Find the chat input and send a message
		const input = page.getByPlaceholder(/Send a message|Ask about your repos/);
		await input.fill("hello");
		await page.getByRole("button", { name: /Send/ }).first().click();

		// Should show the user message and the mock response
		await expect(page.getByText("hello")).toBeVisible();
		await expect(page.getByText("Mock assistant reply")).toBeVisible();
	});

	test("chat input is a multi-line textarea that auto-grows with the message/transcript (#164)", async ({ page }) => {
		await mockSignedInConsole(page);
		await page.goto("/console/instances/inst-1");

		const box = page.getByPlaceholder(/Send a message|Ask about your repos/);
		await expect(box).toBeVisible();
		// It's a textarea (multi-line capable), not a single-line input — so the full live
		// transcript / a long message is readable, not truncated to one line.
		expect(await box.evaluate((el) => el.tagName)).toBe("TEXTAREA");

		const before = (await box.boundingBox())!.height;
		await box.fill("line one\nline two\nline three\nline four\nline five\nline six");
		const after = (await box.boundingBox())!.height;
		// The field grew to fit the content, and newlines are preserved.
		expect(after).toBeGreaterThan(before);
		expect(await box.inputValue()).toContain("\n");
	});

	test("instance chat has labeled voice controls with descriptive tooltips", async ({
		page,
	}) => {
		await mockSignedInConsole(page);
		await page.goto("/console/instances/inst-1");

		// A single segmented control with three interaction modes (replaced the four
		// overlapping toggles), each carrying a VISIBLE label + a plain-language tooltip.
		const chat = page.getByTitle(/^Chat:/);
		const ptt = page.getByTitle(/^Tap to talk:/);
		const handsfree = page.getByTitle(/^Hands-free:/);

		await expect(chat).toBeVisible();
		await expect(ptt).toBeVisible();
		await expect(handsfree).toBeVisible();

		// Labels are the whole point of the fix — assert they're rendered.
		await expect(chat).toContainText("Chat");
		await expect(ptt).toContainText("Tap to talk");
		await expect(handsfree).toContainText("Hands-free");

		// Copy JSON + Clear moved into the "Chat options" overflow menu.
		const menu = page.getByTitle("Chat options");
		await expect(menu).toBeVisible();
		await menu.click();
		await expect(page.getByRole("button", { name: "Copy JSON" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Clear messages" })).toBeVisible();
	});

	test("instance chat load more button appears with many messages", async ({
		page,
	}) => {
		// Mock 20 messages (the page size) so "Load earlier" button appears
		const messages = Array.from({ length: 20 }, (_, i) => ({
			id: `msg-${i}`,
			role: i % 2 === 0 ? "user" : "assistant",
			content: `Message ${i}`,
			createdAt: new Date(Date.now() - (20 - i) * 60000).toISOString(),
		}));
		await mockSignedInConsole(page);
		await page.route("**/v1/instances/inst-1/messages*", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ messages }),
			}),
		);
		await page.goto("/console/instances/inst-1");

		await expect(page.getByRole("button", { name: "Load earlier messages" })).toBeVisible();
	});

	test("instance chat sends 'message' field to /chat API", async ({ page }) => {
		let capturedBody: Record<string, unknown> | null = null;
		await mockSignedInConsole(page);
		await page.route("**/v1/instances/inst-1/chat", async (route) => {
			if (route.request().method() === "POST") {
				capturedBody = route.request().postDataJSON();
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ message: { role: "assistant", content: "ok" } }),
				});
			}
			return route.continue();
		});
		await page.goto("/console/instances/inst-1");
		const input = page.getByPlaceholder(/Send a message|Ask about your repos/);
		await input.fill("test payload");
		await page.getByRole("button", { name: /Send/ }).first().click();
		await expect(page.getByText("ok")).toBeVisible();
		expect(capturedBody).toMatchObject({ message: "test payload" });
	});

	test("coding terminal sends 'text' field to /message API", async ({ page }) => {
		let capturedBody: Record<string, unknown> | null = null;
		await mockSignedInConsole(page, {
			instances: [{
				id: "inst-1",
				name: "Coder",
				slug: "coder",
				category: "code",
				capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" },
			}],
		});
		// Mock all coding endpoints
		await page.route("**/v1/instances/inst-1/coding/**", async (route) => {
			const url = route.request().url();
			const method = route.request().method();
			const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
			if (url.includes("/repos")) return json({ repos: [{ id: "repo-1", name: "test-repo", workdir: "~/test", cloneStatus: "ready" }] });
			if (url.includes("/engines")) return json({ engines: [], defaultEngineId: "claude" });
			if (url.includes("/message") && method === "POST") { capturedBody = route.request().postDataJSON(); return json({ ok: true }); }
			if (url.includes("/capture")) return json({ pane: "❯ ready", runState: "idle" });
			if (url.includes("/start")) return json({ ok: true });
			if (url.includes("/timeline")) return json({ timeline: [] });
			if (url.includes("/sessions") && method === "POST") return json({ session: { id: "sess-1", repoId: "repo-1", status: "active" } });
			if (url.includes("/sessions")) return json({ sessions: [{ id: "sess-1", repoId: "repo-1", status: "active" }] });
			return json({});
		});

		await page.goto("/console/instances/inst-1");
		// Coding tab now defaults to the repo list — open the active session first, then Terminal.
		await page.getByRole("button", { name: "Coding" }).click();
		await page.getByRole("button", { name: "Open", exact: true }).click();
		await page.getByRole("button", { name: "Terminal", exact: true }).click();
		const termInput = page.getByPlaceholder(/message to the (CLI|Engine)/i);
		await termInput.fill("git status");
		await page.getByRole("button", { name: "Send", exact: true }).last().click();
		await expect.poll(() => capturedBody).toBeTruthy();
		expect(capturedBody).toMatchObject({ text: "git status" });
	});

	test("coding terminal shows colorized output", async ({ page }) => {
		await mockSignedInConsole(page, {
			instances: [{
				id: "inst-1",
				name: "Coder",
				slug: "coder",
				category: "code",
				capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" },
			}],
		});
		await page.route("**/v1/instances/inst-1/coding/**", async (route) => {
			const url = route.request().url();
			const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
			if (url.includes("/repos")) return json({ repos: [{ id: "repo-1", name: "test-repo", workdir: "~/test", cloneStatus: "ready" }] });
			if (url.includes("/engines")) return json({ engines: [], defaultEngineId: "claude" });
			if (url.includes("/capture")) return json({ pane: "❯ hello\n[error] something broke\n✓ done", runState: "idle" });
			if (url.includes("/start")) return json({ ok: true });
			if (url.includes("/timeline")) return json({ timeline: [] });
			if (url.includes("/sessions")) return json({ sessions: [{ id: "sess-1", repoId: "repo-1", status: "active" }] });
			return json({});
		});
		await page.goto("/console/instances/inst-1");
		await page.getByRole("button", { name: "Coding" }).click();
		await page.getByRole("button", { name: "Open", exact: true }).click();
		await page.getByRole("button", { name: "Terminal", exact: true }).click();

		// Prompt line should be cyan
		await expect(page.locator('span[style*="color:#67e8f9"]')).toBeVisible();
		// Error line should be red
		await expect(page.locator('span[style*="color:#f87171"]')).toBeVisible();
		// Success line should be green
		await expect(page.locator('span[style*="color:#4ade80"]')).toBeVisible();
	});

	test("instance chat shows error message on API failure", async ({
		page,
	}) => {
		await mockSignedInConsole(page, {
			instanceChatStatus: 402,
			instanceChatBody: {
				error:
					"Add your Cloudflare Workers AI account ID and API token before running this agent.",
			},
		});

		await page.goto("/console/instances/inst-1");
		const input = page.getByPlaceholder(/Send a message|Ask about your repos/);
		await input.fill("hello");
		await page.getByRole("button", { name: /Send/ }).first().click();

		await expect(
			page.getByText(
				"Add your Cloudflare Workers AI account ID and API token before running this agent.",
			),
		).toBeVisible();
	});
});

test.describe("ProAgentStore skill discovery", () => {
	test("skills catalog links to the MCP operator skill", async ({ page }) => {
		await page.goto("/skills/");

		await expect(page).toHaveTitle(/Skills/);
		await expect(
			page.getByRole("heading", { name: "ProAgentStore Skills" }),
		).toBeVisible();
		await expect(
			page.getByRole("link", { name: "proagentstore-mcp-operator" }),
		).toBeVisible();
		await expect(page.getByText("codex plugin marketplace add")).toBeVisible();
		await expect(page.getByText("/plugin install proagentstore")).toBeVisible();
	});

	test("MCP operator skill page documents the private runtime flow", async ({
		page,
	}) => {
		await page.goto("/skills/proagentstore-mcp-operator/");

		await expect(page).toHaveTitle(/proagentstore-mcp-operator/);
		await expect(
			page.getByRole("heading", { name: "proagentstore-mcp-operator" }),
		).toBeVisible();
		await expect(
			page.getByText(
				"list_agents -> subscribe_agent -> my_instances -> add_instance_knowledge -> chat_with_instance -> instance_messages",
			),
		).toBeVisible();
		await expect(page.getByText("Requires MCP sign-in")).toBeVisible();
	});

	test("machine-readable skill discovery files are served", async ({
		request,
	}) => {
		const skillsRes = await request.get("/skills.json");
		expect(skillsRes.ok()).toBe(true);
		expect(skillsRes.headers()["content-type"]).toContain("application/json");
		const skills = (await skillsRes.json()) as {
			skills: Array<{ name: string; private_instance_flow: string[] }>;
		};
		expect(skills.skills[0]?.name).toBe("proagentstore-mcp-operator");
		expect(skills.skills[0]?.private_instance_flow).toContain(
			"chat_with_instance",
		);

		const llmsRes = await request.get("/llms.txt");
		expect(llmsRes.ok()).toBe(true);
		expect(llmsRes.headers()["content-type"]).toContain("text/plain");
		expect(await llmsRes.text()).toContain("Claude Code");
	});
});

test.describe("ProAgentStore agent detail pages", () => {
	test("job application assistant renders as a public agent dashboard", async ({ page }) => {
		await page.route(`${API}/v1/public/agents/job-application-assistant`, (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					id: "job-application-assistant",
					slug: "job-application-assistant",
					name: "Job Application Assistant",
					description:
						"Turns a job URL into a tailored application packet and submits only after explicit confirmation.",
					category: "productivity",
					store_type: "agent",
					model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
					created_at: "2026-06-15T00:00:00Z",
					subscriber_count: 0,
				}),
			}),
		);
		await page.route("https://mcp.proagentstore.online/health", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true, tools: 28 }),
			}),
		);
		await page.route(
			"https://raw.githubusercontent.com/ProAgentStore/platform/main/agents/job-application-assistant/README.md",
			(route) =>
				route.fulfill({
					status: 200,
					contentType: "text/plain",
					body: "# Job Application Assistant\n\nPrepare and submit job applications safely.",
				}),
		);

		await page.goto("/agents/job-application-assistant/");

		await expect(
			page.getByRole("heading", { name: "Job Application Assistant" }),
		).toBeVisible();
		await expect(page.locator("#a-category")).toHaveText("productivity");
		await expect(page.locator("#a-health-pill")).toHaveText("online");
		await expect(page.getByText("MCP online with 28 tools")).toBeVisible();
		await expect(page.locator("#api-chat")).toContainText(
			"/v1/public/agents/job-application-assistant/try",
		);
		await expect(page.locator("#readme-summary")).toContainText(
			"Prepare and submit job applications safely.",
		);
	});
});

test.describe("ProAgentStore architecture docs", () => {
	test("browser runtime docs show the ProAgentStore runtime architecture", async ({ page }) => {
		await page.goto("/docs/browser-runtime/");

		await expect(
			page.getByRole("heading", { name: "ProAgentStore Browser Runtime" }),
		).toBeVisible();
		await expect(page.getByRole("heading", { name: "Connectivity Modes" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Brain vs Hands" })).toBeVisible();
		await expect(page.getByText("WebSocket relay").first()).toBeVisible();
	});
});

test.describe("ProAgentStore live API smoke", () => {
	test("providers include Cloudflare Workers AI", async ({ request }) => {
		const res = await request.get(
			"https://api.proagentstore.online/v1/keys/providers",
		);
		expect(res.ok()).toBe(true);

		const data = (await res.json()) as {
			providers: Array<{ id: string; name: string }>;
		};
		expect(data.providers).toContainEqual(
			expect.objectContaining({
				id: "cloudflare",
				name: "Cloudflare Workers AI",
			}),
		);
	});
});

test.describe("ProAgentStore authenticated Console", () => {
	test("opens an agent and renders the chat tab", async ({
		page,
	}) => {
		await mockSignedInConsole(page);
		await page.goto("/console/agents");

		await expect(page.getByText("Agents you've built")).toBeVisible();
		await page.getByText("Ops Agent").click();

		// Agent detail page should load with chat
		await expect(page.getByText("Ops Agent").first()).toBeVisible();
		await expect(page.getByPlaceholder("Send a message...")).toBeVisible();
	});

	test("opens an agent and navigates to settings tab", async ({
		page,
	}) => {
		await mockSignedInConsole(page);
		await page.goto("/console/agents");

		await page.getByText("Ops Agent").click();
		await page.getByRole("button", { name: "Settings", exact: true }).click();

		await expect(page.getByText("Identity")).toBeVisible();
		await expect(page.getByText("Model & Publishing")).toBeVisible();
		await expect(page.getByRole("button", { name: "Save All Settings" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Delete Agent" })).toBeVisible();
	});
});

/**
 * Overflow measurement shared by the guards below.
 *
 * `<main>` is the scroll region and the header nav is an intentional `overflow-x-auto` strip, so
 * those two are what the assertions look at — plus any OTHER element inside main that has quietly
 * become horizontally pannable, which is what a user feels as "the page scrolls sideways" even
 * when the document does not (#235).
 *
 * ── `wide`, and why `docOv` cannot be the guard (#333)
 *
 * #333 proposed asserting `documentElement.scrollWidth - clientWidth` on every route. That would
 * assert NOTHING here: the app root is `h-dvh overflow-hidden` (Layout.tsx), so the document is
 * exactly the viewport and `docOv` is structurally 0 no matter what overflows inside. It is kept
 * below only as a cheap tripwire for that root class changing.
 *
 * The hole #333 correctly identified is in `scrollers`, which only looks at elements whose OWN
 * `overflow-x` is `auto`/`scroll`. The failure mode it is worried about — a `flex` row that cannot
 * wrap — has `overflow-x: visible`, so it widens its ancestors and is skipped here. `wide` closes
 * that by measuring GEOMETRY instead: any element whose right edge is past the viewport.
 *
 * Descendants of a nested scroller are excused, because a strip that pans on purpose (the
 * instance sub-tabs) has content past the edge by design. `<main>` is SKIPPED in that walk rather
 * than counted: it is `overflow-auto` on the pages that scroll vertically, so treating it as a
 * licence would excuse the whole page and put the hole straight back.
 *
 * ── `wide` measures the whole BODY, not just `<main>`
 *
 * `scrollers` and the loop that fed `wide` both started at `<main>`, so two of the three regions of
 * the app shell were outside everything this function could see: the sticky header (logo, nav,
 * bell, avatar, hamburger) and the push-permission banner above `<main>` — a `flex-wrap` row with a
 * `min-w-[8rem]` text column and a `whitespace-nowrap shrink-0` button, i.e. exactly the shape #333
 * was reported against, in a component the guard could not measure. A user who feels the page pan
 * sideways does not know which region did it. `wide` now walks `document.body`.
 *
 * `scrollers` deliberately stays scoped to `<main>`: the header nav IS `overflow-x-auto` by design
 * from `sm` up, and `navOv` below is the assertion that owns it.
 */
async function measureOverflow(page: Page) {
	return page.evaluate(() => {
		const m = document.querySelector("main");
		const scrollers: string[] = [];
		const wide: string[] = [];
		const name = (h: HTMLElement) => {
			const cls = typeof h.className === "string" ? h.className : "";
			return `${h.tagName.toLowerCase()}${h.id ? `#${h.id}` : ""}.${cls.split(/\s+/).slice(0, 3).join(".")}`;
		};
		const insideScroller = (el: HTMLElement) => {
			for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
				if (p === m) continue; // the page's own scroll region, never a licence
				const ox = getComputedStyle(p).overflowX;
				if (ox === "auto" || ox === "scroll") return true;
			}
			return false;
		};
		for (const el of Array.from(m?.querySelectorAll("*") ?? [])) {
			const h = el as HTMLElement;
			const over = h.scrollWidth - h.clientWidth;
			const ox = getComputedStyle(h).overflowX;
			if (over > 1 && (ox === "auto" || ox === "scroll")) {
				scrollers.push(`${name(h)} (+${over}px)`);
			}
		}
		for (const el of Array.from(document.body.querySelectorAll("*"))) {
			const h = el as HTMLElement;
			const r = h.getBoundingClientRect();
			if (r.width > 0 && r.right > window.innerWidth + 1 && !insideScroller(h)) {
				wide.push(`${name(h)} (right ${Math.round(r.right)} > ${window.innerWidth})`);
			}
		}
		const nav = document.querySelector('header nav[aria-label="Primary"]');
		return {
			mainOv: m ? m.scrollWidth - m.clientWidth : 0,
			docOv: document.documentElement.scrollWidth - window.innerWidth,
			wide,
			// The primary nav used to be the ONLY thing that panned on a phone, and the guard
			// explicitly excused it — so the guard was green on the page users said scrolled
			// sideways. It is hidden below sm now (the hamburger carries it), so it must measure 0
			// at these widths. Hidden ⇒ scrollWidth/clientWidth are both 0.
			navOv: nav ? nav.scrollWidth - nav.clientWidth : 0,
			scrollers,
		};
	});
}

test.describe("mobile — no horizontal overflow (regression guard for the missing-w-full bug)", () => {
	// Phones. The bug (page container sizing to max-content instead of the viewport)
	// only shows below the sm: breakpoint (640px) and needs real content to trigger.
	// 320px is the narrowest phone still in use (iPhone SE 1st gen) and the width where a row
	// of fixed-width controls stops fitting; 375 is the common floor.
	// 390 added at #333 — it is the width the report named (iPhone 12/13/14), and a row that fits
	// at 375 and not at 390 is impossible, but a row sized off a 390-wide breakpoint is not.
	const WIDTHS = [320, 375, 390];

	// Routes rendered with the mock's seeded content — empty pages can't reproduce the
	// bug (their max-content is small), so we cover the content-bearing pages that had it.
	const routes = [
		"/console/", // agents grid
		"/console/instances", // instances grid
		"/console/agents/agent-1", // AgentDetail (the tab bar + header that overflowed)
		"/console/agents/agent-1/settings",
		"/console/instances/inst-1", // Assistant/chat
		"/console/instances/inst-1/board", // apply board
		"/console/instances/inst-1/knowledge",
		"/console/instances/inst-1/settings",
		"/console/profile",
		"/console/preferences",
		"/console/notifications",
	];

	for (const width of WIDTHS) {
		for (const route of routes) {
			test(`no horizontal scroll at ${width}px — ${route}`, async ({ page }) => {
				await page.setViewportSize({ width, height: 812 });
				await mockSignedInConsole(page);
				await page.goto(route);
				await page.waitForLoadState("networkidle");
				await page.locator("main").waitFor();
				await page.waitForTimeout(300); // let async content settle

				const { mainOv, docOv, navOv, wide } = await measureOverflow(page);
				expect(mainOv, `<main> overflows by ${mainOv}px at ${width}w on ${route}`).toBeLessThanOrEqual(1);
				expect(docOv, `page overflows by ${docOv}px at ${width}w on ${route}`).toBeLessThanOrEqual(1);
				expect(navOv, `primary nav pans by ${navOv}px at ${width}w on ${route}`).toBeLessThanOrEqual(1);
				// The `overflow-x: visible` case the other three miss: content past the right edge
				// that is clipped rather than scrollable, so nothing reports it and nobody can reach it.
				expect(wide, `content past the right edge at ${width}w on ${route}: ${wide.join(", ")}`).toEqual([]);
			});
		}
	}
});

/**
 * The Terminal tab's pane is readable on a phone (#370).
 *
 * This is the guard the sweep above structurally could not be. `measureOverflow` measures the
 * HORIZONTAL axis, and #370 was a vertical collapse: below `lg` the tab's two-column grid stacks
 * eight blocks in one column, five of which are full-width inputs below `sm`, and the `<pre>` is
 * the only `flex-1` element among them — so it absorbed the whole deficit and resolved to 24px,
 * its own `p-3` padding and ZERO lines of output. Nothing about that pushes anything past the
 * right edge, so every horizontal assertion was correctly green on a tab showing nothing.
 *
 * The second reason it was never caught: no instance in any fixture declares `surfaces: ["tmux"]`,
 * so `TmuxTab` had never rendered in an e2e run at all — a vertical check bolted onto the sweep
 * would still not have visited it. This block supplies the fixture and asserts BOTH axes.
 */
test.describe("mobile — the terminal pane is readable (#370)", () => {
	const PANE = Array.from({ length: 60 }, (_, i) => `❯ line ${i} ${"x".repeat(70)}`).join("\n");

	const tmuxInstance = [{
		id: "inst-1",
		name: "Terminal Agent",
		slug: "terminal-agent",
		category: "productivity",
		capabilities: { surfaces: ["tmux"], runtime: "terminal", workflow: null },
	}];

	async function mockTmux(page: Page) {
		await mockSignedInConsole(page, { instances: tmuxInstance });
		await page.route("**/v1/instances/inst-1/tools**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
			if (path.endsWith("/tools")) {
				// Every write tool granted: that renders the create-target and send-keys rows, which
				// are the five stacked inputs that squeezed the pane. A read-only fixture would not
				// reproduce the bug.
				return json({
					tools: ["terminal_list_targets", "terminal_capture", "terminal_run_command", "terminal_send_keys", "terminal_new_target", "terminal_kill_target"]
						.map((name) => ({ name, allowed: true, scope: name.endsWith("_capture") || name.endsWith("_targets") ? "read" : "write" })),
				});
			}
			if (path.endsWith("/terminal_list_targets")) {
				return json({
					success: true,
					content: JSON.stringify([
						{ backend: "tmux", id: "main", name: "main", windows: 3, attached: true, activeCommand: "pnpm test", activeWindow: "editor" },
						{ backend: "tmux", id: "build", name: "build", windows: 1, attached: false, activeCommand: "vite" },
						{ backend: "kitty", id: "7", name: "scratch", windows: 1, attached: false },
					]),
				});
			}
			if (path.endsWith("/terminal_capture")) return json({ success: true, content: PANE });
			return json({ success: true, content: "" });
		});
	}

	/** Height of the pane's CONTENT box in whole lines — what a person can actually read. */
	async function paneLines(page: Page) {
		return page.evaluate(() => {
			const pre = document.querySelector("pre");
			if (!pre) return 0;
			const cs = getComputedStyle(pre);
			const inner = pre.getBoundingClientRect().height - Number.parseFloat(cs.paddingTop) - Number.parseFloat(cs.paddingBottom);
			return Math.floor(inner / Number.parseFloat(cs.lineHeight));
		});
	}

	/**
	 * Ten lines is well under what the fix delivers (30 at 320px, 32 at 390px, 20 at 390px/1.3x)
	 * and far above what the bug did (0). It is a floor on "readable", not a pin on the layout —
	 * pinning the exact height would fail on any deliberate chrome change and teach nothing.
	 */
	const MIN_LINES = 10;

	for (const width of [320, 390]) {
		test(`the pane shows terminal output at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockTmux(page);
			await page.goto("/console/instances/inst-1/tmux");
			await page.waitForLoadState("networkidle");
			await page.waitForTimeout(400);

			// The fixture really rendered — a 0-line pane and an unrendered tab both "show nothing".
			await expect(page.locator('span[style*="color:#67e8f9"]').first()).toBeVisible();
			expect(await paneLines(page), `terminal pane shows too few lines at ${width}px`).toBeGreaterThanOrEqual(MIN_LINES);

			// And it did not buy that height by panning the page sideways.
			const { mainOv, docOv, wide } = await measureOverflow(page);
			expect(wide, `content past the right edge at ${width}w: ${wide.join(", ")}`).toEqual([]);
			expect(mainOv).toBeLessThanOrEqual(1);
			expect(docOv).toBeLessThanOrEqual(1);
		});
	}

	test("the pane survives the largest text size", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 812 });
		await mockTmux(page);
		await page.addInitScript(() => window.localStorage.setItem("pags:textScale", "1.3"));
		await page.goto("/console/instances/inst-1/tmux");
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(400);

		const rootPx = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
		expect(rootPx, "text scale did not reach the document").toBeGreaterThan(19);
		expect(await paneLines(page), "terminal pane shows too few lines at 1.3x").toBeGreaterThanOrEqual(MIN_LINES);

		const { wide, mainOv } = await measureOverflow(page);
		expect(wide, `content past the right edge at 390w / 1.3x: ${wide.join(", ")}`).toEqual([]);
		expect(mainOv).toBeLessThanOrEqual(1);
	});

	test("the switch reaches the target list and the controls the pane no longer shares a column with", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 812 });
		await mockTmux(page);
		await page.goto("/console/instances/inst-1/tmux");
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(400);

		// Output is the landing view — the report was "it shows the terminal selector", so landing
		// on the selector would reproduce the complaint deliberately.
		await expect(page.getByRole("button", { name: "Output", exact: true })).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByRole("button", { name: "Text to send" })).toBeHidden();

		await page.getByRole("button", { name: "Controls", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "Text to send" })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Working directory" })).toBeVisible();
		await expect(page.locator("pre")).toBeHidden();

		await page.getByRole("button", { name: "Targets", exact: true }).click();
		await expect(page.getByText("scratch")).toBeVisible();

		// Picking a target is asking for its output, so the tap lands you back on the pane.
		await page.getByText("scratch").click();
		await expect(page.locator("pre")).toBeVisible();
		expect(await paneLines(page)).toBeGreaterThanOrEqual(MIN_LINES);
	});

	test("the wide layout still shows every block at once", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 812 });
		await mockTmux(page);
		await page.goto("/console/instances/inst-1/tmux");
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(400);

		// No switch above lg, and the three blocks it would switch between are all on screen —
		// the two-column layout was never the bug and must not become collateral.
		await expect(page.getByRole("button", { name: "Output", exact: true })).toBeHidden();
		await expect(page.locator("pre")).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Text to send" })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Command", exact: true })).toBeVisible();
		await expect(page.getByText("scratch")).toBeVisible();
		expect(await paneLines(page)).toBeGreaterThanOrEqual(MIN_LINES);
	});
});

/**
 * Profile, with the data a real account actually has (#235).
 *
 * The sweep above ran Profile with the default fixture: no profile fields, no API providers, a
 * 15-character token, `user-1` / `tester`. Under that fixture three of the page's five sections
 * never render and the two that do hold strings shorter than any real value — so the guard was
 * green while users saw the page pan sideways. A regression guard is only as honest as its
 * fixture, and this is the fixture the page is actually used with.
 */
test.describe("mobile — Profile with real-shaped account data", () => {
	const realistic = {
		user: {
			id: "9f1c2b84-6d3e-4a55-9c07-2f8ab41d7e63",
			login: "serge-ivo-development",
			display_name: "Serge Ivochkin (ProAgentStore)",
			roles: ["user", "creator", "admin"],
		},
		profile: {
			fields: [
				{ key: "full_name", label: "Full name", group: "personal" },
				{ key: "phone", label: "Phone number", group: "personal", private: true },
				{ key: "city", label: "City / suburb", group: "personal" },
				{ key: "country", label: "Country of residence", group: "personal" },
				{ key: "linkedin", label: "LinkedIn profile URL", group: "personal" },
				{ key: "work_auth", label: "Work authorization status", group: "job", private: true },
				{ key: "salary", label: "Salary expectation (annual)", group: "job", private: true },
			],
			profile: {
				full_name: "Serge Ivochkin",
				phone: "+61 400 000 000",
				city: "Sydney",
				country: "Australia",
				linkedin: "https://www.linkedin.com/in/a-fairly-long-profile-slug-here",
				work_auth: "Permanent resident — full working rights",
				salary: "180000",
			},
		},
		providers: [
			{ id: "anthropic", name: "Anthropic Claude", hasKey: true },
			{ id: "openai", name: "OpenAI", hasKey: false },
			{ id: "cloudflare", name: "Cloudflare Workers AI", hasKey: true },
			{ id: "google", name: "Google Gemini", hasKey: false },
		],
	};

	for (const width of [320, 360, 375, 390]) {
		test(`no horizontal scroll at ${width}px — /console/profile`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockSignedInConsole(page, realistic);
			await page.goto("/console/profile");
			await page.waitForLoadState("networkidle");
			await page.locator("main").waitFor();
			// Every section rendered — otherwise this is the old, hollow version of the check.
			await expect(page.getByRole("heading", { name: "API Token" })).toBeVisible();
			await expect(page.getByText("Anthropic Claude")).toBeVisible();
			await expect(page.getByText("Work authorization status")).toBeVisible();
			// Worst case for the token row: the full value on screen, not the 12-char preview.
			await page.getByRole("button", { name: "Show" }).click();
			await page.waitForTimeout(200);

			const { mainOv, docOv, navOv, scrollers, wide } = await measureOverflow(page);
			expect(mainOv, `<main> overflows by ${mainOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(docOv, `page overflows by ${docOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(navOv, `primary nav pans by ${navOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(wide, `content past the right edge at ${width}w: ${wide.join(", ")}`).toEqual([]);
			// A pannable strip inside the page reads as horizontal page scroll on a touch device
			// even when nothing reports document overflow. Profile has no legitimate one.
			expect(scrollers, `unexpected horizontal scrollers at ${width}w: ${scrollers.join(", ")}`).toEqual([]);
		});
	}

	/**
	 * The roles row, past what an account can actually hold (#333).
	 *
	 * Deliberately NOT folded into `realistic` above, and deliberately labelled as a stress case:
	 * the platform has exactly three roles, all three are in the real fixture, and all three fit
	 * at 320px. Pretending otherwise would be the same dishonesty as the fixture that made #235
	 * look fixed.
	 *
	 * It is here because the row is `flex`, and a `flex` row does not wrap unless told to — so
	 * with the real data the wrap is never exercised and could be deleted without a test noticing.
	 * Verified to fail on `wide` at 320px with `flex-wrap` removed, and to pass with it.
	 */
	test("the roles row wraps rather than pushing past the edge", async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 812 });
		await mockSignedInConsole(page, { ...realistic, user: { ...realistic.user, roles: ["user", "creator", "admin", "moderator"] } });
		await page.goto("/console/profile");
		await page.waitForLoadState("networkidle");
		await page.locator("main").waitFor();
		await page.waitForTimeout(200);

		const { mainOv, wide } = await measureOverflow(page);
		expect(wide, `roles row pushed content past the right edge: ${wide.join(", ")}`).toEqual([]);
		expect(mainOv).toBeLessThanOrEqual(1);
	});

	/**
	 * The largest text size, which every other guard here runs without (#333).
	 *
	 * Preferences → Appearance offers 0.9x / 1x / 1.15x / 1.3x, persisted to `pags:textScale` and
	 * applied to `document.documentElement.style.fontSize` on boot (`main.tsx`). At 1.3x every
	 * rem-sized padding, gap and font grows 30% while the px-pinned parts do not move — the 72px
	 * avatar, `max-w-[220px]` on the token, `max-w-[200px]` on the user id, the mobile input's
	 * `font-size: 16px`. A row that fits at 1x and not at 1.3x is the exact shape of this report,
	 * and it is one tap away from any account, so a guard that only ever runs at 1x is measuring a
	 * setting rather than the app.
	 *
	 * It passes today. It is here so that stays a measured fact.
	 */
	for (const width of [320, 390]) {
		for (const route of ["/console/profile", "/console/preferences"]) {
			test(`no horizontal scroll at ${width}px and 1.3x text — ${route}`, async ({ page }) => {
				await page.setViewportSize({ width, height: 812 });
				await mockSignedInConsole(page, realistic);
				await page.addInitScript(() => window.localStorage.setItem("pags:textScale", "1.3"));
				await page.goto(route);
				await page.waitForLoadState("networkidle");
				await page.locator("main").waitFor();
				await page.waitForTimeout(300);

				// The scale actually reached the document — otherwise this is a 1x run wearing a
				// 1.3x name, which is the hollow-fixture failure #235 was closed on.
				const rootPx = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
				expect(rootPx, "text scale did not reach the document").toBeGreaterThan(19);

				const { mainOv, wide } = await measureOverflow(page);
				expect(wide, `content past the right edge at ${width}w / 1.3x on ${route}: ${wide.join(", ")}`).toEqual([]);
				expect(mainOv, `<main> overflows by ${mainOv}px at ${width}w / 1.3x on ${route}`).toBeLessThanOrEqual(1);
			});
		}
	}
});
