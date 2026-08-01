/**
 * The declarative agent definition — one validated shape describing everything an
 * agent IS as data, so a creator (or the authoring UI / AI builder) can define an
 * agent without a platform code change. This is the "creator way" made concrete and
 * the single source of truth for agent-config validation.
 *
 * It composes the existing per-field sanitizers (capabilities, tools, settings schema)
 * and the canonical guardrails normalizer rather than re-validating anything, and it
 * emits exactly the `agents.config` shape the platform already reads (see the repo-chat
 * seed, migration 0032): `{ identity: { personality, goal, guardrails, welcomeMessage },
 * capabilities: { surfaces, runtime, workflow, tools }, settingsSchema? }`.
 */

import { defaultGuardrails } from "../agent-do-prompt.js";
import type { Guardrails } from "../agent-types.js";
import {
	type DeclaredCapabilities,
	type SettingsField,
	sanitizeDeclaredCapabilities,
	sanitizeSettingsSchema,
} from "./agent-capabilities.js";

/** Who the agent is + how it behaves (applied to each subscriber's instance DO). */
export interface AgentIdentity {
	personality: string;
	goal: string;
	guardrails: Guardrails;
	welcomeMessage: string;
}

/** A complete, validated declarative agent definition = the stored `agents.config`. */
export interface AgentDefinition {
	identity: AgentIdentity;
	capabilities: DeclaredCapabilities;
	settingsSchema?: SettingsField[];
}

const MAX_PERSONALITY = 4000;
const MAX_GOAL = 2000;
const MAX_WELCOME = 1000;

function boundedString(value: unknown, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Validate + normalize raw creator input into the canonical agent config. Never throws
 * — every field is coerced or dropped to a safe default, mirroring the other sanitizers
 * — so it is safe to call directly on an untrusted request body.
 */
export function sanitizeAgentDefinition(input: unknown): AgentDefinition {
	const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const identityIn = (o.identity && typeof o.identity === "object" ? o.identity : {}) as Record<string, unknown>;

	const identity: AgentIdentity = {
		personality: boundedString(identityIn.personality, MAX_PERSONALITY),
		goal: boundedString(identityIn.goal, MAX_GOAL),
		guardrails: defaultGuardrails(identityIn.guardrails as Partial<Guardrails> | undefined),
		welcomeMessage: boundedString(identityIn.welcomeMessage, MAX_WELCOME),
	};

	const def: AgentDefinition = {
		identity,
		capabilities: sanitizeDeclaredCapabilities(o.capabilities),
	};
	const settingsSchema = sanitizeSettingsSchema(o.settingsSchema);
	if (settingsSchema) def.settingsSchema = settingsSchema;
	return def;
}
