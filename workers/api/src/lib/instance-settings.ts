/**
 * Per-instance typed settings values — the subscriber side of the agent's declared
 * settingsSchema (lib/agent-capabilities.ts).
 *
 * Pure functions shared by the /v1/instances/:id/settings routes and the chat
 * prompt builder (agent-think.ts), so validation and the injected prompt text
 * have exactly one implementation.
 */
import type { SettingsField } from "./agent-capabilities.js";

export type SettingsValue = string | number | boolean;

/** True when `value` is a valid value for `field` (select: one of its options). */
function valueFits(field: SettingsField, value: unknown): value is SettingsValue {
	switch (field.type) {
		case "select":
			return typeof value === "string" && !!field.options?.some((o) => o.value === value);
		case "text":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "toggle":
			return typeof value === "boolean";
	}
}

/** Stored values merged over schema defaults — filtered to schema fields, type-checked. */
export function resolveSettingsValues(
	schema: SettingsField[],
	raw: unknown,
): Record<string, SettingsValue> {
	const stored = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const out: Record<string, SettingsValue> = {};
	for (const field of schema) {
		if (valueFits(field, stored[field.id])) out[field.id] = stored[field.id] as SettingsValue;
		else if (field.default !== undefined) out[field.id] = field.default;
	}
	return out;
}

/**
 * Apply a subscriber patch over the currently stored values. Only known field ids
 * whose value type-checks are kept (text capped at 500 chars). Returns the next
 * stored map, plus — when a `voiceLanguage` field was set in THIS patch — the
 * BCP-47 value the caller must sync into the instance's voice settings.
 */
export function applySettingsPatch(
	schema: SettingsField[],
	current: unknown,
	patch: unknown,
): { settings: Record<string, SettingsValue>; voiceLanguageValue?: string } {
	const next: Record<string, SettingsValue> = {};
	const cur = current && typeof current === "object" ? (current as Record<string, unknown>) : {};
	const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
	let voiceLanguageValue: string | undefined;
	for (const field of schema) {
		if (field.id in p) {
			let value = p[field.id];
			if (field.type === "text" && typeof value === "string") value = value.slice(0, 500);
			if (valueFits(field, value)) {
				next[field.id] = value;
				if (field.voiceLanguage && typeof value === "string") voiceLanguageValue = value;
				continue;
			}
		}
		if (valueFits(field, cur[field.id])) next[field.id] = cur[field.id] as SettingsValue;
	}
	return { settings: next, voiceLanguageValue };
}

/**
 * The `## Settings` system-prompt block ("" when nothing is set). Labels first,
 * with the raw value in parens when it differs from its label (so the model sees
 * both "Chinese (Mandarin)" and "zh-CN"). The framing is deliberately strong —
 * settings are authoritative config, not conversation state: the model must not
 * ask for them or mirror them into memory (that path caused the duplicate-key
 * memory drift this feature replaces).
 */
export function settingsPromptBlock(
	schema: SettingsField[],
	values: Record<string, SettingsValue>,
): string {
	const lines: string[] = [];
	for (const field of schema) {
		const value = values[field.id];
		if (value === undefined) continue;
		if (field.type === "toggle") {
			lines.push(`- ${field.label}: ${value ? "on" : "off"}`);
			continue;
		}
		const option = field.options?.find((o) => o.value === value);
		const shown = option ? option.label : String(value);
		const suffix = option && option.label !== option.value ? ` (${option.value})` : "";
		lines.push(`- ${field.label}: ${shown}${suffix}`);
	}
	if (!lines.length) return "";
	return (
		"## Settings\n" +
		"The subscriber configured these for you in the console Settings tab. They are authoritative:\n" +
		"follow them exactly, never ask the user to provide or confirm them, and never store them in\n" +
		"memory — the user changes them in Settings, not in chat. If the conversation history\n" +
		"contradicts these values (e.g. you were using a different language earlier), the settings\n" +
		"were CHANGED mid-conversation: follow the settings below, not the history, starting now.\n" +
		lines.join("\n")
	);
}
