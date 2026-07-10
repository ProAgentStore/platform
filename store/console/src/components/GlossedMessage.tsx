/**
 * An assistant message's content with the learning display (Settings → Translation):
 * the interlinear hanzi+romanization grid REPLACES the plain original when word
 * pairs exist, with the translation beneath at the same gloss size. Every layer is
 * tappable to hear it spoken; long-press/drag text selection is respected (a tap
 * with an active selection does nothing).
 */
import { renderMd } from "@proagentstore/sdk/ui";
import type { Message, MessageGloss } from "../lib/types";

/**
 * The word under a tap, for tap-to-pronounce. Uses the caret-from-point APIs to find
 * the text position, then Intl.Segmenter (word granularity — it segments Chinese/
 * Japanese without spaces, so a tap yields 名字, not a lone character) to expand it.
 * Returns null off-text, on punctuation/whitespace, or when the APIs are unavailable
 * (caller falls back to speaking the whole block).
 */
function wordAtPoint(x: number, y: number): string | null {
	const doc = document as Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};
	let node: Node | null = null;
	let offset = 0;
	if (doc.caretPositionFromPoint) {
		const p = doc.caretPositionFromPoint(x, y);
		if (p) { node = p.offsetNode; offset = p.offset; }
	} else if (doc.caretRangeFromPoint) {
		const r = doc.caretRangeFromPoint(x, y);
		if (r) { node = r.startContainer; offset = r.startOffset; }
	}
	if (!node || node.nodeType !== Node.TEXT_NODE) return null;
	const text = node.textContent || "";
	if (!text.trim()) return null;
	const Seg = (Intl as unknown as {
		Segmenter?: new (locale: undefined, opts: { granularity: "word" }) => {
			segment(t: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }>;
		};
	}).Segmenter;
	if (!Seg) return null;
	try {
		for (const s of new Seg(undefined, { granularity: "word" }).segment(text)) {
			if (offset >= s.index && offset < s.index + s.segment.length) {
				return s.isWordLike ? s.segment : null;
			}
		}
	} catch { /* segmentation unavailable */ }
	return null;
}

interface Props {
	message: Message;
	gloss?: MessageGloss;
	enabled: boolean;
	wordTap: boolean;
	/** Target-language name + BCP-47 tag (the translation is SPOKEN in its own language). */
	target: string;
	targetTag: string;
	sizes: { word: string; gloss: string };
	/** Speak text aloud; `lang` overrides the voice language for that utterance. */
	onSpeak: (text: string, lang?: string) => void;
}

export default function GlossedMessage({ message: m, gloss, enabled, wordTap, target, targetTag, sizes, onSpeak }: Props) {
	const hasGrid = enabled && !!gloss?.pairs?.length;
	return (
		<>
			{/* The interlinear grid REPLACES the plain original (showing both duplicated the
			    text); plain markdown renders until pairs arrive or when the gloss is off.
			    Whole-message playback lives on the bubble's speaker button. */}
			{!hasGrid && (
				<div
					className={`msg-md ${enabled && wordTap ? "cursor-pointer" : ""}`}
					title={enabled && wordTap ? "Tap a word to hear it" : undefined}
					onClick={enabled && wordTap ? (e) => {
						if ((e.target as HTMLElement).closest("a, button")) return;
						if (window.getSelection()?.toString()) return; // long-press selected text
						e.stopPropagation();
						const word = wordAtPoint(e.clientX, e.clientY);
						if (word) onSpeak(word);
					} : undefined}
					dangerouslySetInnerHTML={{ __html: renderMd(m.content) }}
				/>
			)}
			{enabled && gloss && (
				<div className={`flex flex-col gap-1 ${hasGrid ? "" : "mt-1.5 pt-1.5 border-t border-line/60"}`}>
					{/* Interlinear gloss: each original word with its romanization directly
					    beneath (textbook-style), every column tappable to hear that word.
					    Falls back to the flat transliteration line. */}
					{hasGrid ? (
						<div className="flex flex-wrap gap-x-2 gap-y-1.5 items-end">
							{gloss.pairs?.map(([word, roman], pi) => (
								<span
									key={`${pi}-${word}`}
									className="inline-flex flex-col items-center cursor-pointer hover:text-accent transition-colors"
									title="Tap to hear this word"
									onClick={(e) => { if (window.getSelection()?.toString()) return; e.stopPropagation(); onSpeak(word); }}
								>
									<span className={`${sizes.word} leading-tight`}>{word}</span>
									<span className={`${sizes.gloss} text-muted leading-tight min-h-[1em]`}>{roman}</span>
								</span>
							))}
						</div>
					) : gloss.transliteration ? (
						<div
							className={`${sizes.gloss} text-muted whitespace-pre-wrap cursor-pointer`}
							title="Tap to hear the original spoken"
							onClick={(e) => { if (window.getSelection()?.toString()) return; e.stopPropagation(); onSpeak(m.content); }}
						>
							{gloss.transliteration}
						</div>
					) : null}
					{/* Translation — SAME size as the transliteration (equally visible), color
					    is the differentiator. Spoken in ITS OWN language: the tapped word when
					    word-tap is on (whole line as fallback), else the line. */}
					<div
						className={`${sizes.gloss} text-accent whitespace-pre-wrap cursor-pointer mt-0.5`}
						title={wordTap ? `Tap a word to hear it in ${target}` : `Tap to hear it in ${target}`}
						onClick={(e) => {
							if (window.getSelection()?.toString()) return;
							e.stopPropagation();
							const word = wordTap ? wordAtPoint(e.clientX, e.clientY) : null;
							onSpeak(word || gloss.translation, targetTag);
						}}
					>
						{gloss.translation}
					</div>
				</div>
			)}
		</>
	);
}
