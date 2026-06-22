import { z } from "zod";
import { apiBase, authedCall, type McpEnv } from "./http.js";

type Env = McpEnv;

export const AGENT_ID = z
	.string()
	.regex(/^[a-z][a-z0-9-]*$/)
	.describe("Agent slug, lowercase with hyphens, e.g. 'job-apply-agent'");

export async function validatePagsToken(env: Env, token: string): Promise<boolean> {
	const res = await fetch(`${apiBase(env)}/v1/auth/me`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	return res.ok;
}

export interface AgentSummary {
	id: string;
	slug: string;
	name: string;
	description?: string;
	category?: string;
}

export async function ownsAgent(
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

export function repoNameFor(agentId: string): string {
	return agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export function b64(textValue: string): string {
	const bytes = new TextEncoder().encode(textValue);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function fromB64(value: string): string {
	const binary = atob(value.replace(/\n/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

export async function github(
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

export async function repoExists(env: Env, org: string, repo: string): Promise<boolean> {
	const res = await github(env, `/repos/${org}/${repo}`);
	return res.ok;
}

export async function createRepo(
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

export async function getRepoFile(
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

export async function putRepoFile(
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

export async function listRepoFiles(
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

export function agentTemplateFiles(config: {
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

export async function deployStatus(
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

export async function triggerDeploy(
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


