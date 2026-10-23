/** Pilot routing is separate from advisory Brain and the local coding CLI (#1316). */
import type { Env } from "../types.js";
import { patchInstanceConfig } from "./instance-config.js";

export const DEFAULT_PILOT_MODEL = "claude-sonnet-4-6" as const;
export const PILOT_MODEL_OPTIONS = [
	{ id: DEFAULT_PILOT_MODEL, label: "Sonnet 4.6", hint: "Default controller; Anthropic when configured, otherwise the inherited Cloudflare route" },
	{ id: "claude-haiku-5-5", label: "Haiku 5.5 canary", hint: "Experimental routine decisions; Sonnet checks endings and owner decisions. Both require an Anthropic API key" },
] as const;
export type PilotModelId = (typeof PILOT_MODEL_OPTIONS)[number]["id"];

export function pilotModelProblem(model: unknown): string | null {
	return PILOT_MODEL_OPTIONS.some((m) => m.id === model) ? null : "pilotModel must be claude-sonnet-4-6 or claude-haiku-5-5.";
}

export function pilotModelFrom(config: unknown): PilotModelId {
	let value = config;
	if (typeof value === "string") {
		try { value = JSON.parse(value); } catch { return DEFAULT_PILOT_MODEL; }
	}
	const pilot = value && typeof value === "object" ? (value as { pilot?: { model?: unknown } }).pilot : undefined;
	return pilot && !pilotModelProblem(pilot.model) ? pilot.model as PilotModelId : DEFAULT_PILOT_MODEL;
}

export async function readPilotModel(env: Pick<Env, "DB">, instanceId: string, userId: string): Promise<PilotModelId> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, userId).first<{ config: string | null }>();
	if (!row) throw new Error("instance not found");
	return pilotModelFrom(row.config);
}

export async function setPilotModel(env: Env, instanceId: string, userId: string, model: unknown): Promise<void> {
	const problem = pilotModelProblem(model);
	if (problem) throw new Error(problem);
	if (!(await patchInstanceConfig(env, instanceId, userId, "pilot", { model }))) throw new Error("instance not found");
}
