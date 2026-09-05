import { logEvent } from "./events.js";
// From the leaf, NOT from `usage.ts` — `usage.ts` imports `PromptSectionInput` from this file, so
// importing the kind back off it closes a cycle. Type-only, so it erases at runtime and nothing
// would have failed; `import-graph.test.ts` is what catches it.
import type { UsageKind } from "./usage-shape.js";
import type { Env } from "../types.js";

export interface PromptSectionInput {
	label: string;
	value: unknown;
}

export interface PromptSectionEstimate {
	label: string;
	bytes: number;
	estimatedTokens: number;
}

const encoder = new TextEncoder();

function sectionText(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function estimatePromptSections(sections: readonly PromptSectionInput[]): PromptSectionEstimate[] {
	return sections.map((section) => {
		const bytes = encoder.encode(sectionText(section.value)).length;
		return {
			label: String(section.label).slice(0, 80),
			bytes,
			// Rough estimator only. Provider usage remains authoritative after the call.
			estimatedTokens: bytes > 0 ? Math.ceil(bytes / 4) : 0,
		};
	}).filter((section) => section.bytes > 0);
}

export async function logPromptSectionEstimates(
	env: Pick<Env, "DB">,
	args: {
		userId?: string | null;
		instanceId?: string | null;
		traceId?: string | null;
		source: string;
		kind: UsageKind;
		model: string;
		phase?: string | null;
		sections: readonly PromptSectionInput[];
	},
): Promise<void> {
	if (!args.userId || !args.instanceId) return;
	const sections = estimatePromptSections(args.sections);
	if (!sections.length) return;

	const totalBytes = sections.reduce((sum, section) => sum + section.bytes, 0);
	const totalEstimatedTokens = sections.reduce((sum, section) => sum + section.estimatedTokens, 0);
	const ranked = [...sections].sort((a, b) => b.estimatedTokens - a.estimatedTokens || b.bytes - a.bytes);
	const shown = ranked.slice(0, 15);

	await logEvent(env, {
		source: args.source,
		event: "llm.prompt_sections",
		level: "debug",
		message: `${args.kind} prompt estimate: ~${totalEstimatedTokens} input tokens across ${sections.length} sections.`,
		userId: args.userId,
		instanceId: args.instanceId,
		traceId: args.traceId ?? null,
		context: {
			kind: args.kind,
			model: args.model,
			phase: args.phase ?? null,
			totalBytes,
			totalEstimatedTokens,
			sections: shown,
			omittedSections: Math.max(0, ranked.length - shown.length),
		},
	});
}
