/**
 * Short relative timestamp: "just now", "3m ago", "2h ago", "5d ago" (#187).
 *
 * One definition for what was three byte-identical copies (the Coder's Builds and Pulls panels
 * and the console's DeploymentCard) — "one clock across the tab", as the Pulls copy put it.
 * Floors each unit and never goes negative, so a clock skewed slightly ahead reads "just now".
 * Not the SDK's `formatTime`, which switches to a calendar date after a week and normalises
 * SQLite's zone-less timestamps; these callers pass real ISO strings and want "Nd ago".
 */
export function timeAgo(iso?: string, now: number = Date.now()): string {
	if (!iso) return "";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const s = Math.max(0, Math.floor((now - then) / 1000));
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}
