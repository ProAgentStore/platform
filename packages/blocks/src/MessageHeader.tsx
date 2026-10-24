import type { ReactNode } from "react";

/**
 * The strip above a chat bubble's text: who said it, an optional play button, and the stamp (#187).
 * One definition for what the console's chat and the Coder's Co-pilot thread each spelled out inline,
 * line for line, apart from the label, the playback icon and the wording of the titles — which are
 * props here, so the gloss and voice layers stay with the caller.
 *
 * `pr-12 sm:pr-0` reserves the width of the bubble's copy/delete actions on a phone, where they are
 * permanently visible (the #445 timestamp-overlap guard measures this); `data-msg-stamp` is how that
 * guard finds the stamp.
 *
 * A user bubble shows the play button only for a saved recording — the caller passes `onPlay` or not.
 */
export function MessageHeader({
	speaker,
	label,
	onPlay,
	playTitle,
	playAriaLabel,
	playIcon,
	stamp,
	stampTitle,
}: {
	speaker: "user" | "assistant";
	label: string;
	onPlay?: () => void;
	playTitle?: string;
	playAriaLabel?: string;
	playIcon?: ReactNode;
	stamp?: string;
	stampTitle?: string;
}) {
	const user = speaker === "user";
	return (
		<div className={`text-2xs ${user ? "opacity-70" : "text-accent"} mb-0.5 font-bold flex items-center justify-between gap-3 pr-12 sm:pr-0`}>
			<span className="flex items-center gap-1">
				{label}
				{onPlay && (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onPlay();
						}}
						onDoubleClick={(e) => e.stopPropagation()}
						title={playTitle}
						aria-label={playAriaLabel}
						className={`tap-target min-w-6 inline-flex justify-center ${user ? "opacity-80" : "opacity-70"} hover:opacity-100`}
					>
						{playIcon}
					</button>
				)}
			</span>
			{stamp && (
				<span data-msg-stamp title={stampTitle} className={`font-normal ${user ? "opacity-80" : "text-muted"} text-right`}>
					{stamp}
				</span>
			)}
		</div>
	);
}
