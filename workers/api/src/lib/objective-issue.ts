/**
 * The GitHub issue an objective is ABOUT, or null when it names none.
 *
 * An objective routinely mentions several ("Work issue #920 … the #919 run pushed …"), so this is
 * the FIRST reference, preferring an explicit one — `issue #920`, `issue 920`, `…/issues/920`,
 * `owner/repo#920` — over a bare `#920`, because objectives lead with their subject and a bare `#N`
 * later on is usually context. Pull-request URLs and `PR #N` are not issues and are ignored.
 *
 * Its own module so the queue and the run store can stamp the issue on a row they create without importing
 * objective-dedupe, which imports the queue (#1335). objective-dedupe re-exports it.
 */
export function referencedIssue(objective: string): number | null {
	const explicit = /\bissues?\s*#?\s*(\d+)\b|\/issues\/(\d+)\b|\b[\w.-]+\/[\w.-]+#(\d+)\b/i.exec(objective);
	if (explicit) return Number(explicit[1] ?? explicit[2] ?? explicit[3]);
	const bare = /(?<![\w/])(?<!\bPR\s?)(?<!\bpull request\s?)#(\d+)\b/i.exec(objective);
	return bare ? Number(bare[1]) : null;
}
