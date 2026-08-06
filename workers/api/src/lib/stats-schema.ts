/**
 * Stats cards — what an agent shows about itself, as declared configuration (#310).
 *
 * ## Cards are data, not code
 *
 * The house pattern is settled: surfaces come from `capabilities.surfaces`, tools from
 * `capabilities.tools` + the connector registry, subscriber settings from `settingsSchema`, board
 * columns from `capabilities.boardColumns`, character from `BEHAVIOUR_FIELDS`. A stats page written
 * as a hardcoded dashboard would be the same mistake as the technicality heuristic in
 * `agent-think.ts`: behaviour asserted in code, drifting from what the agent actually is.
 *
 * So `statsSchema` is a TABLE of card definitions, sanitized and capped, resolved the way behaviour
 * is — creator default (`agents.config.statsSchema`) merged per card under the subscriber's
 * override (`agent_instances.config.stats`).
 *
 * ## The security boundary: a card names a SOURCE, it never carries a query
 *
 * {@link STATS_SOURCES} is a closed vocabulary of hand-written, owner-scoped aggregates. Every one
 * of them bakes `WHERE instance_id = ? AND user_id = ?` into its SQL (see `stats-sources.ts`); a
 * card supplies WHICH VIEW, never WHOSE DATA. That single sentence is what makes agent-authored
 * stats safe: an agent may add a card exactly as it may set its tone (#224), and it may no more
 * widen scope than it may widen a guardrail. A prompt-injected Repo Coder can at worst produce a
 * useless card.
 *
 * Anything resembling free-form SQL in a card is deliberately absent and must stay absent.
 *
 * ## Family is DERIVED from kind, not separately declared
 *
 * #313 splits cards into `trend` (read from the `agent_stats_daily` rollup) and `point_in_time`
 * (read live). Storing that as its own field would let it contradict the kind — a card declared
 * `trend` but drawn as a bar chart has no series to draw, and the two truths would drift the way
 * `capabilities.surfaces` and the prompt's claims drifted in #254. So there is ONE axis:
 *
 *   `line` → trend (a daily series from the rollup)
 *   `number` | `bar` | `table` → point-in-time (a live aggregate over the page window)
 *
 * {@link familyForKind} is the only place that mapping exists. Writers may still SEND `family` —
 * `set_stats_card` accepts it — and it is checked against the kind and rejected by name on
 * mismatch, rather than silently stored and silently ignored.
 */

/** The four shapes the console can draw. Closed: the renderer has a table with exactly these
 *  entries, so an open set would mean rendering something it has never seen. Grows by adding an
 *  entry here AND in the renderer, the way `BEHAVIOUR_FIELDS` grows. */
export type StatsCardKind = "number" | "line" | "bar" | "table";

export const STATS_CARD_KINDS: readonly StatsCardKind[] = ["number", "line", "bar", "table"];

/** Where a card's numbers come from. See the header — this is derived, never stored. */
export type StatsCardFamily = "trend" | "point_in_time";

export function familyForKind(kind: StatsCardKind): StatsCardFamily {
	return kind === "line" ? "trend" : "point_in_time";
}

/** What a source's numbers do NOT count, or how they are arrived at. Rendered verbatim next to the
 *  card and returned by `get_stats`, because the Usage page learned the expensive version of this:
 *  a confident wrong number is worse than an absent one. Every source that estimates, samples or
 *  omits something says so here, in the source table, so the caveat cannot drift from the query. */
export type StatsSourceCaveat = string;

/**
 * What a source's numbers ARE. Declared here, beside the caveat, and used by both the executor's
 * scalar and the trend series so the two can never disagree.
 *
 * It is not cosmetic. `usage.cost` counts USD MICROS (1,000,000 = $1); a trend series that carried
 * no unit rendered "2,500,000" under a card titled "Estimated AI cost" — off by six orders of
 * magnitude, and exactly the kind of confidently-wrong figure this feature is built not to show.
 * The console must not infer it from the source id, because an inference in the UI is a second
 * declaration that drifts.
 */
export type StatsUnit = "count" | "tokens" | "usd_micros";

export type StatsParamType = "collection" | "field" | "limit";

export interface StatsParam {
	id: string;
	type: StatsParamType;
	label: string;
	required?: boolean;
	/** `limit` only. Hard ceiling; see MAX_CARD_LIMIT for why it is small. */
	max?: number;
	default?: number;
}

export interface StatsSource {
	id: string;
	label: string;
	/** Which card kinds this source can actually fill. A source producing one scalar cannot fill a
	 *  table; a source producing groups cannot fill a line. Checked at save time. */
	kinds: readonly StatsCardKind[];
	/** Human description of what is being counted — shown in the card picker. */
	describes: string;
	caveat: StatsSourceCaveat;
	/** The unit of this source's scalars AND of its daily series. One declaration, two readers. */
	unit: StatsUnit;
	params: readonly StatsParam[];
}

/** A source's unit, defaulting to a plain count for anything unknown. */
export function unitFor(sourceId: string): StatsUnit {
	return statsSource(sourceId)?.unit ?? "count";
}

/** Collection and field names come from the agent's own storage engine. The collection regex is
 *  the SAME anchored shape `assertCollectionName` enforces on write (`agent-storage/collections.ts`)
 *  — a name containing `:` collides with another collection's key prefix, so a looser regex here
 *  would let a card address storage the engine itself refuses to name. */
const COLLECTION_NAME_RE = /^[a-z][a-z0-9_]{0,49}$/;
/** A record field is agent-defined, so it cannot be enumerated — but it CAN be constrained. */
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/**
 * Every group-by / table source caps its rows here, and a card's `limit` param is clamped to it.
 *
 * Small on purpose. #243 is the precedent: an unparseable `limit` silently meant "drop every
 * record". Both halves of that are handled below — `Number.isFinite` parsing, and absent treated
 * differently from unparseable — but the ceiling is the part that stops a stats tab someone leaves
 * open from becoming the most expensive query in the product.
 */
export const MAX_CARD_LIMIT = 25;

/** How many records a `collection.group_by` card will scan before it reports a partial answer.
 *  Collections live in the instance Durable Object with no aggregate index, so a group-by is a
 *  scan; bounding it is the difference between a stats tab and an outage. */
export const COLLECTION_SCAN_CAP = 500;

const LIMIT_PARAM: StatsParam = { id: "limit", type: "limit", label: "Rows", max: MAX_CARD_LIMIT, default: 10 };

/**
 * THE CLOSED SOURCE VOCABULARY.
 *
 * Adding an entry is a reviewed code change that must also add an owner-scoped executor in
 * `stats-sources.ts` (a test asserts the two tables match exactly, so a descriptor without a query
 * — or a query nothing can name — fails the build rather than 500ing at read time).
 *
 * Note what is NOT here: no fifth record of what happened. Every source reads a table that already
 * exists for its own reasons — `ai_usage` (0048), `agent_loop_runs` (0062), `pipeline_runs` (0052),
 * `instance_runtime_tasks` (0012), `agent_events` (0038), `agent_trigger_events` (0045) — or the
 * instance's own collections. #313's rollup snapshots these; it does not duplicate them.
 */
export const STATS_SOURCES: readonly StatsSource[] = [
	{
		id: "usage.tokens",
		label: "AI tokens",
		kinds: ["number", "line"],
		describes: "Input, output and cache tokens across every AI call this agent made.",
		unit: "tokens",
		caveat:
			"Counts only calls brokered by the platform and recorded in the usage ledger, and adds cached tokens to the total (the Usage page reports them separately). Tokens spent by a coding engine running on your own machine under your own login are not metered here.",
		params: [],
	},
	{
		id: "usage.cost",
		label: "Estimated AI cost",
		kinds: ["number", "line"],
		describes: "Estimated USD spend across every AI call this agent made.",
		unit: "usd_micros",
		caveat:
			"An ESTIMATE, not a bill. Keys are yours (BYOK) so the real provider invoice is never visible here; cached input is priced at 0.1x list, and rows tagged as reported-not-estimated carry a figure the engine reported rather than one we computed.",
		params: [],
	},
	{
		id: "runs.count",
		label: "Agent runs",
		kinds: ["number", "line"],
		describes: "Durable agent-loop runs started.",
		caveat: "Counts runs STARTED in the period, including ones still running — so a long run is counted on the day it began.",
		unit: "count",
		params: [],
	},
	{
		id: "runs.outcome",
		label: "Runs by outcome",
		kinds: ["bar", "table"],
		describes: "Agent-loop runs grouped by status.",
		caveat: "Groups by current status, so a run still in flight appears as `running` and moves group when it ends.",
		unit: "count",
		params: [LIMIT_PARAM],
	},
	{
		id: "pipeline.runs",
		label: "Pipeline runs",
		kinds: ["number", "line", "bar", "table"],
		describes: "Declarative-pipeline runs, grouped by status for bar/table.",
		caveat: "Counts runs STARTED in the period. A pipeline that runs once and writes 500 records is one run, not 500.",
		unit: "count",
		params: [LIMIT_PARAM],
	},
	{
		id: "board.by_column",
		label: "Board items by column",
		kinds: ["bar", "table"],
		describes: "Runtime tasks grouped by status.",
		caveat: "A point-in-time view of items TOUCHED in the period, grouped by their status now — not by the status they had then.",
		unit: "count",
		params: [LIMIT_PARAM],
	},
	{
		id: "events.by_type",
		label: "Activity by type",
		kinds: ["bar", "table"],
		describes: "Trace events grouped by event name.",
		caveat: "Trace retention is opportunistic, so a long window can under-count the oldest days rather than showing them as empty.",
		unit: "count",
		params: [LIMIT_PARAM],
	},
	{
		id: "triggers.fires",
		label: "Trigger fires",
		kinds: ["number", "line", "bar", "table"],
		describes: "Webhook and cron trigger events, grouped by status for bar/table.",
		caveat: "Counts trigger EVENTS, which includes retries and failures — it is not a count of successful work.",
		unit: "count",
		params: [LIMIT_PARAM],
	},
	{
		id: "collection.count",
		label: "Collection size",
		kinds: ["number", "line"],
		describes: "How many records the named collection holds.",
		unit: "count",
		caveat:
			"A running total, not a per-period count: the number is the collection's size, and as a trend it is its size at the end of each day. Deletions make it go down.",
		params: [{ id: "collection", type: "collection", label: "Collection", required: true }],
	},
	{
		id: "collection.group_by",
		label: "Collection breakdown",
		kinds: ["bar", "table"],
		describes: "Records in the named collection grouped by one field.",
		caveat: `Scans at most ${COLLECTION_SCAN_CAP} records; past that the breakdown is reported as partial rather than presented as the whole collection. Records missing the field are grouped as "(not set)".`,
		unit: "count",
		params: [
			{ id: "collection", type: "collection", label: "Collection", required: true },
			{ id: "field", type: "field", label: "Group by field", required: true },
			LIMIT_PARAM,
		],
	},
];

export const STATS_SOURCE_IDS: readonly string[] = STATS_SOURCES.map((s) => s.id);

export function statsSource(id: string): StatsSource | undefined {
	return STATS_SOURCES.find((s) => s.id === id);
}

// ── Cards ───────────────────────────────────────────────────────────────────

export type StatsParamValue = string | number;

export interface StatsCard {
	id: string;
	title: string;
	kind: StatsCardKind;
	source: string;
	params: Record<string, StatsParamValue>;
}

/** A card that did not survive validation, and WHY, by name. Never swallowed: #310 asks for
 *  rejection "at save time, by name" for the same reason `validateConnectionFilter` rejects a
 *  never-matching filter up front — a card that silently vanishes looks like a save that worked. */
export interface StatsCardRejection {
	/** Position in the submitted array, so a caller can point at the offender even with no id. */
	index: number;
	id?: string;
	reason: string;
}

/** Twelve, matching MAX_SETTINGS_FIELDS. One page-level window means one query set per view, and
 *  this is how big that set can get. */
export const MAX_STATS_CARDS = 12;

const CARD_ID_RE = /^[a-z0-9_-]{1,40}$/;

/**
 * Validate one submitted card. Returns the card or the reason it was refused.
 *
 * `family` is accepted but never stored — see the module header. A caller that sends a family
 * contradicting the kind is REFUSED rather than silently corrected, because a writer told "saved"
 * about a trend card that is actually rendered live has been taught something false.
 */
export function validateStatsCard(value: unknown, index = 0): { card: StatsCard } | { rejection: StatsCardRejection } {
	const reject = (reason: string, id?: string) => ({ rejection: { index, id, reason } });
	if (!value || typeof value !== "object" || Array.isArray(value)) return reject("not an object");
	const o = value as Record<string, unknown>;

	const id = typeof o.id === "string" ? o.id.trim() : "";
	if (!CARD_ID_RE.test(id)) return reject(`invalid card id ${JSON.stringify(id)} — use a-z, 0-9, _ or -, max 40`);

	const title = typeof o.title === "string" ? o.title.trim().slice(0, 80) : "";
	if (!title) return reject("title is required", id);

	const kind = o.kind;
	if (typeof kind !== "string" || !STATS_CARD_KINDS.includes(kind as StatsCardKind)) {
		return reject(`unknown kind ${JSON.stringify(kind)} — one of ${STATS_CARD_KINDS.join(", ")}`, id);
	}

	const sourceId = typeof o.source === "string" ? o.source.trim() : "";
	const source = statsSource(sourceId);
	// Named, not "invalid card". The whole point of a closed vocabulary is that a typo is
	// answerable: the caller (often a model) can be told the list and try again.
	if (!source) return reject(`unknown source ${JSON.stringify(sourceId)} — one of ${STATS_SOURCE_IDS.join(", ")}`, id);
	if (!source.kinds.includes(kind as StatsCardKind)) {
		return reject(`source "${sourceId}" cannot be drawn as "${kind}" — it supports ${source.kinds.join(", ")}`, id);
	}

	if (o.family !== undefined) {
		const want = familyForKind(kind as StatsCardKind);
		if (o.family !== want) {
			return reject(`family ${JSON.stringify(o.family)} contradicts kind "${kind}", which is always "${want}"`, id);
		}
	}

	const rawParams = o.params && typeof o.params === "object" && !Array.isArray(o.params) ? (o.params as Record<string, unknown>) : {};
	const params: Record<string, StatsParamValue> = {};
	for (const spec of source.params) {
		const raw = rawParams[spec.id];
		if (spec.type === "limit") {
			// Absent and unparseable are treated DIFFERENTLY (#243): absent takes the default,
			// unparseable is an error the caller is told about. Collapsing them is precisely how an
			// unparseable limit came to mean "drop everything".
			if (raw === undefined || raw === null) {
				params[spec.id] = spec.default ?? MAX_CARD_LIMIT;
				continue;
			}
			const n = typeof raw === "number" ? raw : Number(raw);
			if (!Number.isFinite(n) || n < 1) return reject(`param "${spec.id}" must be a number ≥ 1, got ${JSON.stringify(raw)}`, id);
			params[spec.id] = Math.min(Math.floor(n), spec.max ?? MAX_CARD_LIMIT);
			continue;
		}
		if (raw === undefined || raw === null || raw === "") {
			if (spec.required) return reject(`missing required param "${spec.id}"`, id);
			continue;
		}
		if (typeof raw !== "string") return reject(`param "${spec.id}" must be a string, got ${typeof raw}`, id);
		const re = spec.type === "collection" ? COLLECTION_NAME_RE : FIELD_NAME_RE;
		if (!re.test(raw)) return reject(`param "${spec.id}" has an invalid ${spec.type} name ${JSON.stringify(raw)}`, id);
		params[spec.id] = raw;
	}

	return { card: { id, title, kind: kind as StatsCardKind, source: sourceId, params } };
}

/** Validate a whole array of cards, reporting every refusal. Duplicate ids are a rejection rather
 *  than a silent last-wins, because two cards with one id means one of them is invisible. */
export function validateStatsCards(value: unknown): { cards: StatsCard[]; rejected: StatsCardRejection[] } {
	const cards: StatsCard[] = [];
	const rejected: StatsCardRejection[] = [];
	if (!Array.isArray(value)) return { cards, rejected };
	const seen = new Set<string>();
	value.forEach((raw, index) => {
		if (cards.length >= MAX_STATS_CARDS) {
			rejected.push({ index, reason: `over the ${MAX_STATS_CARDS}-card limit` });
			return;
		}
		const result = validateStatsCard(raw, index);
		if ("rejection" in result) {
			rejected.push(result.rejection);
			return;
		}
		if (seen.has(result.card.id)) {
			rejected.push({ index, id: result.card.id, reason: `duplicate card id "${result.card.id}"` });
			return;
		}
		seen.add(result.card.id);
		cards.push(result.card);
	});
	return { cards, rejected };
}

/** Drop-the-junk form, for reading config written by an earlier (or looser) writer. Mirrors
 *  `sanitizeSettingsSchema`: `undefined` when nothing valid survives, so "declared nothing" and
 *  "declared only junk" read the same at the call site. */
export function sanitizeStatsSchema(value: unknown): StatsCard[] | undefined {
	const { cards } = validateStatsCards(value);
	return cards.length ? cards : undefined;
}

// ── The subscriber override ─────────────────────────────────────────────────

/**
 * What a subscriber stores at `agent_instances.config.stats`.
 *
 * `hidden` exists because a subscriber cannot DELETE a creator's card — that card belongs to the
 * agent every other subscriber gets, and the same boundary `patchBehaviour` holds ("a subscriber
 * changing their mind must not edit the agent every other subscriber gets") applies here. They hide
 * it in their own view, and un-hiding restores it. A tombstone in `cards` would have been
 * indistinguishable from an edit.
 */
export interface StatsOverride {
	cards: StatsCard[];
	hidden: string[];
}

export function sanitizeStatsOverride(value: unknown): StatsOverride {
	const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const cards = sanitizeStatsSchema(o.cards) ?? [];
	const hidden = Array.isArray(o.hidden)
		? [...new Set(o.hidden.filter((h): h is string => typeof h === "string" && CARD_ID_RE.test(h)))].slice(0, MAX_STATS_CARDS)
		: [];
	return { cards, hidden };
}

/**
 * Creator default merged per card under the subscriber's override — the same resolution shape as
 * behaviour, and for the same reason: the creator ships a useful starting set, the subscriber
 * adjusts their own copy, and neither write touches the other's row.
 *
 * Order is creator-first so a subscriber editing an inherited card keeps its position; new
 * subscriber cards append. Capped at MAX_STATS_CARDS after the merge, since two writers each under
 * the cap can exceed it together.
 */
export function resolveStatsCards(creatorSchema: unknown, subscriberOverride: unknown): StatsCard[] {
	const base = sanitizeStatsSchema(creatorSchema) ?? [];
	const { cards: overrides, hidden } = sanitizeStatsOverride(subscriberOverride);
	const hiddenSet = new Set(hidden);
	const byId = new Map<string, StatsCard>();
	const order: string[] = [];
	for (const card of base) {
		if (hiddenSet.has(card.id)) continue;
		byId.set(card.id, card);
		order.push(card.id);
	}
	for (const card of overrides) {
		if (!byId.has(card.id)) order.push(card.id);
		byId.set(card.id, card);
	}
	return order.slice(0, MAX_STATS_CARDS).map((id) => byId.get(id) as StatsCard);
}

/** One edit to the subscriber's override. `card: null` clears — matching every other patch route
 *  on the platform (`patchBehaviour`, settings, translation). */
export interface StatsCardOp {
	id: string;
	card: unknown | null;
}

/**
 * Apply card ops to the subscriber's stored override.
 *
 * Refusals are returned, never swallowed, and the ops that DID validate still apply — #312's
 * requirement, and the `set_behaviour` lesson: a tool that half-applies a patch and reports success
 * teaches the model it changed something it did not.
 *
 * `creatorIds` decides what a removal MEANS. Removing an inherited card hides it; removing one the
 * subscriber added deletes it. Without this the two are indistinguishable and hiding an inherited
 * card would appear to work and then silently come back on the next read.
 */
export function applyStatsCardOps(
	current: unknown,
	ops: unknown,
	creatorIds: readonly string[],
): { override: StatsOverride; rejected: StatsCardRejection[] } {
	const override = sanitizeStatsOverride(current);
	const rejected: StatsCardRejection[] = [];
	const list = Array.isArray(ops) ? ops : [ops];
	const creator = new Set(creatorIds);

	list.forEach((raw, index) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			rejected.push({ index, reason: "not an object" });
			return;
		}
		const op = raw as Record<string, unknown>;
		const id = typeof op.id === "string" ? op.id.trim() : "";
		if (!CARD_ID_RE.test(id)) {
			rejected.push({ index, reason: `invalid card id ${JSON.stringify(id)}` });
			return;
		}
		if (op.card === null) {
			override.cards = override.cards.filter((c) => c.id !== id);
			if (creator.has(id)) {
				if (!override.hidden.includes(id)) override.hidden.push(id);
			}
			return;
		}
		// An id on the op and an id inside the card must agree, or the caller is editing something
		// other than what it named — which is how a "fix card A" patch quietly creates card B.
		const body = { ...(op.card && typeof op.card === "object" ? (op.card as Record<string, unknown>) : {}), id };
		const result = validateStatsCard(body, index);
		if ("rejection" in result) {
			rejected.push(result.rejection);
			return;
		}
		override.hidden = override.hidden.filter((h) => h !== id);
		const at = override.cards.findIndex((c) => c.id === id);
		if (at >= 0) override.cards[at] = result.card;
		else if (override.cards.length + creator.size >= MAX_STATS_CARDS) {
			rejected.push({ index, id, reason: `over the ${MAX_STATS_CARDS}-card limit` });
		} else override.cards.push(result.card);
	});

	return { override, rejected };
}

/**
 * The `## Stats` prompt block, DERIVED from the resolved cards ("" when there are none).
 *
 * Derived, not written. #254 is the precedent: the prompt asserted a capability the tool set
 * contradicted, and the agent confidently offered something it could not do. An agent with no cards
 * is told it has none — so it cannot answer "how many leads this week" from an imagined dashboard —
 * and an agent with cards is told their titles so it knows `get_stats` is worth calling.
 */
export function statsPromptBlock(cards: readonly StatsCard[]): string {
	if (!cards.length) return "";
	const lines = cards.map((c) => `- ${c.title} (${familyForKind(c.kind) === "trend" ? "daily trend" : "current"})`);
	return (
		"## Stats\nYou track these for your subscriber. Call `get_stats` to read the CURRENT numbers " +
		"before answering any question about them — never estimate, and never recompute them from a " +
		"record dump:\n" +
		lines.join("\n")
	);
}

// ── The page window ─────────────────────────────────────────────────────────

/** One page-level window, not one per card, so a view is one query set (#310). */
export const STATS_WINDOWS = [7, 30, 90] as const;
export type StatsWindowDays = (typeof STATS_WINDOWS)[number];

/** Absent → 30d. Unparseable or out-of-vocabulary → also 30d, but the caller is told which window
 *  it actually got (`window` is echoed in every response) rather than being left to assume. */
export function parseStatsWindow(raw: unknown): StatsWindowDays {
	const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/d$/, ""));
	return Number.isFinite(n) && (STATS_WINDOWS as readonly number[]).includes(n) ? (n as StatsWindowDays) : 30;
}
