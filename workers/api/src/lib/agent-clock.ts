/**
 * What time it is, and whose clock that is (#329).
 *
 * ── The bug, which does not look like one
 *
 * A Coder Lead reported: *"the run completed at 22:34:19 UTC today"*. Read quickly that is a small
 * annoyance. It is a correctness bug: "the run finished at 22:34" is a DIFFERENT CLAIM in Sydney
 * than in UTC, and "today" is a different day. The agent was not at fault — it read an ISO string
 * out of a tool result and labelled it accurately with the only zone it had been given. Two facts,
 * both verified when the ticket was filed:
 *
 *   • No user timezone was stored anywhere. Not in `users.preferences`, not in `user_profile`, not
 *     in any migration.
 *   • No prompt contained a clock at all. An agent could not say what "today" was, let alone
 *     "overnight" or "this morning".
 *
 * ── Where the zone comes from, and why not the other two candidates
 *
 * `users.preferences.timezone` — the account blob from #211. A timezone is a property of the PERSON,
 * exactly like the voice and translation settings already there, and that blob is the one the owner
 * already maintains for everything that follows them across agents. It needed no migration (the
 * column exists since 0071) and no new page.
 *
 * The alternatives were both worse for the same reason — they are maintained by fewer people than
 * need the answer. `user_profile` is the apply pipeline's structured PII, so a zone stored there is
 * only ever filled in by someone using the job agent. A typed `settingsSchema` field would have to be
 * DECLARED by each creator and then SET by each subscriber, per agent — a user with four agents
 * would answer the same question four times, and any agent whose creator forgot to declare it would
 * still narrate in UTC. A browser-supplied value is the right way to SEED the stored one (the console
 * knows it for free from `Intl.DateTimeFormat().resolvedOptions().timeZone`), but it cannot be the
 * source of record: it changes when you travel, it is absent on every non-browser path (cron
 * triggers, the pump, MCP), and it is not something the user can correct.
 *
 * ── Unset is a first-class state
 *
 * There is no default zone. An absent timezone means "nobody has told us", and the prompt then names
 * UTC out loud and says so. This is the behaviour system's rule (#223) applied to a clock: an unset
 * field emits nothing and leaves the existing behaviour in charge. **A confidently wrong local time
 * is worse than an explicit UTC** — the whole complaint in #329 is a time that means something other
 * than what the reader thinks, and guessing a zone produces exactly that with the honest label
 * removed.
 *
 * ── Language the model can repeat, not arithmetic it can get subtly wrong
 *
 * Timezone maths is the class of thing a language model does *almost* right: DST edges, day
 * boundaries, "yesterday" near midnight. So the block hands over a PRE-FORMATTED local string and the
 * current offset, and tells the model to convert only near now and to fall back to naming UTC
 * otherwise. Same principle as rendering a technicality slider as a described band rather than
 * "70/100" (#223): give it words to repeat rather than a number to compute with.
 *
 * PURE — no D1, no Env, no `Date.now()` of its own. `now` is always passed so every branch is
 * testable at a fixed instant, including either side of a DST transition.
 */

/** A wall-clock string in `zone`, with the zone abbreviation named. Throws on an unknown zone. */
export function formatInZone(now: number, zone: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone: zone,
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short",
	}).format(new Date(now));
}

/**
 * The zone's CURRENT offset from UTC, as `+10:00` / `-04:30` / `+00:00`.
 *
 * Derived by differencing the same instant formatted in the zone against the same instant formatted
 * in UTC, rather than parsing an abbreviation: `AEST` is not a value any API resolves, and the
 * `GMT+10` form `timeZoneName: "shortOffset"` gives is not available on every runtime. Deliberately
 * "current" — the offset is a fact about NOW, which is why the prompt bounds its use to times near
 * now instead of presenting it as a property of the zone.
 */
export function utcOffsetLabel(now: number, zone: string): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(now));
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	// Rounded to the minute: `now` carries milliseconds that the formatted parts do not, so the raw
	// difference is off by up to 999ms and would render zones like Kathmandu (+05:45) as +05:44.
	const minutes = Math.round((asUtc - Math.floor(now / 1000) * 1000) / 60000);
	const sign = minutes < 0 ? "-" : "+";
	const abs = Math.abs(minutes);
	return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** The same instant in UTC, for the branch where UTC is the only zone we can honestly name. */
function formatUtc(now: number): string {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone: "UTC",
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(new Date(now));
}

/**
 * The `## Current time` block.
 *
 * Emitted in BOTH branches, because "what time is it" and "which zone is the user in" are two
 * different questions and only the second one has an unset state. A clock in UTC is a FACT; a local
 * time without a zone would be a guess. So an unset zone loses the localisation, never the clock.
 */
export function clockPrompt(now: number, zone?: string): string {
	if (!zone) {
		return (
			`\n\n## Current time\nRight now it is ${formatUtc(now)} UTC.` +
			"\n- You have NOT been told the user's timezone, so UTC is the only zone you can name honestly. Say \"UTC\" every" +
			" time you give a time, and never present a UTC time as if it were the user's local time." +
			"\n- Do NOT guess a local time, and do not assume the user lives in UTC. If a local time matters, ask them, or" +
			" tell them they can set their timezone once in their account preferences and every agent will use it."
		);
	}
	return (
		`\n\n## Current time\nRight now it is ${formatInZone(now, zone)} — the user's own timezone (${zone}, currently UTC${utcOffsetLabel(now, zone)}).` +
		" Use it for \"today\", \"this morning\", \"overnight\" and any other relative day-word." +
		"\n- Give times in the user's zone and NAME the zone, e.g. \"08:33 AEST\". Do not report bare UTC to them." +
		"\n- Timestamps you read out of tools, records, documents or logs are UTC unless they say otherwise. For a time within" +
		" about a day of now, convert it with the offset above. Further from now the offset can change with daylight saving —" +
		" then give the UTC value and say it is UTC rather than guessing an hour."
	);
}
