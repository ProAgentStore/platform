/**
 * The wire shapes of the stats API (#310/#312/#313), mirrored for the console.
 *
 * Types only — no copy, no thresholds, no source list. Everything a user READS about a source
 * (its label, what it describes and, above all, its caveat) is served by `GET /v1/stats/sources`
 * and rendered verbatim; restating any of it here is how the console comes to say a number counts
 * something the query stopped counting.
 */

export type StatsCardKind = "number" | "line" | "bar" | "table";
export type StatsUnit = "count" | "tokens" | "usd_micros";

/** One day of a trend. `value: null` means NO ROW — the agent did not run that day. It is not a
 *  zero, and no renderer may turn it into one. */
export interface StatsPoint {
	day: string;
	value: number | null;
}

export type StatsData =
	// The series carries its unit: `usage.cost` is USD micros, and a trend rendered as a plain
	// count would be wrong by six orders of magnitude. The unit is declared once, server-side,
	// beside the caveat — inferring it here from the source id would be a second declaration.
	| { type: "series"; unit?: StatsUnit; points: StatsPoint[] }
	| { type: "scalar"; value: number; unit: StatsUnit }
	| {
			type: "groups";
			rows: Array<{ label: string; value: number }>;
			/** The breakdown covers `scanned` of `total` records — say so rather than presenting a
			 *  sample as the whole collection. */
			partial?: boolean;
			scanned?: number;
			total?: number;
	  };

/**
 * A resolved card. Carries EITHER `data` or `error`, never both, which is what makes "this card
 * failed" distinguishable from "this card has nothing yet" without the console guessing.
 */
export interface StatsCardValue {
	id: string;
	title: string;
	kind: StatsCardKind;
	source: string;
	family: "trend" | "point_in_time";
	params?: Record<string, string | number>;
	/** What this number does not count. Travels with the value; rendered next to it. */
	caveat: string;
	data?: StatsData;
	error?: string;
}

export interface StatsResponse {
	window: number;
	/** The last COMPLETED UTC day. Every series ends here; today is deliberately absent. */
	throughDay: string;
	/** First day the rollup holds for this instance, or `null` when it holds nothing. There is no
	 *  backfill, so a short series is a young rollup rather than an idle agent. */
	historyStart: string | null;
	cards: StatsCardValue[];
}

/** One entry of the served source catalog. */
export interface StatsSourceInfo {
	id: string;
	label: string;
	describes: string;
	caveat: string;
	kinds: StatsCardKind[];
	families: Array<"trend" | "point_in_time">;
	params: Array<{ id: string; type: "collection" | "field" | "limit"; label: string; required?: boolean; max?: number; default?: number }>;
}

export interface StatsSourcesResponse {
	sources: StatsSourceInfo[];
	maxCards: number;
}

/** A card the server refused, and why — shown, never swallowed. */
export interface StatsRejection {
	index: number;
	id?: string;
	reason: string;
}
