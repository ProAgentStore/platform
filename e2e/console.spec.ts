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
	instanceChatStatus?: number;
	instanceChatBody?: Record<string, unknown>;
	boardConfig?: Record<string, unknown> | null;
	ops?: Record<string, unknown>;
	verifyStatus?: number;
	verifyBody?: Record<string, unknown>;
	deployStatus?: number;
	deployBody?: Record<string, unknown>;
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
				avatar: "https://example.com/avatar.png",
				roles: ["user", "creator"],
				boardConfig: options.boardConfig ?? null,
			});
		}
		if (path === "/v1/notifications") return json({ notifications: [], unreadCount: 0 });
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
						category: "productivity",
						icon_bg: "#7c3aed",
					},
				],
			});
		}
		if (path === "/v1/instances/inst-1/messages") return json({ messages: [] });
		if (path === "/v1/instances/inst-1/chat" && method === "POST") {
			return json(
				options.instanceChatBody ?? {
					message: { role: "assistant", content: "Mock assistant reply" },
				},
				options.instanceChatStatus ?? 200,
			);
		}
		if (path === "/v1/instances/inst-1/knowledge") return json({ documents: [] });
		if (path === "/v1/instances/inst-1/runtime") {
			return json({
				runtime: options.runtime ?? {
					instanceId: "inst-1",
					status: "online",
					placement: "local",
				},
			});
		}
		if (path === "/v1/instances/inst-1/tasks") {
			return json({
				tasks: options.runtimeTasks ?? [
					{
						id: "task-approval",
						type: "job.apply_basic",
						status: "needs_approval",
						requiresApproval: true,
						approval: { prompt: "Submit application to Acme?" },
						createdAt: "2026-06-20T01:00:00Z",
						updatedAt: "2026-06-20T01:01:00Z",
					},
					{
						id: "task-done",
						type: "job.apply_basic",
						status: "completed",
						requiresApproval: true,
						output: { submitted: true, finalUrl: "https://example.com/success" },
						createdAt: "2026-06-20T00:00:00Z",
						updatedAt: "2026-06-20T00:02:00Z",
					},
				],
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
						createdAt: "2026-06-20T01:01:00Z",
					},
					{
						id: "event-2",
						taskId: "task-done",
						type: "browser.goto.completed",
						message: "Job application page loaded",
						data: { url: "https://example.com/jobs/1", title: "Example Job" },
						createdAt: "2026-06-20T00:00:30Z",
					},
					{
						id: "event-3",
						taskId: "task-done",
						type: "job.form.filled",
						message: "Application form fields completed",
						data: { fieldsFilled: ["fullName", "email", "resume"] },
						createdAt: "2026-06-20T00:01:00Z",
					},
					{
						id: "event-4",
						taskId: "task-done",
						type: "task.completed",
						message: "Task completed: job.apply_basic",
						data: { submitted: true },
						createdAt: "2026-06-20T00:02:00Z",
					},
				],
			});
		}
		if (path === "/v1/instances/inst-1/tasks/task-approval/approve" && method === "POST") {
			approvedTaskId = "task-approval";
			return json({ id: "task-approval", status: "running" });
		}
		if (path === "/v1/instances/inst-1/tasks/task-approval/cancel" && method === "POST") {
			cancelledTaskId = "task-approval";
			return json({ id: "task-approval", status: "cancelled" });
		}

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
		get approvedTaskId() {
			return approvedTaskId;
		},
		get cancelledTaskId() {
			return cancelledTaskId;
		},
	};
}

test.describe("ProAgentStore Console smoke", () => {
	test("console root renders the sign-in screen", async ({ page }) => {
		await page.goto("/");

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

	test("ops and user-owned AI controls are present in the console bundle", async ({
		page,
	}) => {
		await page.goto("/");

		const html = await page.locator("html").evaluate((el) => el.innerHTML);
		expect(html).toContain("AI Billing");
		expect(html).toContain("Runtime Health");
		expect(html).toContain("Verify Key");
		expect(html).toContain("Cloudflare account ID");
		expect(html).toContain("triggerDeploy");
	});

	test("signed-in creator console shows an agent status board", async ({ page }) => {
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
				{
					id: "error-agent",
					slug: "error-agent",
					name: "Error Agent",
					description: "Needs operator review",
					category: "data",
					visibility: "draft",
					status: "error",
				},
			],
		});

		await page.goto("/");

		await expect(page.getByText("3 agents across setup, review, live, and attention")).toBeVisible();
		await expect(page.getByText("Setup").first()).toBeVisible();
		await expect(page.getByText("Live").first()).toBeVisible();
		await expect(page.getByText("Attention").first()).toBeVisible();
		await expect(
			page.getByLabel("Setup column").getByRole("button", { name: "Open Draft Agent" }),
		).toBeVisible();
		await expect(
			page.getByLabel("Live column").getByRole("button", { name: "Open Live Agent" }),
		).toBeVisible();
		await expect(
			page.getByLabel("Attention column").getByRole("button", { name: "Open Error Agent" }),
		).toBeVisible();
		await expect(
			page.getByLabel("Setup column").getByRole("button", { name: "Open Error Agent" }),
		).toHaveCount(0);
	});

	test("signed-in creator can save a custom agent board config", async ({ page }) => {
		const mock = await mockSignedInConsole(page);
		await page.goto("/");

		await page.getByRole("button", { name: "Configure Board" }).click();
		const customConfig = {
			summary: "build and shipped",
			columns: [
				{
					id: "build",
					title: "Build",
					color: "var(--yellow)",
					statuses: ["inactive"],
					visibilities: ["draft"],
				},
				{
					id: "shipped",
					title: "Shipped",
					color: "var(--green)",
					statuses: ["active"],
					visibilities: ["published"],
					catchAll: true,
				},
			],
		};
		await page.locator("#board-config-json").fill(JSON.stringify(customConfig, null, 2));
		await page.getByRole("button", { name: "Save Board" }).click();

		await expect(page.getByText("1 agent across build and shipped")).toBeVisible();
		await expect(page.getByText("Build").first()).toBeVisible();
		expect(mock.profileUpdates).toHaveLength(1);
		expect(mock.profileUpdates[0]).toMatchObject({ board_config: customConfig });
	});

	test("signed-in user can inspect instance runtime tasks as a board", async ({
		page,
	}) => {
		const mock = await mockSignedInConsole(page);
		await page.goto("/");

		await page.getByRole("button", { name: "My Instances (Client)" }).click();
		await page.getByText("Job Application Assistant").click();
		await page.getByRole("button", { name: "Runtime" }).click();

		await expect(page.locator("#inst-runtime-summary")).toContainText(
			"2 runtime tasks",
		);
		await expect(
			page.locator("#inst-runtime-board").getByText("Waiting"),
		).toBeVisible();
		await expect(
			page.locator("#inst-runtime-board").getByText("job.apply_basic").first(),
		).toBeVisible();
		await expect(page.getByText("Waiting for approval before submit")).toBeVisible();

		await page
			.getByRole("button", { name: "Open runtime task task-done" })
			.click();
		await expect(page).toHaveURL(/\/console\/instances\/inst-1\/runtime\/tasks\/task-done$/);
		const taskDetail = page.locator("#runtime-task-detail");
		await expect(taskDetail).toBeVisible();
		await expect(taskDetail.getByRole("heading", { name: "job.apply_basic" })).toBeVisible();
		await expect(taskDetail.getByText("task-done")).toBeVisible();
		await expect(taskDetail.getByText("https://example.com/success")).toBeVisible();
		await expect(taskDetail.getByText("Task History")).toBeVisible();
		await expect(taskDetail.getByText("browser.goto.completed")).toBeVisible();
		await expect(taskDetail.getByText("job.form.filled")).toBeVisible();
		await expect(
			taskDetail.getByText("Application form fields completed"),
		).toBeVisible();
		await page.reload();
		await expect(taskDetail).toBeVisible();
		await expect(taskDetail.getByText("job.form.filled")).toBeVisible();
		await page.getByRole("button", { name: "Back to runtime board" }).click();
		await expect(page).toHaveURL(/\/console\/instances\/inst-1\/runtime$/);
		await expect(taskDetail).toBeHidden();

		await page.getByRole("button", { name: "Approve" }).click();
		expect(mock.approvedTaskId).toBe("task-approval");
	});

	test("console deep links restore instance tabs after refresh", async ({ page }) => {
		await mockSignedInConsole(page);

		await page.goto("/console/instances/inst-1/runtime");

		await expect(
			page.getByRole("heading", { name: "Runtime Board" }),
		).toBeVisible();
		await expect(page.locator("#inst-runtime-summary")).toContainText(
			"2 runtime tasks",
		);

		await page.getByRole("button", { name: "My Documents" }).click();
		await expect(page).toHaveURL(/\/console\/instances\/inst-1\/knowledge$/);
		await page.reload();

		await expect(page.getByRole("heading", { name: "Your Documents" })).toBeVisible();
		await expect(page.locator("#inst-tab-knowledge")).toHaveClass(/active/);
	});

	test("profile and notifications have refreshable routes", async ({ page }) => {
		await mockSignedInConsole(page);

		await page.goto("/console/profile");
		await expect(
			page.getByRole("heading", { name: "Profile", exact: true }),
		).toBeVisible();
		await expect(page.locator("#profile-login")).toHaveText("@tester");

		await page.goto("/console/notifications");
		await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
		await expect(page.locator("#notif-empty")).toBeVisible();
	});

	test("keyboard chat shortcut focuses the visible instance chat input", async ({
		page,
	}) => {
		await mockSignedInConsole(page);

		await page.goto("/console/instances/inst-1/chat");
		await expect(page.locator("#inst-tab-chat")).toHaveClass(/active/);
		await page.evaluate(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "K",
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
				}),
			);
		});

		await expect(page.locator("#inst-chat-input")).toBeFocused();
	});

	test("instance chat links missing Cloudflare credentials to profile setup", async ({
		page,
	}) => {
		await mockSignedInConsole(page, {
			instanceChatStatus: 402,
			instanceChatBody: {
				error:
					"Add your Cloudflare Workers AI account ID and API token before running this agent.",
			},
		});

		await page.goto("/console/instances/inst-1/chat");
		await page.locator("#inst-chat-input").fill("hello");
		await page.getByRole("button", { name: "Send" }).click();

		await expect(
			page.getByText(
				"Add your Cloudflare Workers AI account ID and API token before running this agent.",
			),
		).toBeVisible();
		await expect(page.getByRole("link", { name: /Profile/ })).toHaveAttribute(
			"href",
			"/console/profile",
		);
		await expect(page.getByText("Cloudflare Account ID")).toBeVisible();
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
	test("browser runtime docs show the FAGS runtime target architecture", async ({ page }) => {
		await page.goto("/docs/browser-runtime/");

		await expect(
			page.getByRole("heading", { name: "FAGS Browser Runtime For PAGS Agents" }),
		).toBeVisible();
		await expect(page.getByText("PAS precedent: our loop")).toBeVisible();
		await expect(page.getByText("Managed FAGS Runtime").first()).toBeVisible();
		await expect(page.getByText("Local FAGS Runtime").first()).toBeVisible();
		await expect(page.getByText("Target: outbound polling")).toBeVisible();
		await expect(page.getByText("Runtime: FAGS")).toBeVisible();
		await expect(page.getByText("Cheapest best-practice recommendation")).toBeVisible();
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
	test("opens an agent and renders the Ops tab from mocked owner data", async ({
		page,
	}) => {
		await mockSignedInConsole(page);
		await page.goto("/");

		await expect(page.getByText("Agents you've built")).toBeVisible();
		await page.getByRole("button", { name: "Open Ops Agent" }).click();
		await page.getByRole("button", { name: "Ops", exact: true }).click();

		await expect(page.getByText("Ready: user-owned Cloudflare Workers AI")).toBeVisible();
		await expect(page.getByText("API:")).toBeVisible();
		await expect(page.getByText("MCP:")).toBeVisible();
		await expect(page.getByText("Worker:")).toBeVisible();
		await expect(
			page.getByRole("link", { name: "ProAgentStore/ops-agent" }),
		).toBeVisible();
		await expect(page.getByText("123ms")).toBeVisible();
	});

	test("Ops verify and deploy controls call the protected API endpoints", async ({
		page,
	}) => {
		const calls = await mockSignedInConsole(page);
		page.on("dialog", (dialog) => dialog.accept());
		await page.goto("/");

		await page.getByRole("button", { name: "Open Ops Agent" }).click();
		await page.getByRole("button", { name: "Ops", exact: true }).click();
		await page.getByRole("button", { name: "Verify Key" }).click();
		await expect
			.poll(() => calls.verifyCalls)
			.toBe(1);

		await page.getByRole("button", { name: "Deploy" }).click();
		await expect
			.poll(() => calls.deployCalls)
			.toBe(1);
	});

	test("Ops renderer treats malformed backend fields as inert text", async ({
		page,
	}) => {
		await mockSignedInConsole(page, {
			ops: {
				agent: {
					id: "agent-1",
					slug: "ops-agent",
					name: "Ops Agent",
					model: "<img src=x onerror=alert(1)>",
					visibility: "draft",
					status: "inactive",
					workerUrl: "https://ops-agent.proagentstore.online/",
				},
				billing: {
					provider: "cloudflare",
					mode: "<script>alert(1)</script>",
					hasCloudflareKey: true,
					createdAt: "2026-06-10T01:00:00Z",
					lastUsedAt: "2026-06-10T02:00:00Z",
				},
				deploy: {
					configured: true,
					org: "ProAgentStore",
					repo: 'ops-agent"><img src=x onerror=alert(1)>',
					runs: [
						{
							id: 1,
							name: "<img src=x onerror=alert(1)>",
							status: "completed",
							conclusion: "success",
							url: "javascript:alert(1)",
							createdAt: "2026-06-10T03:00:00Z",
							updatedAt: "2026-06-10T03:01:00Z",
						},
					],
				},
				executions: [
					{
						id: "exec-1",
						model: "<script>alert(1)</script>",
						duration_ms: 0,
						error: "<img src=x onerror=alert(1)>",
						created_at: "2026-06-10T04:00:00Z",
					},
				],
			},
		});
		await page.goto("/");

		await page.getByRole("button", { name: "Open Ops Agent" }).click();
		await page.getByRole("button", { name: "Ops", exact: true }).click();

		await expect(page.locator("#tab-ops img")).toHaveCount(0);
		await expect(page.locator("#tab-ops script")).toHaveCount(0);
		await expect(page.locator('#ops-deploy-runs a[href^="javascript:"]')).toHaveCount(0);
		await expect(page.locator("#ops-deploy-runs a")).toHaveCount(0);
		await expect(page.locator("#ops-deploy-runs")).toContainText(
			"<img src=x onerror=alert(1)>",
		);
		await expect(page.locator("#ops-execs")).toContainText(
			"<img src=x onerror=alert(1)>",
		);
	});

	test("Ops controls do not call protected endpoints when confirmation is canceled", async ({
		page,
	}) => {
		const calls = await mockSignedInConsole(page);
		page.on("dialog", (dialog) => dialog.dismiss());
		await page.goto("/");

		await page.getByRole("button", { name: "Open Ops Agent" }).click();
		await page.getByRole("button", { name: "Ops", exact: true }).click();
		await page.getByRole("button", { name: "Verify Key" }).click();
		await page.getByRole("button", { name: "Deploy" }).click();

		await expect.poll(() => calls.verifyCalls).toBe(0);
		await expect.poll(() => calls.deployCalls).toBe(0);
	});
});
