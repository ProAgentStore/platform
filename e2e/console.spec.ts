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
	appRecords?: Array<Record<string, unknown>>;
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
				display_name: "Test User",
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
						slug: "job-application-assistant",
						category: "productivity",
						icon_bg: "#7c3aed",
						capabilities: { surfaces: ["apply"], runtime: "browser", workflow: "apply" },
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
		if (path === "/v1/instances/inst-1/knowledge") return json({ knowledge: [] });
		if (path === "/v1/instances/inst-1/memory") return json({ memory: [] });
		if (path === "/v1/instances/inst-1/files") return json({ files: [] });
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
		if (path === "/v1/keys/status") return json({ providers: [] });
		if (path === "/v1/profile") return json({ fields: [], profile: {} });
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
		get approvedTaskId() {
			return approvedTaskId;
		},
		get cancelledTaskId() {
			return cancelledTaskId;
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

		await page.goto("/console/");

		await expect(page.getByText("Agents you've built")).toBeVisible();
		await expect(page.getByText("Draft Agent")).toBeVisible();
		await expect(page.getByText("Live Agent")).toBeVisible();
	});

	test("signed-in user can open an instance and see the board tab", async ({
		page,
	}) => {
		const mock = await mockSignedInConsole(page);
		await page.goto("/console/");

		// Navigate to instances
		await page.getByRole("link", { name: "Instances" }).click();
		await page.getByText("Job Application Assistant").click();

		// Board tab should be available for apply agents
		await page.getByRole("button", { name: "Board", exact: true }).click();

		// Should show task count
		await expect(page.getByText(/2 task/)).toBeVisible();
		// Should show the approval task
		await expect(page.getByText("Job application").first()).toBeVisible();
		// Approve button should work
		await page.getByRole("button", { name: "Approve" }).click();
		expect(mock.approvedTaskId).toBe("task-approval");
	});

	test("console deep links restore instance tabs after refresh", async ({ page }) => {
		await mockSignedInConsole(page);

		// Navigate directly to an instance's knowledge tab
		await page.goto("/console/instances/inst-1/knowledge");

		// The knowledge tab should load — sub-tabs and heading are visible
		await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
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

	test("instance chat has voice controls with correct tooltips", async ({
		page,
	}) => {
		await mockSignedInConsole(page);
		await page.goto("/console/instances/inst-1");

		// All three voice buttons should be present with descriptive tooltips
		const mic = page.getByTitle("Push to talk");
		const speak = page.getByTitle("Auto-speak");
		const convo = page.getByTitle(/Hands-free voice/);
		const copy = page.getByTitle("Copy JSON");
		const clear = page.getByTitle("Clear all messages");

		await expect(mic).toBeVisible();
		await expect(speak).toBeVisible();
		await expect(convo).toBeVisible();
		await expect(copy).toBeVisible();
		await expect(clear).toBeVisible();
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
		// Navigate to Coding tab, then open Terminal
		await page.getByRole("button", { name: "Coding" }).click();
		await page.getByRole("button", { name: "Terminal", exact: true }).click();
		const termInput = page.getByPlaceholder("Type a message to the CLI...");
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
	test("opens an agent and renders the chat tab", async ({
		page,
	}) => {
		await mockSignedInConsole(page);
		await page.goto("/console/");

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
		await page.goto("/console/");

		await page.getByText("Ops Agent").click();
		await page.getByRole("button", { name: "Settings", exact: true }).click();

		await expect(page.getByText("Identity")).toBeVisible();
		await expect(page.getByText("Model & Publishing")).toBeVisible();
		await expect(page.getByRole("button", { name: "Save All Settings" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Delete Agent" })).toBeVisible();
	});
});
