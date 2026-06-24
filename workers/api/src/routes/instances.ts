import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError, requireUser } from "../lib/auth.js";
import { createNotification } from "./notifications.js";
import type { Env } from "../types.js";
import {
	callRuntime,
	cloudflareAiSetupTask,
	cloudflareAiSetupTaskId,
	deleteMirroredRuntimeTask,
	encodeRuntimeToken,
	fagsRuntimeSetupTask,
	fagsRuntimeSetupTaskId,
	expireOrphanedRuntimeTasks,
	getRuntime,
	isCloudflareAiCredentialsError,
	isRecord,
	mirrorRuntimeTask,
	mirrorRuntimeEvents,
	mirrorRuntimeTasks,
	mirrorSyntheticTaskEvent,
	mirrorTaskLifecycleEvents,
	mirroredRuntimeEvents,
	mirroredRuntimeTask,
	mirroredRuntimeTasks,
	normalizeRunnerTaskBody,
	requireOwnedInstance,
	requireRuntime,
	runtimeErrorPayload,
	runtimeJson,
	runtimeResponse,
	runtimeStatus,
	safeCapabilities,
	syntheticEventsFromTasks,
	updateRuntimeStatus,
	UPSERT_INSTANCE_RUNTIME_SQL,
	validateRuntimeEndpointUrl,
	type InstanceRow,
	type RuntimeRegistrationBody,
} from "./instances-runtime.js";

export {
	cloudflareAiSetupTask,
	cloudflareAiSetupTaskId,
	fagsRuntimeSetupTask,
	fagsRuntimeSetupTaskId,
	isCloudflareAiCredentialsError,
	normalizeRunnerTaskBody,
	runtimeEventsFromPayload,
	runtimeTasksFromPayload,
	UPSERT_INSTANCE_RUNTIME_SQL,
	validateRuntimeEndpointUrl,
} from "./instances-runtime.js";

export const instanceRoutes = new Hono<{ Bindings: Env }>();

/** Subscribe to an agent — creates a personal instance with its own DO. */
instanceRoutes.post("/:agentId/subscribe", async (c) => {
	const session = await requireUser(c);
	const agentId = c.req.param("agentId");

	// Verify agent exists and is published
	const agent = await c.env.DB.prepare(
		`SELECT id, name, model, visibility FROM agents WHERE (id = ?1 OR slug = ?1) AND visibility = 'published'`,
	)
		.bind(agentId)
		.first<{ id: string; name: string; model: string }>();
	if (!agent) throw new HttpError(404, "Agent not found or not published");

	// Check if already subscribed
	const existing = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE agent_id = ?1 AND user_id = ?2",
	)
		.bind(agent.id, session.uid)
		.first();
	if (existing) throw new HttpError(409, "Already subscribed to this agent");

	const instanceId = crypto.randomUUID();

	// Create instance row
	await c.env.DB.prepare(
		`INSERT INTO agent_instances (id, agent_id, user_id, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'active', datetime('now'), datetime('now'))`,
	)
		.bind(instanceId, agent.id, session.uid)
		.run();

	// Create subscription row
	await c.env.DB.prepare(
		`INSERT INTO subscriptions (id, user_id, agent_id, status, started_at)
     VALUES (?1, ?2, ?3, 'active', datetime('now'))`,
	)
		.bind(crypto.randomUUID(), session.uid, agent.id)
		.run();

	// Initialize the instance's DO — copy template state from the agent's DO
	const templateDoId = c.env.AGENT.idFromName(agent.id);
	const templateStub = c.env.AGENT.get(templateDoId);
	const stateRes = await templateStub.fetch(new Request("https://agent/state"));
	const templateState = (await stateRes.json()) as Record<string, unknown>;

	// Initialize instance DO with template config
	const instanceDoId = c.env.AGENT.idFromName(instanceId);
	const instanceStub = c.env.AGENT.get(instanceDoId);
	await instanceStub.fetch(
		new Request("https://agent/init", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: instanceId,
				name: templateState.name || agent.name,
				personality: templateState.personality || "",
				goal: templateState.goal || "",
				model: templateState.model || agent.model,
				guardrails: templateState.guardrails || {},
				welcomeMessage: templateState.welcomeMessage || "",
			}),
		}),
	);

	// Copy knowledge base from template to instance
	const kbRes = await templateStub.fetch(new Request("https://agent/knowledge"));
	const kbData = (await kbRes.json()) as {
		documents?: Array<{
			title: string;
			content: string;
			source: string;
			sourceUrl?: string;
		}>;
	};
	if (kbData.documents?.length) {
		for (const doc of kbData.documents) {
			await instanceStub.fetch(
				new Request("https://agent/knowledge", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(doc),
				}),
			);
		}
	}

	// Track subscription event for analytics
	await c.env.DB.prepare(
		`INSERT INTO usage (id, agent_id, user_id, event, metadata, created_at)
     VALUES (?1, ?2, ?3, 'subscribe', '{}', datetime('now'))`,
	).bind(crypto.randomUUID(), agent.id, session.uid).run();

	// Notify the agent creator
	const creator = await c.env.DB.prepare(
		"SELECT owner_id FROM agents WHERE id = ?1",
	).bind(agent.id).first<{ owner_id: string }>();
	if (creator && creator.owner_id !== session.uid) {
		const subscriber = await c.env.DB.prepare(
			"SELECT github_login FROM users WHERE id = ?1",
		).bind(session.uid).first<{ github_login: string }>();
		await createNotification(
			c.env.DB, creator.owner_id, "subscribe",
			`New subscriber: ${subscriber?.github_login || "someone"}`,
			`${subscriber?.github_login || "A user"} subscribed to ${agent.name}.`,
			agent.id,
		);
	}

	return c.json({ instanceId, agentId: agent.id, status: "active" }, 201);
});

/** List my subscribed instances. */
instanceRoutes.get("/my/instances", async (c) => {
	const session = await requireUser(c);
	const { results } = await c.env.DB.prepare(
		`SELECT i.id, i.agent_id, i.status, i.created_at,
            a.name, a.slug, a.description, a.category, a.icon, a.icon_bg
     FROM agent_instances i
     JOIN agents a ON a.id = i.agent_id
     WHERE i.user_id = ?1
     ORDER BY i.updated_at DESC`,
	)
		.bind(session.uid)
		.all();
	return c.json({ instances: results });
});

/** Register or update the local/managed runtime for my instance. */
instanceRoutes.post("/:instanceId/runtime", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);

	const body = await c.req.json<RuntimeRegistrationBody>();
	const endpointUrl = validateRuntimeEndpointUrl(body.endpointUrl);
	const tokenParts = await encodeRuntimeToken(c.env, body.token);
	const capabilities = JSON.stringify(safeCapabilities(body.capabilities));
	const placement = body.placement === "managed" ? "managed" : "local";
	const runnerVersion = String(body.runnerVersion || "").slice(0, 80);

	await c.env.DB.prepare(UPSERT_INSTANCE_RUNTIME_SQL)
		.bind(
			instanceId,
			session.uid,
			placement,
			endpointUrl,
			tokenParts.ciphertext,
			tokenParts.dekWrapped,
			tokenParts.iv,
			tokenParts.plaintext,
			capabilities,
			runnerVersion,
		)
		.run();

	// A fresh runner session can't own tasks paused on the previous one — expire
	// them so the board doesn't keep stale "Needs you" cards after a restart.
	await expireOrphanedRuntimeTasks(c.env, instanceId, session.uid).catch(() => undefined);

	// Read back to confirm (or just return success if readback fails)
	const runtime = await getRuntime(c.env, instanceId, session.uid);
	return c.json({
		runtime: runtime ? runtimeResponse(runtime) : { instanceId, endpointUrl, placement, status: "registered" },
	}, 201);
});

/** Read my registered runtime without exposing its token. */
instanceRoutes.get("/:instanceId/runtime", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await getRuntime(c.env, instanceId, session.uid);
	return c.json({ runtime: runtime ? runtimeResponse(runtime) : null });
});

/** Heartbeat from user/CLI after checking the FAGS runtime is online. */
instanceRoutes.post("/:instanceId/runtime/heartbeat", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	await requireRuntime(c.env, instanceId, session.uid);
	await updateRuntimeStatus(c.env, instanceId, session.uid, "online");
	return c.json({ success: true, status: "online" });
});

/** Probe a registered runtime's health and capabilities through PAGS. */
instanceRoutes.get("/:instanceId/runtime/status", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);

	try {
		const [healthRes, capabilitiesRes] = await Promise.all([
			callRuntime(c.env, runtime, "/health"),
			callRuntime(c.env, runtime, "/capabilities"),
		]);
		const health = await healthRes.json().catch(() => ({}));
		const capabilities = await capabilitiesRes.json().catch(() => ({}));
		const online = healthRes.ok && capabilitiesRes.ok;
		await updateRuntimeStatus(c.env, instanceId, session.uid, online ? "online" : "offline");
		return c.json({
			runtime: runtimeResponse({
				...runtime,
				status: online ? "online" : "offline",
				last_seen_at: new Date().toISOString(),
			}),
			health,
			capabilities,
		});
	} catch (error) {
		await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
		return c.json({
			runtime: runtimeResponse({ ...runtime, status: "offline" }),
			error: error instanceof Error ? error.message : String(error),
		}, 502);
	}
});

// ── Human takeover relay (console ⇄ PAGS ⇄ runner, through the tunnel) ──────

/** List active human-takeover sessions on my instance's runtime. */
instanceRoutes.get("/:instanceId/takeover", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const res = await callRuntime(c.env, runtime, "/takeover");
	return c.json(await runtimeJson(res) as object, runtimeStatus(res, 200));
});

/** Live JPEG frame of a paused (needs_human) task's browser page. */
instanceRoutes.get("/:instanceId/takeover/:taskId/frame", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const taskId = c.req.param("taskId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/frame`);
	return c.json(await runtimeJson(res) as object, runtimeStatus(res, 200));
});

/** Relay a human's mouse/keyboard input into the taken-over page. */
instanceRoutes.post("/:instanceId/takeover/:taskId/input", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const taskId = c.req.param("taskId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const body = await c.req.text();
	const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/input`, {
		method: "POST",
		body,
	});
	return c.json(await runtimeJson(res) as object, runtimeStatus(res, 200));
});

/** Resume after a human solved the challenge — re-check + submit. */
instanceRoutes.post("/:instanceId/takeover/:taskId/resume", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const taskId = c.req.param("taskId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/resume`, {
		method: "POST",
	});
	return c.json(await runtimeJson(res) as object, runtimeStatus(res, 200));
});

/** End a human-takeover session. */
instanceRoutes.post("/:instanceId/takeover/:taskId/end", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const taskId = c.req.param("taskId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const res = await callRuntime(c.env, runtime, `/takeover/${encodeURIComponent(taskId)}/end`, {
		method: "POST",
	});
	return c.json(await runtimeJson(res) as object, runtimeStatus(res, 200));
});

/** Remove my registered runtime. */
instanceRoutes.delete("/:instanceId/runtime", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	await c.env.DB.prepare(
		"DELETE FROM instance_runtimes WHERE instance_id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.run();
	return c.json({ success: true });
});

/** List tasks on my registered runtime. */
instanceRoutes.get("/:instanceId/tasks", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await getRuntime(c.env, instanceId, session.uid);
	if (!runtime) {
		const tasks = await mirroredRuntimeTasks(c.env, instanceId, session.uid);
		const hasRuntimeSetupTask = tasks.some(
			(task) => isRecord(task) && task.id === fagsRuntimeSetupTaskId(instanceId),
		);
		if (!hasRuntimeSetupTask) tasks.unshift(fagsRuntimeSetupTask(instanceId));
		return c.json({
			tasks,
			runtimeUnavailable: true,
			error: "Runtime not registered",
		});
	}
	try {
		const res = await callRuntime(c.env, runtime, "/tasks");
		const payload = await runtimeJson(res);
		if (res.ok) {
			await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
			return c.json(payload, 200);
		}
		await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
		return c.json({
			tasks: await mirroredRuntimeTasks(c.env, instanceId, session.uid),
			runtimeUnavailable: true,
			error: runtimeErrorPayload(payload),
		});
	} catch (error) {
		await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
		return c.json({
			tasks: await mirroredRuntimeTasks(c.env, instanceId, session.uid),
			runtimeUnavailable: true,
			error: error instanceof Error ? error.message : String(error),
		});
	}
});

/** Create a task on my registered runtime. */
instanceRoutes.post("/:instanceId/tasks", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const body = normalizeRunnerTaskBody(await c.req.json());
	const res = await callRuntime(c.env, runtime, "/tasks", {
		method: "POST",
		body: JSON.stringify(body),
	});
	const payload = await runtimeJson(res);
	if (res.ok) {
		await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
		await mirrorTaskLifecycleEvents(c.env, instanceId, session.uid, payload, "created");
	}
	return c.json(payload, runtimeStatus(res, 202));
});

/** Read a task from my registered runtime. */
instanceRoutes.get("/:instanceId/tasks/:taskId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const taskId = c.req.param("taskId");
	try {
		const res = await callRuntime(c.env, runtime, `/tasks/${encodeURIComponent(taskId)}`);
		const payload = await runtimeJson(res);
		if (res.ok) {
			await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
			return c.json(payload, 200);
		}
		const mirrored = await mirroredRuntimeTask(c.env, instanceId, session.uid, taskId);
		if (mirrored) return c.json({ ...(isRecord(mirrored) ? mirrored : {}), runtimeUnavailable: true });
		return c.json(payload, runtimeStatus(res, 200));
	} catch (error) {
		const mirrored = await mirroredRuntimeTask(c.env, instanceId, session.uid, taskId);
		if (mirrored) return c.json({ ...(isRecord(mirrored) ? mirrored : {}), runtimeUnavailable: true });
		throw error;
	}
});

/** Approve a task waiting on local human approval. */
instanceRoutes.post("/:instanceId/tasks/:taskId/approve", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const res = await callRuntime(
		c.env,
		runtime,
		`/tasks/${encodeURIComponent(c.req.param("taskId"))}/approve`,
		{ method: "POST" },
	);
	const payload = await runtimeJson(res);
	if (res.ok) {
		await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
		await mirrorTaskLifecycleEvents(c.env, instanceId, session.uid, payload, "approved");
	}
	return c.json(payload, runtimeStatus(res, 200));
});

/** Cancel a runtime task. */
instanceRoutes.post("/:instanceId/tasks/:taskId/cancel", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const runtime = await requireRuntime(c.env, instanceId, session.uid);
	const res = await callRuntime(
		c.env,
		runtime,
		`/tasks/${encodeURIComponent(c.req.param("taskId"))}/cancel`,
		{ method: "POST" },
	);
	const payload = await runtimeJson(res);
	if (res.ok) {
		await mirrorRuntimeTasks(c.env, instanceId, session.uid, payload);
		await mirrorTaskLifecycleEvents(c.env, instanceId, session.uid, payload, "cancelled");
	}
	return c.json(payload, runtimeStatus(res, 200));
});

/** Read recent task events from my registered runtime. */
instanceRoutes.get("/:instanceId/task-events", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	await requireOwnedInstance(c.env, instanceId, session.uid);
	const rawLimit = Number(c.req.query("limit") || "100");
	const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.trunc(rawLimit))) : 100;
	const runtime = await getRuntime(c.env, instanceId, session.uid);
	if (!runtime) {
		const events = await mirroredRuntimeEvents(c.env, instanceId, session.uid, limit);
		const tasks = events.length ? [] : await mirroredRuntimeTasks(c.env, instanceId, session.uid, limit);
		return c.json({
			events: events.length ? events : syntheticEventsFromTasks(tasks.length ? tasks : [fagsRuntimeSetupTask(instanceId)]),
			runtimeUnavailable: true,
			error: "Runtime not registered",
		});
	}
	try {
		const res = await callRuntime(c.env, runtime, `/events?limit=${encodeURIComponent(String(limit))}`);
		const payload = await runtimeJson(res);
		if (res.ok) {
			await mirrorRuntimeEvents(c.env, instanceId, session.uid, payload);
			return c.json(payload, 200);
		}
		await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
		const events = await mirroredRuntimeEvents(c.env, instanceId, session.uid, limit);
		const tasks = events.length ? [] : await mirroredRuntimeTasks(c.env, instanceId, session.uid, limit);
		return c.json({
			events: events.length ? events : syntheticEventsFromTasks(tasks),
			runtimeUnavailable: true,
			error: runtimeErrorPayload(payload),
		});
	} catch (error) {
		await updateRuntimeStatus(c.env, instanceId, session.uid, "offline");
		const events = await mirroredRuntimeEvents(c.env, instanceId, session.uid, limit);
		const tasks = events.length ? [] : await mirroredRuntimeTasks(c.env, instanceId, session.uid, limit);
		return c.json({
			events: events.length ? events : syntheticEventsFromTasks(tasks),
			runtimeUnavailable: true,
			error: error instanceof Error ? error.message : String(error),
		});
	}
});

/** Chat with my instance of an agent. */
instanceRoutes.post("/:instanceId/chat", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");
	const { message } = await c.req.json<{ message: string }>();
	if (!message) throw new HttpError(400, "message required");

	// Verify ownership
	const instance = await c.env.DB.prepare(
		"SELECT id, agent_id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first<InstanceRow>();
	if (!instance) throw new HttpError(404, "Instance not found");

	const doId = c.env.AGENT.idFromName(instanceId);
	const stub = c.env.AGENT.get(doId);
	// Pass agentId/agentName for auto-init if DO has no state
	const agentMeta = await c.env.DB.prepare(
		"SELECT name FROM agents WHERE id = ?1",
	).bind(instance.agent_id).first<{ name: string }>();

	const doRes = await stub.fetch(
		new Request("https://agent/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message, channel: "chat", userId: session.uid,
				agentId: instanceId, agentName: agentMeta?.name || "Agent",
			}),
		}),
	);

	// Track usage
	await c.env.DB.prepare(
		`INSERT INTO usage (id, agent_id, user_id, event, metadata, created_at)
     VALUES (?1, ?2, ?3, 'instance_chat', ?4, datetime('now'))`,
	)
		.bind(
			crypto.randomUUID(),
			instance.agent_id,
			session.uid,
			JSON.stringify({ instanceId }),
		)
		.run();

	const data = await doRes.json();
	if (doRes.ok) {
		await deleteMirroredRuntimeTask(
			c.env,
			instanceId,
			session.uid,
			cloudflareAiSetupTaskId(instanceId),
		);
	} else if (
		isRecord(data) &&
		isCloudflareAiCredentialsError(data.error)
	) {
		const task = cloudflareAiSetupTask(instanceId, String(data.error));
		await mirrorRuntimeTask(c.env, instanceId, session.uid, task);
		await mirrorSyntheticTaskEvent(
			c.env,
			instanceId,
			session.uid,
			task,
			"setup.blocked",
			task.updatedAt,
			{ provider: "cloudflare" },
		);
	}
	return c.json(data, (doRes.ok ? 200 : doRes.status) as ContentfulStatusCode);
});

/** Get messages for my instance. */
instanceRoutes.get("/:instanceId/messages", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first();
	if (!instance) throw new HttpError(404, "Instance not found");

	const limit = c.req.query("limit") || "50";
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(
		new Request(`https://agent/messages?limit=${limit}`),
	);
	return c.json(await doRes.json());
});

/** Add knowledge to my instance (client's own docs). */
instanceRoutes.post("/:instanceId/knowledge", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first();
	if (!instance) throw new HttpError(404, "Instance not found");

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(
		new Request("https://agent/knowledge", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(await c.req.json()),
		}),
	);
	return c.json(
		await doRes.json(),
		(doRes.ok ? 201 : doRes.status) as ContentfulStatusCode,
	);
});

/** Delete a doc from my instance's knowledge base. */
instanceRoutes.delete("/:instanceId/knowledge/:docId", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first();
	if (!instance) throw new HttpError(404, "Instance not found");

	const docId = c.req.param("docId");
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(
		new Request(`https://agent/knowledge/${docId}`, { method: "DELETE" }),
	);
	return c.json(await doRes.json());
});

/** Import URL into my instance's knowledge base. */
instanceRoutes.post("/:instanceId/knowledge/ingest-url", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first();
	if (!instance) throw new HttpError(404, "Instance not found");

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(
		new Request("https://agent/knowledge/ingest-url", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(await c.req.json()),
		}),
	);
	return c.json(
		await doRes.json(),
		(doRes.ok ? 201 : doRes.status) as ContentfulStatusCode,
	);
});

/** Get my instance's knowledge base. */
instanceRoutes.get("/:instanceId/knowledge", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	const instance = await c.env.DB.prepare(
		"SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first();
	if (!instance) throw new HttpError(404, "Instance not found");

	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(instanceId));
	const doRes = await stub.fetch(new Request("https://agent/knowledge"));
	return c.json(await doRes.json());
});

/** Cancel subscription / deactivate instance. */
instanceRoutes.post("/:instanceId/cancel", async (c) => {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId");

	const instance = await c.env.DB.prepare(
		"SELECT id, agent_id FROM agent_instances WHERE id = ?1 AND user_id = ?2",
	)
		.bind(instanceId, session.uid)
		.first<InstanceRow>();
	if (!instance) throw new HttpError(404, "Instance not found");

	await c.env.DB.batch([
		c.env.DB.prepare(
			`UPDATE agent_instances SET status = 'canceled', updated_at = datetime('now') WHERE id = ?1`,
		).bind(instanceId),
		c.env.DB.prepare(
			`UPDATE subscriptions SET status = 'canceled', canceled_at = datetime('now')
       WHERE agent_id = ?1 AND user_id = ?2 AND status = 'active'`,
		).bind(instance.agent_id, session.uid),
	]);

	return c.json({ success: true });
});
