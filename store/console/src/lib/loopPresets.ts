/**
 * Pure logic behind the Loop presets editor (#234).
 *
 * The presets were five literals in `CodingTab`'s `useState`, handed to one child. That is why an
 * agent declaring `copilot:false` had none: not a decision, a wiring accident. Now they are per
 * instance config, which means an editor — add, rename, reorder, remove, reset — and every one of
 * those is a list transformation that is only checkable by clicking unless it lives here.
 *
 * The rules that are easy to get wrong and invisible when wrong: an id must stay unique (it is the
 * React key AND the handle an edit matches on, so a collision edits the wrong row), a half-typed
 * row must not be saved as a button that starts a loop with no objective, and "Reset" must only be
 * offered when there is something of the user's own to reset (#232).
 */

export interface LoopPreset {
	id: string;
	label: string;
	objective: string;
}

/** Which layer the list currently comes from — mirrors LoopPresetSource on the API. */
export type LoopPresetSource = "instance" | "agent" | "default";

export const MAX_LOOP_PRESETS = 12;
export const MAX_PRESET_LABEL = 60;
export const MAX_PRESET_OBJECTIVE = 1000;

/** A blank row appended by "Add preset", with an id that cannot collide with an existing one. */
export function addPreset(list: readonly LoopPreset[]): LoopPreset[] {
	if (list.length >= MAX_LOOP_PRESETS) return [...list];
	const taken = new Set(list.map((p) => p.id));
	let n = list.length + 1;
	let id = `preset-${n}`;
	while (taken.has(id)) id = `preset-${++n}`;
	return [...list, { id, label: "", objective: "" }];
}

export function updatePreset(list: readonly LoopPreset[], id: string, patch: Partial<Omit<LoopPreset, "id">>): LoopPreset[] {
	return list.map((p) =>
		p.id === id
			? {
					...p,
					...(patch.label !== undefined ? { label: patch.label.slice(0, MAX_PRESET_LABEL) } : {}),
					...(patch.objective !== undefined ? { objective: patch.objective.slice(0, MAX_PRESET_OBJECTIVE) } : {}),
				}
			: p,
	);
}

export function removePreset(list: readonly LoopPreset[], id: string): LoopPreset[] {
	return list.filter((p) => p.id !== id);
}

/** Move one row up (-1) or down (+1). Out-of-range is a no-op, so the buttons at the ends are inert
 *  rather than wrapping — a preset that jumps from top to bottom reads as a bug. */
export function movePreset(list: readonly LoopPreset[], id: string, delta: -1 | 1): LoopPreset[] {
	const i = list.findIndex((p) => p.id === id);
	const j = i + delta;
	if (i < 0 || j < 0 || j >= list.length) return [...list];
	const out = [...list];
	[out[i], out[j]] = [out[j], out[i]];
	return out;
}

/**
 * What actually gets PUT: trimmed, with incomplete rows dropped.
 *
 * A row is dropped rather than blocking the save because the common case is an "Add preset" the
 * user changed their mind about, and refusing to save the other eleven because of an empty twelfth
 * is a worse experience than quietly not saving the empty one — which is also what the server does.
 */
export function saveablePresets(list: readonly LoopPreset[]): LoopPreset[] {
	return list
		.map((p) => ({ id: p.id, label: p.label.trim(), objective: p.objective.trim() }))
		.filter((p) => p.label && p.objective);
}

/**
 * The one thing worth WARNING about before a save: a row with a label and no objective (or the
 * reverse) is half-finished work that is about to vanish silently.
 */
export function incompleteCount(list: readonly LoopPreset[]): number {
	return list.filter((p) => {
		const label = p.label.trim();
		const objective = p.objective.trim();
		return (label && !objective) || (!label && objective);
	}).length;
}

/** Has the user changed anything since the last load/save? Order counts — reorder is an edit. */
export function presetsDirty(list: readonly LoopPreset[], saved: readonly LoopPreset[]): boolean {
	const a = saveablePresets(list);
	const b = saveablePresets(saved);
	if (a.length !== b.length) return true;
	return a.some((p, i) => p.label !== b[i].label || p.objective !== b[i].objective);
}

/**
 * Offer "Reset to defaults" ONLY when the instance has its own list. Offering it against a creator
 * default or the built-ins is a button that does nothing, which is exactly the confusion #232 fixed
 * elsewhere: a reset that resets to what you are already looking at.
 */
export function canResetPresets(source: LoopPresetSource): boolean {
	return source === "instance";
}

/** One line telling the user where the list they see came from. */
export function presetSourceLabel(source: LoopPresetSource, count: number): string {
	if (source === "instance") return "Your presets for this agent.";
	if (source === "agent") return "The presets this agent's creator ships. Editing them makes your own copy.";
	return count
		? "The built-in presets for a coding agent. Editing them makes your own copy."
		: "This agent ships no loop presets. Add one and it appears wherever a loop starts.";
}
