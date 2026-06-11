import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const API = "https://api.proagentstore.online";
const TEST_TOKEN = "test-pags-token";

interface OpsMockOptions {
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
		if (path === "/v1/auth/me") {
			return json({
				id: "user-1",
				login: "tester",
				name: "Test User",
				avatar: "https://example.com/avatar.png",
				roles: ["user", "creator"],
			});
		}
		if (path === "/v1/notifications") return json({ notifications: [], unreadCount: 0 });
		if (path === "/v1/agents/my/agents") {
			return json({
				agents: [
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
		await page.locator("#agents-list .agent-card", { hasText: "Ops Agent" }).click();
		await page.getByRole("button", { name: "Ops" }).click();

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

		await page.locator("#agents-list .agent-card", { hasText: "Ops Agent" }).click();
		await page.getByRole("button", { name: "Ops" }).click();
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

		await page.locator("#agents-list .agent-card", { hasText: "Ops Agent" }).click();
		await page.getByRole("button", { name: "Ops" }).click();

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

		await page.locator("#agents-list .agent-card", { hasText: "Ops Agent" }).click();
		await page.getByRole("button", { name: "Ops" }).click();
		await page.getByRole("button", { name: "Verify Key" }).click();
		await page.getByRole("button", { name: "Deploy" }).click();

		await expect.poll(() => calls.verifyCalls).toBe(0);
		await expect.poll(() => calls.deployCalls).toBe(0);
	});
});
