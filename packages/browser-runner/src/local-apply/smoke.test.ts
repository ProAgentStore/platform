/**
 * Live machine-login smoke test (#957): the REAL Claude Code and Codex CLIs, signed in on this
 * machine, fill the local fixture application form in a REAL headless browser through the apply
 * bridge, in fill-and-review mode. Skipped unless `PAGS_ENGINE_SMOKE=1` — it spends the machine's
 * subscription and needs both CLIs signed in. Needs the runner built (`dist/` holds the bridge
 * forwarder the CLI launches):
 *
 *   pnpm --filter @proagentstore/browser-runner build
 *   PAGS_ENGINE_SMOKE=1 pnpm vitest run --project integration packages/browser-runner/src/local-apply/smoke.test.ts
 *
 * The proof that nothing was submitted is the fixture server's own record: it stores every POST
 * to /apply, and must hold none.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpRuntime } from "../mcp-runtime.js";
import { startTestJobServer } from "../test-job-server.js";
import { LocalApplyRuntime } from "./runtime.js";

const PROFILE = `Full name: Jane Citizen
Email: jane.citizen@example.com
Phone: 0400 123 456
Location: Sydney
Work authorization: Authorized to work in the United States
`;
const RESUME = "Jane Citizen\nSenior TypeScript Engineer, Acme, 2019 - 2024\n";
const COVER = "I build careful, approval-first browser automation in TypeScript, and would like to bring that to Fixture Labs.\n";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const BRIDGE = fileURLToPath(new URL("../../dist/local-browser/bridge-stdio.js", import.meta.url));

describe.skipIf(process.env.PAGS_ENGINE_SMOKE !== "1")("live machine-login application fill", () => {
	it.each(["claude", "codex"] as const)(
		"%s fills the fixture form in fill-and-review mode and submits nothing",
		async (engine) => {
			const jobs = await startTestJobServer(0);
			const home = mkdtempSync(join(tmpdir(), `lap-smoke-home-${engine}-`));
			const data = mkdtempSync(join(tmpdir(), `lap-smoke-data-${engine}-`));
			mkdirSync(join(home, "jobs/applications/lead-smoke/t"), { recursive: true });
			writeFileSync(join(home, "jobs/profile.md"), PROFILE);
			writeFileSync(join(home, "jobs/applications/lead-smoke/t/resume.md"), RESUME);
			writeFileSync(join(home, "jobs/applications/lead-smoke/t/cover-letter.md"), COVER);
			const browsers: McpRuntime[] = [];
			let selfUrl: string | null = null;
			const rt = new LocalApplyRuntime({
				dataDir: data,
				homeDir: home,
				selfUrl: () => selfUrl,
				bridgeScript: BRIDGE,
				browserFor: async (_p, runDir) => {
					const mcp = new McpRuntime();
					await mcp.start({ userDataDir: join(runDir, "profile"), headless: true });
					browsers.push(mcp);
					return { tools: mcp, stop: () => mcp.stop() };
				},
			});
			// The runner's bridge endpoint, as server.ts serves it.
			const server = createServer(async (req, res) => {
				const chunks: Buffer[] = [];
				for await (const c of req) chunks.push(c as Buffer);
				const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
				if (!rt.authorizeBridge(String(body.runId ?? ""), String(req.headers["x-pags-bridge-token"] ?? ""))) {
					res.writeHead(401).end("{}");
					return;
				}
				const out = await rt.bridge(body).catch((e: Error) => ({ error: e.message }));
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
			});
			await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
			selfUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const runId = `smoke-${engine}`;
			try {
				rt.start({
					type: "local_browser.apply",
					runId,
					requestId: `smoke:${engine}`,
					instanceId: "smoke-runner",
					applicationId: "app-smoke",
					engine,
					authMode: "machine",
					browserProfile: "isolated",
					applicationUrl: jobs.jobUrl,
					job: { title: "Senior Software Engineer", company: "Fixture Labs" },
					workspace: "~/jobs",
					sources: [{ role: "profile", path: "profile.md" }],
					artifacts: [
						{ kind: "resume", path: "~/jobs/applications/lead-smoke/t/resume.md", sha256: sha(RESUME) },
						{ kind: "cover_letter", path: "~/jobs/applications/lead-smoke/t/cover-letter.md", sha256: sha(COVER) },
					],
					policy: { mode: "fill_and_review", allowDomains: ["127.0.0.1"] },
					limits: { maxMinutes: 10, maxPages: 10, maxActions: 80 },
				});
				let status = rt.status({ runId });
				const pauses: string[] = [];
				for (let i = 0; i < 660 && status.state !== "ended"; i++) {
					await new Promise((r) => setTimeout(r, 1000));
					status = rt.status({ runId });
					// The owner, played here: every question is left unanswered ("leave it blank").
					if (status.state === "paused" && status.pause) {
						pauses.push(status.pause.reason);
						rt.resume({ runId });
					}
				}
				const r = status.result;
				const decisions = status.events.filter((e) => e.type === "policy.decision").map((e) => `${e.detail?.tool}:${e.detail?.class}:${e.detail?.decision}`);
				console.log(`[apply-smoke:${engine}]`, JSON.stringify({ outcome: r?.outcome, engineAuth: r?.engineAuth, filled: r?.filled, uploaded: r?.uploaded, submitAttempted: r?.submitAttempted, blockReason: r?.blockReason, questions: r?.questions, error: r?.error, summary: r?.summary, events: status.events.map((e) => e.type), decisions, pauses, submissions: jobs.submissions.length }, null, 2));
				expect(r?.engineAuth).toBe("machine-login");
				expect(r?.outcome).toBe("awaiting_review");
				expect(r?.submitAttempted).toBe(false);
				expect(r?.filled).toBeGreaterThanOrEqual(2);
				expect(r?.uploaded).toContain("resume");
				expect(jobs.submissions).toHaveLength(0);
			} finally {
				rt.closeAll();
				await Promise.all(browsers.map((b) => b.stop().catch(() => undefined)));
				server.close();
				await jobs.close();
				rmSync(home, { recursive: true, force: true });
				rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
			}
		},
		720_000,
	);
});
