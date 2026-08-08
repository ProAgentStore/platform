import { useState } from "react";
import { Ear, AlertTriangle } from "lucide-react";
import { dictationDiverged, dictationLoss } from "@proagentstore/sdk/hooks";

/**
 * The body of a user message, with the live capture behind a toggle when there is one (#319).
 *
 * A voice turn is read by two recognizers — browser dictation as you speak, then Whisper on the
 * clip — and until now only the second one survived the turn. When they disagreed the user had
 * no way to see it: "it isn't capturing everything I say" was a report the platform could not
 * confirm or deny, because the evidence was overwritten at end-of-turn. The message now carries
 * both strings, and this switches between them.
 *
 * ── Why a labelled control and not a tap on the bubble
 *
 * Tapping the bubble body is already taken, twice over. A double-click there selects a word, and
 * an `onDoubleClick` handler on this exact element was REMOVED for hijacking that and blocking
 * copy (see the note at the call site) — replay moved to the always-visible speaker button in the
 * header for the same reason. So the gesture vocabulary is: **speaker button** = hear what was
 * said · **this button** = read what was heard · **the bubble** = read what was sent, and select
 * it. Three explicit controls, no gesture that a reader has to discover or that fights selection.
 *
 * Rendered only when a dictation was stored, which `storedDictation` already withholds when the
 * two readings agree — so no old turn, and no turn where there is nothing to compare, sprouts a
 * dead affordance.
 */
export default function SpokenMessage({ content, dictation }: { content: string; dictation?: string }) {
	const [heard, setHeard] = useState(false);
	if (!dictation) return <span className="whitespace-pre-wrap break-words">{content}</span>;

	// Derived on READ, from the one string that was stored. Cheap enough to do every render, and
	// deliberately not memoized: a memo over two strings would be more machinery than the work.
	const lost = dictationLoss(dictation, content);
	const diverged = dictationDiverged(dictation, content);

	return (
		<>
			<span className="whitespace-pre-wrap break-words">{heard ? dictation : content}</span>
			<div className="mt-1 flex items-center gap-2 text-2xs">
				<button
					type="button"
					aria-pressed={heard}
					onClick={(e) => { e.stopPropagation(); setHeard((v) => !v); }}
					title={heard ? "Show the transcript that was sent" : "Show what the live recogniser heard"}
					className="flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 opacity-80 hover:opacity-100"
				>
					<Ear size={11} />
					{heard ? "Heard live — show sent" : "Show what was heard"}
				</button>
				{/* The count is the whole point of the flag: "some words went missing" is a feeling,
				    "4 words" is a measurement. Shown whenever anything was lost; the warning icon is
				    reserved for a loss big enough that the transcript is materially short. */}
				{lost > 0 && (
					<span className={`flex items-center gap-1 ${diverged ? "font-bold" : "opacity-70"}`}>
						{diverged && <AlertTriangle size={11} />}
						{lost} word{lost === 1 ? "" : "s"} not in the transcript
					</span>
				)}
			</div>
		</>
	);
}
