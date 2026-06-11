/**
 * ProAgentStore MCP Server — manage agents from Claude, Cursor, VS Code.
 * Platform, creator, knowledge, and repo-backed project tools for agents.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { createAuthChallenge, handleOAuthRoute, resolveOAuthToken } from "./oauth-provider.js";

const API = "https://api.proagentstore.online";
type Env = {
	API_BASE?: string;
	AUTH_START?: string;
	GITHUB_ORG?: string;
	GITHUB_TOKEN?: string;
	OAUTH_KV?: KVNamespace;
	SESSION_SIGNING_KEY?: string;
};
type Props = Record<string, unknown>;
type TextResult = { content: { type: "text"; text: string }[] };

const AGENT_ID = z
	.string()
	.regex(/^[a-z][a-z0-9-]*$/)
	.describe("Agent slug, lowercase with hyphens, e.g. 'job-apply-agent'");

const text = (value: string): TextResult => ({
	content: [{ type: "text" as const, text: value }],
});

function apiBase(env?: Env): string {
	return env?.API_BASE || API;
}

async function apiCall(
	path: string,
	opts?: RequestInit,
	env?: Env,
): Promise<unknown> {
	const res = await fetch(`${apiBase(env)}${path}`, {
		...opts,
		headers: { "Content-Type": "application/json", ...opts?.headers },
	});
	const raw = await res.text();
	let json: unknown = {};
	try {
		json = raw ? JSON.parse(raw) : {};
	} catch {
		json = { raw };
	}
	if (!res.ok && typeof json === "object" && json !== null) {
		return { error: `API ${res.status}`, ...json };
	}
	return json;
}

async function authedCall(
	path: string,
	token: string,
	opts?: RequestInit,
	env?: Env,
): Promise<unknown> {
	return apiCall(path, {
		...opts,
		headers: { Authorization: `Bearer ${token}`, ...opts?.headers },
	}, env);
}

async function validatePagsToken(env: Env, token: string): Promise<boolean> {
	const res = await fetch(`${apiBase(env)}/v1/auth/me`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	return res.ok;
}

interface AgentSummary {
	id: string;
	slug: string;
	name: string;
	description?: string;
	category?: string;
}

async function ownsAgent(
	env: Env,
	token: string,
	agentId: string,
): Promise<boolean> {
	const data = (await authedCall("/v1/agents/my/agents", token, {}, env)) as {
		agents?: AgentSummary[];
		error?: string;
	};
	if (data.error) return false;
	return (data.agents || []).some(
		(a) => a.id === agentId || a.slug === agentId,
	);
}

function repoNameFor(agentId: string): string {
	return agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function b64(textValue: string): string {
	const bytes = new TextEncoder().encode(textValue);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function fromB64(value: string): string {
	const binary = atob(value.replace(/\n/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

async function github(
	env: Env,
	path: string,
	opts?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
	if (!env.GITHUB_TOKEN) {
		return {
			ok: false,
			status: 0,
			data: { error: "GITHUB_TOKEN is not configured on the MCP worker" },
			text: "GITHUB_TOKEN is not configured on the MCP worker",
		};
	}
	const res = await fetch(`https://api.github.com${path}`, {
		...opts,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"Content-Type": "application/json",
			"User-Agent": "proagentstore-mcp",
			...opts?.headers,
		},
	});
	const raw = await res.text();
	let data: unknown = {};
	try {
		data = raw ? JSON.parse(raw) : {};
	} catch {
		data = { raw };
	}
	return { ok: res.ok, status: res.status, data, text: raw };
}

async function repoExists(env: Env, org: string, repo: string): Promise<boolean> {
	const res = await github(env, `/repos/${org}/${repo}`);
	return res.ok;
}

async function createRepo(
	env: Env,
	org: string,
	repo: string,
	description: string,
): Promise<string> {
	const res = await github(env, `/orgs/${org}/repos`, {
		method: "POST",
		body: JSON.stringify({
			name: repo,
			description,
			private: false,
			auto_init: false,
		}),
	});
	if (res.ok) return "+ GitHub repo created";
	if (res.status === 422 && (await repoExists(env, org, repo))) {
		return "~ GitHub repo already exists";
	}
	return `! GitHub repo create failed: ${res.text}`;
}

async function getRepoFile(
	env: Env,
	org: string,
	repo: string,
	path: string,
): Promise<{ content?: string; sha?: string; error?: string; status?: number }> {
	const res = await github(
		env,
		`/repos/${org}/${repo}/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}`,
	);
	if (!res.ok) return { error: res.text, status: res.status };
	const data = res.data as { content?: string; sha?: string; type?: string };
	if (data.type !== "file" || data.content === undefined) {
		return { error: `${path} is not a file`, status: 400 };
	}
	return { content: fromB64(data.content), sha: data.sha };
}

async function putRepoFile(
	env: Env,
	org: string,
	repo: string,
	path: string,
	content: string,
	message?: string,
): Promise<string> {
	const existing = await getRepoFile(env, org, repo, path);
	const res = await github(
		env,
		`/repos/${org}/${repo}/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}`,
		{
			method: "PUT",
			body: JSON.stringify({
				message: message || `${existing.sha ? "update" : "create"}: ${path}`,
				content: b64(content),
				sha: existing.sha,
			}),
		},
	);
	if (!res.ok) return `! ${path}: ${res.text}`;
	return `${existing.sha ? "+" : "+"} ${existing.sha ? "Updated" : "Created"} ${path}`;
}

async function listRepoFiles(
	env: Env,
	org: string,
	repo: string,
	path?: string,
): Promise<string> {
	const suffix = path
		? `/${encodeURIComponent(path).replaceAll("%2F", "/")}`
		: "";
	const res = await github(env, `/repos/${org}/${repo}/contents${suffix}`);
	if (!res.ok) return `Error listing files: ${res.text}`;
	const rows = Array.isArray(res.data) ? res.data : [res.data];
	return rows
		.map((row) => {
			const f = row as { path?: string; type?: string; size?: number };
			return `${f.type === "dir" ? "d" : "f"} ${f.path}${f.size ? ` (${f.size}B)` : ""}`;
		})
		.join("\n");
}

function agentTemplateFiles(config: {
	slug: string;
	name: string;
	description: string;
	category: string;
	model: string;
	template: "worker" | "cron" | "api";
}): Map<string, string> {
	const { slug, name, description, category, model, template } = config;
	const storeType =
		template === "api" ? "tool" : template === "cron" ? "worker" : "agent";
	const files = new Map<string, string>();
	files.set(
		"agent.json",
		`${JSON.stringify(
			{
				id: slug,
				name,
				description,
				storeType,
				category,
				model,
				template,
				serverConfig: {
					durableObject: template === "worker",
					cron: template === "cron" ? "0 8 * * *" : undefined,
					routes: [`${slug}.proagentstore.online/*`],
					aiBilling: "caller-provided",
				},
			},
			null,
			2,
		)}\n`,
	);
	files.set(
		"package.json",
		`${JSON.stringify(
			{
				name: `@proagentstore/${slug}`,
				version: "0.0.1",
				private: true,
				type: "module",
				packageManager: "pnpm@10.30.3",
				scripts: {
					dev: "wrangler dev",
					deploy: "wrangler deploy",
					typecheck: "tsc --noEmit",
				},
				dependencies: { hono: "^4.7.0" },
				devDependencies: {
					"@cloudflare/workers-types": "^4.20250530.0",
					typescript: "^5.7.0",
					wrangler: "^4.0.0",
				},
			},
			null,
			2,
		)}\n`,
	);
	const wrangler = [
		`name = "proagentstore-${slug}"`,
		'main = "src/index.ts"',
		'compatibility_date = "2026-01-01"',
		'compatibility_flags = ["nodejs_compat"]',
		"",
		"[[routes]]",
		`pattern = "${slug}.proagentstore.online/*"`,
		'zone_name = "proagentstore.online"',
	];
	if (template === "worker") {
		wrangler.push(
			"",
			"[[durable_objects.bindings]]",
			'name = "AGENT"',
			'class_name = "GeneratedAgentDO"',
			"",
			"[[migrations]]",
			'tag = "v1"',
			'new_classes = ["GeneratedAgentDO"]',
		);
	}
	if (template === "cron") wrangler.push("", "[triggers]", 'crons = ["0 8 * * *"]');
	files.set("wrangler.toml", `${wrangler.join("\n")}\n`);
	files.set(
		"tsconfig.json",
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "ESNext",
					module: "ESNext",
					moduleResolution: "bundler",
					lib: ["ESNext"],
					types: ["@cloudflare/workers-types"],
					strict: true,
					skipLibCheck: true,
					outDir: "dist",
					rootDir: "src",
				},
				include: ["src"],
				exclude: ["src/**/*.test.ts"],
			},
			null,
			2,
		)}\n`,
	);
	if (template === "cron") {
		files.set(
			"src/index.ts",
			`export default {\n\tasync scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {\n\t\tconsole.log("${slug} cron fired:", event.cron);\n\t},\n\tasync fetch() {\n\t\treturn new Response("${slug} cron worker", { status: 200 });\n\t},\n};\n\ninterface Env {}\n`,
		);
	} else if (template === "api") {
		files.set(
			"src/index.ts",
			`import { Hono } from "hono";\n\ninterface Env {}\n\nconst app = new Hono<{ Bindings: Env }>();\n\napp.post("/run", async (c) => {\n\tconst { input } = await c.req.json<{ input: unknown }>();\n\treturn c.json({ result: input });\n});\n\nexport default app;\n`,
		);
	} else {
		files.set(
			"src/index.ts",
			`import { Hono } from "hono";\n\ninterface Env {}\n\nconst MODEL = "${model}";\n\nconst app = new Hono<{ Bindings: Env }>();\n\napp.get("/", (c) => c.json({\n\tagent: "${slug}",\n\tstatus: "ok",\n\taiBilling: "caller-provided",\n\trequiredHeaders: ["X-CF-Account-ID", "X-CF-AI-Token"],\n}));\n\napp.post("/chat", async (c) => {\n\tconst credentials = callerAiCredentials(c.req.raw);\n\tif (!credentials) {\n\t\treturn c.json({\n\t\t\terror: "caller_ai_credentials_required",\n\t\t\tmessage: "Pass your own Cloudflare Workers AI credentials with X-CF-Account-ID and X-CF-AI-Token. The platform will not spend its Workers AI account for this agent.",\n\t\t}, 402);\n\t}\n\tconst { message } = await c.req.json<{ message: string }>();\n\tconst result = await runCallerWorkersAi(credentials, {\n\t\tmessages: [\n\t\t\t{ role: "system", content: "You are ${name}. ${description}" },\n\t\t\t{ role: "user", content: message },\n\t\t],\n\t});\n\treturn c.json(result);\n});\n\nfunction callerAiCredentials(request: Request): { accountId: string; token: string } | null {\n\tconst accountId = request.headers.get("X-CF-Account-ID")?.trim();\n\tconst token = request.headers.get("X-CF-AI-Token")?.trim();\n\tif (!accountId || !token) return null;\n\treturn { accountId, token };\n}\n\nasync function runCallerWorkersAi(credentials: { accountId: string; token: string }, body: unknown): Promise<unknown> {\n\tconst encodedModel = MODEL.split("/").map(encodeURIComponent).join("/");\n\tconst res = await fetch("https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(credentials.accountId) + "/ai/run/" + encodedModel, {\n\t\tmethod: "POST",\n\t\theaders: {\n\t\t\t"Authorization": "Bearer " + credentials.token,\n\t\t\t"Content-Type": "application/json",\n\t\t},\n\t\tbody: JSON.stringify(body),\n\t});\n\tconst data = await res.json().catch(() => ({}));\n\tif (!res.ok) return { error: "caller_workers_ai_failed", status: res.status, details: data };\n\tif (data && typeof data === "object" && "result" in data) return (data as { result: unknown }).result;\n\treturn data;\n}\n\nexport class GeneratedAgentDO {\n\tconstructor(private state: DurableObjectState, private env: Env) {}\n\n\tasync fetch(request: Request): Promise<Response> {\n\t\treturn app.fetch(request, this.env);\n\t}\n}\n\nexport default app;\n`,
		);
	}
	files.set(
		"README.md",
		`# ${name}\n\n${description || `A ProAgentStore ${template} agent.`}\n\n## AI billing\n\nThis generated agent does not use the ProAgentStore Cloudflare Workers AI binding by default. AI calls require caller-provided Cloudflare Workers AI credentials:\n\n- \`X-CF-Account-ID\`\n- \`X-CF-AI-Token\`\n\nThat makes inference spend bill to the caller's Cloudflare account, not the ProAgentStore platform account.\n\n## Development\n\n\`\`\`bash\npnpm install\npnpm dev\n\`\`\`\n\n## Deploy\n\n\`\`\`bash\npnpm deploy\n\`\`\`\n`,
	);
	files.set("LICENSE", "MIT License\n");
	files.set(".gitignore", "node_modules/\ndist/\n.wrangler/\n");
	files.set(
		".github/workflows/deploy.yml",
		`name: Deploy\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: pnpm/action-setup@v4\n        with:\n          version: 10.30.3\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: pnpm install --no-frozen-lockfile\n      - run: pnpm typecheck\n      - uses: cloudflare/wrangler-action@v3\n        with:\n          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}\n          command: deploy\n`,
	);
	return files;
}

async function deployStatus(
	env: Env,
	org: string,
	repo: string,
): Promise<string> {
	const res = await github(
		env,
		`/repos/${org}/${repo}/actions/runs?per_page=5`,
	);
	if (!res.ok) return `Error: ${res.text}`;
	const data = res.data as {
		workflow_runs?: Array<{
			name: string;
			conclusion: string | null;
			status: string;
			updated_at: string;
			html_url: string;
			head_sha: string;
		}>;
	};
	const runs = data.workflow_runs || [];
	if (runs.length === 0) return `No workflow runs found for ${repo}.`;
	return runs
		.map((r) => {
			const status = r.conclusion || r.status;
			return `- ${status} ${r.name} (${r.head_sha?.slice(0, 7)}) — ${r.updated_at}\n  ${r.html_url}`;
		})
		.join("\n");
}

async function triggerDeploy(
	env: Env,
	org: string,
	repo: string,
): Promise<string> {
	const res = await github(
		env,
		`/repos/${org}/${repo}/actions/workflows/deploy.yml/dispatches`,
		{
			method: "POST",
			body: JSON.stringify({ ref: "main" }),
		},
	);
	if (res.status === 204) {
		return `Deploy triggered for ${repo}.\n${await deployStatus(env, org, repo)}`;
	}
	const status = await deployStatus(env, org, repo);
	if (res.status === 404 && !status.startsWith("No workflow runs found")) {
		return `Deploy workflow is still indexing or already queued for ${repo}.\n${status}`;
	}
	return `Deploy trigger failed for ${repo}: ${res.text}`;
}

export class PagsMcp extends McpAgent<Env, unknown, Props> {
	server = new McpServer({ name: "ProAgentStore", version: "0.1.0" });
	private userToken: string | null = null;

	private token(provided?: string): string | null {
		return provided || this.userToken;
	}

	async init() {
		this.userToken =
			((this.props as { authToken?: string } | undefined)?.authToken as string | undefined) ||
			null;

		this.server.tool(
			"list_agents",
			"List all published agents on ProAgentStore",
			{},
			async () => {
				const data = (await apiCall("/v1/agents", {}, this.env)) as { agents: unknown[] };
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(data.agents, null, 2),
						},
					],
				};
			},
		);

		this.server.tool(
			"agent_info",
			"Get detailed info about an agent",
			{ agent_id: z.string().describe("Agent ID or slug") },
			async ({ agent_id }) => {
				const data = await apiCall(`/v1/public/agents/${agent_id}`, {}, this.env);
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(data, null, 2) },
					],
				};
			},
		);

		this.server.tool(
			"chat_with_agent",
			"Send a message to a published agent (trial mode)",
			{
				agent_id: z.string(),
				message: z.string(),
				session_id: z.string().optional(),
			},
			async ({ agent_id, message, session_id }) => {
				const data = (await apiCall(`/v1/public/agents/${agent_id}/try`, {
					method: "POST",
					body: JSON.stringify({ message, sessionId: session_id }),
				}, this.env)) as {
					message?: { content: string };
					sessionId?: string;
					error?: string;
				};
				return {
					content: [
						{
							type: "text" as const,
							text: `${data.message?.content || data.error || "No response"}\n\nSession: ${data.sessionId || "none"}`,
						},
					],
				};
			},
		);

		this.server.tool(
			"my_agents",
			"List agents owned by the authenticated ProAgentStore creator.",
			{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in.") },
			async ({ token }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const data = (await authedCall(
					"/v1/agents/my/agents",
					sessionToken,
					{},
					this.env,
				)) as { agents?: AgentSummary[]; error?: string };
				if (data.error) return text(`Error: ${data.error}`);
				const agents = data.agents || [];
				if (agents.length === 0) return text("No owned agents yet.");
				return text(JSON.stringify(agents, null, 2));
			},
		);

		this.server.tool(
			"create_agent",
			"Create a new agent on ProAgentStore",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				slug: AGENT_ID,
				name: z.string(),
				description: z.string().optional(),
				category: z.string().optional(),
				model: z.string().optional(),
				personality: z.string().optional(),
				goal: z.string().optional(),
			},
			async ({
				token,
				slug,
				name,
				description,
				category,
				model,
				personality,
				goal,
			}) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const data = (await authedCall("/v1/agents", sessionToken, {
					method: "POST",
					body: JSON.stringify({
						slug,
						name,
						description,
						category,
						model,
						personality,
						goal,
					}),
				}, this.env)) as { id?: string; error?: string };
				return {
					content: [
						{
							type: "text" as const,
							text: data.id
								? `Created: ${data.id}\nhttps://proagentstore.online/agents/${slug}/`
								: `Error: ${data.error}`,
						},
					],
				};
			},
		);

		this.server.tool(
			"scaffold_agent",
			"Create a ProAgentStore agent and scaffold its GitHub repo from a starter template. Requires PAGS token plus GITHUB_TOKEN configured on the MCP worker.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				slug: AGENT_ID,
				name: z.string(),
				description: z.string(),
				category: z.string().optional(),
				model: z.string().optional(),
				template: z.enum(["worker", "cron", "api"]).optional(),
				personality: z.string().optional(),
				goal: z.string().optional(),
				auto_deploy: z.boolean().optional().describe("Trigger the deploy workflow after scaffolding. Defaults to true."),
			},
			async ({
				token,
				slug,
				name,
				description,
				category,
				model,
				template,
				personality,
				goal,
				auto_deploy,
			}) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const repo = repoNameFor(slug);
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				const selectedTemplate = template || "worker";
				const selectedModel = model || "@cf/meta/llama-3.2-3b-instruct";
				const created = (await authedCall("/v1/agents", sessionToken, {
					method: "POST",
					body: JSON.stringify({
						slug,
						name,
						description,
						category,
						model: selectedModel,
						personality,
						goal,
					}),
				}, this.env)) as { id?: string; error?: string };
				if (!created.id) return text(`Agent create failed: ${created.error || "unknown error"}`);

				const steps: string[] = [`+ Agent registered: ${created.id}`];
				steps.push(await createRepo(this.env, org, repo, description));
				if (!this.env.GITHUB_TOKEN) {
					steps.push("! Repo scaffold skipped: GITHUB_TOKEN is not configured");
				} else {
					const files = agentTemplateFiles({
						slug,
						name,
						description,
						category: category || "general",
						model: selectedModel,
						template: selectedTemplate,
					});
					for (const [path, content] of files) {
						steps.push(
							await putRepoFile(
								this.env,
								org,
								repo,
								path,
								content,
								`scaffold ${slug} via MCP`,
							),
						);
					}
					if (auto_deploy !== false) {
						steps.push(await triggerDeploy(this.env, org, repo));
					} else {
						steps.push("~ Auto deploy skipped by request");
					}
				}

				return text(
					[
						`Scaffolded **${name}** (${slug})`,
						`Store: https://proagentstore.online/agents/${slug}/`,
						`Repo: https://github.com/${org}/${repo}`,
						`Worker: https://${slug}.proagentstore.online`,
						"",
						...steps,
					].join("\n"),
				);
			},
		);

		this.server.tool(
			"update_agent",
			"Update an agent's settings",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string(),
				name: z.string().optional(),
				description: z.string().optional(),
				visibility: z.string().optional(),
				model: z.string().optional(),
			},
			async ({ token, agent_id, ...updates }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const body: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(updates)) {
					if (v) body[k] = v;
				}
				const data = (await authedCall(`/v1/agents/${agent_id}`, sessionToken, {
					method: "PUT",
					body: JSON.stringify(body),
				}, this.env)) as { success?: boolean; error?: string };
				return {
					content: [
						{
							type: "text" as const,
							text: data.success ? "Updated" : `Error: ${data.error}`,
						},
					],
				};
			},
		);

		this.server.tool(
			"list_agent_files",
			"List files in an owned agent's GitHub repo.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string().describe("Agent ID or slug"),
				path: z.string().optional(),
			},
			async ({ token, agent_id, path }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				if (!(await ownsAgent(this.env, sessionToken, agent_id))) {
					return text(`Error: you do not own agent "${agent_id}" or it does not exist.`);
				}
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				return text(await listRepoFiles(this.env, org, repoNameFor(agent_id), path));
			},
		);

		this.server.tool(
			"read_agent_file",
			"Read a file from an owned agent's GitHub repo.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string().describe("Agent ID or slug"),
				path: z.string().describe("File path relative to repo root"),
			},
			async ({ token, agent_id, path }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				if (!(await ownsAgent(this.env, sessionToken, agent_id))) {
					return text(`Error: you do not own agent "${agent_id}" or it does not exist.`);
				}
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				const file = await getRepoFile(this.env, org, repoNameFor(agent_id), path);
				if (file.error) return text(`Error reading ${path}: ${file.error}`);
				return text(file.content || "");
			},
		);

		this.server.tool(
			"write_agent_file",
			"Create or overwrite a file in an owned agent's GitHub repo.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string().describe("Agent ID or slug"),
				path: z.string().describe("File path relative to repo root"),
				content: z.string().describe("Full file content"),
				message: z.string().optional().describe("Commit message"),
			},
			async ({ token, agent_id, path, content, message }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				if (!(await ownsAgent(this.env, sessionToken, agent_id))) {
					return text(`Error: you do not own agent "${agent_id}" or it does not exist.`);
				}
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				return text(
					await putRepoFile(
						this.env,
						org,
						repoNameFor(agent_id),
						path,
						content,
						message,
					),
				);
			},
		);

		this.server.tool(
			"batch_write_agent_files",
			"Create or overwrite multiple files in an owned agent's GitHub repo.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string().describe("Agent ID or slug"),
				files: z.array(
					z.object({
						path: z.string(),
						content: z.string(),
					}),
				),
				message: z.string().optional().describe("Commit message"),
			},
			async ({ token, agent_id, files, message }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				if (!(await ownsAgent(this.env, sessionToken, agent_id))) {
					return text(`Error: you do not own agent "${agent_id}" or it does not exist.`);
				}
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				const lines: string[] = [];
				for (const file of files) {
					lines.push(
						await putRepoFile(
							this.env,
							org,
							repoNameFor(agent_id),
							file.path,
							file.content,
							message,
						),
					);
				}
				return text(lines.join("\n"));
			},
		);

		this.server.tool(
			"agent_deploy_status",
			"Check the latest GitHub Actions deploy runs for an agent repo.",
			{ agent_id: z.string().describe("Agent ID or slug") },
			async ({ agent_id }) => {
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				return text(await deployStatus(this.env, org, repoNameFor(agent_id)));
			},
		);

		this.server.tool(
			"trigger_agent_deploy",
			"Trigger the GitHub Actions deploy workflow for an owned agent repo.",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string().describe("Agent ID or slug"),
			},
			async ({ token, agent_id }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				if (!(await ownsAgent(this.env, sessionToken, agent_id))) {
					return text(`Error: you do not own agent "${agent_id}" or it does not exist.`);
				}
				const org = this.env.GITHUB_ORG || "ProAgentStore";
				return text(await triggerDeploy(this.env, org, repoNameFor(agent_id)));
			},
		);

		this.server.tool(
			"add_knowledge",
			"Add a document to an agent's knowledge base",
			{
				token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."),
				agent_id: z.string(),
				title: z.string(),
				content: z.string(),
				source: z.string().optional(),
			},
			async ({ token, agent_id, title, content, source }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const data = (await authedCall(
					`/v1/agents/${agent_id}/knowledge`,
					sessionToken,
					{
						method: "POST",
						body: JSON.stringify({ title, content, source: source || "paste" }),
					},
					this.env,
				)) as { id?: string; error?: string };
				return {
					content: [
						{
							type: "text" as const,
							text: data.id ? `Added: ${title}` : `Error: ${data.error}`,
						},
					],
				};
			},
		);

		this.server.tool(
			"list_knowledge",
			"List documents in an agent's knowledge base",
			{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."), agent_id: z.string() },
			async ({ token, agent_id }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const data = (await authedCall(
					`/v1/agents/${agent_id}/knowledge`,
					sessionToken,
					{},
					this.env,
				)) as { documents?: unknown[] };
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(data.documents || [], null, 2),
						},
					],
				};
			},
		);

		this.server.tool(
			"agent_analytics",
			"Get usage analytics for an agent",
			{ token: z.string().optional().describe("PAGS session token. Omit when connected with browser sign-in."), agent_id: z.string() },
			async ({ token, agent_id }) => {
				const sessionToken = this.token(token);
				if (!sessionToken) return text("Error: authentication required. Connect with browser sign-in or pass a PAGS session token.");
				const data = await authedCall(
					`/v1/agents/${agent_id}/analytics`,
					sessionToken,
					{},
					this.env,
				);
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(data, null, 2) },
					],
				};
			},
		);

		this.server.tool(
			"platform_guide",
			"Get ProAgentStore platform guide",
			{},
			async () => {
				return { content: [{ type: "text" as const, text: PLATFORM_GUIDE }] };
			},
		);

		this.server.tool(
			"sdk_reference",
			"Get ProAgentStore SDK usage examples",
			{},
			async () => {
				return { content: [{ type: "text" as const, text: SDK_REFERENCE }] };
			},
		);
	}
}

const PLATFORM_GUIDE = `# ProAgentStore Platform Guide

Marketplace for server-powered AI agents. Creators build agent templates, clients subscribe and run them on their own data.

## Agent Types: Agents | Workers | Tools
## CLI: pags init <name> --template worker|cron|api, pags check, pags publish
## MCP project tools: scaffold_agent, list_agent_files, read_agent_file, write_agent_file, batch_write_agent_files, trigger_agent_deploy, agent_deploy_status
## URLs: Store proagentstore.online, API api.proagentstore.online, MCP mcp.proagentstore.online/mcp
## Key endpoints: GET /v1/agents, POST /v1/public/agents/:id/try, POST /v1/instances/:id/subscribe`;

const SDK_REFERENCE = `# SDK: import { initPro } from '@proagentstore/sdk'
const agent = initPro({ agentId: '...', token: '...' })
await agent.chat('Hello!')
await agent.memory.set('key', 'type', 'content')
await agent.tasks.create('title', 'description')
# Widget: <script src="https://proagentstore.online/widget.js" data-agent="slug"></script>
# Webhook: POST /v1/public/webhook/INSTANCE_ID/ingest with {title, content}`;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		const issuer = `${url.protocol}//${url.host}`;

		if (env.OAUTH_KV && env.SESSION_SIGNING_KEY) {
			const oauthRes = await handleOAuthRoute(request, {
				issuer,
				authStart: env.AUTH_START || "https://api.freeappstore.online/v1/auth/github/start",
				apiBase: apiBase(env),
				kv: env.OAUTH_KV,
				sessionSigningKey: env.SESSION_SIGNING_KEY,
			});
			if (oauthRes) return oauthRes;
		}

		const isMcpTransport = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");
		if (isMcpTransport) {
			let bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
			if (bearer && env.OAUTH_KV) {
				const session = await resolveOAuthToken(bearer, env.OAUTH_KV);
				if (session) bearer = session;
			}
			const validUser = bearer ? await validatePagsToken(env, bearer) : false;

			if (
				request.method !== "OPTIONS" &&
				env.OAUTH_KV &&
				env.SESSION_SIGNING_KEY &&
				!validUser
			) {
				return createAuthChallenge({ issuer }, bearer ? "invalid_token" : undefined);
			}

			if (bearer && validUser) {
				(ctx as unknown as { props?: Record<string, unknown> }).props = {
					...((ctx as unknown as { props?: Record<string, unknown> }).props ?? {}),
					authToken: bearer,
				};
			}
			return PagsMcp.serve("/mcp").fetch(request, env, ctx);
		}
		if (url.pathname === "/health") {
			return new Response(
				JSON.stringify({ ok: true, service: "proagentstore-mcp", tools: 17 }),
				{ headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://proagentstore.online" } },
			);
		}
		return new Response(
			"ProAgentStore MCP Server\n\nConnect: npx mcp-remote https://mcp.proagentstore.online/mcp\n\nTools include: list_agents, my_agents, scaffold_agent, create_agent, update_agent, list/read/write agent files, add/list knowledge, analytics, deploy status, platform guide, SDK reference.",
			{ headers: { "Content-Type": "text/plain" } },
		);
	},
};
