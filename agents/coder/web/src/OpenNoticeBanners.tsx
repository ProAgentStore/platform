// What an open of a repo says on screen. The choosing is in ./open-notice; this is the rendering.
//
// ── Where it renders, and why not where you would expect
//
// In the SESSION view, not on the landing strip beside `openError` (#549). An open that has
// anything to report always returns a session, so `openTerminal` runs and the landing strip
// unmounts in the same tick — a notice there would be written and never seen. The one place the
// user is certain to be looking after pressing start is the terminal they were just taken to.
//
// Rendered from ONE component used at both call sites, because there are TWO session views — the
// single-repo surface returns ~120 lines above the multi-repo one — and a notice in only one of
// them is a notice most Coder subscribers never see. That is not hypothetical: #545's banner was
// first placed inline in the multi-repo view alone, and the phone spec for the solo surface found
// it missing.
//
// ── Two tones, and the asymmetry is the point (#697)
//
// `warn` is the tinted bordered banner #549 established for "the open did something other than
// what the button implies". `quiet` is the same geometry in panel colours. A resume is the
// expected outcome and wants to read as reassurance; shouted in yellow on every open it would
// train the eye to skip the banner, which is exactly the banner needed on the ONE open where the
// engine has forgotten everything.

import type { OpenNotice } from "./open-notice";

const TONE: Record<OpenNotice["tone"], string> = {
	warn: "bg-warning-soft border border-warning-line text-warning font-semibold",
	quiet: "bg-panel border border-line text-muted",
};

/** One row per fact, in the order ./open-notice put them. Empty list renders nothing. */
export default function OpenNoticeBanners({ notices }: { notices: OpenNotice[] }) {
	return (
		<>
			{notices.map((n) => (
				// `break-words`: the server's sentences are long and name a whole shell command, and a
				// 320px phone is where an unbreakable one becomes a horizontal scrollbar.
				<div key={n.id} id={n.id} className={`rounded-lg p-2.5 m-2 text-xs break-words ${TONE[n.tone]}`}>
					{n.text}
				</div>
			))}
		</>
	);
}
