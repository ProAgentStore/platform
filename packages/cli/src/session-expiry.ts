/**
 * When the machine's sign-in runs out, said early enough to act on (#1184): 30, 7 and 1 days before, and once it has.
 *
 * A running `pags up` renews its own sign-in in the last 7 days (session-refresh.ts); this is what the owner sees about it
 * everywhere else — `pags whoami`, `pags devices` — so a machine that is not running, or whose renewal fails, is not discovered
 * only when it goes dark. Pure: the caller prints.
 */
export const EXPIRY_TIERS_DAYS = [30, 7, 1] as const;
const DAY_MS = 24 * 3600_000;

export interface ExpiryReading {
	/** Whole days left, rounded up; 0 or less once expired. */
	daysLeft: number;
	expired: boolean;
	/** The warning tier this falls in (30, 7 or 1), or null when there is more than 30 days left. */
	tier: (typeof EXPIRY_TIERS_DAYS)[number] | null;
}

export function readExpiry(expiresAt: number | null, now: number): ExpiryReading | null {
	if (expiresAt === null || !Number.isFinite(expiresAt)) return null;
	const left = expiresAt - now;
	const daysLeft = Math.ceil(left / DAY_MS);
	// The smallest tier that still contains the time left: 20 days → 30, 5 days → 7, 20 hours → 1.
	const tier = left <= 0 ? null : (([...EXPIRY_TIERS_DAYS].reverse().find((t) => left <= t * DAY_MS) ?? null) as ExpiryReading["tier"]);
	return { daysLeft, expired: left <= 0, tier };
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One line about the expiry, always: "Signed in until 2026-11-24 (29 days)". */
export function expiryLine(expiresAt: number | null, now: number): string {
	const r = readExpiry(expiresAt, now);
	if (!r || expiresAt === null) return "Sign-in expiry: unknown";
	if (r.expired) return `Sign-in expired on ${date(expiresAt)}`;
	return `Signed in until ${date(expiresAt)} (${r.daysLeft} day${r.daysLeft === 1 ? "" : "s"})`;
}

/** The warning for the tier reached, or null when there is nothing to warn about yet. */
export function expiryWarning(expiresAt: number | null, now: number): string | null {
	const r = readExpiry(expiresAt, now);
	if (!r) return null;
	if (r.expired) return "This sign-in has expired. Sign in again with `pags login` (`pags login --device` over SSH).";
	if (!r.tier) return null;
	const when = r.tier === 1 ? "within a day" : `in ${r.daysLeft} day${r.daysLeft === 1 ? "" : "s"}`;
	return `This sign-in expires ${when}. A running \`pags up\` renews it in its last 7 days; otherwise sign in again with \`pags login --device\`. Lifetime and machines: \`pags devices\`.`;
}

/** Warns once per tier per process, so a long-running caller does not repeat itself. */
export function expiryWarner(): (expiresAt: number | null, now: number) => string | null {
	const seen = new Set<string>();
	return (expiresAt, now) => {
		const r = readExpiry(expiresAt, now);
		const key = r?.expired ? "expired" : String(r?.tier ?? "");
		if (!r || (!r.expired && !r.tier) || seen.has(key)) return null;
		seen.add(key);
		return expiryWarning(expiresAt, now);
	};
}
