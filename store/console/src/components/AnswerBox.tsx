import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ANSWER_MIN_ROWS, answerBoxHeight } from "../lib/answerBox";
import Button from "./Button";

/**
 * The owner's free-text answer to an agent's question (#1338) — the "type a different answer" box on a run that needs input.
 *
 * Multi-line and auto-growing, so what a person is writing stays visible and editable on a phone. Enter inserts a NEWLINE, never sends: the
 * owner decided on a dedicated, always-visible Send button, because a send-on-Enter box sends half a sentence the moment a phone keyboard's
 * return key is touched. Send sits under the box, full width on a phone.
 *
 * The draft lives in the parent (`value`), so it survives switching between choices and "type a different answer"; a failed send leaves it
 * exactly as typed (the parent only clears it on success). While a send is in flight the box is read-only, not disabled, so the text stays
 * selectable and focus is not thrown away.
 */
export default function AnswerBox({ value, onChange, onSend, saving, labelledBy, placeholder }: {
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	saving: boolean;
	/** The id of the element that holds the agent's question: the label, so the question is not duplicated into a placeholder that vanishes. */
	labelledBy: string;
	placeholder: string;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	const fit = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto"; // measure the content, not the previous height
		el.style.height = `${answerBoxHeight(el.scrollHeight, window.visualViewport?.height ?? window.innerHeight)}px`;
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger — re-measure whenever the text changes — not a value read here.
	useLayoutEffect(fit, [value, fit]);
	// The phone keyboard opening or the device turning changes the visible height, and so the cap.
	useEffect(() => {
		const viewport = window.visualViewport;
		window.addEventListener("resize", fit);
		viewport?.addEventListener("resize", fit);
		return () => {
			window.removeEventListener("resize", fit);
			viewport?.removeEventListener("resize", fit);
		};
	}, [fit]);
	return (
		<div className="flex flex-col gap-2 mt-2" data-testid="answer-box">
			<textarea
				ref={ref}
				data-testid="answer-textarea"
				aria-labelledby={labelledBy}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				readOnly={saving}
				aria-busy={saving || undefined}
				rows={ANSWER_MIN_ROWS}
				enterKeyHint="enter"
				placeholder={placeholder}
				className="block w-full min-h-28 resize-none overflow-y-auto bg-panel border border-line rounded-lg px-3 py-2.5 text-base leading-relaxed text-ink"
			/>
			<Button variant="primary" size="lg" className="w-full sm:w-auto sm:self-end" data-testid="answer-send" disabled={saving || !value.trim()} onClick={onSend}>
				{saving ? "Saving…" : "Send"}
			</Button>
		</div>
	);
}
