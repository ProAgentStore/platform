import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { requirePro } from "../lib/billing.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import { resolveSettingsValues, settingsPromptBlock } from "../lib/instance-settings.js";
import { deriveFromUrl } from "../lib/board.js";
import type { BrowserTaskJob } from "../lib/browser-task-loop.js";
import type { Env } from "../types.js";
import { createBrowserRuntimeTask } from "./browser-workflows.js";
import { requireLiveRuntime, requireOwnedInstance } from "./instances-runtime.js";

/** A browse-trigger failure with an HTTP-ish status. */
export class BrowseError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}

function trimmed(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const t = value.trim();
	return t.length > 0 ? t : undefined;
}

function parseJson(s: string | null | undefined): Record<string, unknown> {
	try { return s ? (JSON.parse(s) as Record<string, unknown>) : {}; } catch { return {}; }
}

export interface StartBrowseInput {
	/** Start URL override; falls back to the agent's declared start URL. */
	url?: string;
	/** Objective override; falls back to the agent's goal + the instance's settings. */
	objective?: string;
	dryRun?: boolean;
}

/**
 * Start a generic browser task: build the objective from the agent's declared goal +
 * the subscriber's typed settings (as DATA — the platform stays domain-agnostic),
 * create the agent-driven runner task, and start the BrowserTaskWorkflow brain.
 * Mirrors startJobApply — same single-flight, same task/workflow shape.
 */
export async function startBrowserTask(env: Env, instanceId: string, userId: string, input: StartBrowseInput): Promise<{ workflowId: string; taskId: string }> {
	await requireLiveRuntime(env, instanceId, userId); // throws if no runner

	const inst = await env.DB.prepare("SELECT agent_id, config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ agent_id: string; config: string | null }>();
	if (!inst) throw new BrowseError("instance not found", 404);
	const agentRow = await env.DB.prepare("SELECT slug, category, config FROM agents WHERE id = ?1").bind(inst.agent_id).first<{ slug: string | null; category: string | null; config: string | null }>();
	const caps = agentCapabilities({ slug: agentRow?.slug, category: agentRow?.category, config: agentRow?.config });
	if (caps.workflow !== "BROWSER_TASK") throw new BrowseError("this agent is not a browser-task agent", 400);

	const agentCfg = parseJson(agentRow?.config);
	const instCfg = parseJson(inst.config);
	const identity = (agentCfg.identity ?? {}) as Record<string, unknown>;
	const browserTaskCfg = (agentCfg.browserTask ?? {}) as Record<string, unknown>;

	// Start URL: explicit override > agent-declared start URL.
	const startUrl = trimmed(input.url) ?? trimmed(browserTaskCfg.startUrl) ?? trimmed(agentCfg.startUrl);
	if (!startUrl || !/^https?:\/\//.test(startUrl)) throw new BrowseError("no start URL — pass `url` or set config.browserTask.startUrl on the agent", 400);

	// Objective: explicit override > (agent goal + rendered subscriber settings). Fully
	// data-driven; the settings block is generic (same one the chat prompt injects).
	const goal = trimmed(identity.goal) ?? "";
	const schema = caps.settingsSchema ?? [];
	const settingsBlock = schema.length ? settingsPromptBlock(schema, resolveSettingsValues(schema, instCfg.settings)) : "";
	const objective = trimmed(input.objective) ?? [goal, settingsBlock].filter(Boolean).join("\n\n");
	if (!objective) throw new BrowseError("no objective — set the agent's goal or pass `objective`", 400);

	// Single-flight: the runner drives ONE browser page, so a second concurrent run on
	// this instance would clobber the first. Atomic INSERT-WHERE-NOT-EXISTS claim (same
	// mechanism + 4h stale cutoff as apply); D1 serializes writes so exactly one wins.
	const STALE_MS = 4 * 60 * 60 * 1000;
	const claimId = `browse-claim_${crypto.randomUUID()}`;
	const nowIso = new Date().toISOString();
	const staleCutoff = new Date(Date.now() - STALE_MS).toISOString();
	const claim = await env.DB.prepare(
		`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
		 SELECT ?1, ?2, ?3, 'browser.task', 'queued', '{"claim":true}', ?4, ?4
		 WHERE NOT EXISTS (
		   SELECT 1 FROM instance_runtime_tasks
		   WHERE instance_id = ?2 AND type = 'browser.task'
		     AND status IN ('queued','running','needs_human') AND hidden = 0
		     AND updated_at > ?5
		 )`,
	).bind(claimId, instanceId, userId, nowIso, staleCutoff).run();
	if ((claim.meta.changes ?? 0) === 0) {
		throw new BrowseError("A run is already in progress on this agent — finish or cancel it before starting another.", 409);
	}
	const dropClaim = () => env.DB.prepare("DELETE FROM instance_runtime_tasks WHERE id = ?1").bind(claimId).run().catch(() => undefined);

	try {
		const job: BrowserTaskJob = {
			url: startUrl,
			objective,
			dryRun: input.dryRun === true,
			specialInstructions: trimmed(instCfg.specialInstructions),
			today: new Date().toISOString().slice(0, 10),
		};
		let taskId: string;
		try {
			const card = deriveFromUrl(startUrl);
			({ taskId } = await createBrowserRuntimeTask(env, instanceId, userId, {
				type: "browser.task",
				input: { url: startUrl, objective: objective.slice(0, 500) },
				title: card.title || undefined,
				subtitle: card.subtitle || undefined,
			}));
		} catch (e) {
			throw new BrowseError(e instanceof Error ? e.message : String(e), 502);
		}
		const instance = await env.BROWSER_TASK.create({ params: { instanceId, userId, taskId, job } });
		return { workflowId: instance.id, taskId };
	} finally {
		await dropClaim();
	}
}

/** Register the generic browser-task trigger. Owner-scoped; Pro (server-driven browser). */
export function registerBrowseRoutes(router: Hono<{ Bindings: Env }>): void {
	/** Start a generic browser task. dryRun walks the flow but blocks the committing action. */
	router.post("/:instanceId/browse", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);
		await requirePro(c.env, session);
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		try {
			const { workflowId, taskId } = await startBrowserTask(c.env, instanceId, session.uid, {
				url: typeof body.url === "string" ? body.url : undefined,
				objective: typeof body.objective === "string" ? body.objective : undefined,
				dryRun: body.dryRun === true || body.dry_run === true,
			});
			return c.json({ workflowId, taskId, status: "running" }, 202);
		} catch (e) {
			if (e instanceof BrowseError) {
				const status = e.status === 502 ? 502 : e.status === 404 ? 404 : e.status === 409 ? 409 : 400;
				return c.json({ error: e.message }, status);
			}
			throw e;
		}
	});
}
