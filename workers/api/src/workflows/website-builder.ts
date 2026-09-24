import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS } from "../lib/runner-client.js";
import { getWebsiteBuilderJob, listWebsiteBuilderJobCalls, markWebsiteBuilderJob, revealWebsiteBuilderJobToken, type WebsiteBuilderJobCall } from "../lib/website-builder-jobs.js";
import { trustedWebsiteBuilderEvidence, type WebsiteBuilderWorkerClaim } from "../lib/website-builder-evidence.js";
import { mirrorRuntimeEvent, mirrorRuntimeTask } from "../routes/instances-runtime.js";
import { buildTicketAction } from "../lib/actionable-ticket.js";
import { logEvent } from "../lib/events.js";
import type { Env } from "../types.js";

export interface WebsiteBuilderWorkflowParams {
	instanceId: string;
	userId: string;
	taskId: string;
	engine: "claude" | "codex";
	lead: Record<string, unknown>;
	brokerUrl: string;
	mcpUrl: string;
	maxRefinements?: number;
}

type Snapshot = { pane?: string; alive?: boolean; runState?: string };
const MARKER = "PAGS_WEBSITE_BUILDER_EVIDENCE:";

function parseWorkerClaim(pane: string): WebsiteBuilderWorkerClaim | null {
	const at = pane.lastIndexOf(MARKER);
	if (at < 0) return null;
	try {
		const line = pane.slice(at + MARKER.length).trim().split(/\r?\n/, 1)[0] || "";
		const value = JSON.parse(line) as Record<string, unknown>;
		if (typeof value.session_id !== "string" || !value.session_id || typeof value.template_slug !== "string" || !value.template_slug) return null;
		return { session_id: value.session_id, template_slug: value.template_slug, summary: typeof value.summary === "string" ? value.summary.slice(0, 2000) : undefined };
	} catch { return null; }
}

function runnerInput(p: WebsiteBuilderWorkflowParams, jobToken: string, existingSessionId?: string) {
	return {
		taskId: p.taskId, instanceId: p.instanceId, engine: p.engine, lead: p.lead,
		brokerUrl: p.brokerUrl, jobToken, maxRefinements: p.maxRefinements,
		...(existingSessionId ? { existingSessionId } : {}),
	};
}

export class WebsiteBuilderWorkflow extends WorkflowEntrypoint<Env, WebsiteBuilderWorkflowParams> {
	async run(event: WorkflowEvent<WebsiteBuilderWorkflowParams>, step: WorkflowStep): Promise<{ outcome: "completed" | "failed"; detail: string }> {
		const p = event.payload;
		let reviewTicketCreated = false;
		try {
			// The runner task is created before this workflow, but a successful local task
			// listing may not be mirrored until its next polling interval.  Make the board
			// truthful immediately, without ever persisting the job token to the card.
			await step.do("mirror-runtime-task-start", async () => {
				const now = new Date().toISOString();
				const name = typeof p.lead.name === "string" ? p.lead.name : "lead";
				await mirrorRuntimeTask(this.env, p.instanceId, p.userId, {
					id: p.taskId, type: "website.build", status: "running",
					title: `Build draft website for ${name}`,
					description: "Draft-only local subscription worker. Deployment remains a separate PAGS approval; the ticket records FWS static QA and capture confirmation, not pixel-level visual approval.",
					input: { lead: p.lead }, createdAt: now, updatedAt: now,
				});
				await mirrorRuntimeEvent(this.env, p.instanceId, p.userId, {
					id: `${p.taskId}:website-builder.started`, taskId: p.taskId, type: "website-builder.started",
					message: "Website Builder subscription worker queued", createdAt: now,
				});
			});
			let conn = await getBoundRunnerConn(this.env, p.instanceId, p.userId);
			for (let i = 0; !conn && i < 120; i++) {
				await step.sleep(`wait-for-runner-${i}`, "5 seconds");
				conn = await getBoundRunnerConn(this.env, p.instanceId, p.userId);
			}
			if (!conn) throw new Error("No local pags up runtime connected within ten minutes; the Website Builder job was not run.");
			await step.do("mark-job-running", () => markWebsiteBuilderJob(this.env, p.taskId, "running"));
			await step.do("start-subscription-worker", async () => {
				// The bearer is encrypted in D1 and intentionally absent from durable
				// Workflow params. Reveal it only for this authenticated relay call.
				const jobToken = await revealWebsiteBuilderJobToken(this.env, p.taskId);
				if (!jobToken) throw new Error("Website Builder job capability is unavailable or expired before the subscription worker could start.");
				return callRunner(conn!, "/website-builder/start", runnerInput(p, jobToken)) as Promise<never>;
			});

			let snapshot: Snapshot | null = null;
			let claim: WebsiteBuilderWorkerClaim | null = null;
			for (let i = 0; i < 120; i++) { // 10 minutes, bounded by workflow state rather than a CLI promise.
				// Supplying the complete durable input lets a fresh `pags up` process recreate
				// the local subscription session after a restart.  It never guesses from a
				// missing in-memory session, and the runner does not persist the job token.
				const job = await getWebsiteBuilderJob(this.env, p.taskId);
				if (!job) throw new Error("Website Builder job record disappeared before the local worker could be resumed.");
				snapshot = await step.do(`capture-${i}`, async () => {
					const jobToken = await revealWebsiteBuilderJobToken(this.env, p.taskId);
					if (!jobToken) throw new Error("Website Builder job capability expired before the local runner could resume.");
					return callRunner<Snapshot>(conn!, "/website-builder/capture", { taskId: p.taskId, resume: runnerInput(p, jobToken, job.fwsSessionId ?? undefined) }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null) as Promise<never>;
				}) as unknown as Snapshot | null;
				if (!snapshot) {
					// A relay loss parks this durable job rather than turning a closed laptop into a
					// failed site build. The next capture resolves the pin-aware live runner again.
					await step.sleep(`wait-for-reconnect-${i}`, "5 seconds");
					conn = await getBoundRunnerConn(this.env, p.instanceId, p.userId);
					if (!conn) continue;
					continue;
				}
				claim = parseWorkerClaim(String(snapshot.pane ?? ""));
				if (claim && (snapshot.runState === "idle" || snapshot.alive === false)) break;
				if (snapshot.alive === false) break;
				await step.sleep(`wait-${i}`, "5 seconds");
			}
			if (!claim) throw new Error("The subscription worker ended without a valid Website Builder session claim.");
			const calls = await step.do("read-broker-evidence", async () => listWebsiteBuilderJobCalls(this.env, p.taskId) as unknown as never) as unknown as WebsiteBuilderJobCall[];
			const job = await getWebsiteBuilderJob(this.env, p.taskId);
			if (!job) throw new Error("Website Builder job record disappeared before review evidence could be verified.");
			const evidence = trustedWebsiteBuilderEvidence(claim, calls, { fwsSessionId: job.fwsSessionId, noindexConfirmed: job.noindexConfirmed, mcpUrl: job.mcpUrl });
			if (!evidence) throw new Error("The claimed draft is not corroborated by broker-confirmed FWS create, passing static QA, rendered preview and desktop/mobile capture metadata; no deployment approval was created.");

			// This is deliberately before completion.  If a durable retry happens after a
			// transient runner failure, the fixed ticket id makes this an idempotent upsert
			// instead of leaving a 'completed' job with no way to review or deploy it.
			await step.do("create-deploy-approval", async () => {
				const name = typeof p.lead.name === "string" ? p.lead.name : "this business";
				await mirrorRuntimeTask(this.env, p.instanceId, p.userId, {
					id: `website-builder-review-${p.taskId}`, type: "ticket", status: "needs_approval",
					title: `Review and deploy ${name}`,
					reasoning: "A local subscription worker built a no-index FWS draft through PAGS's task-scoped broker. FWS static QA passed and FWS confirmed desktop/mobile captures for the rendered preview. Screenshot pixels are not forwarded through this broker, so review the linked preview yourself before approving. Approving is the only route that may run the separate site-deploy pipeline.",
					evidence,
					action: buildTicketAction("run_pipeline", { pipeline: "site-deploy" }, { session_id: evidence.session_id, mcp_url: p.mcpUrl }),
					createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
				});
				await logEvent(this.env, { source: "website-builder", event: "website_builder.ready_for_review", message: "Draft passed FWS static QA with rendered-preview and desktop/mobile capture confirmation; deployment requires approval.", userId: p.userId, instanceId: p.instanceId, context: { taskId: p.taskId, sessionId: evidence.session_id } });
			});
			reviewTicketCreated = true;
			await step.do("record-evidence-and-complete-runner", async () => {
				await markWebsiteBuilderJob(this.env, p.taskId, "completed", evidence);
				await callRunner(conn!, "/website-builder/complete", { taskId: p.taskId, status: "completed", output: evidence });
			});
			return { outcome: "completed", detail: "Draft evidence recorded; deployment approval ticket created." };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			// Once the review ticket exists, it is the durable approval record.  Do not
			// overwrite a trusted completed job with 'failed' just because its idempotent
			// runner-completion acknowledgement was interrupted.
			if (!reviewTicketCreated) {
				await markWebsiteBuilderJob(this.env, p.taskId, "failed", { error: detail }).catch(() => undefined);
				const conn = await getBoundRunnerConn(this.env, p.instanceId, p.userId).catch(() => null);
				if (conn) await callRunner(conn, "/website-builder/complete", { taskId: p.taskId, status: "failed", error: detail }).catch(() => undefined);
				await logEvent(this.env, { source: "website-builder", event: "website_builder.failed", level: "warn", message: detail, userId: p.userId, instanceId: p.instanceId, context: { taskId: p.taskId } }).catch(() => undefined);
			}
			return { outcome: "failed", detail };
		}
	}
}
