/**
 * The Brain-model card (#1043) — what each choice is, what it needs, and what confirming it says.
 *
 * The Brain is advisory and orchestration only. It is a different thing from the Coding engine card
 * below it: the engine is your subscription CLI that edits, tests and deploys code (#1042), and no
 * Brain choice can change it, start it, or stand in for it. The model list and its cost hints are the
 * API's own (`workers/api/src/lib/brain-models.ts`), so DeepSeek appears only if it is added there.
 */
import { BRAIN_MODELS, type BrainModel, brainProviderLabel } from "../../../../workers/api/src/lib/brain-models";

export const BRAIN_CARD_TITLE = "Brain model";
export const BRAIN_CARD_SCOPE = "Advisory and orchestration only. It never edits, tests or deploys code.";
export const BRAIN_SURFACES =
	"Used for: the assistant chat and its tools, coder-brain decisions, the Co-pilot reading the terminal, Loop orchestration and the job-application supervisor. The Pilot that drives the coding CLI always uses Claude Sonnet, and the coding engine stays your subscription CLI.";

/** `GET /v1/keys/status` — provider ids with whether a credential is stored; never a key value. */
export interface KeysStatusResponse {
	providers?: Array<{ id: string; hasKey?: boolean }>;
}

/** Which brain credentials are stored, from {@link KeysStatusResponse}. */
export function storedBrainKeys(status: KeysStatusResponse): StoredBrainKeys {
	const has = (id: string) => !!status.providers?.find((p) => p.id === id)?.hasKey;
	return { anthropic: has("anthropic"), cloudflare: has("cloudflare") };
}

/** Which brain credentials are stored — null while unknown, which offers the choice and lets the server decide. */
export interface StoredBrainKeys {
	anthropic: boolean | null;
	cloudflare: boolean | null;
}

export interface BrainOption {
	id: string;
	label: string;
	provider: BrainModel["provider"];
	providerLabel: string;
	costNote: string;
	/** False when its prerequisite is known to be missing — the choice is shown, disabled, with why. */
	available: boolean;
	prerequisite: string | null;
}

export function brainOptions(keys: StoredBrainKeys): BrainOption[] {
	return BRAIN_MODELS.map((m) => {
		const cloudflare = m.provider === "cloudflare";
		const missing = cloudflare ? keys.cloudflare === false : keys.anthropic === false;
		return {
			id: m.id,
			label: m.label,
			provider: m.provider,
			providerLabel: brainProviderLabel(m.provider),
			costNote: m.hint,
			// A Cloudflare pick is refused by the API without credentials, so it is not offered without them.
			// An Anthropic pick can be saved; it runs once the key is stored, and the note says so.
			available: !(cloudflare && missing),
			prerequisite: missing
				? cloudflare
					? "Needs your Cloudflare account ID and API token in Profile → API Keys first."
					: "Runs on your Anthropic API key — add it in Profile → API Keys."
				: null,
		};
	});
}

/** What the confirmation shows before a Brain model is saved. */
export function brainConfirmation(option: BrainOption): { provider: string; model: string; costNote: string; billingWarning: string } {
	const source = option.provider === "cloudflare" ? "your own Cloudflare Workers AI account" : "your own Anthropic API key";
	return {
		provider: option.providerLabel,
		model: option.label,
		costNote: option.costNote,
		billingWarning: `Billed per token to ${source}, separately from any subscription. Only the Brain uses this — your coding engine stays on your subscription CLI.`,
	};
}

export const ENGINE_CARD_SCOPE = "Your subscription CLI on your machine — the only thing that edits, tests and deploys code. The Brain model above never changes it.";
