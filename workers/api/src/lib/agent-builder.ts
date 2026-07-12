import { HttpError } from "./auth.js";
import type { Env, SessionPayload } from "../types.js";

export type BuilderAction = "create_agent" | "scaffold_agent";
export type BuilderTemplate = "worker" | "cron" | "api";

export interface AgentBuilderConnector {
	provider: "google_drive" | "zoho_workdrive" | "gmail";
	reason: string;
	requiredGrant: "folder" | "shared_drive" | "mailbox";
}

export interface AgentBuilderPlan {
	intent: string;
	action: BuilderAction;
	agent: {
		slug: string;
		name: string;
		description: string;
		category: string;
		model: string;
		personality: string;
		goal: string;
	};
	template?: BuilderTemplate;
	runtime?: {
		kind: "hosted" | "browser" | "coder";
		reason: string;
	};
	connectors: AgentBuilderConnector[];
	suggestedSurfaces: string[];
	warnings: string[];
	dryRun: {
		endpoint: string;
		method: "POST";
		body: Record<string, unknown>;
	};
}

export interface AgentBuilderExecuteResult {
	agentId: string;
	slug: string;
	action: BuilderAction;
	repo?: {
		org: string;
		name: string;
		url: string;
		steps: string[];
	};
	connectors: AgentBuilderConnector[];
	nextSteps: string[];
}

const DEFAULT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const FAST_MODEL = "@cf/meta/llama-3.2-3b-instruct";
const CODER_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";

function hasAny(text: string, words: string[]): boolean {
	return words.some((word) => text.includes(word));
}

export function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/['"]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 56)
		.replace(/-+$/g, "");
	return /^[a-z]/.test(slug) ? slug : `agent-${slug || "draft"}`;
}

function nameFor(prompt: string, text: string): string {
	if (hasAny(text, ["contract", "clause", "legal"]) && hasAny(text, ["review", "risk", "summarize", "analyse", "analyze"])) {
		return "Contract Review Agent";
	}
	if (hasAny(text, ["job application", "apply to jobs", "resume", "cv"]) && hasAny(text, ["browser", "form", "apply"])) {
		return "Job Application Agent";
	}
	if (hasAny(text, ["api", "webhook", "endpoint", "integration"])) {
		return "API Integration Agent";
	}
	if (hasAny(text, ["github", "repo", "pull request", "code review"])) {
		return "Coding Agent";
	}

	const subject = prompt
		.trim()
		.replace(/^(please\s+)?(create|build|make|generate|scaffold|deploy)\s+/i, "")
		.replace(/^(an?\s+|the\s+)?(ai\s+)?(agent|assistant|bot|tool|app)\s+(that|to|for|with)\s+/i, "")
		.replace(/^that\s+/i, "");
	const stop = new Set(["a", "an", "and", "for", "from", "in", "my", "of", "on", "our", "that", "the", "to", "with"]);
	const words = slugify(subject)
		.split("-")
		.filter((word) => word && !stop.has(word))
		.slice(0, 4);
	if (words.length === 0) return "New Agent";
	const name = words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
	return /\b(agent|assistant|bot|tool|app)\b/i.test(name) ? name : `${name} Agent`;
}

function firstSentence(input: string): string {
	const clean = input.trim().replace(/\s+/g, " ");
	const sentence = clean.match(/^(.{20,180}?[.!?])\s/)?.[1] || clean.slice(0, 180);
	return sentence || "A ProAgentStore agent created from a guided prompt.";
}

function categoryFor(text: string): string {
	if (hasAny(text, ["code", "coding", "repo", "github", "pull request", "terminal"])) return "code";
	if (hasAny(text, ["document", "docs", "drive", "workdrive", "gmail", "email", "file"])) return "productivity";
	if (hasAny(text, ["data", "analytics", "report", "spreadsheet", "csv"])) return "data";
	if (hasAny(text, ["write", "creative", "copy", "story", "marketing"])) return "creative";
	return "general";
}

function connectorsFor(text: string): AgentBuilderConnector[] {
	const connectors: AgentBuilderConnector[] = [];
	if (hasAny(text, ["google doc", "google docs", "google drive", "drive folder", "shared drive"])) {
		connectors.push({
			provider: "google_drive",
			reason: "The prompt asks for Google Docs or Google Drive access.",
			requiredGrant: hasAny(text, ["shared drive"]) ? "shared_drive" : "folder",
		});
	}
	if (hasAny(text, ["zoho", "workdrive"])) {
		connectors.push({
			provider: "zoho_workdrive",
			reason: "The prompt asks for Zoho WorkDrive access.",
			requiredGrant: "folder",
		});
	}
	if (hasAny(text, ["gmail", "email", "inbox"])) {
		connectors.push({
			provider: "gmail",
			reason: "The prompt asks for email or Gmail access.",
			requiredGrant: "mailbox",
		});
	}
	return connectors;
}

export function planAgentFromPrompt(prompt: string): AgentBuilderPlan {
	const clean = prompt.trim();
	if (clean.length < 12) {
		throw new HttpError(400, "Describe the agent in at least a sentence.");
	}

	const text = clean.toLowerCase();
	const needsCode = hasAny(text, ["code", "coding", "repo", "github", "pull request", "terminal", "cli"]);
	const needsBrowser = hasAny(text, ["browser", "click", "form", "apply", "website", "login", "playwright"]);
	const needsApi = hasAny(text, ["api", "webhook", "endpoint", "integrate", "integration"]);
	const needsCron = hasAny(text, ["daily", "weekly", "schedule", "cron", "every morning", "recurring"]);
	const connectors = connectorsFor(text);
	const needsScaffold = needsCode || needsBrowser || needsApi || needsCron || hasAny(text, ["deploy", "worker", "custom"]);

	const name = nameFor(clean, text);
	const slug = slugify(name);
	const category = categoryFor(text);
	const template: BuilderTemplate | undefined = needsScaffold
		? needsCron
			? "cron"
			: needsApi
				? "api"
				: "worker"
		: undefined;
	const runtime = needsBrowser
		? { kind: "browser" as const, reason: "The prompt mentions browser/web interaction." }
		: needsCode
			? { kind: "coder" as const, reason: "The prompt mentions code, repos, terminal, or GitHub work." }
			: { kind: "hosted" as const, reason: "The prompt can run as a hosted chat/knowledge agent." };
	const model = needsCode ? CODER_MODEL : needsScaffold ? DEFAULT_MODEL : FAST_MODEL;
	const action: BuilderAction = needsScaffold ? "scaffold_agent" : "create_agent";
	const warnings: string[] = [];
	if (connectors.length > 0) {
		warnings.push("Connector access is not granted automatically. Connect the account and approve folder/mailbox grants after creation.");
	}
	if (runtime.kind === "browser" || runtime.kind === "coder") {
		warnings.push(`This plan creates the control-plane agent. ${runtime.kind === "browser" ? "Browser" : "Coder"} runtime work still requires a connected runner.`);
	}

	const agent = {
		slug,
		name,
		description: firstSentence(clean),
		category,
		model,
		personality: "Clear, careful, and explicit about assumptions.",
		goal: clean,
	};

	return {
		intent: clean,
		action,
		agent,
		template,
		runtime,
		connectors,
		suggestedSurfaces: runtime.kind === "hosted" ? ["chat", "knowledge", "settings"] : ["chat", "knowledge", "board", "settings"],
		warnings,
		dryRun: {
			endpoint: action === "create_agent" ? "/v1/agents" : "/v1/agent-builder/execute",
			method: "POST",
			body: action === "create_agent" ? agent : { agent, template, runtime, connectors },
		},
	};
}

async function createAgentRecord(env: Env, session: SessionPayload, plan: AgentBuilderPlan): Promise<string> {
	const existing = await env.DB.prepare("SELECT id FROM agents WHERE slug = ?1")
		.bind(plan.agent.slug)
		.first<{ id: string }>();
	if (existing) throw new HttpError(409, "Agent slug already taken");

	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO agents (id, owner_id, slug, name, description, category, icon, icon_bg, model, visibility, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'draft', 'inactive', datetime('now'), datetime('now'))`,
	)
		.bind(
			id,
			session.uid,
			plan.agent.slug,
			plan.agent.name,
			plan.agent.description,
			plan.agent.category,
			"",
			"#7c3aed",
			plan.agent.model,
		)
		.run();

	const doId = env.AGENT.idFromName(id);
	const stub = env.AGENT.get(doId);
	await stub.fetch(
		new Request("https://agent/init", {
			method: "POST",
			body: JSON.stringify({
				agentId: id,
				name: plan.agent.name,
				personality: plan.agent.personality,
				goal: plan.agent.goal,
				model: plan.agent.model,
			}),
		}),
	);

	return id;
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

async function github(env: Env, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; text: string }> {
	if (!env.GITHUB_TOKEN) {
		return { ok: false, status: 0, text: "GITHUB_TOKEN is not configured" };
	}
	const res = await fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"Content-Type": "application/json",
			"User-Agent": "proagentstore-api",
			...(init.headers || {}),
		},
	});
	return { ok: res.ok, status: res.status, text: await res.text() };
}

function scaffoldFiles(plan: AgentBuilderPlan): Map<string, string> {
	const template = plan.template || "worker";
	const { slug, name, description, category, model } = plan.agent;
	const files = new Map<string, string>();
	files.set("agent.json", `${JSON.stringify({ id: slug, name, description, storeType: template === "api" ? "tool" : "agent", category, model, template, suggestedSurfaces: plan.suggestedSurfaces, runtime: plan.runtime }, null, 2)}\n`);
	files.set("README.md", `# ${name}\n\n${description}\n\n## Goal\n\n${plan.agent.goal}\n`);
	files.set("package.json", `${JSON.stringify({ name: `@proagentstore/${slug}`, version: "0.0.1", private: true, type: "module", packageManager: "pnpm@10.30.3", scripts: { dev: "wrangler dev", deploy: "wrangler deploy", typecheck: "tsc --noEmit" }, dependencies: { hono: "^4.7.0" }, devDependencies: { "@cloudflare/workers-types": "^4.20250530.0", typescript: "^5.7.0", wrangler: "^4.0.0" } }, null, 2)}\n`);
	files.set("tsconfig.json", `${JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", lib: ["ESNext"], types: ["@cloudflare/workers-types"], strict: true, skipLibCheck: true }, include: ["src"] }, null, 2)}\n`);
	files.set("wrangler.toml", `name = "proagentstore-${slug}"\nmain = "src/index.ts"\ncompatibility_date = "2026-01-01"\ncompatibility_flags = ["nodejs_compat"]\n\n[[routes]]\npattern = "${slug}.proagentstore.online/*"\nzone_name = "proagentstore.online"\n`);
	files.set(".gitignore", "node_modules/\ndist/\n.wrangler/\n");
	files.set(".github/workflows/deploy.yml", `name: Deploy\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: pnpm/action-setup@v4\n        with:\n          version: 10.30.3\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: pnpm install --no-frozen-lockfile\n      - run: pnpm typecheck\n      - uses: cloudflare/wrangler-action@v3\n        with:\n          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}\n          command: deploy\n`);
	if (template === "cron") {
		files.set("src/index.ts", `export default {\n\tasync scheduled(event: ScheduledEvent) {\n\t\tconsole.log("${slug} cron fired", event.cron);\n\t},\n\tasync fetch() {\n\t\treturn Response.json({ agent: "${slug}", status: "ok" });\n\t},\n};\n`);
	} else if (template === "api") {
		files.set("src/index.ts", `import { Hono } from "hono";\n\nconst app = new Hono();\n\napp.post("/run", async (c) => {\n\tconst body = await c.req.json().catch(() => ({}));\n\treturn c.json({ ok: true, input: body });\n});\n\nexport default app;\n`);
	} else {
		files.set("src/index.ts", `import { Hono } from "hono";\n\nconst app = new Hono();\n\napp.get("/", (c) => c.json({ agent: "${slug}", status: "ok" }));\napp.post("/chat", async (c) => {\n\tconst { message } = await c.req.json<{ message?: string }>().catch(() => ({}));\n\treturn c.json({ response: "TODO: implement ${name} runtime.", echo: message || "" });\n});\n\nexport default app;\n`);
	}
	return files;
}

async function scaffoldRepo(env: Env, plan: AgentBuilderPlan): Promise<AgentBuilderExecuteResult["repo"]> {
	const org = env.GITHUB_ORG || "ProAgentStore";
	const name = plan.agent.slug;
	const url = `https://github.com/${org}/${name}`;
	const steps: string[] = [];
	if (!env.GITHUB_TOKEN) {
		return { org, name, url, steps: ["Repo scaffold skipped: GITHUB_TOKEN is not configured on the API worker."] };
	}

	const repo = await github(env, `/orgs/${org}/repos`, {
		method: "POST",
		body: JSON.stringify({ name, description: plan.agent.description.slice(0, 350), private: false, auto_init: false }),
	});
	if (repo.ok) steps.push("GitHub repo created");
	else if (repo.status === 422) steps.push("GitHub repo may already exist; continuing with file writes");
	else steps.push(`GitHub repo create failed: ${repo.text}`);

	for (const [path, content] of scaffoldFiles(plan)) {
		const res = await github(env, `/repos/${org}/${name}/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}`, {
			method: "PUT",
			body: JSON.stringify({ message: `scaffold ${plan.agent.slug} via Agent Builder`, content: b64(content) }),
		});
		steps.push(res.ok ? `Created ${path}` : `Failed ${path}: ${res.text}`);
	}

	return { org, name, url, steps };
}

export async function executeAgentBuilderPlan(env: Env, session: SessionPayload, plan: AgentBuilderPlan): Promise<AgentBuilderExecuteResult> {
	const agentId = await createAgentRecord(env, session, plan);
	const repo = plan.action === "scaffold_agent" ? await scaffoldRepo(env, plan) : undefined;
	const nextSteps = [
		"Review the draft agent settings.",
		...plan.connectors.map((connector) => `Connect ${connector.provider} and grant the required ${connector.requiredGrant}.`),
		...(plan.runtime?.kind === "browser" || plan.runtime?.kind === "coder" ? ["Start a local runner with `pags up` before runtime tasks."] : []),
		...(repo ? [`Review repo scaffold: ${repo.url}`] : []),
	];
	return { agentId, slug: plan.agent.slug, action: plan.action, repo, connectors: plan.connectors, nextSteps };
}
