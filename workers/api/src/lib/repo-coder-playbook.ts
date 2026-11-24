/**
 * The effective Repo Coder playbook (#1691): ONE deterministic resolution of the free-text Instructions
 * that apply to an exact (template, instance, registered repo), with provenance.
 *
 * ## Layers, lowest to highest precedence (later wins where two layers conflict)
 *
 *   1. template  — the provider's defaults, `agents.config.instructions` of the instance's own template.
 *   2. instance  — the owner's scoped overrides for every repo of the instance (Special Instructions,
 *                  `agent_instances.config.specialInstructions`).
 *   3. repo      — project conventions for ONE registered repo (`coding_repos.instructions`, e.g. its
 *                  test commands). Most specific scope, so it speaks last.
 *
 * These are the stored Instructions the platform already has; there is no parallel "playbook" store.
 * Text order is precedence order, so `text` is the layers joined by a blank line — with no template
 * layer it is byte-for-byte what `readStandingInstructions` and the direct turn path already build
 * (instance, then repo). That is the property this module must not break.
 *
 * ## What this is NOT
 *
 * Free text is guidance, never authority. The result carries no capability, merge/question policy,
 * approval or check setting, and nothing here reads or writes one: typed policy (`mergePolicy`, the
 * question policy, write scope, approval gates, mandatory checks) is resolved elsewhere from typed
 * columns and cannot be widened, narrowed or bypassed by what a layer says. The coder never writes
 * any layer here (this module has no write path). The Operator Manual is caller reference and is
 * deliberately not a layer.
 *
 * ## Isolation
 *
 * Every read is owner-scoped: the instance by (id, user), the template by that instance's own
 * `agent_id`, the repo by (id, instance, user). A repo that is not that instance's contributes no
 * layer, so another repo's — or another owner's — text can never reach the result.
 *
 * ## Limitations (this slice)
 *
 * - Where template guidance lives today: there is no provider-editable coding Instructions field.
 *   The template DO state (`goal`/`personality`, edited by `PUT /v1/agents/:id/state`, snapshotted by
 *   `agent_versions`) is chat persona copied ONCE into each instance at subscribe, and
 *   `agents.config.behaviour` is typed style. So `agents.config.instructions` is the template layer,
 *   and NOTHING writes it yet: it is empty on every template until a follow-up adds an authenticated,
 *   versioned provider edit. Resolving an empty layer is the behaviour-preserving default.
 * - The resolver is not yet the single source for the Pilot (`coding-standing-constraints.ts`) or
 *   the direct turn path (`routes/coding-drive.ts`); both still join instance + repo themselves.
 *   Delivering this view across callers and launch routes, and showing it in UI/MCP, is #1692.
 */
import type { Env } from "../types.js";

export type PlaybookLayerSource = "template" | "instance" | "repo";

export interface PlaybookLayer {
	source: PlaybookLayerSource;
	/** Where the text came from — ids only, so a caller can attribute it without a second lookup. */
	origin: { agentId?: string; instanceId?: string; repoId?: string };
	text: string;
}

export interface EffectivePlaybook {
	/** The layers joined in precedence order; undefined when every layer is empty. */
	text: string | undefined;
	/** Non-empty layers only, lowest precedence first. */
	layers: PlaybookLayer[];
	/** Highest precedence first — what wins on a conflict. */
	precedence: readonly PlaybookLayerSource[];
}

export const PLAYBOOK_PRECEDENCE: readonly PlaybookLayerSource[] = ["repo", "instance", "template"];

export interface PlaybookInputs {
	template?: { agentId: string; text?: string | null };
	instance?: { instanceId: string; text?: string | null };
	repo?: { repoId: string; text?: string | null };
}

/** Pure composition. A blank or whitespace-only layer is absent; present text is kept verbatim. */
export function composePlaybook(inputs: PlaybookInputs): EffectivePlaybook {
	const layers: PlaybookLayer[] = [];
	const add = (source: PlaybookLayerSource, origin: PlaybookLayer["origin"], text: string | null | undefined) => {
		if (typeof text === "string" && text.trim()) layers.push({ source, origin, text });
	};
	add("template", { agentId: inputs.template?.agentId }, inputs.template?.text);
	add("instance", { instanceId: inputs.instance?.instanceId }, inputs.instance?.text);
	add("repo", { repoId: inputs.repo?.repoId }, inputs.repo?.text);
	return { text: layers.map((l) => l.text).join("\n\n") || undefined, layers, precedence: PLAYBOOK_PRECEDENCE };
}

function parseJson(raw: string | null | undefined): Record<string, unknown> {
	try {
		const v = JSON.parse(raw || "{}");
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const asText = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Resolve the effective playbook for one owner's instance + registered repo. */
export async function resolveRepoCoderPlaybook(env: Env, input: { instanceId: string; userId: string; repoId: string }): Promise<EffectivePlaybook> {
	const inst = await env.DB.prepare("SELECT agent_id, config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(input.instanceId, input.userId)
		.first<{ agent_id: string; config: string | null }>();
	if (!inst) return composePlaybook({});
	const agent = await env.DB.prepare("SELECT config FROM agents WHERE id = ?1")
		.bind(inst.agent_id)
		.first<{ config: string | null }>();
	const repo = await env.DB.prepare("SELECT instructions FROM coding_repos WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
		.bind(input.repoId, input.instanceId, input.userId)
		.first<{ instructions: string | null }>();
	return composePlaybook({
		template: { agentId: inst.agent_id, text: asText(parseJson(agent?.config).instructions) },
		instance: { instanceId: input.instanceId, text: asText(parseJson(inst.config).specialInstructions) },
		repo: repo ? { repoId: input.repoId, text: repo.instructions } : undefined,
	});
}
