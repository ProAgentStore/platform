import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { writeError, writeLine } from "../output.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEMPLATES = ["worker", "cron", "api"] as const;
type TemplateType = (typeof TEMPLATES)[number];

const TEMPLATE_DESC: Record<TemplateType, string> = {
	worker: "Durable Object agent with memory, conversation, and tools",
	cron: "Scheduled worker for daily digests, monitoring, batch processing",
	api: "Stateless API endpoint for transform, generate, or analyze",
};

export const initCommand = new Command("init")
	.description("Scaffold a new ProAgentStore agent")
	.argument("<name>", "Agent name (lowercase, hyphens)")
	.option(
		"-t, --template <type>",
		`Template: ${TEMPLATES.join(", ")}`,
		"worker",
	)
	.action((name: string, opts: { template: string }) => {
		const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
		const template = opts.template as TemplateType;

		if (!TEMPLATES.includes(template)) {
			writeError(
				`Unknown template: ${template}. Choose: ${TEMPLATES.join(", ")}`,
			);
			process.exit(1);
		}

		const dir = resolve(slug);
		if (existsSync(dir)) {
			writeError(`Directory ${slug} already exists`);
			process.exit(1);
		}

		// Try to copy from templates directory (only if it has files)
		const templateDir = resolve(
			__dirname,
			"..",
			"..",
			"..",
			"..",
			"templates",
			`template-agent-${template}`,
		);
		const templateHasFiles = existsSync(join(templateDir, "agent.json"));
		if (templateHasFiles) {
			cpSync(templateDir, dir, { recursive: true });
			writeLine(`Copied template: template-agent-${template}`);
		} else {
			// Generate minimal scaffold
			mkdirSync(dir, { recursive: true });
			mkdirSync(join(dir, "src"));
			mkdirSync(join(dir, "migrations"));
			mkdirSync(join(dir, ".github", "workflows"), { recursive: true });

			// agent.json manifest
			writeFileSync(
				join(dir, "agent.json"),
				`${JSON.stringify(
					{
						id: slug,
						name: name,
						description: "",
						storeType:
							template === "api"
								? "tool"
								: template === "cron"
									? "worker"
									: "agent",
						category: "general",
						model: "@cf/meta/llama-3.2-3b-instruct",
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

			// package.json
			writeFileSync(
				join(dir, "package.json"),
				`${JSON.stringify(
					{
						name: `@proagentstore/${slug}`,
						version: "0.0.1",
						private: true,
						type: "module",
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

			// wrangler.toml
			const wranglerLines = [
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
				wranglerLines.push(
					"",
					"[[durable_objects.bindings]]",
					'name = "AGENT"',
					'class_name = "AgentDO"',
				);
				wranglerLines.push(
					"",
					"[[migrations]]",
					'tag = "v1"',
					'new_classes = ["AgentDO"]',
				);
			}
			if (template === "cron") {
				wranglerLines.push("", "[triggers]", 'crons = ["0 8 * * *"]');
			}
			writeFileSync(
				join(dir, "wrangler.toml"),
				`${wranglerLines.join("\n")}\n`,
			);

			// tsconfig
			writeFileSync(
				join(dir, "tsconfig.json"),
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

			// Entry point
			if (template === "worker") {
				writeFileSync(
					join(dir, "src", "index.ts"),
					`import { Hono } from 'hono';\n\nconst app = new Hono();\n\napp.get('/', (c) => c.json({ agent: '${slug}', status: 'ok' }));\n\nexport default app;\n`,
				);
			} else if (template === "cron") {
				writeFileSync(
					join(dir, "src", "index.ts"),
					`export default {\n  async scheduled(event: ScheduledEvent, env: unknown, ctx: ExecutionContext) {\n    // Your scheduled logic here. Access event.cron if you need the trigger expression.\n  },\n  async fetch() {\n    return new Response('${slug} cron worker', { status: 200 });\n  },\n};\n`,
				);
			} else {
				writeFileSync(
					join(dir, "src", "index.ts"),
					`import { Hono } from 'hono';\n\nconst app = new Hono();\n\napp.post('/run', async (c) => {\n  const { input } = await c.req.json();\n  // Your API logic here\n  return c.json({ result: input });\n});\n\nexport default app;\n`,
				);
			}

			// README
			writeFileSync(
				join(dir, "README.md"),
				`# ${name}\n\nA ProAgentStore ${template} agent.\n\n## AI billing\n\nThis scaffold does not include a ProAgentStore Cloudflare Workers AI binding. AI calls must use caller-owned credentials or another explicit billing source.\n\n## Development\n\n\`\`\`bash\npnpm install\npnpm dev\n\`\`\`\n\n## Deploy\n\n\`\`\`bash\npags publish\n\`\`\`\n`,
			);

			// Deploy workflow
			writeFileSync(
				join(dir, ".github", "workflows", "deploy.yml"),
				`name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: pnpm/action-setup@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: pnpm\n      - run: pnpm install --frozen-lockfile\n      - uses: cloudflare/wrangler-action@v3\n        with:\n          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}\n          command: deploy\n`,
			);

			// .gitignore
			writeFileSync(
				join(dir, ".gitignore"),
				"node_modules/\ndist/\n.wrangler/\n",
			);

			// LICENSE
			writeFileSync(join(dir, "LICENSE"), "MIT License\n");
		}

		// Replace AGENTNAME placeholders
		writeLine(`\n  Created ${slug}/`);
		writeLine(`  Template: ${template} — ${TEMPLATE_DESC[template]}`);
		writeLine(`\n  cd ${slug}`);
		writeLine("  pnpm install");
		writeLine("  pnpm dev");
		writeLine();
	});
