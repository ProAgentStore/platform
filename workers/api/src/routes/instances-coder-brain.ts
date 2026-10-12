import type { Context, Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { PO_TRIAGE_ACTION, readCoderBrain, setCoderBrain } from "../lib/coder-brain.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

/** The coder brain switch (#1025 §1) and the product-owner triage reports it gates (#1027). */
export function registerCoderBrainRoutes(router: Hono<{ Bindings: Env }>): void {
	const owned = async (c: Context<{ Bindings: Env }>) => {
		const s = await requireUser(c);
		const instanceId = c.req.param("instanceId") ?? "";
		await requireOwnedInstance(c.env, instanceId, s.uid);
		return { instanceId, uid: s.uid };
	};
	const view = async (env: Env, instanceId: string, uid: string) => {
		const { results } = await env.DB.prepare("SELECT id, name, schedule, enabled, config, next_run_at, last_run_at FROM agent_triggers WHERE instance_id = ?1 AND user_id = ?2 AND action = ?3 ORDER BY created_at")
			.bind(instanceId, uid, PO_TRIAGE_ACTION)
			.all<{ id: string; name: string; schedule: string | null; enabled: number; config: string | null; next_run_at: string | null; last_run_at: string | null }>();
		return {
			settings: await readCoderBrain(env, instanceId, uid),
			triggers: (results ?? []).map((t) => ({ id: t.id, name: t.name, schedule: t.schedule, enabled: !!t.enabled, config: t.config ? JSON.parse(t.config) : {}, nextRunAt: t.next_run_at, lastRunAt: t.last_run_at })),
		};
	};

	router.get("/:instanceId/coder-brain", async (c) => {
		const { instanceId, uid } = await owned(c);
		return c.json(await view(c.env, instanceId, uid));
	});

	/** The one writer (`set_coder_brain`). Turning the PO layer on needs a coding instance. */
	router.put("/:instanceId/coder-brain", async (c) => {
		const { instanceId, uid } = await owned(c);
		const b = (await c.req.json().catch(() => ({}))) as { enabled?: unknown; poEnabled?: unknown };
		if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
		if (b.poEnabled !== undefined && typeof b.poEnabled !== "boolean") throw new HttpError(400, "poEnabled must be true or false.");
		if (b.poEnabled === true) {
			const caps = await capabilitiesForInstance(c.env, instanceId, uid).catch(() => null);
			if (caps?.workflow !== "CODING_SESSION") throw new HttpError(409, "Product-owner triage queues coding runs, so it needs a coding instance (a Repo Coder).");
		}
		const { triggers } = await setCoderBrain(c.env, instanceId, uid, { enabled: b.enabled as boolean | undefined, poEnabled: b.poEnabled as boolean | undefined });
		return c.json({ ...(await view(c.env, instanceId, uid)), changed: triggers });
	});

	router.get("/:instanceId/po-triage/reports", async (c) => {
		const { instanceId, uid } = await owned(c);
		const limit = Math.min(Math.max(Number(new URL(c.req.url).searchParams.get("limit")) || 10, 1), 50);
		const { results } = await c.env.DB.prepare(
			"SELECT id, trigger_id, slot, dry_run, status, report, digest, error, created_at FROM po_triage_reports WHERE instance_id = ?1 AND user_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT ?3",
		)
			.bind(instanceId, uid, limit)
			.all<{ id: string; trigger_id: string | null; slot: string; dry_run: number; status: string; report: string | null; digest: string | null; error: string | null; created_at: string }>();
		return c.json({
			...(await view(c.env, instanceId, uid)),
			reports: (results ?? []).map((r) => ({ id: r.id, triggerId: r.trigger_id, slot: r.slot, dryRun: !!r.dry_run, status: r.status, digest: r.digest, error: r.error, createdAt: r.created_at, report: r.report ? JSON.parse(r.report) : null })),
		});
	});
}
