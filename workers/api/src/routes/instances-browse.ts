import type { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { requirePro } from "../lib/billing.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import { resolveSettingsValues, settingsPromptBlock } from "../lib/instance-settings.js";
import { deriveFromUrl } from "../lib/board.js";
import { logError } from "../lib/error-log.js";
import { triggerActionDenial } from "../lib/trigger-capability.js";
import { createLoopRun } from "../lib/agent-loop-store.js";
import { BROWSER_RUN_ROUNDS, browserRunObjective } from "../lib/browser-run.js";
import type { BrowserTaskJob } from "../lib/browser-task-loop.js";
import type { Env } from "../types.js";
import { createBrowserRuntimeTask } from "./browser-workflows.js";
import { requireLiveRuntime, requireOwnedInstance } from "./instances-runtime.js";
import { sqlTime } from "../lib/sql-time.js";

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
	// Capability BEFORE connectivity (#358). These two preconditions fail differently on purpose:
	// a 503 is transient and environmental, so `executeTriggerAction` records it as a SKIP with
	// failure_count untouched and retries next schedule, while a 400 is a real failure. Asking
	// the environmental question first meant an agent that can never do this — no BROWSER_TASK
	// workflow — never reached the permanent check at all: it 503'd, was recorded as a skip, and
	// the owner was told to run `pags up` on every fire, forever. The free, deterministic,
	// zero-cost question goes first, so the answer is the true one.
	const inst = await env.DB.prepare("SELECT agent_id, config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ agent_id: string; config: string | null }>();
	if (!inst) throw new BrowseError("instance not found", 404);
	const agentRow = await env.DB.prepare("SELECT slug, category, config FROM agents WHERE id = ?1").bind(inst.agent_id).first<{ slug: string | null; category: string | null; config: string | null }>();
	const caps = agentCapabilities({ slug: agentRow?.slug, category: agentRow?.category, config: agentRow?.config });
	// One sentence, shared with the trigger validator and the console picker, so the reason a
	// browser run is refused reads the same wherever you meet it.
	const denial = triggerActionDenial("run_browse", caps);
	if (denial) throw new BrowseError(denial, 400);

	await requireLiveRuntime(env, instanceId, userId); // throws 503 if no runner

	const agentCfg = parseJson(agentRow?.config);
	const instCfg = parseJson(inst.config);
	const identity = (agentCfg.identity ?? {}) as Record<string, unknown>;
	const browserTaskCfg = (agentCfg.browserTask ?? {}) as Record<string, unknown>;
	/** Declared by the agent: this one only ever observes. See `readOnly` on BrowserTaskJob. */
	const readOnly = browserTaskCfg.readOnly === true;

	const schema = caps.settingsSchema ?? [];
	const settings = schema.length ? resolveSettingsValues(schema, instCfg.settings) : {};

	// Start URL: explicit override > the typed SETTING the agent nominates for it >
	// agent-declared default. The setting matters because the start URL is usually the one
	// thing that differs per subscriber (which portal, which account). Without it the URL had
	// to be retyped on every manual run and duplicated into every cron trigger's config, so
	// two places could disagree about what the agent watches; `startUrlSetting` names the
	// field once and both paths read it. Which field it is stays DATA — no slug is hardcoded.
	const urlSettingId = trimmed(browserTaskCfg.startUrlSetting);
	const settingUrl = urlSettingId ? trimmed(settings[urlSettingId]) : undefined;
	const startUrl = trimmed(input.url) ?? settingUrl ?? trimmed(browserTaskCfg.startUrl) ?? trimmed(agentCfg.startUrl);
	if (!startUrl || !/^https?:\/\//.test(startUrl)) {
		throw new BrowseError(
			urlSettingId
				? "no start URL — set it in the console Settings tab, or pass `url`"
				: "no start URL — pass `url` or set config.browserTask.startUrl on the agent",
			400,
		);
	}

	// Objective: explicit override > (agent goal + rendered subscriber settings). Fully
	// data-driven; the settings block is generic (same one the chat prompt injects).
	const goal = trimmed(identity.goal) ?? "";
	const settingsBlock = schema.length ? settingsPromptBlock(schema, settings) : "";
	const objective = trimmed(input.objective) ?? [goal, settingsBlock].filter(Boolean).join("\n\n");
	if (!objective) throw new BrowseError("no objective — set the agent's goal or pass `objective`", 400);

	// Single-flight: the runner drives ONE browser page, so a second concurrent run on
	// this instance would clobber the first. Atomic INSERT-WHERE-NOT-EXISTS claim (same
	// mechanism + 4h stale cutoff as apply); D1 serializes writes so exactly one wins.
	const STALE_MS = 4 * 60 * 60 * 1000;
	const claimId = `browse-claim_${crypto.randomUUID()}`;
	// Written and compared in the COLUMN's format, and necessarily together — see the same claim
	// in `instances-apply.ts` for why an ISO cutoff would retire live cards (#634).
	const nowSql = sqlTime();
	const staleCutoff = sqlTime(Date.now() - STALE_MS);
	const claim = await env.DB.prepare(
		`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
		 SELECT ?1, ?2, ?3, 'browser.task', 'queued', '{"claim":true}', ?4, ?4
		 WHERE NOT EXISTS (
		   SELECT 1 FROM instance_runtime_tasks
		   WHERE instance_id = ?2 AND type = 'browser.task'
		     AND status IN ('queued','running','needs_human') AND hidden = 0
		     AND updated_at > ?5
		 )`,
	).bind(claimId, instanceId, userId, nowSql, staleCutoff).run();
	if ((claim.meta.changes ?? 0) === 0) {
		throw new BrowseError("A run is already in progress on this agent — finish or cancel it before starting another.", 409);
	}
	// A swallowed DELETE leaves the placeholder `queued`, and every later start then 409s with
	// "already in progress" until the 4h stale cutoff — the agent wedged by the very row that
	// exists to keep it from wedging. Nothing else can free it, so at minimum the wedge has to be
	// findable: it is the answer to "why does my agent say a run is in progress when it isn't?".
	const dropClaim = () =>
		env.DB.prepare("DELETE FROM instance_runtime_tasks WHERE id = ?1")
			.bind(claimId)
			.run()
			.catch((e) =>
				logError(env, {
					source: "browse",
					userId,
					message: `could not drop the single-flight claim ${claimId}; this agent will refuse new runs until the stale cutoff: ${e instanceof Error ? e.message : String(e)}`,
					context: { instanceId, claimId },
				}).catch(() => undefined),
			);

	try {
		const job: BrowserTaskJob = {
			url: startUrl,
			objective,
			dryRun: input.dryRun === true,
			// Read from the AGENT row and NOWHERE else — not the request body, not the trigger
			// config, not the instance config — so nobody downstream of the declaration can clear
			// it, the way an actionable ticket's action is fixed when it is created and approving
			// only chooses whether it runs. A read-only agent that its caller could talk out of
			// being read-only would just be a prompt with extra steps.
			readOnly,
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
		// The run row #560 was missing on this driver too, and for the same reason it mattered more
		// here than anywhere: the one runaway-shaped record in the whole error log is a browser task
		// ("max_steps: stopped after 60 actions"), and it was ended by a structural cap rather than
		// by anybody stopping it — because nobody could. `stop_work` resolves through
		// `agent_loop_runs`; without a row it reached neither this driver nor apply.
		//
		// NOT best-effort, on the same reasoning as the apply route and `loop-drivers.ts` before it.
		const loopRunId = crypto.randomUUID();
		try {
			await createLoopRun(env, {
				runId: loopRunId,
				userId,
				instanceId,
				objective: browserRunObjective("browse", { url: startUrl, objective }),
				// The outer handoff-round loop; `runApplyLoop`'s per-round step counter restarts.
				maxIterations: BROWSER_RUN_ROUNDS,
				startedAt: Date.now(),
			});
		} catch (e) {
			await env.DB.prepare(
				"UPDATE instance_runtime_tasks SET status = 'failed', hidden = 1, updated_at = datetime('now') WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
			)
				.bind(taskId, instanceId, userId)
				.run()
				.catch(() => undefined);
			throw new BrowseError(`Could not start the browser task: ${e instanceof Error ? e.message : String(e)}`, 500);
		}
		const instance = await env.BROWSER_TASK.create({ params: { instanceId, userId, taskId, job, loopRunId } });
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
