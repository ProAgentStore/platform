/**
 * A single, secret-safe description of how one owned instance executes work.
 *
 * This is intentionally a projection rather than a convenient dump of the instance, runtime,
 * connection, and run rows. Those rows contain runtime bearer tokens, encrypted credential
 * material, free-form connection config, and traces. Adding a field here is an API and privacy
 * decision; `instance-description.test.ts` protects that boundary.
 */
import type { Context, Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
import { parseBoundRunnerNode } from "../lib/runtime-nodes.js";
import type { Env } from "../types.js";
import { getRuntime, listRuntimeNodes, requireOwnedInstance, runtimeNodeResponse, runtimeResponse } from "./instances-runtime.js";

type RunKind = "browser" | "artifact" | "apply" | "runtime_task";

interface RunRow {
	id: string;
	status: string;
	engine_auth: string | null;
	runner_node: string | null;
	policy?: string | null;
	updated_at: string | number | null;
	type?: string | null;
}

interface ConnectionRow {
	id: string;
	source_instance_id: string;
	target_instance_id: string;
	event_type: string;
	action: string;
	enabled: number;
	source_name: string | null;
	source_slug: string | null;
	target_name: string | null;
	target_slug: string | null;
}

interface TemplateRow {
	agent_id: string;
	agent_name: string;
	agent_slug: string;
	agent_category: string | null;
	agent_config: string | null;
}

function safePolicy(value: string | null | undefined): { engine: string | null; authMode: string | null; browserProfile: string | null } {
	try {
		const p = JSON.parse(value || "{}") as Record<string, unknown>;
		return {
			engine: typeof p.engine === "string" ? p.engine : null,
			authMode: typeof p.authMode === "string" ? p.authMode : null,
			browserProfile: typeof p.browserProfile === "string" ? p.browserProfile : null,
		};
	} catch {
		return { engine: null, authMode: null, browserProfile: null };
	}
}

function runView(kind: RunKind, row: RunRow) {
	const policy = safePolicy(row.policy);
	return {
		kind,
		id: row.id,
		status: row.status,
		engine: policy.engine,
		authMode: policy.authMode ?? row.engine_auth,
		browserProfile: policy.browserProfile,
		runnerNode: row.runner_node || null,
		updatedAt: row.updated_at ?? null,
		...(kind === "runtime_task" && row.type ? { taskType: row.type } : {}),
	};
}

function active(status: string): boolean {
	return !["completed", "failed", "cancelled", "submitted", "blocked"].includes(status);
}

function timeOf(value: string | number | null | undefined): number {
	if (typeof value === "number") return value;
	return value ? Date.parse(value.replace(" ", "T") + (value.includes("T") ? "" : "Z")) || 0 : 0;
}

function executionView(runtime: ReturnType<typeof agentCapabilities>["runtime"], run: ReturnType<typeof runView> | null) {
	if (runtime === "browser") return { kind: "legacy_browser", engine: "claude_api", browser: "managed" };
	if (runtime === "local_browser") return { kind: "local_cli_browser", engine: run?.engine ?? "configured_per_run", browser: "playwright" };
	if (runtime === "local_apply") return { kind: "local_cli_apply", engine: run?.engine ?? "configured_per_run", browser: "playwright" };
	if (runtime === "local_artifact") return { kind: "local_cli_artifact", engine: run?.engine ?? "configured_per_run", browser: null };
	if (runtime === "coding") return { kind: "coding_cli", engine: run?.engine ?? "configured_per_run", browser: null };
	return { kind: "server", engine: null, browser: null };
}

/** Schema provenance, not an assertion that a particular remote database has applied a migration. */
const STORAGE_MIGRATIONS = {
	handoffs: "0056_agent_connections",
	browserRuns: "0175_local_browser_runs",
	tailorRuns: "0180_application_tailor",
	applicationRuns: "0181_application_runner",
} as const;

export async function describeInstance(env: Env, instanceId: string, userId: string) {
	const instance = await requireOwnedInstance(env, instanceId, userId);
	const template = await env.DB.prepare(
		"SELECT id AS agent_id, name AS agent_name, slug AS agent_slug, category AS agent_category, config AS agent_config FROM agents WHERE id = ?1",
	).bind(instance.agent_id).first<TemplateRow>();
	const capabilities = agentCapabilities({ slug: template?.agent_slug ?? "", category: template?.agent_category ?? "", config: template?.agent_config ?? null });
	const [runtime, nodes, credentialPosture, connections, browser, artifact, apply, task] = await Promise.all([
		getRuntime(env, instanceId, userId),
		listRuntimeNodes(env, instanceId, userId),
		env.DB.prepare("SELECT COUNT(*) AS stored, COALESCE(SUM(CASE WHEN secrets_ciphertext IS NOT NULL THEN 1 ELSE 0 END), 0) AS protected FROM agent_credentials WHERE instance_id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ stored: number; protected: number }>(),
		env.DB.prepare(`SELECT c.id, c.source_instance_id, c.target_instance_id, c.event_type, c.action, c.enabled,
			sa.name AS source_name, sa.slug AS source_slug, ta.name AS target_name, ta.slug AS target_slug
			FROM agent_connections c
			JOIN agent_instances si ON si.id = c.source_instance_id AND si.user_id = c.user_id
			JOIN agents sa ON sa.id = si.agent_id
			JOIN agent_instances ti ON ti.id = c.target_instance_id AND ti.user_id = c.user_id
			JOIN agents ta ON ta.id = ti.agent_id
			WHERE c.user_id = ?1 AND (c.source_instance_id = ?2 OR c.target_instance_id = ?2)
			ORDER BY c.created_at DESC LIMIT 100`).bind(userId, instanceId).all<ConnectionRow>(),
		env.DB.prepare("SELECT id, status, engine_auth, runner_node, policy, updated_at FROM local_browser_runs WHERE instance_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC LIMIT 1").bind(instanceId, userId).first<RunRow>(),
		env.DB.prepare("SELECT id, status, engine_auth, runner_node, policy, updated_at FROM local_artifact_runs WHERE instance_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC LIMIT 1").bind(instanceId, userId).first<RunRow>(),
		env.DB.prepare("SELECT id, status, engine_auth, runner_node, policy, updated_at FROM local_apply_runs WHERE instance_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC LIMIT 1").bind(instanceId, userId).first<RunRow>(),
		env.DB.prepare("SELECT id, status, type, updated_at FROM instance_runtime_tasks WHERE instance_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC LIMIT 1").bind(instanceId, userId).first<RunRow>(),
	]);

	const runs = ([browser && runView("browser", browser), artifact && runView("artifact", artifact), apply && runView("apply", apply), task && runView("runtime_task", task)]).filter(Boolean) as ReturnType<typeof runView>[];
	const currentRun = runs.filter((r) => active(r.status)).sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt))[0] ?? null;
	const recentRun = currentRun ?? runs.sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt))[0] ?? null;
	const handoffs = (connections.results ?? []).map((row) => ({
		id: row.id,
		direction: row.source_instance_id === instanceId ? "outgoing" : "incoming",
		eventType: row.event_type,
		action: row.action,
		enabled: Boolean(row.enabled),
		peer: row.source_instance_id === instanceId
			? { instanceId: row.target_instance_id, name: row.target_name, slug: row.target_slug }
			: { instanceId: row.source_instance_id, name: row.source_name, slug: row.source_slug },
	}));

	return {
		instance: { id: instance.id, status: instance.status, createdAt: instance.created_at, updatedAt: instance.updated_at },
		template: { id: instance.agent_id, name: template?.agent_name ?? null, slug: template?.agent_slug ?? null, category: template?.agent_category ?? null },
		execution: executionView(capabilities.runtime, recentRun),
		capabilities: { runtime: capabilities.runtime, workflow: capabilities.workflow, surfaces: capabilities.surfaces, declaredTools: capabilities.tools ?? [] },
		runtime: { boundNode: parseBoundRunnerNode(instance.config) || null, default: runtime ? runtimeResponse(runtime) : null, nodes: nodes.map(runtimeNodeResponse) },
		credentialPosture: { stored: Number(credentialPosture?.stored ?? 0), protected: Number(credentialPosture?.protected ?? 0) },
		handoffs,
		currentRun,
		recentRun,
		storageMigrations: STORAGE_MIGRATIONS,
	};
}

export function registerInstanceDescriptionRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/description", async (c: Context<{ Bindings: Env }>) => {
		const session = await requireUser(c);
		return c.json(await describeInstance(c.env, c.req.param("instanceId") ?? "", session.uid));
	});
}
