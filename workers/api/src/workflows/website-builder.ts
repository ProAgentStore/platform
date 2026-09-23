import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS } from "../lib/runner-client.js";
import { listWebsiteBuilderJobCalls, markWebsiteBuilderJob, type WebsiteBuilderJobCall } from "../lib/website-builder-jobs.js";
import { mirrorRuntimeTask } from "../routes/instances-runtime.js";
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
	jobToken: string;
	mcpUrl: string;
	maxRefinements?: number;
}

type Snapshot = { pane?: string; alive?: boolean; runState?: string };
type Evidence = {
	session_id: string; template_slug: string; quality_report: Record<string, unknown>;
	desktop_preview: string; mobile_preview: string; ready_for_human_review: boolean; summary?: string;
};
const MARKER = "PAGS_WEBSITE_BUILDER_EVIDENCE:";

function parseEvidence(pane: string): Evidence | null {
	const at = pane.lastIndexOf(MARKER);
	if (at < 0) return null;
	try {
		const line = pane.slice(at + MARKER.length).trim().split(/\r?\n/, 1)[0] || "";
		const value = JSON.parse(line) as Record<string, unknown>;
		if (typeof value.session_id !== "string" || !value.session_id || typeof value.template_slug !== "string" || !value.template_slug ||
			!value.quality_report || typeof value.quality_report !== "object" || Array.isArray(value.quality_report) ||
			typeof value.desktop_preview !== "string" || typeof value.mobile_preview !== "string" || typeof value.ready_for_human_review !== "boolean") return null;
		return { session_id: value.session_id, template_slug: value.template_slug, quality_report: value.quality_report as Record<string, unknown>, desktop_preview: value.desktop_preview, mobile_preview: value.mobile_preview, ready_for_human_review: value.ready_for_human_review, summary: typeof value.summary === "string" ? value.summary.slice(0, 2000) : undefined };
	} catch { return null; }
}

function evidenceReviewable(evidence: Evidence): boolean {
	return evidence.ready_for_human_review && !!evidence.desktop_preview && !!evidence.mobile_preview;
}

/** Evidence must be corroborated by the job broker, never a pasted terminal JSON. */
function brokerCorroborates(evidence: Evidence, calls: WebsiteBuilderJobCall[]): boolean {
	const create = calls.some((c) => c.success && c.tool === "create_site" && c.result.includes(evidence.session_id));
	const quality = calls.some((c) => c.success && c.tool === "get_quality_report" && c.result.includes("ready_for_human_review") && c.result.includes("true"));
	const screenshot = (viewport: string) => calls.some((c) => c.success && c.tool === "capture_preview" && c.args.viewport === viewport && c.args.session_id === evidence.session_id);
	return create && quality && screenshot("desktop") && screenshot("mobile");
}

export class WebsiteBuilderWorkflow extends WorkflowEntrypoint<Env, WebsiteBuilderWorkflowParams> {
	async run(event: WorkflowEvent<WebsiteBuilderWorkflowParams>, step: WorkflowStep): Promise<{ outcome: "completed" | "failed"; detail: string }> {
		const p = event.payload;
		try {
			let conn = await getBoundRunnerConn(this.env, p.instanceId, p.userId);
			for (let i = 0; !conn && i < 120; i++) {
				await step.sleep(`wait-for-runner-${i}`, "5 seconds");
				conn = await getBoundRunnerConn(this.env, p.instanceId, p.userId);
			}
			if (!conn) throw new Error("No local pags up runtime connected within ten minutes; the Website Builder job was not run.");
			await step.do("mark-job-running", () => markWebsiteBuilderJob(this.env, p.taskId, "running"));
			await step.do("start-subscription-worker", () => callRunner(conn!, "/website-builder/start", {
				taskId: p.taskId, instanceId: p.instanceId, engine: p.engine, lead: p.lead,
				brokerUrl: p.brokerUrl, jobToken: p.jobToken, maxRefinements: p.maxRefinements,
			}) as Promise<never>);

			let snapshot: Snapshot | null = null;
			let evidence: Evidence | null = null;
			for (let i = 0; i < 120; i++) { // 10 minutes, bounded by workflow state rather than a CLI promise.
				snapshot = await step.do(`capture-${i}`, () => callRunner<Snapshot>(conn!, "/website-builder/capture", { taskId: p.taskId }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null));
				if (!snapshot) {
					// A relay loss parks this durable job rather than turning a closed laptop into a
					// failed site build. The next capture resolves the pin-aware live runner again.
					await step.sleep(`wait-for-reconnect-${i}`, "5 seconds");
					conn = await getBoundRunnerConn(this.env, p.instanceId, p.userId);
					if (!conn) continue;
					continue;
				}
				evidence = parseEvidence(String(snapshot.pane ?? ""));
				if (evidence && (snapshot.runState === "idle" || snapshot.alive === false)) break;
				if (snapshot.alive === false) break;
				await step.sleep(`wait-${i}`, "5 seconds");
			}
			if (!evidence) throw new Error("The subscription worker ended without valid Website Builder evidence.");
			if (!evidenceReviewable(evidence)) throw new Error("The draft did not pass QA with both desktop and mobile preview evidence; no deployment approval was created.");
			const calls = await step.do("read-broker-evidence", async () => listWebsiteBuilderJobCalls(this.env, p.taskId) as unknown as never) as unknown as WebsiteBuilderJobCall[];
			if (!brokerCorroborates(evidence, calls)) throw new Error("The claimed draft evidence is not corroborated by successful PAGS-brokered create, QA, desktop and mobile screenshot calls; no deployment approval was created.");

			await step.do("record-evidence", () => markWebsiteBuilderJob(this.env, p.taskId, "completed", evidence));
			await step.do("complete-runner-task", () => callRunner(conn!, "/website-builder/complete", { taskId: p.taskId, status: "completed", output: evidence }) as Promise<never>);
			await step.do("create-deploy-approval", async () => {
				const name = typeof p.lead.name === "string" ? p.lead.name : "this business";
				await mirrorRuntimeTask(this.env, p.instanceId, p.userId, {
					id: `website-builder-review-${p.taskId}`, type: "ticket", status: "needs_approval",
					title: `Review and deploy ${name}`,
					reasoning: "A local subscription worker built a no-index FWS draft through PAGS's task-scoped broker. Desktop and mobile previews plus the FWS quality report passed. Approving is the only route that may run the separate site-deploy pipeline.",
					evidence,
					action: buildTicketAction("run_pipeline", { pipeline: "site-deploy" }, { session_id: evidence.session_id, mcp_url: p.mcpUrl }),
					createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
				});
				await logEvent(this.env, { source: "website-builder", event: "website_builder.ready_for_review", message: "Draft passed QA; deployment requires approval.", userId: p.userId, instanceId: p.instanceId, context: { taskId: p.taskId, sessionId: evidence.session_id } });
			});
			return { outcome: "completed", detail: "Draft evidence recorded; deployment approval ticket created." };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			await markWebsiteBuilderJob(this.env, p.taskId, "failed", { error: detail }).catch(() => undefined);
			const conn = await getBoundRunnerConn(this.env, p.instanceId, p.userId).catch(() => null);
			if (conn) await callRunner(conn, "/website-builder/complete", { taskId: p.taskId, status: "failed", error: detail }).catch(() => undefined);
			await logEvent(this.env, { source: "website-builder", event: "website_builder.failed", level: "warn", message: detail, userId: p.userId, instanceId: p.instanceId, context: { taskId: p.taskId } }).catch(() => undefined);
			return { outcome: "failed", detail };
		}
	}
}
