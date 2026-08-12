/**
 * Agent Behaviour (#223) — how an agent ACTS, as declared configuration.
 *
 * Three things made this necessary, and they are worth stating because they shape the design:
 *
 * 1. `Guardrails` (agent-types.ts) has been stored and injected into prompts since the beginning
 *    and is referenced NOWHERE in the console. It has never been editable by anyone.
 * 2. Style is GUESSED, not declared — `agent-think.ts` infers "you want jargon" from whether the
 *    instance happens to have repos attached, and hardcodes both "never output step-by-step
 *    thinking" and "MAXIMUM 2 sentences" with no way to opt out.
 * 3. Asked to be less technical, a real agent wrote `preference:response_style` into MEMORY —
 *    because there was no proper home. Memory is for subject-matter knowledge; character is not
 *    knowledge. (Rules & Tips stays in Knowledge for the same reason, inverted: standing rules are
 *    about the subject, behaviour is about the agent.)
 *
 * ## Everything is data, including the prompt text
 *
 * A field's rendered instruction lives in the field definition as a STRING, never a function. That
 * is what lets `GET /v1/behaviour/schema` serialise the whole table so the console renders sliders,
 * labels AND the band prose from the same source the prompt is built from. A callback here would
 * force the UI to restate the copy, and the two would drift — which is the failure this module
 * exists to remove, not repeat.
 *
 * ## A slider is language, not a number
 *
 * `technicality: 70` renders as "Assume the reader is comfortable with the domain…", never
 * "Technicality: 70/100". Models ignore or overfit a bare scalar; they follow described behaviour.
 * The number is a UI affordance for picking one of a few bands — the band is the real setting.
 *
 * ## Unset is a first-class state
 *
 * A field absent from the stored object emits NOTHING and leaves the existing heuristic in charge.
 * `default` below is only where the UI parks a slider before the user touches it. This is what
 * makes the change safe: an agent that has configured nothing gets today's prompt byte-for-byte.
 */
import { withSubscriberRulePrecedence } from "./subscriber-rule-precedence.js";

export type BehaviourValue = number | string | boolean | string[];

/** Sparse by design — a missing key means "not configured", NOT "default". See the header. */
export type Behaviour = Record<string, BehaviourValue>;

export type BehaviourGroup = "style" | "reasoning" | "formatting" | "interaction" | "guardrails";

export interface BehaviourBand {
	/** Inclusive upper bound on a 0–100 scale. Bands are ordered ascending. */
	max: number;
	/** Short name shown on the slider, e.g. "Senior engineer". */
	label: string;
	/** The instruction this band actually contributes to the prompt. */
	prompt: string;
}

export interface BehaviourOption {
	value: string;
	label: string;
	prompt: string;
}

export interface BehaviourField {
	id: string;
	group: BehaviourGroup;
	label: string;
	help?: string;
	type: "scale" | "choice" | "toggle" | "text" | "list" | "number";
	/** Where the UI parks the control before the user chooses. NOT a value — see the header. */
	default: BehaviourValue;
	bands?: BehaviourBand[];
	options?: BehaviourOption[];
	/** toggle */
	onPrompt?: string;
	offPrompt?: string;
	/** text / list / number — `{value}` is substituted. */
	template?: string;
	maxLength?: number;
	/** list */
	maxItems?: number;
	/** number */
	min?: number;
	max?: number;
	/**
	 * May the agent change this itself via `set_behaviour` (#224)?
	 *
	 * False for every guardrail. A Repo Coder reads untrusted repo files and GitHub issue bodies;
	 * if injected text can widen the agent's own restrictions then the restrictions are decorative.
	 * Presentation preferences are low-stakes and self-correcting — a user who dislikes the tone
	 * says so. A silently removed topic restriction is not observable.
	 */
	selfWritable: boolean;
}

const SCALE_BANDS_TECHNICALITY: BehaviourBand[] = [
	{
		max: 24,
		label: "Plain language",
		prompt:
			"Explain everything in plain language. Avoid jargon, file paths, and code. If a technical term is unavoidable, say what it means in the same sentence.",
	},
	{
		max: 49,
		label: "Mostly plain",
		prompt:
			"Keep explanations mostly plain. Introduce technical terms only where they carry real meaning, and briefly gloss them the first time.",
	},
	{
		max: 74,
		label: "Comfortable with the domain",
		prompt:
			"Write for someone comfortable with the domain. Use correct technical terms without defining the basics, and refer to real files and functions where they make the answer concrete.",
	},
	{
		max: 100,
		label: "Senior engineer",
		prompt:
			"Assume senior-engineer familiarity. Be precise and specific: cite real file paths, function names, and short snippets, and skip introductory explanation.",
	},
];

export const BEHAVIOUR_FIELDS: BehaviourField[] = [
	// ---- Style ----------------------------------------------------------------------------
	{
		id: "technicality",
		group: "style",
		label: "Technicality",
		help: "How much domain knowledge to assume. Overrides the platform's guess based on whether this agent has repos.",
		type: "scale",
		default: 50,
		bands: SCALE_BANDS_TECHNICALITY,
		selfWritable: true,
	},
	{
		id: "verbosity",
		group: "style",
		label: "Response length",
		type: "choice",
		default: "balanced",
		options: [
			{ value: "brief", label: "Brief", prompt: "Keep replies short — a few sentences. Lead with the answer." },
			{ value: "balanced", label: "Balanced", prompt: "Give a complete answer without padding — a short paragraph or two." },
			{
				value: "thorough",
				label: "Thorough",
				prompt: "Be comprehensive: cover edge cases, trade-offs, and the reasoning behind the answer.",
			},
		],
		selfWritable: true,
	},
	{
		id: "tone",
		group: "style",
		label: "Tone",
		type: "choice",
		default: "neutral",
		options: [
			{ value: "casual", label: "Casual", prompt: "Write casually, the way a colleague would in chat. Contractions are fine." },
			{ value: "neutral", label: "Neutral", prompt: "Write plainly and professionally, without stiffness." },
			{ value: "formal", label: "Formal", prompt: "Write formally: full sentences, no slang, no contractions." },
		],
		selfWritable: true,
	},
	{
		id: "warmth",
		group: "style",
		label: "Warmth",
		help: "Independent of tone — you can be formal and warm, or casual and blunt.",
		type: "choice",
		default: "neutral",
		options: [
			{
				value: "blunt",
				label: "Matter-of-fact",
				prompt: "Be matter-of-fact. Skip pleasantries, praise, and apologies; state the thing and move on.",
			},
			{ value: "neutral", label: "Neutral", prompt: "Be personable without being effusive." },
			{ value: "warm", label: "Warm", prompt: "Be warm and encouraging, acknowledging effort and frustration where it is real." },
		],
		selfWritable: true,
	},
	{
		id: "replyLanguage",
		group: "style",
		label: "Reply language",
		help: "Leave unset to reply in whatever language the user writes in.",
		type: "text",
		default: "",
		maxLength: 40,
		template: "Always reply in {value}, whatever language the user writes in.",
		selfWritable: true,
	},

	// ---- Reasoning ------------------------------------------------------------------------
	{
		id: "showWorking",
		group: "reasoning",
		label: "Show its working",
		help: "By default the platform forbids step-by-step narration entirely. Turn this on to see the steps.",
		type: "toggle",
		default: false,
		onPrompt: "When a task takes several steps, briefly say what you are doing as you go, then give the result.",
		offPrompt: "Give the result, not the process. Never narrate step-by-step thinking.",
		selfWritable: true,
	},
	{
		id: "hedging",
		group: "reasoning",
		label: "Certainty",
		type: "choice",
		default: "flag",
		options: [
			{
				value: "commit",
				label: "Commit to an answer",
				prompt: "Commit to a clear answer. Do not hedge with 'it depends' unless it genuinely does.",
			},
			{
				value: "flag",
				label: "Flag uncertainty",
				prompt: "Say explicitly when you are unsure, inferring, or working from incomplete information.",
			},
		],
		selfWritable: true,
	},
	{
		id: "clarifying",
		group: "reasoning",
		label: "When a request is ambiguous",
		type: "choice",
		default: "assume_and_flag",
		options: [
			{ value: "ask", label: "Ask first", prompt: "When a request is ambiguous, ask a clarifying question before acting." },
			{
				value: "assume_and_flag",
				label: "Assume, and say so",
				prompt: "When a request is ambiguous, take the most reasonable interpretation, proceed, and state the assumption you made.",
			},
			{
				value: "assume",
				label: "Just proceed",
				prompt: "When a request is ambiguous, take the most reasonable interpretation and proceed without asking.",
			},
		],
		selfWritable: true,
	},

	// ---- Formatting -----------------------------------------------------------------------
	{
		id: "formatting",
		group: "formatting",
		label: "Formatting",
		type: "choice",
		default: "markdown",
		options: [
			{ value: "prose", label: "Plain prose", prompt: "Answer in plain prose. No headings, bullet lists, or tables." },
			{ value: "markdown", label: "Light markdown", prompt: "Use light markdown — short bullet lists and bold where it aids scanning. Avoid headings in short replies." },
			{ value: "rich", label: "Headings and tables", prompt: "Structure longer answers with headings, tables, and lists." },
		],
		selfWritable: true,
	},
	{
		id: "emoji",
		group: "formatting",
		label: "Emoji",
		type: "toggle",
		default: false,
		onPrompt: "Occasional emoji are welcome.",
		offPrompt: "Do not use emoji.",
		selfWritable: true,
	},
	{
		id: "codeExamples",
		group: "formatting",
		label: "Code examples",
		type: "choice",
		default: "on_request",
		options: [
			{ value: "none", label: "Never", prompt: "Do not include code snippets. Describe changes in words." },
			{ value: "on_request", label: "When asked", prompt: "Include code snippets when asked, or when a snippet is genuinely clearer than prose." },
			{ value: "liberal", label: "Liberally", prompt: "Show code freely — a concrete snippet is usually the best answer." },
		],
		selfWritable: true,
	},

	// ---- Interaction ----------------------------------------------------------------------
	{
		id: "proactivity",
		group: "interaction",
		label: "Proactivity",
		type: "choice",
		default: "suggest",
		options: [
			{ value: "answer_only", label: "Answer only", prompt: "Answer exactly what was asked. Do not volunteer extra work or suggestions." },
			{ value: "suggest", label: "Suggest next steps", prompt: "Answer what was asked, then note the obvious next step if there is one." },
			{ value: "drive", label: "Drive the work", prompt: "Take the initiative: after answering, carry on with the obvious next step rather than waiting to be asked." },
		],
		selfWritable: true,
	},
	{
		id: "endWithQuestion",
		group: "interaction",
		label: "End with a question",
		type: "toggle",
		default: false,
		onPrompt: "Where it helps, end with a question that moves the work forward.",
		offPrompt: "Do not end replies with a question unless you genuinely need an answer to continue.",
		selfWritable: true,
	},
	{
		id: "addressAs",
		group: "interaction",
		label: "Call me",
		type: "text",
		default: "",
		maxLength: 60,
		template: "Address the user as {value}.",
		selfWritable: true,
	},
	{
		id: "persona",
		group: "interaction",
		label: "Persona",
		help: "Free text for anything the fields above don't cover, e.g. 'a blunt staff engineer who hates ceremony'.",
		type: "text",
		default: "",
		maxLength: 600,
		template: "Adopt this character: {value}",
		selfWritable: true,
	},

	// ---- Guardrails (existing, finally reachable — NOT self-writable) -----------------------
	{
		id: "topicRestrictions",
		group: "guardrails",
		label: "Stay on topic",
		help: "The agent politely declines anything outside this.",
		type: "text",
		default: "",
		maxLength: 400,
		template:
			"Topic restrictions: {value}. If the user asks about anything outside this scope, politely decline and redirect.",
		selfWritable: false,
	},
	{
		id: "blockedTerms",
		group: "guardrails",
		label: "Never say",
		type: "list",
		default: [],
		maxItems: 40,
		maxLength: 60,
		template: "Never use these words or phrases: {value}",
		selfWritable: false,
	},
	{
		id: "requireCitations",
		group: "guardrails",
		label: "Cite sources",
		type: "toggle",
		default: false,
		onPrompt: "Always cite which knowledge document you are drawing from.",
		selfWritable: false,
	},
	{
		id: "maxResponseLength",
		group: "guardrails",
		label: "Hard character limit",
		help: "0 for no limit.",
		type: "number",
		default: 0,
		min: 0,
		max: 20000,
		template: "Keep responses under {value} characters.",
		selfWritable: false,
	},
];

const FIELDS_BY_ID = new Map(BEHAVIOUR_FIELDS.map((f) => [f.id, f]));

export function behaviourField(id: string): BehaviourField | undefined {
	return FIELDS_BY_ID.get(id);
}

/** Ids the agent may set itself. The boundary for #224 — see `BehaviourField.selfWritable`. */
export const SELF_WRITABLE_FIELDS: string[] = BEHAVIOUR_FIELDS.filter((f) => f.selfWritable).map((f) => f.id);

function clampNumber(v: unknown, min: number, max: number): number | undefined {
	const n = typeof v === "number" ? v : Number(v);
	if (!Number.isFinite(n)) return undefined;
	return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeOne(field: BehaviourField, raw: unknown): BehaviourValue | undefined {
	switch (field.type) {
		case "scale":
			return clampNumber(raw, 0, 100);
		case "number":
			return clampNumber(raw, field.min ?? 0, field.max ?? 1_000_000);
		case "toggle":
			return typeof raw === "boolean" ? raw : undefined;
		case "choice": {
			if (typeof raw !== "string") return undefined;
			return field.options?.some((o) => o.value === raw) ? raw : undefined;
		}
		case "text": {
			if (typeof raw !== "string") return undefined;
			const t = raw.trim().slice(0, field.maxLength ?? 200);
			// An empty string is a deliberate CLEAR, kept distinct from `undefined` (unparseable
			// input, which is dropped). Callers strip empties when they mean "unset".
			return t;
		}
		case "list": {
			if (!Array.isArray(raw)) return undefined;
			return raw
				.filter((x): x is string => typeof x === "string")
				.map((x) => x.trim().slice(0, field.maxLength ?? 60))
				.filter(Boolean)
				.slice(0, field.maxItems ?? 40);
		}
	}
}

export interface SanitizeResult {
	behaviour: Behaviour;
	/** Keys that were dropped, so a caller can report a partial patch honestly rather than silently. */
	rejected: string[];
}

/**
 * Clamp and allowlist an incoming object.
 *
 * `allowedIds` restricts which fields may be written at all — that is how #224 keeps the agent out
 * of its own guardrails. Rejections are REPORTED, not swallowed: a patch that half-applies while
 * claiming success is how a "set this" tool ends up lying about what it did.
 */
export function sanitizeBehaviour(raw: unknown, allowedIds?: readonly string[]): SanitizeResult {
	const out: Behaviour = {};
	const rejected: string[] = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { behaviour: out, rejected };
	const allowed = allowedIds ? new Set(allowedIds) : null;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const field = FIELDS_BY_ID.get(key);
		if (!field || (allowed && !allowed.has(key))) {
			rejected.push(key);
			continue;
		}
		const clean = sanitizeOne(field, value);
		if (clean === undefined) {
			rejected.push(key);
			continue;
		}
		out[key] = clean;
	}
	return { behaviour: out, rejected };
}

/**
 * Apply a patch to a stored behaviour object.
 *
 * Shared by the route (#223) and the agent's own `set_behaviour` tool (#224) so the two can never
 * disagree about what a patch means — `allowedIds` is the only difference between them.
 *
 * `null` CLEARS a field back to unset. That is not the same as an empty string: a cleared field
 * stops contributing to the prompt AND stops appearing as configured, which is what "go back to how
 * you were" has to mean. Without an explicit clear there is no way back from a setting once made.
 */
export function applyBehaviourPatch(
	current: unknown,
	patch: unknown,
	allowedIds?: readonly string[],
): SanitizeResult {
	const base = sanitizeBehaviour(current).behaviour;
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { behaviour: base, rejected: [] };

	const entries = Object.entries(patch as Record<string, unknown>);
	const allowed = allowedIds ? new Set(allowedIds) : null;
	const rejected: string[] = [];
	const next = { ...base };

	for (const [key, value] of entries) {
		if (value !== null) continue;
		// A clear is still a WRITE — it must obey the same allowlist, or the agent could erase a
		// guardrail it is not allowed to set.
		if (!FIELDS_BY_ID.has(key) || (allowed && !allowed.has(key))) {
			rejected.push(key);
			continue;
		}
		delete next[key];
	}

	const sets = Object.fromEntries(entries.filter(([, v]) => v !== null));
	const { behaviour: applied, rejected: setRejected } = sanitizeBehaviour(sets, allowedIds);
	return { behaviour: { ...next, ...applied }, rejected: [...rejected, ...setRejected] };
}

/**
 * Creator template default < subscriber override.
 *
 * Merged per FIELD, not wholesale: a creator who ships an agent as "technical, thorough" keeps both
 * when the subscriber only changes the tone. Wholesale replacement would silently drop the rest of
 * the character the creator designed the first time the subscriber touched anything.
 */
export function resolveBehaviour(templateDefault: unknown, instanceOverride: unknown): Behaviour {
	const base = sanitizeBehaviour(templateDefault).behaviour;
	const over = sanitizeBehaviour(instanceOverride).behaviour;
	return { ...base, ...over };
}

function bandFor(field: BehaviourField, value: number): BehaviourBand | undefined {
	return field.bands?.find((b) => value <= b.max) ?? field.bands?.[field.bands.length - 1];
}

/** The rendered instruction for one configured field, or "" when it contributes nothing. */
export function fieldPrompt(field: BehaviourField, value: BehaviourValue): string {
	switch (field.type) {
		case "scale":
			return typeof value === "number" ? bandFor(field, value)?.prompt ?? "" : "";
		case "choice":
			return field.options?.find((o) => o.value === value)?.prompt ?? "";
		case "toggle":
			return (value ? field.onPrompt : field.offPrompt) ?? "";
		case "number": {
			// 0 means "no limit" for every numeric field here; emitting "under 0 characters" would
			// be an instruction to say nothing.
			if (typeof value !== "number" || value <= 0) return "";
			return field.template?.replace("{value}", String(value)) ?? "";
		}
		case "list": {
			if (!Array.isArray(value) || value.length === 0) return "";
			return field.template?.replace("{value}", value.join(", ")) ?? "";
		}
		case "text": {
			if (typeof value !== "string" || !value.trim()) return "";
			return field.template?.replace("{value}", value.trim()) ?? "";
		}
	}
}

/**
 * The prompt block.
 *
 * Emits ONLY configured fields — an empty behaviour returns "" and the caller's existing heuristics
 * stay in charge untouched. This is the guarantee that makes the change safe to ship to every
 * existing instance at once.
 *
 * Deliberately placed EARLY in the system prompt by the caller, so the platform's honesty/safety
 * text still comes after it. `persona` is free text from the subscriber; it configures character,
 * and it must not be able to outrank "never claim an action succeeded when it failed".
 */
export function behaviourPrompt(behaviour: Behaviour): string {
	const lines: string[] = [];
	for (const field of BEHAVIOUR_FIELDS) {
		if (!(field.id in behaviour)) continue;
		const line = fieldPrompt(field, behaviour[field.id]);
		if (line) lines.push(`- ${line}`);
	}
	if (!lines.length) return "";
	return (
		"\n\n## How your subscriber wants you to communicate\n" +
		"These are their explicit preferences for your manner. Follow them.\n" +
		lines.join("\n")
	);
}

/**
 * JSON Schema for `set_behaviour` (#224), derived from the field table.
 *
 * Generated rather than hand-written so adding a field never means editing the tool — the same
 * reason the console fetches the table instead of restating it. Every property also accepts `null`,
 * because "go back to how you were" has to be expressible or a setting can only ever be changed,
 * never undone.
 */
export function behaviourToolSchema(allowedIds: readonly string[]): Record<string, unknown> {
	const allowed = new Set(allowedIds);
	const properties: Record<string, unknown> = {};
	for (const f of BEHAVIOUR_FIELDS) {
		if (!allowed.has(f.id)) continue;
		const desc = [f.label, f.help].filter(Boolean).join(" — ");
		switch (f.type) {
			case "scale":
				properties[f.id] = {
					type: ["number", "null"],
					minimum: 0,
					maximum: 100,
					// The bands are spelled out so the model picks a value that lands where it means
					// to, instead of guessing what "70" does.
					description: `${desc}. 0-100: ${(f.bands ?? []).map((b) => `up to ${b.max} = ${b.label}`).join("; ")}`,
				};
				break;
			case "number":
				properties[f.id] = { type: ["number", "null"], minimum: f.min, maximum: f.max, description: desc };
				break;
			case "toggle":
				properties[f.id] = { type: ["boolean", "null"], description: desc };
				break;
			case "choice":
				properties[f.id] = {
					type: ["string", "null"],
					enum: [...(f.options ?? []).map((o) => o.value), null],
					description: `${desc}. ${(f.options ?? []).map((o) => `${o.value} = ${o.label}`).join("; ")}`,
				};
				break;
			case "text":
				properties[f.id] = { type: ["string", "null"], maxLength: f.maxLength, description: desc };
				break;
			case "list":
				properties[f.id] = { type: ["array", "null"], items: { type: "string" }, description: desc };
				break;
		}
	}
	// `required: []` rather than omitted: every tool definition on the platform declares it, and
	// a patch tool genuinely has no required field — say that explicitly.
	return { type: "object", properties, required: [] };
}

/**
 * Human-readable current settings, for `get_behaviour` (#224) and the UI summary.
 *
 * Returns the BAND PROSE alongside the raw value so the agent explains itself in the same words the
 * prompt uses. Reading back "technicality is 70" would be the number leaking into the conversation,
 * which is the thing this module is built to avoid.
 */
export function describeBehaviour(behaviour: Behaviour): Array<{ id: string; label: string; value: BehaviourValue; description: string }> {
	const out: Array<{ id: string; label: string; value: BehaviourValue; description: string }> = [];
	for (const field of BEHAVIOUR_FIELDS) {
		if (!(field.id in behaviour)) continue;
		out.push({
			id: field.id,
			label: field.label,
			value: behaviour[field.id],
			description: fieldPrompt(field, behaviour[field.id]),
		});
	}
	return out;
}

/**
 * Does the subscriber want technical language?
 *
 * `undefined` means "not configured" — the caller keeps its existing heuristic. Returning a boolean
 * default here would silently override every agent's current style on deploy.
 */
export function prefersTechnical(behaviour: Behaviour): boolean | undefined {
	const v = behaviour.technicality;
	return typeof v === "number" ? v >= 50 : undefined;
}

/** One-line reminder appended after tool rounds, mirroring the caller's `styleReminder`. */
export function behaviourStyleReminder(behaviour: Behaviour): string {
	const parts: string[] = [];
	for (const id of ["technicality", "verbosity"]) {
		const field = FIELDS_BY_ID.get(id);
		if (field && id in behaviour) {
			const line = fieldPrompt(field, behaviour[id]);
			if (line) parts.push(line);
		}
	}
	return parts.join(" ");
}

/**
 * Does this memory key hold a communication preference that now belongs in behaviour (#226)?
 *
 * Live agents wrote these before there was anywhere else to put them, and memory lives in the DO —
 * out of reach of a D1 migration. The prompt uses this to ask the agent to move its own, once.
 *
 * Deliberately narrow. A key like `preference:coffee_supplier` is a genuine fact about the subject
 * and must stay in memory; only keys naming an aspect of MANNER match. A loose match here would
 * have agents deleting real knowledge.
 */
const BEHAVIOURAL_KEY_HINTS = [
	"response_style",
	"responsestyle",
	"communication",
	"tone",
	"verbosity",
	"technicality",
	"formality",
	"persona",
	"reply_length",
	"response_length",
];

export function strayBehaviourKey(key: string): boolean {
	const k = key.toLowerCase();
	if (!k.startsWith("preference:") && !k.startsWith("pref:")) return false;
	return BEHAVIOURAL_KEY_HINTS.some((h) => k.includes(h));
}

/** Just enough of a memory entry to decide what the self-heal may say about it. */
export interface StrayCandidate {
	key: string;
	/** Absent on legacy entries, which are agent-written by definition. */
	source?: string;
}

/**
 * The self-heal block for memory entries that hold communication preferences (#226), split by
 * WHO wrote them (#230). Returns "" when there is nothing to migrate.
 *
 * The first version listed every stray under one instruction ending "…and then delete_memory the
 * old key". Two lines above it the same prompt promises that entries marked (user-set) are never
 * overwritten or deleted unless the user asks — and the stray list was the more specific, later
 * instruction, naming exact keys and an exact tool. A model follows that one. The Memory tab is
 * editable and tags manual entries `source:"user"`, so a hand-typed `preference:tone` was being
 * pointed at delete_memory by the platform's own prompt.
 *
 * `executeTool` does refuse the delete at runtime (lib/tools.ts guards write_memory and
 * delete_memory on `source:"user"`), so the entry survives; what the contradiction actually costs
 * is a prompt that instructs a tool call it has already decided to reject — a wasted round, a
 * failure the model has to explain, and a stated invariant undermined in the one place a model
 * reads most literally. The guard is the backstop, not the rule; the rule belongs here.
 *
 * A user-set stray is still WORTH migrating — the preference belongs in behaviour, and the copy is
 * what makes the agent honour it — so it is listed for the move and withheld only from the delete.
 */
export function behaviourStrayPrompt(memory: readonly StrayCandidate[]): string {
	const strays = memory.filter((m) => strayBehaviourKey(m.key));
	if (!strays.length) return "";
	const userSet = strays.filter((m) => m.source === "user").map((m) => m.key);
	const agentSet = strays.filter((m) => m.source !== "user").map((m) => m.key);

	let out = "";
	if (agentSet.length) {
		out +=
			`\nThese entries hold COMMUNICATION preferences, which no longer belong in memory: ${agentSet.join(", ")}.` +
			" When the user next asks about how you communicate, move each one with set_behaviour" +
			" and then delete_memory the old key. Do not act on them as if they were facts about the subject.\n";
	}
	if (userSet.length) {
		out +=
			`\nThese entries also hold COMMUNICATION preferences, but the USER wrote them: ${userSet.join(", ")}.` +
			" Copy each into behaviour with set_behaviour so you actually honour it, then LEAVE THE MEMORY ENTRY" +
			" ALONE — never delete_memory a user-set key. You may tell them it is now stored as behaviour and" +
			" offer to remove the old entry; only delete it if they say yes. Do not act on them as if they were" +
			" facts about the subject.\n";
	}
	return out;
}

export interface ResponseStyle {
	/**
	 * Does this agent have a code-grounding context (a vector index, or live coding sessions)?
	 *
	 * A FACT about the agent, never a preference. Kept separate from `technical` because they were
	 * briefly one variable, and that was a real bug: a plain chat agent whose owner set technicality
	 * to 60 fell into the Coder branch and was told it has "Attached Repositories", "live terminal
	 * snapshots" and a Coding tab. Those blocks exist to stop a false self-model; conflating the two
	 * handed one to an agent with none of it.
	 */
	codingContext: boolean;
	/** Should the reply use technical language? Declared preference first, capability as fallback. */
	technical: boolean;
	/** The one-line reminder appended after tool rounds. */
	styleReminder: string;
	/**
	 * Use the plain-speech, read-aloud VOICE? False once the owner has asked for technical language.
	 * Not "instead of the coding block" — alongside it: `styleGuidance` takes the grounding from
	 * `codingContext` and the voice from this, so a Coder at technicality 0 keeps every factual line
	 * about what it can see and stops citing file paths (#430).
	 */
	plainSpeech: boolean;
}

const GROUNDED = "Answer accurately and concretely, grounded in the code above.";

/**
 * Decide response style from what the agent IS and what its owner ASKED for.
 *
 * A preference may change the language level; it must never invent a capability.
 */
export function resolveResponseStyle(opts: {
	repoChatStyle: boolean;
	hasCodingContext: boolean;
	behaviour: Behaviour;
	/** The subscriber's stored Rules & Tips. They outrank the style sentence — see #521. */
	subscriberRules?: string;
}): ResponseStyle {
	const codingContext = opts.repoChatStyle || opts.hasCodingContext;
	const technical = prefersTechnical(opts.behaviour) ?? codingContext;
	const declared = behaviourStyleReminder(opts.behaviour);

	// The grounding clause SURVIVES a declared style. Replacing the whole reminder meant setting
	// verbosity alone silently dropped "grounded in the code above" from every post-tool round on a
	// coding agent — a length preference quietly removing an accuracy instruction.
	const platformReminder = declared
		? codingContext
			? `${GROUNDED} ${declared}`
			: declared
		: technical
			? `${GROUNDED} Lead with a plain-English explanation; cite real file paths/functions and add short snippets only when they help.`
			: "Reply in MAX 2 sentences, plain English, no filenames or code. This will be read aloud.";

	// `!technical`, NOT `!codingContext && !technical` (#430). Capability vetoing preference here was
	// the last place the two were still conflated: `codingContext` is true for any instance with a
	// repo attached, so the plain-speech rules — including "never mention filenames, paths, function
	// names, or code", the one thing a non-technical owner reaches for — were unreachable for a
	// Coder at EVERY slider position, including 0. The grounding is not lost with them: the coding
	// branch still emits its factual lines, and only the voice changes.
	return { codingContext, technical, styleReminder: withSubscriberRulePrecedence(platformReminder, opts.subscriberRules), plainSpeech: !technical };
}
