/**
 * A coder's Brain model, as one setting (#1043).
 *
 * The Brain is the ADVISORY and orchestration layer: the Assistant chat and its tools, the coder
 * brain's escalation decisions (#1025), the Co-pilot reading the terminal, the Loop orchestrator, the
 * repo-agent route, and the Application Runner's checkpoint supervisor (#982). It runs on the owner's
 * own provider key — the one place an API key is allowed (#1042) — and it never edits, tests, deploys
 * or signs anything in. The Pilot that drives the coding engine stays on Claude Sonnet, and the
 * engine itself is the subscription CLI #1042 governs: nothing here reads or writes an engine preset,
 * a sign-in mode or an API-coding confirmation.
 *
 * Stored where the chat already kept it — the instance DO's `state.model` + `modelChosen`, set by
 * `PUT /v1/instances/:id/state` (the Brain card) and, through the same check, by `set_coder_brain`.
 */
import { TOOL_CAPABLE_MODELS } from "../agent-do-prompt.js";
import type { AgentState } from "../agent-types.js";
import { brainModel, brainModelOptions, isWorkersAiModel, offCatalogueModel } from "./brain-models.js";
import { cloudflareAiCredentialProblem } from "./cloudflare-ai-check.js";
import type { Env } from "../types.js";

/** What every advisory surface ran before the selector reached it — and runs while nothing is picked. */
export const DEFAULT_BRAIN_MODEL = "claude-sonnet-4-6";

export interface InstanceBrain {
	model: string;
	/** The owner picked it (#852): a Workers AI pick then runs on Workers AI (`honorModel`). */
	modelChosen: boolean;
}

/** The Brain from an instance's DO state. Anything malformed or off the catalogue is the default, never an arbitrary id. */
export function brainFromState(state: Partial<AgentState> | null | undefined): InstanceBrain {
	const model = typeof state?.model === "string" && brainModel(state.model) ? state.model : DEFAULT_BRAIN_MODEL;
	return { model, modelChosen: state?.modelChosen === true && model === state?.model };
}

/** Read it. Null when the DO cannot be asked — a caller decides what an unanswerable read means. */
export async function readInstanceBrain(env: Pick<Env, "AGENT">, instanceId: string): Promise<InstanceBrain | null> {
	try {
		const res = await env.AGENT.get(env.AGENT.idFromName(instanceId)).fetch(new Request("https://agent/state"));
		if (!res.ok) return null;
		return brainFromState((await res.json().catch(() => null)) as Partial<AgentState> | null);
	} catch {
		return null;
	}
}

/**
 * The model and provider routing an advisory call should use: the Brain the owner PICKED, else the
 * default these surfaces always ran on — so nothing changes for a coder whose owner has not chosen.
 */
export async function advisoryBrain(env: Pick<Env, "AGENT">, instanceId: string | null | undefined): Promise<InstanceBrain> {
	const brain = instanceId ? await readInstanceBrain(env, instanceId) : null;
	return brain?.modelChosen ? brain : { model: DEFAULT_BRAIN_MODEL, modelChosen: false };
}

/**
 * Why an instance cannot take `model` as its brain (#852), or null when it can: it must call tools
 * (a brain that cannot confabulates instead), it must be in the brain catalogue (#853 finding 7: the
 * Anthropic brain always runs claude-sonnet-4-6, so a Haiku or Opus pick ran — and billed — Sonnet
 * under another name), and a Workers AI pick needs Cloudflare credentials that Cloudflare accepts
 * (#853 finding 8) — 502, not 400, when Cloudflare cannot be asked.
 */
export async function brainModelRefusal(env: Env, uid: string, model: unknown): Promise<{ status: 400 | 502; error: string } | null> {
	const refuse = (error: string) => ({ status: 400 as const, error });
	const options = brainModelOptions();
	if (typeof model !== "string" || !model.trim()) return refuse(`A model id is required. Brain models: ${options}.`);
	if (!TOOL_CAPABLE_MODELS.has(model)) return refuse(`${model} cannot call tools, so it cannot run this agent's brain. Brain models: ${options}.`);
	const offCatalogue = offCatalogueModel(model);
	if (offCatalogue) return refuse(offCatalogue);
	if (!isWorkersAiModel(model)) return null;
	const cf = await env.DB.prepare("SELECT 1 FROM user_api_keys WHERE user_id = ?1 AND provider = 'cloudflare'").bind(uid).first();
	if (!cf) return refuse(`${model} runs on Cloudflare Workers AI, and no Cloudflare credentials are stored. Add your Cloudflare account ID and API token in Profile → API Keys, then pick it again.`);
	return cloudflareAiCredentialProblem(env, uid);
}

/** Set it — after {@link brainModelRefusal} said yes. `modelChosen` is set here, never by a caller. */
export async function writeInstanceBrain(env: Pick<Env, "AGENT">, instanceId: string, model: string): Promise<void> {
	const res = await env.AGENT.get(env.AGENT.idFromName(instanceId)).fetch(
		new Request("https://agent/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, modelChosen: true }) }),
	);
	if (!res.ok) throw new Error(`The brain model could not be saved (HTTP ${res.status}).`);
}
