import type { Hono } from "hono";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { HttpError, requireUser } from "../lib/auth.js";
import { buildConsoleLink, type ConsoleTarget } from "../lib/console-deep-link.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

/**
 * A precise console link for an instance, a run, a task, a secret request or a section (#938).
 *
 * The route only resolves what the pure builder (`lib/console-deep-link.ts`) cannot know: that the
 * caller owns the instance and every record named, which tabs the instance shows, and which coding
 * session a loop run drives. A record that is not this owner's on this instance is a 404 — never a
 * link that lands on a page reading "not found".
 */
export function registerConsoleLinkRoutes(router: Hono<{ Bindings: Env }>): void {
	/** GET /v1/instances/:instanceId/console-link?section=|target=files-upload|run_id=|task_id=|secure_input_id= — at most one. */
	router.get("/:instanceId/console-link", async (c) => {
		const session = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, session.uid);

		const q = (k: string) => c.req.query(k)?.trim() || "";
		const given = (["section", "target", "run_id", "task_id", "secure_input_id"] as const).filter((k) => q(k));
		if (given.length > 1) throw new HttpError(400, `Give one of section, target, run_id, task_id or secure_input_id, not ${given.join(" and ")} — a record's page already sits on its own tab.`);

		let target: ConsoleTarget = { kind: "instance" };
		if (q("section")) target = { kind: "section", section: q("section").toLowerCase() };
		else if (q("target")) {
			if (q("target") !== "files-upload") throw new HttpError(400, `Unknown console-link target "${q("target")}"`);
			target = { kind: "filesUpload" };
		}
		else if (q("run_id")) {
			const run = await c.env.DB.prepare("SELECT session_id FROM agent_loop_runs WHERE run_id = ?1 AND instance_id = ?2 AND user_id = ?3")
				.bind(q("run_id"), instanceId, session.uid)
				.first<{ session_id: string | null }>();
			// A run id is a loop run or a local browser research run (#946); the two never share ids.
			const research = run
				? null
				: await c.env.DB.prepare("SELECT id FROM local_browser_runs WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(q("run_id"), instanceId, session.uid).first();
			if (!run && !research) throw new HttpError(404, "Run not found on this instance");
			target = run ? { kind: "run", runId: q("run_id"), sessionId: run.session_id || null } : { kind: "local_browser_run", runId: q("run_id") };
		} else if (q("task_id")) {
			const task = await c.env.DB.prepare("SELECT id FROM instance_runtime_tasks WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(q("task_id"), instanceId, session.uid).first();
			if (!task) throw new HttpError(404, "Task not found on this instance");
			target = { kind: "task", taskId: q("task_id") };
		} else if (q("secure_input_id")) {
			const req = await c.env.DB.prepare("SELECT id FROM secure_input_requests WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3").bind(q("secure_input_id"), instanceId, session.uid).first();
			if (!req) throw new HttpError(404, "Secure input request not found on this instance");
			target = { kind: "secure_input", requestId: q("secure_input_id") };
		}

		const caps = await capabilitiesForInstance(c.env, instanceId, session.uid);
		const link = buildConsoleLink(instanceId, target, { surfaces: caps?.surfaces ?? [], runtime: caps?.runtime ?? null, tools: caps?.tools });
		if ("error" in link) return c.json(link, 400);
		return c.json(link);
	});
}
