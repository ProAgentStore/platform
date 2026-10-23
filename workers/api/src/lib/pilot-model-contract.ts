/** Shared Pilot configuration contract, independent of worker bindings. */
export const DEFAULT_PILOT_MODEL = "claude-sonnet-4-6" as const;
export const PILOT_MODEL_OPTIONS = [
	{ id: DEFAULT_PILOT_MODEL, label: "Sonnet 4.6", hint: "Default controller; Anthropic when configured, otherwise the inherited Cloudflare route" },
	{ id: "claude-haiku-5-5", label: "Haiku 5.5 canary", hint: "Experimental routine decisions; Sonnet checks endings and owner decisions. Both require an Anthropic API key" },
] as const;
export type PilotModelId = (typeof PILOT_MODEL_OPTIONS)[number]["id"];

/** The Pilot projection served by coder-brain and po-triage/reports. */
export interface PilotModelResponse {
	pilot: { model: PilotModelId; fallbackModel: typeof DEFAULT_PILOT_MODEL; options: typeof PILOT_MODEL_OPTIONS };
}
