import { AlertTriangle } from "lucide-react";
import { type EngineTurnReport, engineTurnNotice } from "./engine-turn-view";

/**
 * The ENGINE refused its last turn (#545).
 *
 * A component rather than a fragment built inside CodingTab, because there are TWO session views
 * — the single-repo surface returns ~120 lines above the multi-repo one — and a notice in only one
 * of them is a notice most Coder subscribers never see. That is not hypothetical: the first
 * placement was inline in the multi-repo view alone, and the phone spec for the solo surface found
 * it missing. Hoisting it to a shared local was the first fix; being its own component is the same
 * property with nothing left to forget to render.
 *
 * Rendered above the pane in both, because the whole finding is that this fact WAS on the page —
 * three times, as `[codex exited with code 1]` — and read as ordinary output. A pane is something
 * a person has to parse; this is the sentence.
 *
 * The reading is `engineTurnNotice`'s (./engine-turn-view, with its own tests); a null verdict —
 * an ok turn, or a runner older than CLI 0.4.51 — renders nothing. `id` is asserted by
 * e2e/console.spec.ts, so it is part of the contract, not decoration.
 */
export default function EngineTurnBanner({ report }: { report: EngineTurnReport | null }) {
	const turn = engineTurnNotice(report);
	if (!turn) return null;
	return (
		<div id="inst-coding-engine-turn" className="rounded-lg border border-warning-line bg-warning-soft px-3 py-2 m-2">
			<div className="flex items-center gap-1.5 text-sm font-semibold">
				<AlertTriangle size={13} className="text-warning shrink-0" />
				<span>{turn.label}</span>
			</div>
			<p className="text-xs text-muted mt-0.5">{turn.detail}</p>
			{turn.evidence && <pre className="text-2xs text-muted mt-1 whitespace-pre-wrap break-all">{turn.evidence}</pre>}
		</div>
	);
}
