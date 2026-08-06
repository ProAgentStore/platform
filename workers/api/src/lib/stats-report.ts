/**
 * Resolving a card set to its VALUES, and rendering them for a model (#310/#312).
 *
 * Its own module because three callers need the same numbers and must not each compute their own:
 * the route (`GET /v1/instances/:id/stats`), the MCP subscriber tool, and the agent's own
 * `get_stats`. #312's verification is literally "`get_stats` returns the same numbers the Stats tab
 * shows for the same window" — which is only structurally true if there is one implementation.
 */
import { completedDay, readStatsSeries, type StatsPoint } from "./stats-rollup.js";
import { familyForKind, statsSource, type StatsCard, type StatsCardFamily, type StatsUnit, unitFor } from "./stats-schema.js";
import { readPointInTime, statsPeriod, type StatsCtx, type StatsValue } from "./stats-sources.js";

export interface ComputedCard {
	id: string;
	title: string;
	kind: StatsCard["kind"];
	source: string;
	family: StatsCardFamily;
	params: StatsCard["params"];
	/** What this number does not count. Travels WITH the value so a caller cannot show one
	 *  without the other — the Usage page's lesson, made structural. */
	caveat: string;
	/**
	 * A series carries its UNIT for the same reason a scalar does.
	 *
	 * `usage.cost` counts USD micros; a series without a unit rendered "2,500,000" under a card
	 * titled "Estimated AI cost" — wrong by six orders of magnitude. The console must not infer the
	 * unit from the source id, because an inference in the UI is a second declaration that drifts
	 * from this one.
	 */
	data?: StatsValue | { type: "series"; unit: StatsUnit; points: StatsPoint[] };
	/**
	 * Set INSTEAD of `data` when this one card failed.
	 *
	 * One card's failure must not blank the page, and "failed" must stay distinguishable from
	 * "empty": a successful-looking empty result is how #243 and #252 became confusing, and a
	 * renderer cannot tell the two apart unless the API does.
	 */
	error?: string;
}

/**
 * Every card's value for one page-level window.
 *
 * Trend (`line`) cards are a keyed read of the rollup; everything else is the live aggregate.
 * Each card is caught individually, so a single broken source degrades to one error card.
 */
export async function computeStats(
	ctx: StatsCtx,
	cards: readonly StatsCard[],
	windowDays: number,
	now = new Date(),
): Promise<ComputedCard[]> {
	const throughDay = completedDay(now);
	const period = statsPeriod(throughDay, windowDays);
	const out: ComputedCard[] = [];
	for (const card of cards) {
		const base: ComputedCard = {
			id: card.id,
			title: card.title,
			kind: card.kind,
			source: card.source,
			family: familyForKind(card.kind),
			params: card.params,
			caveat: statsSource(card.source)?.caveat ?? "",
		};
		try {
			base.data =
				base.family === "trend"
					? {
							type: "series",
							unit: unitFor(card.source),
							points: await readStatsSeries(ctx.env, ctx.instanceId, ctx.userId, card.id, windowDays, now),
						}
					: await readPointInTime(ctx, card, period);
		} catch (err) {
			base.error = err instanceof Error ? err.message : String(err);
		}
		out.push(base);
	}
	return out;
}

/**
 * The same numbers, as text a model can answer from.
 *
 * The gap rule is spelled out in the OUTPUT, not just in the type. A model handed
 * `[{day:"…",value:null}]` with no explanation reads the null as a bad day and reports it as one —
 * "you found zero leads on Tuesday" — which is the exact misreport #313 exists to prevent. So a
 * gap is rendered as the word "no run", and the block says what that means.
 */
export function describeStats(cards: readonly ComputedCard[], windowDays: number, throughDay: string): string {
	if (!cards.length) {
		return "You have no stats cards configured. You can add one with set_stats_card if the user asks you to track something.";
	}
	const lines: string[] = [`Stats over the last ${windowDays} days (trend series end ${throughDay}, the last completed UTC day):`];
	for (const card of cards) {
		if (card.error) {
			// Reported, never rendered as an empty card. An agent that says "0" because a query
			// failed has invented a fact.
			lines.push(`\n### ${card.title}\nCOULD NOT BE READ: ${card.error}. Do not report a number for this.`);
			continue;
		}
		lines.push(`\n### ${card.title} (${card.source})`);
		const data = card.data;
		if (!data) {
			lines.push("no data");
		} else if (data.type === "series") {
			const shown = data.points.map((p) => `${p.day}: ${p.value === null ? "no run" : p.value}`);
			lines.push(shown.join("\n"));
			// The unit, spelled out for the same reason the gap rule is: a model reading a bare
			// "2500000" under a card titled "cost" will report two and a half million dollars.
			if (data.unit === "usd_micros") lines.push("Values are USD micros (1,000,000 = $1).");
			else if (data.unit === "tokens") lines.push("Values are token counts.");
			if (data.points.some((p) => p.value === null)) {
				lines.push('"no run" means nothing was recorded that day. It is NOT zero — do not report it as a day with no results.');
			}
		} else if (data.type === "scalar") {
			lines.push(`${data.value}${data.unit === "usd_micros" ? " USD micros (1,000,000 = $1)" : data.unit === "tokens" ? " tokens" : ""}`);
		} else {
			lines.push(data.rows.length ? data.rows.map((r) => `${r.label}: ${r.value}`).join("\n") : "(no rows)");
			if (data.partial) {
				lines.push(`Partial: this covers ${data.scanned} of ${data.total} records. Say so rather than presenting it as the whole collection.`);
			}
		}
		if (card.caveat) lines.push(`Caveat: ${card.caveat}`);
	}
	return lines.join("\n");
}
