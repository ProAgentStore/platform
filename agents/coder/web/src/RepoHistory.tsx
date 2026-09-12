import type { TimelineEntry } from "./types";
import { entryText, groupRepoHistory, sessionLabel } from "./repo-history";

/**
 * A repo's terminal transcript, across every session it has ever had (#257).
 *
 * Rendered where "No session running / Start a session" used to be the entire screen. The history
 * was never lost — `coding_timeline` is append-only and it was all still in D1 — but it was only
 * readable per session, and the platform ends sessions by itself: the Pilot closes one every time
 * a run finishes, the orphan reaper closes the rest on each `pags up`. So the act of FINISHING
 * WORK is what emptied the terminal, and one live instance had 13 ended sessions, 0 active, with a
 * healthy runner and nothing on screen.
 */
export default function RepoHistory({ entries }: { entries: TimelineEntry[] | null }) {
	if (entries === null) {
		return <div className="flex-1 flex items-center justify-center p-6"><p className="text-sm text-muted-soft">Loading history…</p></div>;
	}
	const sections = groupRepoHistory(entries);
	if (!sections.length) {
		return (
			<div className="flex-1 flex items-center justify-center p-6 text-center">
				<p className="text-sm text-muted-soft">Nothing has run on this repo yet. Start a session and its output will be kept here.</p>
			</div>
		);
	}
	return (
		<div className="flex-1 min-h-0 overflow-auto bg-black/90 px-3 py-2 font-mono text-xs leading-relaxed">
			{sections.map((section, i) => (
				<div key={`${section.sessionId}:${section.entries[0]?.seq ?? i}`}>
					{/* The separator is the point of the inversion: a session is now a boundary in
					    the history, not the way you ask for it. */}
					<div className="sticky top-0 z-10 -mx-3 px-3 py-1 bg-panel/95 border-y border-line text-2xs text-muted font-sans">
						{sessionLabel(section, i)}
					</div>
					{section.entries.map((e) => (
						<pre key={e.seq} className="whitespace-pre-wrap break-words text-neutral-200">{entryText(e)}</pre>
					))}
				</div>
			))}
		</div>
	);
}
