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
	/** `GET /v1/connectors` — see DEFAULT_CONNECTORS for why the default is not empty. */
	connectors?: Array<Record<string, unknown>>;
}

/**
 * The connector catalog `GET /v1/connectors` serves, with an account connected (#333).
 *
 * This is a DEFAULT rather than an opt-in, because the absence of it is what hid the bug. The
 * route was not mocked at all, so it fell through to the unhandled-route 500 that closes the
 * handler; `AccountConnections` catches that and renders "No other accounts can be connected on
 * this deployment yet." Every mobile guard on Preferences was therefore measuring a Connections
 * section with **no rows in it** — the exact hollow-fixture failure #235 was closed on, one page
 * over, and the reason two rounds of measurement on this ticket reported the page clean.
 *
 * The account is an email because that is what the connected account IS on all three of these,
 * and an email is one unbreakable token: it is the thing that overflowed.
 */
const DEFAULT_CONNECTORS = [
	{ id: "gmail", label: "Gmail", auth: "oauth", grantModel: "user", configured: true, connected: true, account: "sergey.ivochkin@rocketlab.com.au", connectedAt: "2026-07-01T00:00:00Z", reach: null, flow: { start: "/v1/email/google/start", disconnect: "/v1/email/google" } },
	{ id: "google_drive", label: "Google Drive", auth: "oauth", grantModel: "instance-resource", configured: true, connected: true, account: "sergey.ivochkin@rocketlab.com.au", connectedAt: "2026-07-01T00:00:00Z", reach: { grants: 3, instances: 2 }, flow: { start: "/v1/drive/google/start", disconnect: "/v1/drive/google" } },
	{ id: "zoho_workdrive", label: "Zoho WorkDrive", auth: "oauth", grantModel: "instance-resource", configured: true, connected: false, account: null, connectedAt: null, reach: null, flow: { start: "/v1/workdrive/zoho/start", disconnect: "/v1/workdrive/zoho" } },
];

/**
 * The notification vocabulary `GET /v1/preferences` serves (#360).
 *
 * Same reason as above: `NotificationPreferences` is `if (!types.length) return null`, so with no
 * vocabulary in the fixture that whole section rendered NOTHING and no guard had ever visited it.
 */
const DEFAULT_NOTIFICATION_TYPES = [
	{ id: "task.needs_human", label: "An agent needs your input", description: "A run has stopped and is waiting on you — a CAPTCHA, or a value it does not have.", alerts: true },
	{ id: "deploy.finished", label: "Deployment finished", description: "A build of one of your agents completed or failed.", alerts: false },
];

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
			// The REAL wire shape: `relay.connected` + `attachment`, never a top-level `connected`.
			// The old fixture answered the shape the console once wrongly read (and #370's own
			// comment in InstanceDetail describes) — so every signed-in console test ran with a
			// runner the page could only read as offline, and no surface rendering an offline state
			// could be trusted here (#378).
			return json(options.runtime ?? {
				runtime: { instanceId: "inst-1", status: "online", runnerNode: "my-machine" },
				relay: { connected: true, runnerNode: "my-machine", live: true },
				attachment: { state: "attached", message: "Connected.", remedy: null },
			});
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
		if (path === "/v1/connectors") return json({ connectors: options.connectors ?? DEFAULT_CONNECTORS });
		// Account preferences (#211) — voice/translation defaults shared by every agent.
		if (path === "/v1/preferences") {
			if (method === "PUT") { savedPreferences = JSON.parse(route.request().postData() || "{}"); return json({ preferences: savedPreferences }); }
			return json({ preferences: { voice: { speed: 130, sttMode: "openai" } }, languages: [{ name: "Chinese", tag: "zh-CN" }, { name: "English", tag: "en-US" }], notificationTypes: DEFAULT_NOTIFICATION_TYPES });
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

	/**
	 * The console shell is never cached, and this asserts the PRODUCT's header (#437).
	 *
	 * It used to read `toContain("max-age=300")`, which is what `e2e/console-server.mjs` sent and
	 * what `workers/host` has never sent for this path: `CONSOLE_HEADERS` (`workers/host/src/index.ts`)
	 * spreads `HTML_HEADERS` and overrides `Cache-Control` to `no-store`, used for `/console`,
	 * `/console/*` and the `/admin/*` shell. So the test passed in CI because the FIXTURE satisfied
	 * it, and failed against the real origin — verified, `curl -I https://proagentstore.online/console/`
	 * → `cache-control: no-store`. That is #413's shape one layer down: the local server was not
	 * merely possibly-stale, it was the only thing the assertion was about.
	 *
	 * `toBe`, not `toContain`: `no-store` is the whole promise, and a `no-store, max-age=300` that
	 * `toContain` would wave through is a contradiction, not a superset. The fixture was moved to
	 * `no-store` in the same commit — moving one side alone turns this from meaningless-and-green
	 * into meaningless-and-red.
	 */
	test("console HTML is served no-store, as the Worker sends it", async ({ page }) => {
		const res = await page.request.get("/console/");
		expect(res.ok()).toBe(true);
		expect(res.headers()["cache-control"], "workers/host serves CONSOLE_HEADERS (no-store) for /console/ — the fixture must agree").toBe("no-store");
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

	/** A page of the transcript, in the shape the API returns since #428. */
	function messagePage(from: number, count: number) {
		return Array.from({ length: count }, (_, i) => ({
			id: `msg-${from + i}`,
			role: (from + i) % 2 === 0 ? "user" : "assistant",
			content: `Message ${from + i}`,
			createdAt: new Date(Date.now() - (40 - (from + i)) * 60000).toISOString(),
		}));
	}

	test("instance chat load more button appears with many messages", async ({
		page,
	}) => {
		// A full page AND a server cursor: the button is shown only when it can actually work
		// (#428). Before this the console minted its own cursor from `oldest.id` — a UUID the DO's
		// `msg:{createdAt}:{id}` ordering could never seek with — so the button was always present
		// and always re-served the newest page.
		await mockSignedInConsole(page);
		await page.route("**/v1/instances/inst-1/messages*", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ messages: messagePage(20, 20), nextCursor: "msg:cursor:20", hasMore: true }),
			}),
		);
		await page.goto("/console/instances/inst-1");

		await expect(page.getByRole("button", { name: "Load earlier messages" })).toBeVisible();
	});

	test("instance chat hides load more at the start of the conversation", async ({
		page,
	}) => {
		// `hasMore` is the server's MEASUREMENT, not `older.length >= PAGE`. An exactly-full page
		// with nothing behind it used to leave the button up forever, and every click added twenty
		// duplicates of the tail to the top of the thread (#428).
		await mockSignedInConsole(page);
		await page.route("**/v1/instances/inst-1/messages*", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ messages: messagePage(0, 20), nextCursor: null, hasMore: false }),
			}),
		);
		await page.goto("/console/instances/inst-1");

		await expect(page.getByText("Message 19")).toBeVisible();
		await expect(page.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0);
	});

	test("instance chat loads GENUINELY older messages, once, and then stops", async ({
		page,
	}) => {
		// The end-to-end shape of #428: the cursor goes back to the server, the page that comes
		// back is older rather than the newest one again, nothing is duplicated, and the button
		// disappears when the conversation starts.
		const cursors: Array<string | null> = [];
		await mockSignedInConsole(page);
		await page.route("**/v1/instances/inst-1/messages*", (route) => {
			const before = new URL(route.request().url()).searchParams.get("before");
			cursors.push(before);
			const body = before
				? { messages: messagePage(0, 20), nextCursor: null, hasMore: false }
				: { messages: messagePage(20, 20), nextCursor: "msg:cursor:20", hasMore: true };
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
		});
		await page.goto("/console/instances/inst-1");

		await expect(page.getByText("Message 39")).toBeVisible();
		await page.getByRole("button", { name: "Load earlier messages" }).click();

		// Older content is on screen…
		await expect(page.getByText("Message 0")).toBeVisible();
		// …the server got the cursor it handed out, not a message id…
		expect(cursors).toContain("msg:cursor:20");
		// …no row appears twice (the duplicate-key corruption the old prepend caused)…
		await expect(page.getByText("Message 20", { exact: true })).toHaveCount(1);
		// …and the button is gone, because the server said there is nothing older.
		await expect(page.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0);
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
 *
 * ── `escapes`: a box past its OWN container's right edge (#437)
 *
 * Every measurement above shares one axis — *does anything reach past the right edge of the
 * WINDOW*. The defect class none of them can see is *does anything reach past the right edge of its
 * own card*, and that is not hypothetical: it is what #393 shipped. A `truncate shrink-0` span has
 * no width to clamp to, so it draws its full text straight out of the row it sits in and is painted
 * over by the button beside it — two overlapping controls, one unreadable. The span is 288px inside
 * a 288px card inside a 320px window, so `docOv`, `mainOv`, `body` and `wide` all read **0**, in
 * both engines, and always will. Reproduced in a standalone fixture: four green, one red, one
 * defect. `store/console/src/lib/truncation.test.ts` says the same thing from the source side and
 * stays — it catches the CAUSE cheaply, this catches the CLASS, including shapes that are not
 * `truncate shrink-0`.
 *
 * The rule: an element's `right` past its parent's CONTENT-box right (parent rect minus its right
 * border and padding). Attribution is by class name for both the offender and the container,
 * because "the page is 13px too wide" names nobody — the reason #414 asked for it on `wide`.
 *
 * Two exclusions, both narrow and both load-bearing:
 *
 *   - **`position: absolute|fixed`.** Their containing block is the nearest POSITIONED ancestor,
 *     which is usually not the parent, so parent geometry is the wrong yardstick and the answer
 *     would be noise rather than a finding. The overlap defects that live in absolute elements
 *     (#426, #445) are measured directly by intersection in their own blocks.
 *   - **A parent that does not have `overflow-x: visible`.** It clips or scrolls its child, so the
 *     child cannot paint outside it — that parent has taken responsibility for the excess. This is
 *     what excuses the deliberate pans (the instance sub-tab strip) without a list of allowances.
 *
 * Measured before it was gated, rather than assumed: with these two exclusions the current tree
 * reports ZERO on all 11 sweep routes × 320/390 in WebKit, and zero at all 12 call sites below in
 * both engines. So it gates at `[]` rather than ratcheting — there is no deliberate offender to
 * allow, and a guard with a standing allowance list is one nobody reads. The non-vacuity proof is
 * its own test: `mobile — the container-relative guard sees what the viewport guards cannot`
 * injects #393's exact shape and asserts this is the only measurement that goes red.
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
		const escapes: string[] = [];
		for (const el of Array.from(document.body.querySelectorAll("*"))) {
			const h = el as HTMLElement;
			const r = h.getBoundingClientRect();
			if (r.width <= 0) continue;
			if (r.right > window.innerWidth + 1 && !insideScroller(h)) {
				wide.push(`${name(h)} (right ${Math.round(r.right)} > ${window.innerWidth})`);
			}
			// Container-relative: past the right edge of its OWN box, which no measurement above
			// can see. See the two exclusions in the block comment — both are why this gates at [].
			const p = h.parentElement;
			if (!p || p === document.body) continue;
			const pos = getComputedStyle(h).position;
			if (pos === "absolute" || pos === "fixed") continue;
			const ps = getComputedStyle(p);
			if (ps.overflowX !== "visible") continue;
			const px = (v: string) => Number.parseFloat(v) || 0;
			const limit = p.getBoundingClientRect().right - px(ps.borderRightWidth) - px(ps.paddingRight);
			const past = Math.round(r.right - limit);
			if (past > 1) escapes.push(`${name(h)} escapes ${name(p)} by ${past}px`);
		}
		const nav = document.querySelector('header nav[aria-label="Primary"]');
		return {
			mainOv: m ? m.scrollWidth - m.clientWidth : 0,
			docOv: document.documentElement.scrollWidth - window.innerWidth,
			wide,
			escapes,
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

				const { mainOv, docOv, navOv, wide, escapes } = await measureOverflow(page);
				expect(mainOv, `<main> overflows by ${mainOv}px at ${width}w on ${route}`).toBeLessThanOrEqual(1);
				expect(docOv, `page overflows by ${docOv}px at ${width}w on ${route}`).toBeLessThanOrEqual(1);
				expect(navOv, `primary nav pans by ${navOv}px at ${width}w on ${route}`).toBeLessThanOrEqual(1);
				// The `overflow-x: visible` case the other three miss: content past the right edge
				// that is clipped rather than scrollable, so nothing reports it and nobody can reach it.
				expect(wide, `content past the right edge at ${width}w on ${route}: ${wide.join(", ")}`).toEqual([]);
				expect(escapes, `a box past its own container at ${width}w on ${route}: ${escapes.join(", ")}`).toEqual([]);
			});
		}
	}

	/**
	 * The guard is not vacuous, and the four beside it genuinely cannot do its job (#437).
	 *
	 * `escapes` reads `[]` on every route above, which is indistinguishable from a measurement that
	 * can never report anything — the exact failure #414 and #431 both had to write "NON-VACUITY
	 * FIRST" about. So the shape is injected rather than argued: #393's element verbatim, a
	 * `truncate shrink-0` span with no width, inside a rounded card inside `<main>`.
	 *
	 * The assertion is deliberately BOTH halves. That `escapes` goes red is half the ticket; that
	 * `docOv`, `mainOv` and `wide` all stay 0/empty ON THE SAME PAGE is the other half, and it is
	 * the half that stops someone deleting this as a duplicate of the viewport guards. If a future
	 * change makes the viewport guards able to see this, this test fails and says so — which is a
	 * finding, not a flake.
	 */
	test("mobile — the container-relative guard sees what the viewport guards cannot", async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 812 });
		await mockSignedInConsole(page);
		await page.goto("/console/");
		await page.waitForLoadState("networkidle");
		await page.locator("main").waitFor();

		const clean = await measureOverflow(page);
		expect(clean.escapes, `the page was already reporting escapes, so this proves nothing: ${clean.escapes.join(", ")}`).toEqual([]);

		await page.evaluate(() => {
			const card = document.createElement("div");
			card.className = "e2e-393-card";
			// The #393 card: a NARROW bounded box with `overflow-x: visible`, which is what lets its
			// child paint outside it instead of being clipped or scrolled. The width matters — the
			// card has to be narrow enough that the escaping span still ends INSIDE the 320px
			// window, because "escapes its card but not the viewport" is the entire defect class.
			// Sized in px with an explicit font so the fixture does not move with the theme.
			card.style.cssText = "width:120px;padding:8px;border-radius:12px;border:1px solid #303030;font-size:12px";
			const row = document.createElement("div");
			row.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center";
			const span = document.createElement("span");
			// `truncate shrink-0` with no width — `overflow:hidden` clips the TEXT, but `flex-shrink:0`
			// plus `min-width:auto` means the BOX is never narrower than the text, so the box escapes.
			span.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0";
			span.className = "e2e-393-probe";
			span.textContent = "Sergeys-MacBook-Air.local";
			row.appendChild(span);
			card.appendChild(row);
			document.querySelector("main")?.appendChild(card);
		});
		await page.waitForTimeout(100);

		const dirty = await measureOverflow(page);
		const detail = JSON.stringify(dirty);

		// The class this guard exists for, attributed to the element that did it.
		expect(dirty.escapes.join(" "), `the injected #393 shape was not detected: ${detail}`).toContain("e2e-393-probe");

		// And every measurement that predates it is still blind, on this very page. This is the
		// argument for the guard, restated as an assertion so it cannot rot into a duplicate.
		expect(dirty.docOv, `docOv saw it (${dirty.docOv}) — the premise of #437 has changed: ${detail}`).toBeLessThanOrEqual(1);
		expect(dirty.mainOv, `mainOv saw it (${dirty.mainOv}) — the premise of #437 has changed: ${detail}`).toBeLessThanOrEqual(1);
		expect(dirty.wide, `wide saw it — the premise of #437 has changed: ${detail}`).toEqual([]);
	});
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
			const { mainOv, docOv, wide, escapes } = await measureOverflow(page);
			expect(wide, `content past the right edge at ${width}w: ${wide.join(", ")}`).toEqual([]);
			expect(escapes, `a box past its own container at ${width}w: ${escapes.join(", ")}`).toEqual([]);
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

		const { wide, mainOv, escapes } = await measureOverflow(page);
		expect(wide, `content past the right edge at 390w / 1.3x: ${wide.join(", ")}`).toEqual([]);
		expect(escapes, `a box past its own container at 390w / 1.3x: ${escapes.join(", ")}`).toEqual([]);
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

	/**
	 * The offline state, on the device it was reported from (#378).
	 *
	 * With no runner every tool call fails, and the tab used to say so only in a red line it
	 * blanked at the start of the next 4s poll — around three sentences that each assert a runner
	 * that is not there. The phone therefore showed an empty pane and a flicker, which is
	 * indistinguishable from a broken app.
	 *
	 * Asserted on the OUTPUT view, deliberately: the one empty state that named the runner used to
	 * live on Targets, which `DEFAULT_TMUX_VIEW` means a phone never lands on.
	 */
	test("a phone with no runner is told so, and the message does not blink", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 812 });
		await mockTmux(page);
		// Registered AFTER the fixture, so it wins: this instance is pinned to a machine that is up
		// for other agents — the case where `pags up` is the wrong advice.
		await page.route("**/v1/instances/inst-1/runtime/status", (route) => route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				runtime: { instanceId: "inst-1", status: "offline", runnerNode: "my-machine" },
				relay: { connected: false, runnerNode: "my-machine", live: false },
				attachment: {
					state: "machine-online-agent-detached",
					message: "The machine is online but this agent isn't attached.",
					remedy: "pags up --force",
				},
			}),
		}));
		// No runner ⇒ every terminal tool fails, which is how the tab used to find out at all.
		await page.route("**/v1/instances/inst-1/tools/terminal_**", (route) => route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ success: false, content: "No runner is connected for this agent — run `pags up`." }),
		}));
		await page.goto("/console/instances/inst-1/tmux");
		await page.waitForLoadState("networkidle");

		await expect(page.getByRole("button", { name: "Output", exact: true })).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByText("The machine is online but this agent isn't attached.")).toBeVisible();
		// The remedy the CLI knew and nobody could see — and it names the OTHER machine, since
		// `pags up --force` is not a thing this phone can run.
		await expect(page.getByText("pags up --force", { exact: true })).toBeVisible();
		await expect(page.getByText(/Run\s+pags up --force\s+on my-machine\./).first()).toBeVisible();
		// The pane says what will happen rather than asking for a target that cannot exist.
		await expect(page.locator("pre").getByText("Terminal output appears here as soon as the runner reconnects.")).toBeVisible();

		// It must not claim a runner anywhere on the tab.
		const body = await page.evaluate(() => document.body.innerText);
		expect(body).not.toContain("connected runner");
		expect(body).not.toContain("connected machine");

		// And it must STAND. Sampled across more than one 4s poll rather than asserted once: the
		// defect was a message that existed only between a call failing and the next one starting.
		const misses = await page.evaluate(async () => {
			let missed = 0;
			for (let i = 0; i < 55; i++) {
				await new Promise((r) => setTimeout(r, 100));
				if (!document.body.innerText.includes("isn't attached")) missed++;
			}
			return missed;
		});
		expect(misses, "the offline notice disappeared during a poll").toBe(0);
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
 * The same tab on an agent that declares the backend-exclusive `tmux_*` family (#403/#409).
 *
 * The fixture above declares `terminal_*`, which is what three of the four Operators still have —
 * so it stayed green through the entire failure. This one is the tmux Operator: six `tmux_*` tools,
 * no `terminal_*` at all, and a `/tmux/list` payload in the runner's actual shape, which carries a
 * NAME and no `backend`/`id`. That last detail is the whole reason a name-swap would not have
 * worked: the rows would have parsed to nothing and the tab would have looked empty rather than
 * broken.
 *
 * Both phone widths, because the pane's height was the #370 defect and the family change alters the
 * create row's column count. Carries the `mobile — ` prefix on purpose: that is what puts a block in
 * front of WebKit as well as Chromium, and this one measures a phone layout.
 */
test.describe("mobile — the Terminal tab on a tmux-only agent (#409)", () => {
	const PANE = Array.from({ length: 60 }, (_, i) => `❯ tmux line ${i} ${"x".repeat(60)}`).join("\n");

	const tmuxOperator = [{
		id: "inst-1",
		name: "tmux Operator",
		slug: "tmux-operator",
		category: "productivity",
		capabilities: { surfaces: ["tmux"], runtime: "terminal", workflow: null },
	}];

	/** `TOOLS` is the whole variable: swap it and the same fixture becomes the unsupported case. */
	async function mockTmuxOnly(page: Page, TOOLS: string[]) {
		await mockSignedInConsole(page, { instances: tmuxOperator });
		await page.route("**/v1/instances/inst-1/tools**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
			if (path.endsWith("/tools")) {
				return json({ tools: TOOLS.map((name) => ({ name, allowed: true, scope: /_(list|capture)/.test(name) ? "read" : "write" })) });
			}
			if (path.endsWith("/tmux_list_sessions")) {
				// Exactly what `browser-runner/src/coding/tmux.ts` `listSessionsDetailed` returns.
				return json({
					success: true,
					content: JSON.stringify([
						{ name: "main", windows: 3, attached: true, activeCommand: "pnpm test", activeWindow: "editor", created: "1754600000" },
						{ name: "build", windows: 1, attached: false, activeCommand: "vite", activeWindow: "shell", created: "1754600001" },
					]),
				});
			}
			if (path.endsWith("/tmux_capture_pane")) return json({ success: true, content: PANE });
			// The declared-allowlist gate, in the exact shape production returns it (#409's repro).
			if (/\/tools\/terminal_/.test(path)) {
				return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: '"terminal_list_targets" is not one of this agent\'s tools. It can only run the tools its agent declares.' }) });
			}
			return json({ success: true, content: "" });
		});
	}

	const TMUX_TOOLS = ["tmux_list_sessions", "tmux_capture_pane", "tmux_run_command", "tmux_send_keys", "tmux_new_session", "tmux_kill_session"];

	for (const width of [320, 390]) {
		test(`lists tmux sessions and captures a pane at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockTmuxOnly(page, TMUX_TOOLS);
			await page.goto("/console/instances/inst-1/tmux");
			await page.waitForLoadState("networkidle");
			await page.waitForTimeout(500);

			// The pane really rendered — not the 403 the tab showed before this fix.
			await expect(page.locator("pre")).toContainText("tmux line 0");
			const body = await page.evaluate(() => document.body.innerText);
			expect(body).not.toContain("is not one of this agent");
			// And NOT the sentence that sent the owner off to open a session that was already open.
			expect(body).not.toContain("No terminal targets found");

			// Rows survived a payload with no `backend` and no `id` — the trap.
			await page.getByRole("button", { name: "Targets", exact: true }).click();
			await expect(page.getByText("build")).toBeVisible();

			const { wide, mainOv, escapes } = await measureOverflow(page);
			expect(wide, `content past the right edge at ${width}w: ${wide.join(", ")}`).toEqual([]);
			expect(escapes, `a box past its own container at ${width}w: ${escapes.join(", ")}`).toEqual([]);
			expect(mainOv).toBeLessThanOrEqual(1);
		});
	}

	test("the create row offers no backend to choose, and the write controls are live", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 812 });
		await mockTmuxOnly(page, TMUX_TOOLS);
		await page.goto("/console/instances/inst-1/tmux");
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(500);

		await page.getByRole("button", { name: "Controls", exact: true }).click();
		// A tmux-exclusive agent has exactly one backend, so the picker was three options of which
		// two produced a call it cannot make.
		await expect(page.getByRole("combobox", { name: "Terminal backend" })).toBeHidden();
		await expect(page.getByRole("textbox", { name: "Session name" })).toBeEnabled();
		await expect(page.getByRole("textbox", { name: "Text to send" })).toBeEnabled();
	});

	test("an agent with no terminal tool says which tool, and never blames the machine", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 812 });
		// The pre-fix state of the tmux Operator, and the state of any future agent on this surface
		// that declares neither family.
		await mockTmuxOnly(page, ["web_search"]);
		await page.goto("/console/instances/inst-1/tmux");
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(500);

		const body = await page.evaluate(() => document.body.innerText);
		expect(body).toContain("terminal_list_targets or tmux_list_sessions");
		expect(body).not.toContain("No terminal targets found");
		expect(body).not.toContain("Open tmux, kitty, or iTerm2");
		expect(body).not.toContain("is not one of this agent");

		// It must STAND, and it must not cost a call. The tab used to fire two refused requests every
		// four seconds for as long as it was open.
		const seen: string[] = [];
		page.on("request", (r) => { if (/\/tools\/[a-z]/.test(r.url())) seen.push(r.url()); });
		const misses = await page.evaluate(async () => {
			let missed = 0;
			for (let i = 0; i < 55; i++) {
				await new Promise((r) => setTimeout(r, 100));
				if (!document.body.innerText.includes("tmux_list_sessions")) missed++;
			}
			return missed;
		});
		expect(misses, "the not-declared notice disappeared during a poll").toBe(0);
		expect(seen, `the tab kept calling tools it knows are refused: ${seen.join(", ")}`).toEqual([]);
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

			const { mainOv, docOv, navOv, scrollers, wide, escapes } = await measureOverflow(page);
			expect(mainOv, `<main> overflows by ${mainOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(docOv, `page overflows by ${docOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(navOv, `primary nav pans by ${navOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(wide, `content past the right edge at ${width}w: ${wide.join(", ")}`).toEqual([]);
			expect(escapes, `a box past its own container at ${width}w: ${escapes.join(", ")}`).toEqual([]);
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

		const { mainOv, wide, escapes } = await measureOverflow(page);
		expect(wide, `roles row pushed content past the right edge: ${wide.join(", ")}`).toEqual([]);
		expect(escapes, `roles row pushed a box past its own container: ${escapes.join(", ")}`).toEqual([]);
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

				const { mainOv, wide, escapes } = await measureOverflow(page);
				expect(wide, `content past the right edge at ${width}w / 1.3x on ${route}: ${wide.join(", ")}`).toEqual([]);
				expect(escapes, `a box past its own container at ${width}w / 1.3x on ${route}: ${escapes.join(", ")}`).toEqual([]);
				expect(mainOv, `<main> overflows by ${mainOv}px at ${width}w / 1.3x on ${route}`).toBeLessThanOrEqual(1);
			});
		}
	}
});

/**
 * Preferences, with an account actually connected to something (#333).
 *
 * This is the half of #333 that two rounds of measurement reported as "not reproducible", and the
 * reason is the fixture rather than the browser: `GET /v1/connectors` was never mocked, so the
 * Connections section rendered its "nothing to connect on this deployment" line and the rows that
 * carry the overflowing string did not exist. `NotificationPreferences` returns `null` on an empty
 * vocabulary, so that section did not exist either. Two of the page's five sections were absent
 * from every run that declared the page clean — the same hollow fixture as #235, which is the
 * failure this file has now made twice.
 *
 * With the rows present, `<main>` gains **15px of horizontal pan at 390px and 85px at 320px**, at
 * ordinary 1x text. `docOv` stays 0 throughout, exactly as predicted — the app root is
 * `h-dvh overflow-hidden`, so `<main>` is the thing that pans, and everything except the runaway
 * email stops at the viewport. That is why the report was "scrollable into empty space on the
 * right, with no content out there": the content out there is one line of email.
 *
 * The address is plus-addressed because that is the shape of a real Google account and it is what
 * the reporter's own account looks like — NOT a stress case in the sense the roles-row test is one.
 * The plain form (`DEFAULT_CONNECTORS`) reproduces too, at 320px and 1.3x text, which is what the
 * 1.3x block above now covers.
 */
test.describe("mobile — Preferences with a connected account (#333)", () => {
	const connected = {
		user: { githubLinked: "serge-ivo-development" },
		connectors: DEFAULT_CONNECTORS.map((c) =>
			c.account ? { ...c, account: "sergey.ivochkin+proagentstore.console@rocketlab.com.au" } : c,
		),
	};

	for (const width of [320, 360, 375, 390]) {
		test(`no horizontal scroll at ${width}px — /console/preferences`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockSignedInConsole(page, connected);
			await page.goto("/console/preferences");
			await page.waitForLoadState("networkidle");
			await page.locator("main").waitFor();
			await page.waitForTimeout(300);

			// Every section rendered, named one by one. The point of this block is that the two the
			// old fixture skipped are the two that matter, so "the page loaded" is not the check.
			await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
			await expect(page.getByText("sergey.ivochkin+proagentstore.console@rocketlab.com.au").first()).toBeVisible();
			await expect(page.getByRole("button", { name: "Connect Zoho WorkDrive" })).toBeVisible();
			await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
			await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
			await expect(page.getByRole("heading", { name: "Timezone" })).toBeVisible();
			await expect(page.getByRole("heading", { name: "Voice" })).toBeVisible();

			const { mainOv, docOv, navOv, scrollers, wide, escapes } = await measureOverflow(page);
			expect(wide, `content past the right edge at ${width}w: ${wide.join(", ")}`).toEqual([]);
			expect(escapes, `a box past its own container at ${width}w: ${escapes.join(", ")}`).toEqual([]);
			expect(mainOv, `<main> pans by ${mainOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(docOv, `page overflows by ${docOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(navOv, `primary nav pans by ${navOv}px at ${width}w`).toBeLessThanOrEqual(1);
			// Preferences has no strip that pans on purpose, so any is a defect.
			expect(scrollers, `unexpected horizontal scrollers at ${width}w: ${scrollers.join(", ")}`).toEqual([]);
		});
	}
});

/**
 * Preferences on a phone, in the engine every phone actually runs (#384).
 *
 * The block above measures the same page at the same widths and has been green since #333; this
 * one exists because of what that could not see. `playwright.config.ts` declared exactly one
 * project — chromium — so every guard #333 built for "the page scrolls sideways on a phone" ran in
 * the one engine where the remaining defect does not exist. Against WebKit `<main>` pans **59px at
 * 320, 27 at 360, 18 at 375 and 9 at 390**, and 0 in Chromium at every one of them. The
 * measurement was never wrong. It had no WebKit to run in, and "not reproducible" was reported
 * twice on the strength of that.
 *
 * The offender is the Timezone row's `<select>`, and not for the reason a flex bug usually has.
 * The control's BOX is already capped (`max-w-[60%]`) and shrinks in both engines; `min-width: 0`
 * on it was measured to change nothing at any width. What escapes is the selected option's LABEL:
 * WebKit lays it out at its natural width and, because a control's `overflow` computes to
 * `visible`, that box counts toward every ancestor's `scrollWidth`. Chromium finds the same 85px
 * of overflow but reports it ON the select and stops there, treating the control as its own scroll
 * container. Nothing is painted out in the pan — which is exactly what both reports of this said:
 * "empty space on the right, with no content out there".
 *
 * The zone is PINNED here rather than inherited from the host. `timezoneSeed` writes the browser's
 * own zone when nothing is stored, so the selected option is whatever the runner's TZ happens to
 * be — and a CI box on `UTC` seeds nothing, leaving a much shorter label selected. A guard whose
 * worst case depends on the host's clock is the hollow fixture this file has already shipped
 * twice, so the option is asserted before anything is measured. It is `America/North_Dakota/…`
 * rather than the `America/Argentina/…` the report used because the two engines disagree about
 * that one: Chromium's ICU canonicalises it to the shorter `America/Buenos_Aires` link and
 * WebKit's does not, so the fixture would have carried a different worst case per engine.
 */
test.describe("mobile — Preferences in WebKit (#384)", () => {
	test.use({ timezoneId: "America/North_Dakota/New_Salem" });

	const connected = {
		user: { githubLinked: "serge-ivo-development" },
		connectors: DEFAULT_CONNECTORS,
	};

	for (const width of [320, 360, 375, 390]) {
		test(`the timezone select does not pan the page at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockSignedInConsole(page, connected);
			await page.goto("/console/preferences");
			await page.waitForLoadState("networkidle");
			await page.locator("main").waitFor();
			await page.waitForTimeout(300);

			// The seed landed, so the selected option really is the 30-character zone name this
			// block is named after — not "Not set — agents will say UTC" wearing its numbers.
			await expect(page.getByLabel("Your timezone")).toHaveValue("America/North_Dakota/New_Salem");

			const { mainOv, docOv, navOv, scrollers, wide, escapes } = await measureOverflow(page);
			expect(mainOv, `<main> pans by ${mainOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(docOv, `page overflows by ${docOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(navOv, `primary nav pans by ${navOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(wide, `content past the right edge at ${width}w: ${wide.join(", ")}`).toEqual([]);
			expect(escapes, `a box past its own container at ${width}w: ${escapes.join(", ")}`).toEqual([]);
			expect(scrollers, `unexpected horizontal scrollers at ${width}w: ${scrollers.join(", ")}`).toEqual([]);
		});
	}

	/**
	 * The other half of the report — "buttons don't wrap so the text is squashed into one vertical
	 * line" — which is a SQUEEZE, not an overflow, and therefore invisible to every assertion above.
	 *
	 * Both ingredients were added on purpose and are individually right: `[overflow-wrap:anywhere]`
	 * (#333) is what stops the unbreakable email token running off the page, and `shrink-0` is what
	 * stops the button pair collapsing. Together they leave the row unable to overflow and unable to
	 * wrap, so the whole deficit lands on the one thing that will yield. At 320px the label column
	 * gets **25% of the row and runs 390px tall** — in both engines, which is why this test does not
	 * mention WebKit.
	 *
	 * A share floor, not a pin: the fix gives the column the whole row (100%), the bug gives it 25%,
	 * and anything in between is a layout somebody chose. Pinning the width would fail on any
	 * deliberate change to the buttons and teach nothing.
	 */
	const MIN_LABEL_SHARE = 60;

	for (const width of [320, 390]) {
		test(`the Connections rows keep their label readable at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockSignedInConsole(page, connected);
			await page.goto("/console/preferences");
			await page.waitForLoadState("networkidle");
			await page.locator("main").waitFor();
			await page.waitForTimeout(300);

			// The rows exist and carry the account — the empty-section fixture is what made #333
			// look clean, so it is checked before anything is measured here too.
			await expect(page.getByText(DEFAULT_CONNECTORS[0].account as string).first()).toBeVisible();
			// Wrapping must not cost the controls: the button pair is the whole reason the row is
			// tight, and a fix that hid it would pass a width check.
			await expect(page.getByRole("button", { name: "Disconnect" }).first()).toBeVisible();
			await expect(page.getByRole("button", { name: "Reconnect" }).first()).toBeVisible();

			const columns = await page.evaluate(() => {
				const card = Array.from(document.querySelectorAll("h3")).find((h) => h.textContent === "Connections")?.parentElement;
				// Structural rather than class-based: every connection row is a flex row whose FIRST
				// child is the label column. That is the element the buttons crush.
				return Array.from(card?.children ?? [])
					.filter((el) => el.classList.contains("flex") && el.firstElementChild)
					.map((row) => {
						const col = row.firstElementChild as HTMLElement;
						const rowWidth = row.getBoundingClientRect().width;
						return {
							label: (col.textContent || "").slice(0, 24),
							share: Math.round((col.getBoundingClientRect().width / rowWidth) * 100),
							height: Math.round(col.getBoundingClientRect().height),
						};
					});
			});

			expect(columns.length, "no connection rows were measured").toBeGreaterThanOrEqual(4);
			for (const col of columns) {
				expect(col.share, `"${col.label}" gets ${col.share}% of its row and runs ${col.height}px tall at ${width}w`).toBeGreaterThanOrEqual(MIN_LABEL_SHARE);
			}
		});
	}

	/**
	 * A `<select>` cannot widen the row it sits in, named per control (#384).
	 *
	 * The block above measures `<main>`, which is the number a user feels. This one measures the
	 * ROW, which is the number that says what to fix — and it exists because of exactly how the
	 * first fix for this ticket failed.
	 *
	 * `overflow: hidden` on the control was measured green, shipped, and left `main` red for
	 * twelve consecutive commits: WebKit's menulist renderer OVERRIDES that declaration (the
	 * computed `overflow-x` on every one of these selects reads `visible`), while the
	 * `text-overflow: ellipsis` beside it in the same rule applies normally — so the rule looks
	 * live and half of it is inert. The only signal was `mainOv = 68` with `wide` EMPTY: nothing's
	 * box is past the right edge, because what escapes is the OPTION LIST inside a native control,
	 * which has no element of its own to measure. That pair of numbers names nothing.
	 *
	 * So this asserts the mechanism rather than the symptom, and fails by NAME — the select's id
	 * and its widest option. It goes red the moment `contain: paint` leaves `index.css`.
	 *
	 * The widest OPTION, not the selected label, because that is what was measured: at 320px
	 * `voice-tts-provider` widened its card by 43px while showing a value that fits, and the
	 * entry that did not fit was one further down its list. Shortening what the control displays
	 * would therefore have fixed nothing.
	 *
	 * Not scoped to the timezone control on purpose: the 68px at 320px came from TWO cards, and
	 * the widest option on this page belongs to a Voice select ("Smart (AI) — Whisper, most
	 * accurate (appears at end)"), not to a zone name. Any long option anywhere is this defect.
	 */
	for (const width of [320, 390]) {
		test(`no select widens its own row at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockSignedInConsole(page, connected);
			await page.goto("/console/preferences");
			await page.waitForLoadState("networkidle");
			await page.locator("main").waitFor();
			await page.waitForTimeout(300);

			// The selects are really on the page — an unrendered Voice section would make this
			// vacuous, which is the hollow-fixture failure this file has already shipped twice.
			expect(await page.locator("main select").count()).toBeGreaterThanOrEqual(8);

			const offenders = await page.evaluate(() => {
				const out: string[] = [];
				for (const el of Array.from(document.querySelectorAll("main select"))) {
					const s = el as HTMLSelectElement;
					const row = s.parentElement;
					if (!row) continue;
					const before = row.scrollWidth - row.clientWidth;
					if (before <= 1) continue;
					// ATTRIBUTION, not correlation. Several of these selects share one card, so the
					// card's overflow reads the same on all of them and blames the innocent. Take
					// the control out of flow and re-measure: if the row stops overflowing without
					// it, it is the one that did it, and the widest option is what to shorten.
					s.style.display = "none";
					const without = row.scrollWidth - row.clientWidth;
					s.style.display = "";
					if (without > 1) continue;
					const widest = Array.from(s.options).reduce((a, o) => (o.text.length > a.length ? o.text : a), "");
					out.push(`select#${s.id || s.getAttribute("aria-label") || "?"} (widest option "${widest}") widens its row by ${before}px`);
				}
				return out;
			});
			expect(offenders, offenders.join("; ")).toEqual([]);
		});
	}

	/**
	 * A focused `<select>` is VISIBLY focused — in WebKit, where it was not (#436, WCAG 2.4.7).
	 *
	 * Every select in this console declared its focus ring as a `box-shadow`, and WebKit computes
	 * `box-shadow` to `none` on a native menulist. `outline: none` is declared on the same rule, so
	 * there was no platform default left; and `border-color: var(--color-accent)` never applied
	 * either, because every select here carries a Tailwind `border-line` utility and a utility
	 * layer beats a base-layer rule. All three indicators inert: tabbing to any of the 11 selects
	 * on this page changed NOTHING on screen. Measured blurred → focused, byte-identical.
	 *
	 * ── Why this asserts PAINT and not only computed style
	 *
	 * Computed style is what made this ship. Two comments in the stylesheets stated the ring
	 * "still paints outside the border box", checked — in Chromium, where it was never in doubt.
	 * `getComputedStyle` on the shipped rule reads a real shadow in one engine and `none` in the
	 * other, and neither number tells you whether anything appeared. So the assertion below is an
	 * A/B of the actual pixels, over a region 6px larger than the control on every side (an
	 * `outline` with `outline-offset` paints OUTSIDE the border box, and an element-clipped
	 * screenshot would cut off the thing being measured and report a false negative).
	 *
	 * The computed-style half is kept beside it because it names WHICH property is carrying the
	 * indicator, which a pixel diff cannot; and `appearance` is asserted so the fix cannot quietly
	 * become `appearance: none`, rejected in #384 and #414 and again in #436.
	 */
	test("a focused select is visibly focused", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 812 });
		await mockSignedInConsole(page, connected);
		await page.goto("/console/preferences");
		await page.waitForLoadState("networkidle");
		await page.locator("main").waitFor();
		await page.waitForTimeout(300);

		const selects = page.locator("main select");
		expect(await selects.count(), "no selects rendered — this would measure nothing").toBeGreaterThanOrEqual(8);

		const sel = selects.first();
		await sel.scrollIntoViewIfNeeded();
		const box = await sel.boundingBox();
		if (!box) throw new Error("the select has no box");
		const clip = { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 };
		const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

		await blur();
		const blurred = await page.screenshot({ clip });
		await sel.focus();
		const focused = await page.screenshot({ clip });

		const style = await page.evaluate(() => {
			const s = document.querySelector("main select") as HTMLSelectElement;
			const cs = getComputedStyle(s);
			return { focused: s.matches(":focus"), outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, boxShadow: cs.boxShadow, appearance: cs.appearance };
		});

		expect(style.focused, "the select never took focus, so this measures nothing").toBe(true);
		// SOMETHING must indicate focus. `||` rather than a specific property: Chromium carries it
		// on the box-shadow and WebKit on the outline, and pinning one would fail the other engine
		// for being correct.
		expect(
			style.outlineStyle !== "none" || style.boxShadow !== "none",
			`a focused select has no indicator at all: ${JSON.stringify(style)}`,
		).toBe(true);
		// Still a native menulist — `appearance: none` brings the box-shadow back and is rejected.
		expect(style.appearance, "the select stopped being a native menulist").not.toBe("none");

		// And it actually APPEARED. This is the assertion the shipped ring failed in WebKit.
		expect(
			blurred.equals(focused),
			`focusing the select changed no pixels — the indicator computes but does not paint: ${JSON.stringify(style)}`,
		).toBe(false);
	});
});

/**
 * Every control clears the 24px minimum target (#389).
 *
 * The audit that opened this measured 40 interactive elements under 40px on the Assistant
 * screen alone, 12×12px checkboxes on Behaviour, and a 16px *Remove* — which deletes an
 * indexed repository — sitting beside a 16px control that does not.
 *
 * ── The number this asserts, and why it is not 44
 *
 * **WCAG 2.5.8 Target Size (Minimum), Level AA: 24×24 CSS px, in both axes.** Apple's 44 and
 * Material's 48 are the numbers a redesign would meet; every control in this console renders
 * between 24 and 38px tall, so a 44px floor asserted here would fail ~40 controls per screen
 * and the only way to green would be re-laying-out every dense row in the app under cover of
 * an accessibility fix. 44 is met as REACH rather than as box size, by `tap-target` in
 * `index.css`, on the smallest and most error-prone controls — and this measures that too,
 * because it measures the target a finger actually gets rather than the border box.
 *
 * ── What counts as the target
 *
 * The union of the element's own box, its `::after` overlay (which is what `tap-target` is)
 * and, for a checkbox or radio, the `<label>` that encloses it — because clicking that label
 * IS clicking the control, and an `sr-only` radio inside a visible segmented arm is 1×1 by
 * design.
 *
 * ── What it deliberately does not cover
 *
 * A `<button>` with no background, no border and no padding is a link wearing a button tag,
 * and is skipped — the same class `control-shapes.ts` excludes, for the same reason: padding
 * one up to 24px would move text that is meant to sit inside a sentence. That exclusion is
 * also the hole: `RepoTab`'s *Remove* was exactly this shape, so this guard could not have
 * caught the destructive 16px control that motivated it. That one was fixed by hand, and
 * DESIGN-SYSTEM §5 records the gap rather than leaving it to be discovered.
 *
 * And it only sees what the fixture renders. Terminals and Behaviour — two of the routes the
 * audit found worst — are thin here; this holds the routes it visits and nothing more.
 */
test.describe("mobile — every control clears the 24px minimum target (#389)", () => {
	/** WCAG 2.5.8, Level AA. Not a house preference — a published, testable floor. */
	const MIN_TARGET = 24;

	const routes = [
		"/console/",
		"/console/instances",
		"/console/agents/agent-1",
		"/console/agents/agent-1/settings",
		"/console/instances/inst-1",
		"/console/instances/inst-1/board",
		"/console/instances/inst-1/knowledge",
		"/console/instances/inst-1/settings",
		"/console/profile",
		"/console/preferences",
		"/console/notifications",
	];

	async function measureTargets(page: Page, min: number) {
		return page.evaluate((floor) => {
			const main = document.querySelector("main");
			if (!main) return [];
			const px = (v: string) => (v.endsWith("px") ? Number.parseFloat(v) : 0);

			/** A button that draws no box of its own is a text link, and is not this defect. */
			const isTextLink = (el: HTMLElement) => {
				if (el.tagName !== "BUTTON") return false;
				const s = getComputedStyle(el);
				const opaque = s.backgroundColor !== "transparent" && !/,\s*0\)$/.test(s.backgroundColor);
				const sides = ["Top", "Right", "Bottom", "Left"] as const;
				const bordered = sides.some((side) => px(s[`border${side}Width`]) > 0);
				const padded = sides.some((side) => px(s[`padding${side}`]) > 0);
				return !opaque && !bordered && !padded;
			};

			const findings: string[] = [];
			for (const el of Array.from(main.querySelectorAll('button, input[type="checkbox"], input[type="radio"]'))) {
				const h = el as HTMLElement;
				const box = h.getBoundingClientRect();
				if (box.width === 0 && box.height === 0) continue; // not rendered at all
				if (isTextLink(h)) continue;

				// The overlay `tap-target` draws, and the label that IS the target for an input.
				const after = getComputedStyle(h, "::after");
				const label = h.tagName === "INPUT" ? h.closest("label")?.getBoundingClientRect() : undefined;
				const width = Math.max(box.width, px(after.width), label?.width ?? 0);
				const height = Math.max(box.height, px(after.height), label?.height ?? 0);

				if (Math.min(width, height) + 0.5 < floor) {
					const name = (h.getAttribute("aria-label") || h.textContent || h.getAttribute("title") || "").trim().slice(0, 30);
					findings.push(`${Math.round(width)}×${Math.round(height)} <${h.tagName.toLowerCase()}> "${name}"`);
				}
			}
			return findings;
		}, min);
	}

	for (const route of routes) {
		test(`no target under ${MIN_TARGET}px on ${route}`, async ({ page }) => {
			await page.setViewportSize({ width: 390, height: 812 });
			await mockSignedInConsole(page);
			await page.goto(route);
			await page.waitForLoadState("networkidle");
			await page.locator("main").waitFor();
			await page.waitForTimeout(300); // let async content settle

			const findings = await measureTargets(page, MIN_TARGET);
			expect(findings, `targets under ${MIN_TARGET}px on ${route}: ${findings.join(" · ")}`).toEqual([]);
		});
	}
});

/**
 * ADR 0001 M1, rendered and hit-tested: the on-screen mute is reachable in every phase (#388).
 *
 * `packages/sdk/src/voice/mute-invariant.test.ts` proves the VOICE channel over the phase table.
 * `store/console/src/pages/mute-touch-invariant.test.ts` proves the SHAPE of the touch channel —
 * that its render guard names the interaction mode and nothing else. Neither of them opens a
 * browser, and neither can answer the question a user actually has: with the agent talking, on a
 * phone, is the mute button on the screen and can my thumb land on it.
 *
 * That question matters most in the case the ADR records as a KNOWN HOLE. The control listener is
 * built on the browser Web Speech API; where the constructor is absent `ensureControlStt` returns
 * null, no control listener runs, and mute by voice does not exist at all. On such a browser this
 * button is the entire invariant. So the block runs twice — once as it ships, once with Web Speech
 * deleted — and it carries the `mobile — ` prefix, which puts it in the WebKit project (#384).
 * WebKit is not a simulation of that browser: it has no `SpeechRecognition` of its own, and every
 * phone runs it.
 *
 * ── How a real phase is reached, rather than asserted about
 *
 * The status pill is `resolveVoiceStatus`, the one presentation of `derivePhase`, so reading it
 * back is how the test knows WHICH phase the app is in rather than assuming a click worked:
 *
 *   listening   enter hands-free — the mic is open, and the pill says so
 *   processing  `GET /state` reports an in-flight turn (#251/#252), so the page is working
 *   speaking    replay an assistant message through a `speechSynthesis` that never ends its
 *               utterance, which is what a long reply looks like from the UI's side
 *   muted       press mute for real, and assert the way BACK out (M4)
 *
 * `transcribing` is the one phase not reached here — it needs a real clip through a real STT — and
 * it is covered structurally instead, by the guard that no phase signal may appear in the control's
 * render condition at all.
 *
 * Reachability is asserted as visible + enabled + `click({ trial: true })`, which runs Playwright's
 * full actionability check — in the viewport, stable, hit-testable, not covered by the status pill
 * or the composer — WITHOUT performing the click and changing the phase under test. Visibility
 * alone would pass a control sitting under an overlay, and `toBeEnabled` alone would pass one
 * pushed off the bottom of a 320px screen.
 */
test.describe("mobile — mute is reachable in every phase (ADR 0001 M1, #388)", () => {
	/** Long enough that the browser-TTS fallback timer (3s + 80ms/char) cannot end the utterance
	 *  mid-assertion, so `speaking` is a phase this test holds rather than races. */
	const REPLY = `Here is what I found in the repository, at length. ${"Reading on, and on. ".repeat(12)}`;

	/**
	 * A `speechSynthesis` that starts and never finishes — an agent mid-sentence, held there.
	 *
	 * Stubbed rather than driven with a real voice because headless engines have no voices
	 * installed: `speak()` there either ends instantly or never fires at all, and neither is the
	 * state this test is about.
	 */
	async function holdTheAgentTalking(page: Page) {
		await page.addInitScript(() => {
			Object.defineProperty(window, "speechSynthesis", {
				configurable: true,
				value: {
					speaking: true,
					pending: false,
					paused: false,
					getVoices: () => [],
					speak: () => {},
					cancel: () => {},
					pause: () => {},
					resume: () => {},
					addEventListener: () => {},
					removeEventListener: () => {},
				},
			});
		});
	}

	/** The ADR's known hole, made real: a browser where the control listener cannot exist. */
	async function removeWebSpeech(page: Page) {
		await page.addInitScript(() => {
			Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: undefined });
			Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: undefined });
		});
	}

	/** Present, enabled, and hit-testable where it is — the three halves of "reachable". */
	async function expectMuteReachable(page: Page, phase: string) {
		const mute = page.getByTitle(/^(Mute|Unmute) the mic/);
		await expect(mute, `${phase}: the on-screen mute is gone. ADR 0001 M1 — no phase may be a dead zone, and on a browser with no Web Speech API this control is the only channel.`).toBeVisible();
		await expect(mute, `${phase}: the on-screen mute is disabled. A disabled mute is present, legible, and unreachable (ADR 0001 M1).`).toBeEnabled();
		// Actionability without the action: in the viewport, stable, and receiving the pointer.
		await mute.click({ trial: true, timeout: 5_000 });
	}

	for (const webSpeech of [true, false]) {
		test(`mobile — reachable while listening, working, speaking and muted${webSpeech ? "" : ", with no Web Speech API"}`, async ({ page }) => {
			await holdTheAgentTalking(page);
			if (!webSpeech) await removeWebSpeech(page);
			await mockSignedInConsole(page);

			// One assistant reply to replay, with no `audioKey` so playback falls through to TTS.
			await page.route("**/v1/instances/inst-1/messages*", (route) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ messages: [{ id: "m1", role: "assistant", content: REPLY, createdAt: "2026-08-08T10:00:00.000Z" }] }),
				}),
			);
			// The server-side "this agent is working" signal (#252), switchable mid-test. Registered
			// after the catch-all so it wins, and falling back to it while the flag is off.
			let working = false;
			await page.route("**/v1/instances/inst-1/state", async (route) => {
				if (!working) return route.fallback();
				await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "idle", inflight: [{ turnId: "t1", startedAt: Date.now() }] }) });
			});

			await page.setViewportSize({ width: 320, height: 812 });
			await page.goto("/console/instances/inst-1");
			await page.waitForLoadState("networkidle");
			await page.locator("main").waitFor();

			const pill = page.locator("[aria-live='polite']").filter({ hasText: /Hands-free|Listening|Working|Speaking|Muted/ }).first();

			// ── listening ────────────────────────────────────────────────────────────────────
			// Entering hands-free is SETUP, not the claim, and it is the one step here that depends
			// on a hardware device: `toggleConvo` awaits a config read and `getUserMedia`, and on a
			// loaded machine that can lose the race with the click. Retried rather than given a
			// longer single timeout, because the failure mode is a start that did not take, not a
			// start that was slow. A repeat press cannot double-open the mic — `setVoiceMode`
			// returns early once the mode matches, and `resolveToggleAction` answers "ignore" while
			// a start is still in flight (#284). Everything after this point is asserted once.
			await expect(async () => {
				await page.getByTitle(/^Hands-free:/).click();
				await expect(pill).toHaveText(/Listening|Hands-free/, { timeout: 5_000 });
			}).toPass({ timeout: 25_000 });
			await expectMuteReachable(page, "listening");

			// ── speaking (the agent is talking) ──────────────────────────────────────────────
			// The window mute exists for, and the one #386's first draft would have closed.
			await page.getByRole("button", { name: "Play this message" }).click();
			await expect(pill).toHaveText(/Speaking/, { timeout: 15_000 });
			await expectMuteReachable(page, "speaking");

			// ── muted, entered from speaking ─────────────────────────────────────────────────
			// M2 as the user meets it: this press must silence BOTH directions. Until #388 the
			// button's own branch was a copy of `muteFromCommand` missing its `tts.cancel()`, so
			// the mic closed, the agent kept talking, and the pill stayed on "Speaking" — which is
			// how this assertion found it. The phase moving to "Muted" IS the cancellation.
			await page.getByTitle(/^Mute the mic/).click();
			await expect(pill, "muting an agent that keeps talking is not mute (ADR 0001 M2)").toHaveText(/Muted/, { timeout: 15_000 });
			await expectMuteReachable(page, "muted");
			// The same control, now offering the other direction — a session that can be entered
			// and not left is M1 with the sign flipped.
			await expect(page.getByTitle(/^Unmute the mic/), "muted: nothing on screen offers unmute (ADR 0001 M4)").toBeVisible();
			await page.getByTitle(/^Unmute the mic/).click();
			await expect(pill).not.toHaveText(/Muted/, { timeout: 15_000 });

			// ── processing (the agent is thinking) ───────────────────────────────────────────
			// Last, because it is the one phase driven by a 10s server poll rather than a click,
			// and `thinking` outranks every other phase in `derivePhase` — so it is asserted where
			// nothing after it has to wait for the poll to go back the other way.
			working = true;
			await expect(pill).toHaveText(/Working on it/, { timeout: 20_000 });
			await expectMuteReachable(page, "processing");
		});
	}
});

/**
 * A repo the machine could not use says so, beside the repo (#405).
 *
 * The Coding tab called a local repo "Ready", in green, while the directory it pointed at was
 * empty and not a checkout — the state it had been in since the moment it was added. The agent,
 * asked about that code and given nothing but "(no files found at that path)", invented it
 * (#395). The console's half of the fix is that the row cannot say Ready about it.
 *
 * Under `mobile — ` so it runs in WebKit as well as Chromium: the remedy carries a full checkout
 * path, which is the longest unbroken string this card has ever held, and the width at which it
 * has to fit is 320px.
 */
test.describe("mobile — a repo whose path is unusable says so (#405)", () => {
	const LONG_PATH = "/Users/somebody/dev/stores/pas/platform/apps/chess-academy";
	const DIAGNOSIS = `The configured checkout \`${LONG_PATH}\` exists but is EMPTY — nothing was ever cloned into it, or its contents were moved away. There is no code at that path to read.`;

	async function mockCoder(page: Page, repo: Record<string, unknown>) {
		await mockSignedInConsole(page, {
			instances: [{
				id: "inst-1",
				name: "Chess coder",
				slug: "coder",
				category: "code",
				capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" },
			}],
		});
		await page.route("**/v1/instances/inst-1/coding/**", async (route) => {
			const url = route.request().url();
			const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
			if (url.includes("/repos")) return json({ repos: [repo] });
			if (url.includes("/engines")) return json({ engines: [], defaultEngineId: "claude" });
			if (url.includes("/sessions")) return json({ sessions: [] });
			return json({});
		});
	}

	const brokenRepo = {
		id: "repo-1",
		name: "apps/chess-academy",
		workdir: "~/dev/pas/platform/apps/chess-academy",
		cloneStatus: "needs_attention",
		cloneError: DIAGNOSIS,
	};

	for (const width of [320, 390]) {
		test(`the diagnosis and the remedy are both readable at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockCoder(page, brokenRepo);
			await page.goto("/console/instances/inst-1/coding");
			await page.waitForLoadState("networkidle");

			const banner = page.getByTestId("repo-unusable-repo-1");
			await expect(banner).toBeVisible();
			// The server's own sentence, verbatim — the console and the chat must not describe one
			// directory two different ways.
			await expect(banner).toContainText(LONG_PATH);
			await expect(banner).toContainText("Repo settings");

			// The word the row must NOT be saying about this repo, which is the whole defect.
			await expect(page.getByText("Path unusable")).toBeVisible();
			await expect(page.getByText("Ready", { exact: true })).toHaveCount(0);

			// A 58-character path in a card this narrow is exactly the thing that pans a phone.
			const { mainOv, docOv, wide, escapes } = await measureOverflow(page);
			expect(mainOv, `<main> overflows by ${mainOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(docOv, `page overflows by ${docOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(wide, `content past the right edge at ${width}w: ${wide.join(", ")}`).toEqual([]);
			expect(escapes, `a box past its own container at ${width}w: ${escapes.join(", ")}`).toEqual([]);
		});
	}

	test("mobile — a healthy repo is untouched: no banner, and it still reads Ready", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 812 });
		await mockCoder(page, { id: "repo-1", name: "apps/chess-academy", workdir: "~/dev/thing", cloneStatus: "ready" });
		await page.goto("/console/instances/inst-1/coding");
		await page.waitForLoadState("networkidle");
		await expect(page.getByTestId("repo-unusable-repo-1")).toHaveCount(0);
		await expect(page.getByText("Ready", { exact: true })).toBeVisible();
	});
});

/**
 * The Pulls panel on a phone, in WebKit (#401).
 *
 * A PR row carries FOUR badges — agent attribution, mergeability, review state, checks — plus a
 * branch pair, an author and a timestamp, next to a title that is routinely 70 characters. That is
 * more per row than Issues has ever had, and it is exactly the shape #333/#384 found panning
 * `<main>` in Safari and nowhere else. The `mobile — ` prefix puts this block in the WebKit
 * project; without it a new geometry block silently runs in one engine again.
 *
 * The fixture is DELIBERATELY at its worst: a long title, a long branch name, scoped labels, and
 * the conflicted / changes-requested / checks-failed combination that renders every badge at once.
 * This file has twice shipped a geometry guard that was green because the page it measured was
 * empty, so the row is asserted present before anything is measured.
 */
test.describe("mobile — the Pulls panel (#401)", () => {
	const LONG_TITLE = "fix(coding): the engine's stdout latch no longer ends a turn on a slow first token";

	const codingInstance = [
		{
			id: "inst-1",
			name: "Coder",
			slug: "coder",
			category: "code",
			capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" },
		},
	];

	const PULLS = [
		{
			number: 4021,
			title: LONG_TITLE,
			state: "open",
			draft: false,
			merged: false,
			author: "proagentstore-coder",
			branch: "coder/401-conditional-requests-and-pulls-panel",
			baseBranch: "main",
			labels: ["needs-review", "area/coding"],
			comments: 4,
			createdAt: "2026-08-07T00:00:00Z",
			updatedAt: "2026-08-08T00:00:00Z",
			url: "https://github.com/ProAgentStore/platform/pull/4021",
			reviewersRequested: 2,
			mergeable: false,
			mergeableState: "dirty",
			review: "changes_requested",
			checks: { status: "completed", conclusion: "failure", url: "u", name: "ci" },
			agentAct: { traceId: "run-7f3a", act: "pr.open", at: "2026-08-07T00:00:00Z", sessionId: "sess-1" },
		},
		{
			number: 7,
			title: "chore: bump the CLI",
			state: "open",
			draft: true,
			merged: false,
			author: "a-human",
			branch: "chore/bump",
			baseBranch: "main",
			labels: [],
			comments: 0,
			createdAt: "2026-08-06T00:00:00Z",
			updatedAt: "2026-08-06T00:00:00Z",
			url: "https://github.com/ProAgentStore/platform/pull/7",
			reviewersRequested: 0,
			mergeable: null,
			mergeableState: "unknown",
			review: "none",
			checks: null,
			agentAct: null,
		},
	];

	async function mockCodingWithPulls(page: Page) {
		await mockSignedInConsole(page, { instances: codingInstance });
		await page.route("**/v1/instances/inst-1/coding/**", async (route) => {
			const url = route.request().url();
			const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
			if (url.includes("/pulls")) return json({ repo: "ProAgentStore/platform", pulls: PULLS });
			if (url.includes("/issues")) return json({ repo: "ProAgentStore/platform", issues: [] });
			if (url.includes("/repos")) return json({ repos: [{ id: "repo-1", name: "platform", githubRepo: "ProAgentStore/platform", provider: "github", cloneStatus: "ready" }] });
			if (url.includes("/engines")) return json({ engines: [], defaultEngineId: "claude" });
			if (url.includes("/capture")) return json({ pane: "", runState: "idle" });
			if (url.includes("/sessions")) return json({ sessions: [] });
			if (url.includes("/builds")) return json({ builds: [] });
			return json({});
		});
	}

	async function openPulls(page: Page) {
		// Deep link rather than clicking the instance tab: below `sm` the tab bar is ICON-ONLY, so
		// `getByRole("button", { name: "Coding" })` has nothing to match — which is the whole reason
		// this block exists at phone widths.
		await page.goto("/console/instances/inst-1/coding");
		await page.waitForLoadState("networkidle");
		await page.getByRole("button", { name: /^Pulls/ }).first().click();
		await page.waitForTimeout(400);
	}

	for (const width of [320, 390]) {
		test(`does not pan the page with a fully-badged row at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockCodingWithPulls(page);
			await openPulls(page);

			// The fixture LANDED. An empty panel cannot reproduce a row that is too wide, and a
			// green measurement over one is the hollow guard this file has shipped before.
			await expect(page.getByText("#4021")).toBeVisible();
			await expect(page.getByText("Conflicts")).toBeVisible();
			await expect(page.getByText("Changes requested")).toBeVisible();
			await expect(page.getByText("Checks failed")).toBeVisible();
			await expect(page.getByText("Opened by your agent")).toBeVisible();

			const { mainOv, docOv, navOv, wide, escapes } = await measureOverflow(page);
			expect(mainOv, `<main> pans by ${mainOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(docOv, `page overflows by ${docOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(navOv, `primary nav pans by ${navOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(wide, `content past the right edge at ${width}w: ${wide.join(", ")}`).toEqual([]);
			expect(escapes, `a box past its own container at ${width}w: ${escapes.join(", ")}`).toEqual([]);
		});
	}

	/**
	 * The squeeze, which no horizontal assertion can see: four `shrink-0` badges sharing the
	 * title's row would leave that column unable to overflow AND unable to wrap, so the whole
	 * deficit lands on the title and it renders as a vertical ribbon of single characters. That is
	 * exactly the #384 finding on Preferences, one panel over. The badges sit on their own wrapping
	 * row for this reason, and this is what keeps them there.
	 */
	test("mobile — the PR title keeps its width instead of collapsing under the badges", async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 812 });
		await mockCodingWithPulls(page);
		await openPulls(page);

		const title = page.getByTitle(LONG_TITLE).first();
		await expect(title).toBeVisible();
		const box = await title.boundingBox();
		expect(box, "the PR title did not render").toBeTruthy();
		// A share floor, not a pin: the bug gives the title a sliver and hundreds of pixels of
		// height; any sane layout gives it most of the row. Pinning the width would fail on a
		// deliberate change and teach nothing.
		expect(Math.round(box?.width ?? 0), "the PR title was squeezed by the badges").toBeGreaterThan(150);
		expect(Math.round(box?.height ?? 0), "the PR title ran tall — it is wrapping per character").toBeLessThan(80);
	});
});

/**
 * The chat message header on a phone: the two action buttons do not sit on the timestamp (#426).
 *
 * Three individually-correct decisions collided. `CopyButton` (`right-1.5`) and
 * `DeleteTurnButton` (`right-8`) are absolutely positioned in the bubble's top-right corner and
 * are PERMANENTLY visible below `sm` — correctly, because there is no hover on a touch screen
 * (#389). The message header is `justify-between`, so the timestamp is pinned to that same right
 * edge at that same vertical band. Nobody reserved the space, and 42px of a 110px stamp — the
 * minutes included — rendered underneath the two buttons.
 *
 * ── Why this measures an intersection rather than an overflow
 *
 * Every geometry guard in this file so far asks whether something escaped its container. Nothing
 * escaped here: both boxes are exactly where their CSS puts them, inside the bubble, and an
 * overflow measurement over this bug reads zero. The defect is that they occupy the same pixels,
 * so the only assertion that can see it is the bounding-box intersection of the two elements —
 * which is also what the issue measured, so a green run here means the same thing the report did.
 *
 * ── Why the buttons' visibility is asserted first
 *
 * Zero overlap is trivially true when the buttons are invisible, which is exactly their desktop
 * state. A future change that made them hover-only on mobile would delete a control a touch user
 * cannot otherwise reach AND turn this guard green. So the run asserts opacity before it asserts
 * clearance, and the desktop case is asserted the other way round, as its own test.
 *
 * ── Why the fixture carries a message from last year
 *
 * The year is now conditional (#426 fix 2, `formatDateTime`), so the everyday stamp is the short
 * one. A guard built only from those would measure the easy case and pass over the widest stamp
 * the transcript can still produce. Both are in the thread, and the rendered text of each is
 * asserted, so the conditional is proved through the built bundle rather than only in the unit
 * test that pins the pure function.
 *
 * `mobile — ` puts this block in the WebKit project (#384). The report was measured in WebKit at
 * 320 and 390, and that is the engine every phone runs.
 */
test.describe("mobile — Copy and Delete clear the message timestamp (#426)", () => {
	const THIS_YEAR = new Date().getFullYear();
	const LAST_YEAR = THIS_YEAR - 1;
	/** Mid-year and LOCAL, so the rendered year cannot flip under a runner east or west of UTC. */
	const stamp = (year: number) => new Date(year, 6, 8, 14, 12).toISOString();

	const MESSAGES = [
		{ id: "m1", role: "user", content: "Deploy the api worker", createdAt: stamp(THIS_YEAR) },
		{ id: "m2", role: "assistant", content: "Done — the worker is live.", createdAt: stamp(THIS_YEAR) },
		{ id: "m3", role: "user", content: "What did we ship back then?", createdAt: stamp(LAST_YEAR) },
		{ id: "m4", role: "assistant", content: "That turn is old enough to still carry its year.", createdAt: stamp(LAST_YEAR) },
	];

	async function openChat(page: Page) {
		await mockSignedInConsole(page);
		await page.route("**/v1/instances/inst-1/messages*", (route) =>
			route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: MESSAGES }) }),
		);
		await page.goto("/console/instances/inst-1");
		// The fixture LANDED. An empty transcript cannot reproduce an overlap, and a green
		// measurement over one is the hollow guard this file has shipped before.
		await expect(page.locator("[data-chat-bubble]")).toHaveCount(MESSAGES.length);
		await expect(page.locator("[data-msg-stamp]")).toHaveCount(MESSAGES.length);
	}

	/**
	 * Per bubble, per action button: how many pixels of the timestamp that button covers, whether
	 * the button is actually painted, and how tall the header row ended up.
	 */
	async function measureStamps(page: Page) {
		return page.evaluate(() => {
			const rows: { button: string; overlapPx: number; painted: boolean; text: string; headerH: number; leftGapPx: number }[] = [];
			for (const bubble of Array.from(document.querySelectorAll("[data-chat-bubble]"))) {
				const stampEl = bubble.querySelector("[data-msg-stamp]") as HTMLElement | null;
				if (!stampEl) continue;
				const header = stampEl.parentElement as HTMLElement;
				const s = stampEl.getBoundingClientRect();
				const label = header.firstElementChild?.getBoundingClientRect();
				for (const sel of ['[aria-label="Copy message"]', '[aria-label="Delete this turn"]']) {
					const btn = bubble.querySelector(sel) as HTMLElement | null;
					if (!btn) continue;
					const b = btn.getBoundingClientRect();
					const w = Math.min(b.right, s.right) - Math.max(b.left, s.left);
					const h = Math.min(b.bottom, s.bottom) - Math.max(b.top, s.top);
					rows.push({
						button: sel,
						overlapPx: w > 0 && h > 0 ? Math.round(w) : 0,
						painted: Number.parseFloat(getComputedStyle(btn).opacity) > 0.01,
						text: (stampEl.textContent || "").trim(),
						headerH: Math.round(header.getBoundingClientRect().height),
						leftGapPx: label ? Math.round(s.left - label.right) : 999,
					});
				}
			}
			return rows;
		});
	}

	for (const width of [320, 390]) {
		test(`no pixel of the timestamp is under Copy or Delete at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await openChat(page);

			const rows = await measureStamps(page);
			// Four bubbles × two buttons. A short count means a control stopped rendering and the
			// measurement below is about nothing.
			expect(rows.length, "not every bubble rendered both action buttons").toBe(MESSAGES.length * 2);

			// Visible FIRST: zero overlap on an invisible button is the desktop state, not a fix.
			const hidden = rows.filter((r) => !r.painted).map((r) => r.button);
			expect(hidden, `action buttons are not painted at ${width}px, so clearance proves nothing`).toEqual([]);

			const covered = rows.filter((r) => r.overlapPx > 0);
			expect(
				covered.map((r) => `${r.button} covers ${r.overlapPx}px of "${r.text}"`),
				`the timestamp is under an action button at ${width}px`,
			).toEqual([]);

			// The regression the reservation could cause: the 48px squeezing the "You" /
			// "Assistant" group until the two collide.
			const collided = rows.filter((r) => r.leftGapPx < 0);
			expect(collided.map((r) => `${r.text} sits ${r.leftGapPx}px into the role label`), `the stamp ran into the role label at ${width}px`).toEqual([]);

			// …and the one it DOES cause, stated precisely rather than asserted away.
			//
			// A year-bearing stamp is 117px intrinsic. On an assistant bubble at 320px the header's
			// content box is 200px, the role group is 81px and the gap is 12 — so 210px of content
			// in 200px, and it wraps to two lines. There is no padding that fixes that: 44px MUST be
			// reserved or the buttons are back on the stamp, and 4px of it is all that is spare.
			//
			// So the assertion is the everyday row, which is exactly what the conditional year buys:
			// a CURRENT-year stamp never wraps, at either width. A stamp still carrying its year may
			// take a second line at 320px — readable, nothing hidden, nothing covered — and that is
			// the trade this fix makes rather than an oversight. It must still not exceed two lines,
			// which is what would say the row had actually collapsed.
			const wrapped = rows.filter((r) => !/\d{4}/.test(r.text) && r.headerH > 24);
			expect(wrapped.map((r) => `"${r.text}" header is ${r.headerH}px`), `an everyday (current-year) header wrapped at ${width}px`).toEqual([]);
			const collapsed = rows.filter((r) => r.headerH > 40);
			expect(collapsed.map((r) => `"${r.text}" header is ${r.headerH}px`), `a message header ran past two lines at ${width}px`).toEqual([]);
		});
	}

	test("mobile — this year's stamp drops the year and last year's keeps it", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 812 });
		await openChat(page);

		const texts = await page.locator("[data-msg-stamp]").allTextContents();
		expect(texts.slice(0, 2).join(" | "), "a current-year stamp is still spending 30px on the year").not.toContain(String(THIS_YEAR));
		for (const t of texts.slice(2)) {
			expect(t, "a stamp from last year lost its year, which makes it ambiguous").toContain(String(LAST_YEAR));
		}
		// #345's hover text is the reason shortening is safe: the whole local time, zone named.
		await expect(page.locator("[data-msg-stamp]").first()).toHaveAttribute("title", /\d/);
	});

	test("mobile — no space is reserved above the sm breakpoint", async ({ page }) => {
		// The buttons are hover-revealed on a pointer device, so reserving the corner there would
		// be 48px of dead space on every message for a defect that cannot occur.
		await page.setViewportSize({ width: 1024, height: 800 });
		await openChat(page);

		const padding = await page.evaluate(() =>
			Array.from(document.querySelectorAll("[data-msg-stamp]")).map((el) => getComputedStyle(el.parentElement as HTMLElement).paddingRight),
		);
		expect(padding, "the mobile corner reservation leaked into the desktop layout").toEqual(padding.map(() => "0px"));
		const copy = page.getByRole("button", { name: "Copy message" }).first();
		expect(await copy.evaluate((el) => getComputedStyle(el).opacity), "the desktop buttons stopped being hover-only").toBe("0");
	});
});

/**
 * The single-repo Coder's Terminal · Issues · Pulls · Builds row, on a phone, in WebKit (#431).
 *
 * `CodingTab.tsx`'s solo `tab()` helper rendered `<Icon size={13} /> {label}` with NO responsive
 * class, four of them side by side in a `shrink-0` group, inside a `flex-wrap` row that also
 * carries the repo caption and up to five action buttons. Its sibling ~80 lines above — the
 * Co-pilot / Terminal toggle — already ships the icon-only-below-`sm` pattern. The four-button row
 * that actually overflows was the one that never got it.
 *
 * ── Why this needs its OWN measurement rather than the existing overflow sweep
 *
 * `measureOverflow` answers "does anything stick out past the right edge", and it measured ZERO
 * here both before and after the fix — because the parent is `flex-wrap`. An oversized tab group
 * does not pan the page, it WRAPS: what shares its line drops to another one and the terminal pane
 * starts further down the screen, which is #370's complaint on this exact tab. Measured in WebKit,
 * the labelled group was 302px inside a 304px row at 320px — it "fit", by 2px, and left nothing for
 * anything else. So the assertions here are geometric and specific: every tab shares one baseline,
 * the group ends inside the viewport, the group is narrow enough to BE icon-only, and it fits on one
 * line together with the action cluster beside it.
 *
 * ── The residual, which WAS not this ticket and is now fixed (#454)
 *
 * The row was still two lines tall at both widths (65px before, 62px after) and the remaining cause
 * was the repo caption, not the tabs: `text-xs text-muted truncate min-w-0` has a 219px max-content,
 * and flexbox collects lines from HYPOTHETICAL main size before it shrinks anything, so a `truncate`
 * item in a `flex-wrap` row wraps instead of ellipsising. It needed `flex-1`/`basis-0`, it was a
 * different element with a different root cause, and it was left for its own issue rather than
 * folded in here. `headerHeight` was therefore RECORDED in every failure message and asserted on by
 * nothing — a threshold this fix did not move would either fail forever or lock in the defect.
 *
 * #454 moved it, so it is asserted now. Measured live in WebKit (not from a markup fixture) on this
 * very block's fixture, before and after `flex-1 basis-0`:
 *
 *              headerHeight   caption width   scrollWidth > clientWidth
 *     before      65 / 65        219 / 219        FALSE — a dead ellipsis
 *     after       34 / 34        100 / 170        TRUE  — it ellipsises
 *
 * ONE LINE is the invariant, and `headerHeight` is the only assertion that catches a future item
 * wrapping this row again. It is also the guard for a defect class `measureOverflow` structurally
 * cannot see: a `flex-wrap` row does not pan the page when something does not fit, it gets TALLER,
 * and the terminal pane starts further down the screen (#370). Every horizontal number here reads
 * zero before and after.
 *
 * The caption's `scrollWidth > clientWidth` is asserted beside it, because "one line" and "the
 * ellipsis works" are different claims: hiding the caption below `sm` would satisfy the first and
 * delete the content the row exists for.
 *
 * ── Why the accessible name is asserted at both widths
 *
 * Below `sm` the label is `hidden`, so the button's name can only come from `aria-label`. Hiding
 * the text without it would leave four unlabelled icon buttons — the regression #389 was filed to
 * remove from this surface. `getByRole("button", { name })` computes the real accessible name, so
 * the same query proves it at 320px (from `aria-label`) and at 1280px (from the visible text).
 *
 * `mobile — ` prefix on purpose: that is what puts a block in front of WebKit as well as Chromium
 * (#384), and every phone runs WebKit.
 */
test.describe("mobile — the single-repo Coder tab row (#431)", () => {
	const TABS = ["Terminal", "Issues", "Pulls", "Builds"];

	/**
	 * `repos: "single"` is what selects the solo surface, and `repos.length <= 1` is the data guard
	 * beside it — both must hold or `CodingTab` falls through to the multi-repo list and this block
	 * would measure a row that is not the one in the ticket.
	 */
	const soloCoder = [
		{
			id: "inst-1",
			name: "Repo Coder",
			slug: "repo-coder",
			category: "code",
			capabilities: {
				surfaces: ["coding"],
				runtime: "coding",
				workflow: "CODING_SESSION",
				surfaceOptions: { coding: { repos: "single" } },
			},
		},
	];

	/** A real repo name, not `repo`: the caption shares the row and its width is part of the wrap. */
	const REPO = { id: "repo-1", name: "platform", githubRepo: "ProAgentStore/platform", provider: "github", cloneStatus: "ready" };

	async function mockSoloCoder(page: Page) {
		await mockSignedInConsole(page, { instances: soloCoder });
		await page.route("**/v1/instances/inst-1/coding/**", async (route) => {
			const url = route.request().url();
			const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
			if (url.includes("/repos")) return json({ repos: [REPO] });
			if (url.includes("/engines")) return json({ engines: [], defaultEngineId: "claude" });
			if (url.includes("/sessions")) return json({ sessions: [] });
			if (url.includes("/issues")) return json({ repo: REPO.githubRepo, issues: [] });
			if (url.includes("/pulls")) return json({ repo: REPO.githubRepo, pulls: [] });
			if (url.includes("/builds")) return json({ builds: [] });
			if (url.includes("/capture")) return json({ pane: "", runState: "idle" });
			return json({});
		});
	}

	async function openSolo(page: Page, width: number) {
		await page.setViewportSize({ width, height: 812 });
		await mockSoloCoder(page);
		// Deep link: below `sm` the instance tab bar is icon-only, so there is no "Coding" text to
		// click — which is the same convention this row is being brought into line with.
		await page.goto("/console/instances/inst-1/coding");
		await page.waitForLoadState("networkidle");
		await page.locator("#coding-solo-tabs").waitFor();
		await page.waitForTimeout(300);
	}

	/** Rects for the row, its group and each tab — the numbers the ticket asks to be measured. */
	async function measureTabRow(page: Page) {
		return page.evaluate(() => {
			const group = document.querySelector<HTMLElement>("#coding-solo-tabs");
			const header = document.querySelector<HTMLElement>("#coding-solo-header");
			if (!group || !header) throw new Error("the solo tab row did not render");
			const g = group.getBoundingClientRect();
			const h = header.getBoundingClientRect();
			const tabs = Array.from(group.children).map((el) => {
				const b = (el as HTMLElement).getBoundingClientRect();
				return {
					name: (el.getAttribute("aria-label") || el.textContent || "").trim(),
					left: Math.round(b.left),
					right: Math.round(b.right),
					top: Math.round(b.top),
					width: Math.round(b.width),
					height: Math.round(b.height),
				};
			});
			const tops = new Set(tabs.map((t) => t.top));
			// The trailing action cluster (CLI engines, repo settings, session controls). It is
			// `shrink-0`, so whether it shares the tabs' line is decided entirely by how much of
			// the row the tab group takes.
			const actions = header.querySelector<HTMLElement>(":scope > div.ml-auto");
			const a = actions?.getBoundingClientRect();
			const style = getComputedStyle(header);
			const px = (v: string) => Number.parseFloat(v) || 0;
			return {
				viewport: window.innerWidth,
				group: { left: Math.round(g.left), right: Math.round(g.right), width: Math.round(g.width), height: Math.round(g.height) },
				actionsWidth: a ? Math.round(a.width) : 0,
				// Content box of the row: what the group, the caption and the actions divide up.
				rowContentWidth: Math.round(h.width - px(style.paddingLeft) - px(style.paddingRight)),
				columnGap: Math.round(px(style.columnGap)),
				// Asserted since #454 — see the note on the residual above.
				headerHeight: Math.round(h.height),
				// The caption between the tabs and the actions. `:scope > span` is the only direct
				// span child of the row.
				caption: (() => {
					const c = header.querySelector<HTMLElement>(":scope > span");
					if (!c) return null;
					const b = c.getBoundingClientRect();
					// CENTRE, not top: the row is `items-center` and the caption's line box is 16px
					// against the tab group's 26px, so on ONE line their tops legitimately differ.
					return { top: Math.round(b.top), centre: Math.round(b.top + b.height / 2), width: Math.round(b.width), ellipsised: c.scrollWidth > c.clientWidth, title: c.getAttribute("title"), text: c.textContent };
				})(),
				groupCentre: Math.round(g.top + g.height / 2),
				tabs,
				tabRows: tops.size,
				overflowPastViewport: Math.round(g.right - window.innerWidth),
			};
		});
	}

	for (const width of [320, 390]) {
		test(`the four tabs fit one line inside ${width}px`, async ({ page }) => {
			await openSolo(page, width);
			const m = await measureTabRow(page);
			const detail = JSON.stringify(m);

			// The fixture landed: four tabs, not an empty group measured green.
			expect(m.tabs.map((t) => t.name), detail).toEqual(TABS);

			// No wrap INSIDE the group — all four share one baseline.
			expect(m.tabRows, `the tabs wrapped onto ${m.tabRows} lines at ${width}w: ${detail}`).toBe(1);

			// No horizontal overflow: the group ends inside the viewport, with a pixel of slack for
			// sub-pixel rounding.
			expect(m.overflowPastViewport, `the tab group runs ${m.overflowPastViewport}px past the right edge at ${width}w: ${detail}`).toBeLessThanOrEqual(1);

			// The group is ICON-ONLY, which is the change. Four labelled tabs measure 302px in
			// WebKit at both widths; four icon-only ones measure 130px. The ceiling sits between
			// the two so that a label creeping back — a dropped `hidden sm:inline`, a `sm:` typo,
			// a fifth tab — fails here rather than in someone's hand.
			expect(m.group.width, `the tab group is ${m.group.width}px wide at ${width}w — the labels are rendering below sm: ${detail}`).toBeLessThan(200);

			// And the group no longer OWNS the row. `flex-wrap` means an oversized group does not
			// pan the page — it pushes what shares its line onto another one, and the terminal pane
			// down with it (#370). At 302px the group plus the `shrink-0` action cluster could not
			// coexist on one line at 320px; at 130px they fit with the caption between them.
			const needed = m.group.width + m.actionsWidth + m.columnGap;
			expect(needed, `the tabs + the action cluster need ${needed}px of a ${m.rowContentWidth}px row at ${width}w: ${detail}`).toBeLessThanOrEqual(m.rowContentWidth);

			// WCAG 2.5.8 Target Size (Minimum), the same 24px floor the #389 block asserts — whose
			// route list does not reach this surface, so it is asserted here rather than left to a
			// guard that cannot see it. Taking the label away SHRANK these buttons: the text line
			// box is 16px and the icon is 13, so `py-1` alone dropped them from 24px to 21. An
			// icon-only fix that quietly undersizes the target is the #389 defect wearing #431's
			// clothes, which is why it is measured in the same test.
			for (const t of m.tabs) {
				expect(Math.min(t.width, t.height), `"${t.name}" is ${t.width}×${t.height} at ${width}w — under the 24px minimum target: ${detail}`).toBeGreaterThanOrEqual(24);
			}

			// ── ONE LINE (#454) ──
			// The tabs, the caption and the action cluster share a baseline. 65px was two lines
			// (three at 320px with a longer status word); 34px is one. 40 is the ceiling, between
			// the measured value and the smallest two-line row this can produce.
			expect(m.headerHeight, `the header is ${m.headerHeight}px at ${width}w — it has wrapped onto another line: ${detail}`).toBeLessThanOrEqual(40);
			expect(m.caption, `the repo caption did not render, so the wrap cannot be measured: ${detail}`).not.toBeNull();
			if (m.caption) {
				// Same line as the tabs — the direct statement of "one line", independent of the
				// height threshold, which a shorter caption could satisfy by accident. Compared on
				// CENTRES with a 4px tolerance: the row is `items-center` and the two boxes are
				// different heights, so equal tops would be the wrong assertion (it was tried, and
				// it fails on a correctly-laid-out row: caption top 53 vs tab top 49).
				expect(Math.abs(m.caption.centre - m.groupCentre), `the caption is on its own line at ${width}w: ${detail}`).toBeLessThanOrEqual(4);
				// And the ellipsis is LIVE. This was FALSE before the fix: the caption sat at its
				// full 219px max-content on a line of its own and never truncated — #393's defect
				// class in a second costume, which the source guard cannot see because whether it
				// is a defect depends on the PARENT wrapping.
				expect(m.caption.ellipsised, `the caption is not ellipsising — it has room because it wrapped: ${detail}`).toBe(true);
				// Once it ellipsises, the status phrase (#405 "Runner offline", #440 "Build
				// failed") is the first thing cut, and that phrase is what the caption is for.
				expect(m.caption.title, `the ellipsised caption exposes no full text on hover: ${detail}`).toBe(m.caption.text);
			}

			// And the page still does not pan, by the sweep's own definition.
			const { mainOv, docOv, wide, escapes } = await measureOverflow(page);
			expect(mainOv, `<main> pans by ${mainOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(docOv, `page overflows by ${docOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(wide, `content past the right edge at ${width}w: ${wide.join(", ")}`).toEqual([]);
			expect(escapes, `a box past its own container at ${width}w: ${escapes.join(", ")}`).toEqual([]);
		});

		test(`every tab keeps an accessible name at ${width}px`, async ({ page }) => {
			await openSolo(page, width);
			for (const name of TABS) {
				const btn = page.locator("#coding-solo-tabs").getByRole("button", { name, exact: true });
				await expect(btn, `"${name}" has no accessible name at ${width}w`).toHaveCount(1);
				// The desktop tooltip. Below `sm` it is invisible; it costs nothing and is the only
				// hover affordance once the text is hidden.
				await expect(btn).toHaveAttribute("title", name);
			}
		});
	}

	/**
	 * The active tab must still READ as active with no label to colour. Asserted on computed style
	 * rather than the class string: `bg-accent-soft text-accent` is only a promise until the
	 * cascade actually paints it, and an icon-only row where every button looks the same is a
	 * navigation with no current-position indicator.
	 */
	test("mobile — the active tab is distinguishable icon-only", async ({ page }) => {
		await openSolo(page, 320);
		const group = page.locator("#coding-solo-tabs");
		await group.getByRole("button", { name: "Issues", exact: true }).click();
		await page.waitForTimeout(200);

		const styles = await page.evaluate(() =>
			Array.from(document.querySelector("#coding-solo-tabs")?.children ?? []).map((el) => {
				const s = getComputedStyle(el as HTMLElement);
				return { name: (el.getAttribute("aria-label") || el.textContent || "").trim(), pressed: el.getAttribute("aria-pressed"), bg: s.backgroundColor, fg: s.color };
			}),
		);
		const active = styles.find((s) => s.pressed === "true");
		expect(active?.name, JSON.stringify(styles)).toBe("Issues");
		const others = styles.filter((s) => s.pressed !== "true");
		expect(others, JSON.stringify(styles)).toHaveLength(3);
		// Both channels differ, so the state survives a colour-blind reading of either one alone.
		for (const o of others) {
			expect(o.bg, `inactive "${o.name}" shares the active background: ${JSON.stringify(styles)}`).not.toBe(active?.bg);
			expect(o.fg, `inactive "${o.name}" shares the active text colour: ${JSON.stringify(styles)}`).not.toBe(active?.fg);
		}
	});

	/** At `sm` and up the row is unchanged: icon AND label, as it ships today. */
	test("the labels come back at desktop width", async ({ page }) => {
		await openSolo(page, 1280);
		const group = page.locator("#coding-solo-tabs");
		for (const name of TABS) {
			await expect(group.getByRole("button", { name, exact: true })).toContainText(name);
		}
		const m = await measureTabRow(page);
		expect(m.tabRows, JSON.stringify(m)).toBe(1);
	});
});

/**
 * The repo row says HOW OLD its verdict is, and offers a way to re-take it (#440).
 *
 * `pas/platform` read "Path unusable" for five days, from a verdict taken by a `POST /coding/start`
 * that failed on a closed laptop and never looked at the directory. The list's own re-check is
 * conditional on a runner connection the instance's "Runs on" pin would not resolve, and its early
 * return was silent — so the card stated a five-day-old memory with the same confidence as a live
 * check, and the owner had no control that would replace it.
 *
 * Measured on a phone because that is where it is worst: the freshness line, the Re-check control
 * and the "last known" notice are all new text on a 320px card that already carries a repo name, a
 * provider badge and three buttons. `mobile — ` prefix so the block runs under WebKit too (#384).
 */
test.describe("mobile — a repo row dates its verdict and can re-take it (#440)", () => {
	const multiCoder = [
		{
			id: "inst-1",
			name: "Coder Home",
			slug: "coder",
			category: "code",
			capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" },
		},
	];

	/** A local checkout, so there is a folder for a machine to look at — the only case with an age. */
	const REPO = {
		id: "repo-1",
		name: "pas/platform",
		githubRepo: "proappstore-online/platform",
		provider: "local",
		workdir: "~/dev/stores/pas/platform",
		cloneStatus: "ready",
		// Five days before the fixture's "now" is irrelevant to the assertion (the phrase is
		// computed against the browser clock); what matters is that a time is present at all.
		cloneCheckedAt: "2026-08-03 01:44:25",
	};

	async function openRepos(page: Page, width: number) {
		await page.setViewportSize({ width, height: 812 });
		await mockSignedInConsole(page, { instances: multiCoder });
		await page.route("**/v1/instances/inst-1/coding/**", async (route) => {
			const url = route.request().url();
			const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
			if (url.includes("/recheck")) {
				return json({ repo: { ...REPO, cloneCheckedAt: "2026-08-08 09:00:00" }, checked: true, verdict: { state: "ok", path: "/Users/u/dev/stores/pas/platform", detail: "" } });
			}
			if (url.includes("/repos")) {
				// The state the ticket is about: rows shown WITHOUT a re-check, and the server
				// saying so rather than returning early in silence.
				return json({
					repos: [REPO],
					recheck: { ran: false, checked: 0, reason: "This agent is pinned to Sergeys-Mac-mini.local, which isn't connected." },
				});
			}
			if (url.includes("/engines")) return json({ engines: [], defaultEngineId: "claude" });
			if (url.includes("/sessions")) return json({ sessions: [] });
			if (url.includes("/builds")) return json({ builds: [] });
			if (url.includes("/capture")) return json({ pane: "", runState: "idle" });
			return json({});
		});
		await page.goto("/console/instances/inst-1/coding");
		await page.waitForLoadState("networkidle");
		await page.getByRole("button", { name: "Re-check" }).first().waitFor();
		await page.waitForTimeout(200);
	}

	for (const width of [320, 390]) {
		test(`the freshness line and its control fit a ${width}px card`, async ({ page }) => {
			await openRepos(page, width);

			// The age is stated. Without it the row is a claim with no date on it, which is the bug.
			await expect(page.getByText(/checked \d+[dhm]/i).first()).toBeVisible();

			// And so is the fact that THIS list did not re-check — the difference between "the
			// platform looked and it is broken" and "nobody has looked since Monday".
			const notice = page.getByTestId("repos-stale-notice");
			await expect(notice).toBeVisible();
			await expect(notice).toContainText("Sergeys-Mac-mini.local");

			// WCAG 2.5.8 Target Size (Minimum) — the same 24px floor #389/#431 assert on this
			// surface. The control is deliberately not a boxed button (the control-shapes ratchet
			// holds this tree still), so its padding is the only thing giving it a tap target.
			const btn = page.getByRole("button", { name: "Re-check" }).first();
			const box = await btn.boundingBox();
			expect(box, "the Re-check control did not render").not.toBeNull();
			expect(Math.min(box?.width ?? 0, box?.height ?? 0), `Re-check is ${box?.width}×${box?.height} at ${width}w`).toBeGreaterThanOrEqual(24);

			// The new text wraps instead of panning the page. Three new strings on a card that
			// already carries a repo name, a provider badge and three buttons is exactly where a
			// horizontal scrollbar comes from.
			const { mainOv, docOv, wide } = await measureOverflow(page);
			expect(mainOv, `<main> pans by ${mainOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(docOv, `page overflows by ${docOv}px at ${width}w`).toBeLessThanOrEqual(1);
			expect(wide, `content past the right edge at ${width}w: ${wide.join(", ")}`).toEqual([]);
		});
	}

	test("mobile — pressing Re-check reports the verdict it got back", async ({ page }) => {
		// The escape hatch has to SAY something. A control that silently re-runs a check leaves the
		// owner exactly where they were: looking at a status and unable to tell whether it is now
		// current.
		await openRepos(page, 390);
		await page.getByRole("button", { name: "Re-check" }).first().click();
		await expect(page.getByText("Checked — the checkout is there.")).toBeVisible();
		await expect(page.getByText(/checked just now/i).first()).toBeVisible();
	});
});

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * mobile — the Co-pilot's Copy button clears the timestamp (#445)
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * #426 fixed this on the Assistant. The **Coder Co-pilot** renders its own bubble, in a different
 * package, with the same three decisions and none of the fix: an absolutely-positioned Copy button
 * at `top-1 right-1.5`, always visible below `sm` (correctly — there is no hover on a touch
 * screen), over a header row with no reserved padding. Measured in WebKit at 320 and 390:
 * **18×16px of the timestamp underneath the button**, `padding-right: 0px`, identical at both
 * widths because the button is absolutely positioned and does not scale. 18 of an 89px stamp is
 * 20% of it, including the minutes.
 *
 * ── Why the console's guard did not catch it, and why this block had to exist
 *
 * `mobile — Copy and Delete clear the message timestamp (#426)` measures the Assistant tab, mocks
 * `**\/v1/instances/inst-1/messages*` and asserts over `[data-chat-bubble]` / `[data-msg-stamp]`.
 * The Co-pilot renders at a different route, inside a coding session, from
 * `@proagentstore/coder-web`, and carried neither attribute. Two correct decisions — the guard was
 * scoped to the surface the bug was reported on, and the Co-pilot was split into its own package
 * deliberately — which compose into a blind spot.
 *
 * #445 offered "extend the guard, or accept a known blind spot IN WRITING". This is the extension,
 * because the blind spot is the whole reason the defect shipped twice. It costs a fixture that no
 * spec had: a MULTI-repo coding instance (`CodingTab` returns the solo surface before it ever
 * reaches `CopilotView`, so `repos.length > 1` is load-bearing), a session in the URL — which is
 * what `pickAutoOpenSession` opens on — and a `/timeline` answer whose row types map to chat roles
 * through `chatMessagesFrom`'s table (`chat_user`, `chat_assistant`).
 *
 * ── What is asserted
 *
 * Bounding-box INTERSECTION, not padding. `pr-12` is the fix, but asserting the class or the
 * computed padding would pass on a button that later moves or grows. The pixels the user cannot
 * read are the thing. `sm` is asserted separately to stay byte-identical: above the breakpoint the
 * button is hover-only, so reserving space there would be a desktop regression for no reason.
 */
test.describe("mobile — the Co-pilot Copy button clears the timestamp (#445)", () => {
	const multiRepoCoder = [
		{
			id: "inst-1",
			name: "Coder",
			slug: "coder",
			category: "code",
			capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" },
		},
	];

	/** TWO repos: with one, `CodingTab` renders the solo surface and never mounts `CopilotView`. */
	const REPOS = [
		{ id: "repo-1", name: "platform", githubRepo: "ProAgentStore/platform", provider: "github", cloneStatus: "ready" },
		{ id: "repo-2", name: "landing", githubRepo: "OpenFrontierOne/landing", provider: "github", cloneStatus: "ready" },
	];
	const SESSION = { id: "cs-1", repoId: "repo-1", status: "active", clientType: "claude", createdAt: "2026-08-08T02:12:00Z" };

	async function openCopilot(page: Page, width: number) {
		await page.setViewportSize({ width, height: 812 });
		await mockSignedInConsole(page, { instances: multiRepoCoder });
		await page.route("**/v1/instances/inst-1/coding/**", async (route) => {
			const url = route.request().url();
			const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
			if (url.includes("/timeline")) {
				// The row types `chatMessagesFrom` maps to roles. Real-shaped stamps: an
				// everyday one (89px) and one carrying a year (114px), which is the pair #426
				// established matters — the overlap is 18px regardless, and asserting only the
				// short one would hide a regression that only bites the long one.
				return json({
					chat: [
						{ type: "chat_user", content: "run the tests", createdAt: "2026-08-08T02:12:00Z" },
						{ type: "chat_assistant", content: "All 6,768 passed.", createdAt: "2025-07-08T02:12:00Z" },
					],
				});
			}
			if (url.includes("/repos")) return json({ repos: REPOS });
			if (url.includes("/engines")) return json({ engines: [], defaultEngineId: "claude" });
			if (url.includes("/sessions")) return json({ sessions: [SESSION] });
			if (url.includes("/capture")) return json({ pane: "", runState: "idle" });
			return json({});
		});
		// The session id in the URL is what `pickAutoOpenSession` opens on — no click needed, and
		// no dependence on a repo row's markup.
		await page.goto("/console/instances/inst-1/coding/cs-1");
		await page.waitForLoadState("networkidle");
		await page.locator("[data-msg-stamp]").first().waitFor();
		await page.waitForTimeout(300);
	}

	/** Every stamp, against every Copy button, as rectangles. */
	async function measureOverlap(page: Page) {
		return page.evaluate(() => {
			const copies = Array.from(document.querySelectorAll('button[aria-label="Copy message"]')) as HTMLElement[];
			const stamps = Array.from(document.querySelectorAll("[data-msg-stamp]")) as HTMLElement[];
			const hits: string[] = [];
			for (const s of stamps) {
				const sr = s.getBoundingClientRect();
				for (const c of copies) {
					const cr = c.getBoundingClientRect();
					const w = Math.round(Math.min(sr.right, cr.right) - Math.max(sr.left, cr.left));
					const h = Math.round(Math.min(sr.bottom, cr.bottom) - Math.max(sr.top, cr.top));
					if (w > 0 && h > 0) hits.push(`"${s.textContent}" (${Math.round(sr.width)}px) is covered ${w}x${h} by Copy`);
				}
			}
			return {
				hits,
				stamps: stamps.length,
				copies: copies.length,
				// The button must still be PAINTED on a phone — reserving space for an invisible
				// button would "fix" the overlap by hiding the control (#389).
				painted: copies.map((c) => getComputedStyle(c).opacity),
				headerPadding: stamps.map((s) => getComputedStyle(s.parentElement as HTMLElement).paddingRight),
				// #389's floor. `tap-target` adds vertical reach with an ::after, so this reads the
				// pseudo-element rather than the button box, which is deliberately unchanged.
				reach: copies.map((c) => Math.round(Number.parseFloat(getComputedStyle(c, "::after").minHeight) || c.getBoundingClientRect().height)),
			};
		});
	}

	for (const width of [320, 390]) {
		test(`no pixel of the timestamp is under Copy at ${width}px`, async ({ page }) => {
			await openCopilot(page, width);
			const m = await measureOverlap(page);
			const detail = JSON.stringify(m);

			// NON-VACUITY. A Co-pilot that rendered no bubbles would report no overlap and pass —
			// and this is the surface that got here precisely by never being rendered in a test.
			expect(m.stamps, `the Co-pilot rendered no timestamps — fixture gap, not a pass: ${detail}`).toBe(2);
			expect(m.copies, `the Co-pilot rendered no Copy buttons: ${detail}`).toBe(2);
			for (const o of m.painted) {
				expect(Number(o), `Copy is not visible on a phone — there is no hover here (#389): ${detail}`).toBe(1);
			}

			expect(m.hits, `${m.hits.join("; ")} — ${detail}`).toEqual([]);

			// #389's 40px floor, closed on this package in the same edit. The neighbouring play
			// button already had `tap-target`; this one was a 24×24 target.
			for (const r of m.reach) {
				expect(r, `the Copy button's touch reach is ${r}px, under #389's floor: ${detail}`).toBeGreaterThanOrEqual(40);
			}
		});
	}

	test("mobile — no space is reserved above the sm breakpoint", async ({ page }) => {
		await openCopilot(page, 900);
		const m = await measureOverlap(page);
		// `sm:pr-0` — the desktop layout is byte-identical, because there the button is
		// hover-revealed and covers nothing to begin with.
		for (const p of m.headerPadding) {
			expect(p, `space is reserved at desktop width, where Copy is hover-only: ${JSON.stringify(m)}`).toBe("0px");
		}
	});
});
