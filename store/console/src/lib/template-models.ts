/**
 * The agent-template model picker (#863): the brain catalogue — the API's own list, the one the
 * instance picker (`BrainModelCard`) shows — and nothing else. It used to offer Claude Opus/Haiku,
 * which the Anthropic brain runs as Sonnet, a 3B model that cannot call tools, and Mistral.
 */
import { BRAIN_MODELS, brainModel } from "../../../../workers/api/src/lib/brain-models";

export interface TemplateModelOption {
	value: string;
	label: string;
	disabled?: true;
}

/**
 * The options, labelled like the instance picker. A template already storing a model outside the
 * catalogue shows it first, disabled and flagged, so opening the form never silently switches it.
 */
export function templateModelOptions(current?: string | null): TemplateModelOption[] {
	const options: TemplateModelOption[] = BRAIN_MODELS.map((m) => ({ value: m.id, label: `${m.label} — ${m.hint}` }));
	if (!current || brainModel(current)) return options;
	return [{ value: current, label: `${current} (not a brain model — kept until you pick one)`, disabled: true }, ...options];
}

/** The `model` to send with a save: a kept off-catalogue model is left out (the API refuses it), so the rest still saves. */
export const templateModelField = (model: string): { model?: string } => (brainModel(model) ? { model } : {});
