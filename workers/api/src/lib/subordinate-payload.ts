// What `subordinate_status` actually SENDS, and how it is made to fit (#503).
//
// PURE — no D1, no Env, no I/O, like `subordinate-observation.ts` beside it. The reads live in
// `connectors/supervision.ts`; the size judgement lives here, where it can be tested against a
// roster of ten busy agents without a database.
//
// ── The failure this exists to end
//
// A Lead supervising six agents was asked "how many agents do you have" six times over two days
// and never answered it. Measured live: the tool returned 60,239 characters into `capToolResult`'s
// 24,000-character ceiling, so 60% of the roster never reached the model. Two individually correct
// decisions composed into it:
//
//   `summarizeSubordinates` budgets to 16,000 characters — but only over `{work, runs, buckets}`.
//   `connectivity`, `config`, `repo`, `acts` and a 3,600-character legend are attached AFTERWARDS
//   and the whole thing is pretty-printed, so the budget governed a quarter of what shipped.
//
// The cut is announced (`capToolResult` says "the rest was NOT read — ask for a narrower slice"),
// and the agent relayed that honestly every single time. The defect was that there WAS no narrower
// slice that answers "how many agents do I have": the tool takes one instance id or nothing, so
// the roster question had no cheap form and the model answered it by counting the survivors.
//
// ── The two rules everything here follows
//
//  1. THE ROSTER IS NEVER THE THING THAT GETS CUT. `total` and `roster` are the first bytes of the
//     payload and are built from the complete list, so "how many agents do I have" and "which are
//     idle" are answerable from a result that had to drop everything else. A caller must never be
//     able to receive a partial roster that looks whole.
//  2. A REDUCTION SAYS SO, NEXT TO WHAT IT REDUCED. Detail degrades uniformly across every agent
//     rather than dropping agents off the end, and every shortened list carries a `…Omitted` count.
//     This is the #159/#183 invariant restated: a missing `acts` must never read as "it did
//     nothing", so a list is empty ONLY when it is genuinely empty.

import { DIRECTION_LEGEND } from "./agent-direction.js";
import { CONFIG_LEGEND } from "./subordinate-config.js";

/**
 * The ceiling for the whole serialised payload, in characters.
 *
 * Deliberately below `TOOL_RESULT_MAX_CHARS` (24,000), and by a margin: the generic backstop must
 * stay a backstop, and a per-tool budget that overruns the global one is precisely how half a
 * roster disappeared with nothing but a truncation notice to show for it.
 *
 * It is also LESS than this tool spends today. The cap already forces 24,000 characters of this
 * payload into every prompt; 20,000 of a complete answer costs the context window less than 24,000
 * of a broken one. `MAX_OBSERVATION_CHARS` (16,000) still bounds `{work, runs}` upstream — that
 * pre-bound is useful and stays — but it was never the size of what shipped, which is the defect.
 */
export const MAX_STATUS_PAYLOAD_CHARS = 20_000;

/** How much detail survived. Reported in the payload so the model knows which answer it is holding. */
export type DetailLevelId = "full" | "trimmed" | "brief" | "terse" | "summary";

interface DetailLevel {
	id: DetailLevelId;
	/** Max items kept in any list. Never below 1 for a non-empty list — see rule 2. */
	items: number;
	/** Max characters kept in any prose string. */
	chars: number;
	/** The last rung: lists become counts and one line survives per agent. */
	collapse?: boolean;
}

/**
 * The ladder, richest first. The first rung that fits is the one that ships.
 *
 * Uniform across every subordinate on purpose: "six agents exist, here are three in detail" is a
 * strictly worse answer to a supervisor's question than "six agents exist, here is each in brief",
 * because only the second one can be acted on without knowing what is missing.
 *
 * Measured against the live payload (#503): six subordinates of the size that broke this land on
 * `summary`, ten land on `summary`, and one — the narrower slice a supervisor should ask for once
 * it knows which agent it cares about — lands on `full`. That asymmetry is the design, not a
 * compromise: a roster answer has to be complete, and a per-agent answer has to be deep, and one
 * reply cannot be both inside any budget a prompt can afford.
 */
const LEVELS: readonly DetailLevel[] = [
	{ id: "full", items: Number.POSITIVE_INFINITY, chars: Number.POSITIVE_INFINITY },
	{ id: "trimmed", items: 3, chars: 240 },
	{ id: "brief", items: 2, chars: 140 },
	{ id: "terse", items: 1, chars: 90 },
	{ id: "summary", items: 1, chars: 80, collapse: true },
];

/**
 * Keys whose string value is an IDENTIFIER, never prose — cutting one produces a value that looks
 * usable and is not. `repo.githubRepo` cut to 80 characters is still a plausible `owner/name`, and
 * #320 is the ticket about a supervisor passing a plausible-looking repo path to a GitHub tool.
 */
const NEVER_CUT = new Set(["instanceId", "runId", "id", "name", "githubRepo", "node", "kind", "status", "subscription", "state", "policy", "branch", "setBy", "runnerVersion"]);

/** Lists that are already a summary. Trimming a bucket count removes the count, not its detail. */
const NEVER_TRIM = new Set(["buckets"]);

/**
 * Shorten one value to a level: lists capped, prose cut, everything else untouched.
 *
 * Shape-agnostic by design (#468): it walks whatever it is given rather than enumerating the
 * fields of `SubordinateSummary`/`SubordinateConfig`/`RepoStateReport`, so a field added to any of
 * those next month is bounded on the day it appears instead of the day someone remembers this file.
 */
function reduceValue(value: unknown, level: DetailLevel): unknown {
	if (typeof value === "string") {
		if (value.length <= level.chars) return value;
		return `${value.slice(0, level.chars)}…[+${value.length - level.chars} chars]`;
	}
	if (Array.isArray(value)) return value.map((v) => reduceValue(v, level));
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	// Accumulated rather than written inline: a `…Omitted` count may ALREADY be on the input (the
	// work trim in `summarizeSubordinates` sets one), and this pass may drop more from the same
	// list. Writing as we go would replace that count with the smaller one and under-report.
	const omitted = new Map<string, number>();
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		if (key.endsWith("Omitted") && typeof v === "number") {
			omitted.set(key, (omitted.get(key) ?? 0) + v);
			continue;
		}
		if (Array.isArray(v) && !NEVER_TRIM.has(key)) {
			// Floor of 1: a list cut to zero reads as "there is nothing", and the legend tells the
			// model exactly that. One item plus a count is the difference between "idle" and "busy,
			// and here is the newest thing".
			const cap = Math.max(1, level.items);
			const kept = v.slice(0, cap).map((x) => reduceValue(x, level));
			out[key] = kept;
			if (v.length > kept.length) omitted.set(`${key}Omitted`, (omitted.get(`${key}Omitted`) ?? 0) + (v.length - kept.length));
			continue;
		}
		out[key] = NEVER_CUT.has(key) && typeof v === "string" ? v : reduceValue(v, level);
	}
	for (const [key, n] of omitted) out[key] = n;
	return out;
}

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * One agent in one line — the last rung, and the one that makes a ten-agent roster reportable.
 *
 * This is the ONLY place in this file that names fields, and it is named on purpose: the rung is an
 * editorial judgement about what a supervisor must not lose when it can keep almost nothing, and
 * that judgement cannot be derived from the shape. What it keeps, and why:
 *
 *   `connectivity.canWork` — the legend says it is the only field that answers "can I give this
 *     agent work", so collapsing it into prose would make the legend false exactly here.
 *   `irreversibleActs`     — #159/#183: a supervisor reports a merge or a force-push unprompted.
 *     A count cannot be mistaken for "it did nothing" the way an absent list can, and it is the
 *     signal that tells the model to ask about this agent specifically.
 *   `latest`               — what it is doing, in one string, which is the question being asked.
 *   `config.mergeAuthority`— #339: what it is ALLOWED to do is standing configuration, never a run.
 *
 * Every list becomes a `…Count` GENERICALLY, so a list added to the payload next month is counted
 * on the day it appears rather than silently reading as zero.
 */
function collapseSubordinate(sub: Record<string, unknown>, level: DetailLevel): Record<string, unknown> {
	const cut = (v: unknown): string | undefined => {
		if (typeof v !== "string" || !v) return undefined;
		return v.length <= level.chars ? v : `${v.slice(0, level.chars)}…`;
	};
	const out: Record<string, unknown> = {};
	for (const key of ["instanceId", "name", "subscription"]) if (key in sub) out[key] = sub[key];
	for (const [key, v] of Object.entries(sub)) {
		if (!Array.isArray(v)) continue;
		const already = sub[`${key}Omitted`];
		out[`${key}Count`] = v.length + (typeof already === "number" ? already : 0);
	}
	const runs = Array.isArray(sub.runs) ? (sub.runs as Array<Record<string, unknown>>) : [];
	const work = Array.isArray(sub.work) ? (sub.work as Array<Record<string, unknown>>) : [];
	const acts = Array.isArray(sub.acts) ? (sub.acts as Array<Record<string, unknown>>) : [];
	out.activity = runs.some((r) => r.status === "running") ? "working" : "idle";
	// The newest thing this agent is on, whichever record holds it. Not a substitute for the run
	// record — it is the one string that keeps "what is it doing" answerable at this rung.
	const running = runs.find((r) => r.status === "running") ?? runs[0];
	const latest = cut(typeof running?.objective === "string" ? running.objective : undefined) ?? cut(typeof work[0]?.title === "string" ? work[0].title : undefined);
	if (latest) out.latest = latest;
	if (acts.length) out.irreversibleActs = acts.filter((a) => a.irreversible === true).length;
	const conn = asObject(sub.connectivity);
	if (conn) out.connectivity = { state: conn.state, canWork: conn.canWork, ...(cut(conn.message) ? { message: cut(conn.message) } : {}), ...(cut(conn.remedy) ? { remedy: cut(conn.remedy) } : {}) };
	else if ("connectivity" in sub) out.connectivity = sub.connectivity;
	const config = asObject(sub.config);
	if (config) out.config = { available: config.available, mergeAuthority: reduceValue(config.mergeAuthority, level) };
	else if ("config" in sub) out.config = sub.config;
	const repo = asObject(sub.repo);
	if (repo) out.repo = { name: repo.name, githubRepo: repo.githubRepo, branch: repo.branch, dirtyFiles: repo.dirtyFiles, ...(cut(repo.note) ? { note: cut(repo.note) } : {}) };
	for (const key of ["direction", "proposedDirection"]) if (key in sub) out[key] = reduceValue(sub[key], level);
	out.summarised = "one line only — call subordinate_status with this instanceId for its work, runs, acts, configuration and repository";
	return out;
}

/** One line of the complete roster — the part of the answer that is never reduced. */
export interface RosterLine {
	instanceId: string;
	name: string;
	subscription: string;
	/** `working` = a run is going right now; `idle` = nothing in flight. Absent when not read. */
	activity?: "working" | "idle";
	/** `connectivity.canWork` — may it be given work now. Absent when not read. */
	canWork?: boolean;
}

/**
 * The roster, with each agent's one-word state where this call actually looked.
 *
 * `activity` is present only for the subordinates this call OBSERVED: a status call narrowed to one
 * agent reads runs for that agent alone, and reporting the other five as "idle" on the strength of
 * a query that never asked about them is the confident-wrong-answer this whole file is against.
 */
export function rosterLines(input: {
	roster: ReadonlyArray<{ instanceId: string; name: string; subscription: string }>;
	observed: ReadonlyArray<{ instanceId: string; runs: ReadonlyArray<{ status: string }> }>;
	canWork: ReadonlyMap<string, boolean>;
}): RosterLine[] {
	const observedById = new Map(input.observed.map((o) => [o.instanceId, o] as const));
	return input.roster.map((r) => {
		const seen = observedById.get(r.instanceId);
		const can = input.canWork.get(r.instanceId);
		return {
			instanceId: r.instanceId,
			name: r.name,
			subscription: r.subscription,
			...(seen ? { activity: (seen.runs.some((x) => x.status === "running") ? "working" : "idle") as "working" | "idle" } : {}),
			...(typeof can === "boolean" ? { canWork: can } : {}),
		};
	});
}

/**
 * Said in the payload, because the payload is what the model reads (the #259 precedent).
 *
 * Two sentences carry the whole fix: where the count lives, and what a `…Omitted` count means. The
 * second one is load-bearing for #159/#183 — a shortened `acts` list must not read as an all-clear.
 */
export const COMPLETENESS_LEGEND =
	" `total` and `roster` are the COMPLETE list of every agent you supervise and are NEVER shortened: answer \"how many agents do you have\" from `total` and \"which ones are idle\" from `roster[].activity` (`working` = a run is going now, `idle` = nothing in flight, which is the normal ready state). Never answer either question by counting `subordinates` — that is the DETAIL, and `coverage` says how much of it survived. " +
	"A `…Omitted` number beside a list (`workOmitted`, `actsOmitted`, …) means that list was SHORTENED to fit this reply: the items exist, nothing has been lost, and you can see them by calling subordinate_status with that agent's `instanceId`. A list is empty ONLY when there is genuinely nothing in it. " +
	"An entry carrying `summarised` is ONE LINE about that agent, not its record: its lists are replaced by `…Count` numbers (`workCount`, `actsCount`), `latest` is the newest thing it is on, and `irreversibleActs` counts merges, pushes and deletes it made — a non-zero one is worth asking about by instanceId, and a zero one means none were OBSERVED, never that it changed nothing. " +
	"Text ending in `…[+N chars]` or `…` was cut for length — say so rather than reading it as the whole sentence.";

/**
 * Said in the payload because the payload is what the model is reading (#345).
 *
 * Every timestamp here has already been converted to the owner's zone with the zone NAMED, so the
 * remaining failure is a model "helpfully" converting an already-local time back to UTC — which is
 * the same wrong hour arriving by the opposite route.
 */
export const TIMES_LEGEND =
	"Every time in this payload is ALREADY the owner's local wall clock with its zone named. Repeat it as written — do not convert it, do not re-label it UTC, and do not add an offset. ";

/**
 * The whole legend `subordinate_status` ships, assembled from the four that own their own subject.
 *
 * It lives beside the budget rather than beside the reads because it is 3,600 characters of the
 * budget — the single largest thing in the payload after the subordinates themselves, and the one
 * piece that is identical in every reply.
 */
export const STATUS_LEGEND =
	"`connectivity.canWork` is the ONLY field that says whether an agent can be given work now. Empty `work`/`runs` means IDLE — which is normal and ready, not offline. " +
	"`repo` is the CURRENT state of the checkout a goal would run in — the branch it is parked on and any uncommitted work a previous run left. It is context, not a gate: a run starts from wherever the repo was left, and nothing resets or discards it. Relay `repo.note` to the human when it is present, and never instruct an agent to clear a working tree you did not put there. " +
	// #320: the Lead passed "fws" to github_list_issues because `repo.name` was all it had, got
	// "No github access", and asked the HUMAN for a path the platform stores.
	"`repo.githubRepo` is that repository's `owner/name` on GitHub and is the ONLY value to pass to a GitHub tool. `repo.name` is a display label chosen by the owner — it may look like a path and still not be one. When `githubRepo` is absent the repo is not linked to GitHub; say that rather than guessing an owner or asking the human to supply one. " +
	"`acts` is what an agent actually DID — a pull request opened or merged, a push, a force-push, a delete, a deploy — with the literal command as evidence. Anything with `irreversible: true` changed something that cannot simply be undone, so REPORT IT to the human unprompted: an outcome of 'done' says only that the agent believes it finished, never what it changed on the way. " +
	"An act with `ok: false` FAILED and one with `ok: null` was not observed to succeed — neither is a completed action and neither may be described as one. " +
	"ABSENT `acts` means NOT OBSERVED, never 'it did nothing': only some engines report acts at all. Never read a missing `acts` as an all-clear or tell the human the agent changed nothing. " +
	TIMES_LEGEND +
	CONFIG_LEGEND +
	" " +
	DIRECTION_LEGEND;

/**
 * Fit the status payload to its budget, and say in the payload what fitting it cost.
 *
 * Key ORDER matters and is deliberate: `asOf`, `total`, `roster` and `coverage` come before the
 * legend and the detail, so even a result cut by some future caller keeps the answer to the roster
 * question. That is defence in depth — the budget below already guarantees `capToolResult` cannot
 * fire on this tool — and it costs nothing.
 */
export function fitStatusPayload(input: {
	/** Already the owner's wall clock — `localStamp` returns null for a time it cannot render. */
	asOf: string | null;
	roster: readonly RosterLine[];
	subordinates: ReadonlyArray<Record<string, unknown>>;
	/** Anything that rides between `coverage` and `legend` — today `resolved`. */
	extra?: Record<string, unknown>;
	legend: string;
	maxChars?: number;
}): { content: string; level: DetailLevelId; detailOmittedFor: string[] } {
	const max = input.maxChars ?? MAX_STATUS_PAYLOAD_CHARS;
	const total = input.roster.length;
	const legend = input.legend + COMPLETENESS_LEGEND;

	const note = (level: DetailLevelId, shown: number, omittedNames: string[]): string => {
		const head = `All ${total} agent${total === 1 ? "" : "s"} you supervise are listed in \`roster\`.`;
		if (level === "full" && !omittedNames.length) return `${head} Every one is reported in full below.`;
		const cut =
			level === "full"
				? ""
				: " Per-agent detail below was SHORTENED to fit — see the `…Count`/`…Omitted` numbers, and call subordinate_status with one `instanceId` to get that agent in full.";
		// The names are NOT repeated here: `roster` above already holds every one of them, and
		// spelling 400 of them out twice is how this reply blew its own budget in testing.
		const dropped = omittedNames.length
			? ` Detail for ${omittedNames.length} of them was left out of this reply entirely — they are named in \`roster\`, and asking about one by its instanceId returns it in full.`
			: "";
		return `${head} ${shown} of ${total} are reported below.${cut}${dropped}`;
	};

	/** Names, capped: enough to act on, and never enough to become the thing that does not fit. */
	const NAMES_IN_COVERAGE = 20;

	const build = (subs: unknown[], level: DetailLevelId, omittedNames: string[], roster: readonly RosterLine[], rosterOmitted: number) =>
		JSON.stringify({
			asOf: input.asOf,
			total,
			roster,
			...(rosterOmitted ? { rosterOmitted } : {}),
			coverage: {
				detailFor: subs.length,
				of: total,
				detailLevel: level,
				...(omittedNames.length ? { detailOmittedFor: omittedNames.slice(0, NAMES_IN_COVERAGE), detailOmittedCount: omittedNames.length } : {}),
				note: note(level, subs.length, omittedNames),
			},
			...(input.extra ?? {}),
			legend,
			subordinates: subs,
		});

	const at = (level: DetailLevel) => input.subordinates.map((s) => (level.collapse ? collapseSubordinate(s, level) : (reduceValue(s, level) as Record<string, unknown>)));

	for (const level of LEVELS) {
		const content = build(at(level), level.id, [], input.roster, 0);
		if (content.length <= max) return { content, level: level.id, detailOmittedFor: [] };
	}

	// Past the deepest rung — a roster far larger than this feature was built for. Detail now comes
	// off the END, and how many came off is stated in `coverage`; the names are already in `roster`,
	// which is itself the last thing to go and only ever with `rosterOmitted` saying how many.
	//
	// Binary search, because the payload grows monotonically with what is kept and a linear walk
	// over four hundred agents means four hundred serialisations of a 16 KB document.
	const reduced = at(LEVELS[LEVELS.length - 1]);
	const nameOf = (i: number) => String(reduced[i]?.name ?? input.subordinates[i]?.name ?? "unnamed");
	const largestFitting = (hi: number, render: (keep: number) => string): { keep: number; content: string } | null => {
		let lo = 0;
		let best: { keep: number; content: string } | null = null;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const content = render(mid);
			if (content.length <= max) {
				best = { keep: mid, content };
				lo = mid + 1;
			} else hi = mid - 1;
		}
		return best;
	};

	const withDetail = largestFitting(reduced.length - 1, (keep) =>
		build(reduced.slice(0, keep), "summary", reduced.slice(keep).map((_, i) => nameOf(keep + i)), input.roster, 0),
	);
	if (withDetail) {
		const omittedNames = reduced.slice(withDetail.keep).map((_, i) => nameOf(withDetail.keep + i));
		return { content: withDetail.content, level: "summary", detailOmittedFor: omittedNames };
	}

	const allNames = reduced.map((_, i) => nameOf(i));
	const withRoster = largestFitting(input.roster.length, (keep) => build([], "summary", allNames, input.roster.slice(0, keep), input.roster.length - keep));
	// Nothing fits at all: return the smallest honest thing rather than a lie about the count.
	return { content: withRoster?.content ?? build([], "summary", allNames, [], input.roster.length), level: "summary", detailOmittedFor: allNames };
}
