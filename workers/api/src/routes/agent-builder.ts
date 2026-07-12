import { Hono } from "hono";
import { HttpError, requireCreator } from "../lib/auth.js";
import {
	executeAgentBuilderPlan,
	planAgentFromPrompt,
	type AgentBuilderPlan,
} from "../lib/agent-builder.js";
import type { Env } from "../types.js";

export const agentBuilderRoutes = new Hono<{ Bindings: Env }>();

agentBuilderRoutes.post("/plan", async (c) => {
	await requireCreator(c);
	const body = await c.req.json<{ prompt?: string }>();
	const prompt = body.prompt?.trim();
	if (!prompt) throw new HttpError(400, "prompt required");
	return c.json({ plan: planAgentFromPrompt(prompt) });
});

agentBuilderRoutes.post("/execute", async (c) => {
	const session = await requireCreator(c);
	const body = await c.req.json<{ plan?: AgentBuilderPlan }>();
	if (!body.plan) throw new HttpError(400, "plan required");
	if (!body.plan.agent?.slug || !body.plan.agent?.name) {
		throw new HttpError(400, "plan.agent.slug and plan.agent.name required");
	}
	if (!["create_agent", "scaffold_agent"].includes(body.plan.action)) {
		throw new HttpError(400, "unsupported builder action");
	}
	if (!/^[a-z][a-z0-9-]*$/.test(body.plan.agent.slug)) {
		throw new HttpError(400, "slug must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens");
	}
	if (body.plan.template && !["worker", "cron", "api"].includes(body.plan.template)) {
		throw new HttpError(400, "unsupported builder template");
	}
	const result = await executeAgentBuilderPlan(c.env, session, body.plan);
	return c.json({ result }, 201);
});
