import { SafeHtmlView } from "@proagentstore/sdk/ui-react";
import { renderMd, formatDateTime } from "@proagentstore/sdk/ui";
import { gapBetween, stampTitle } from "../lib/messageStamp";
import { useAccountTimeZone } from "../lib/accountTimezone";

/**
 * The third channel in the transcript: neither of you said this, the platform is reporting.
 *
 * Loop entries (`**Loop → engine** (step 3)`, `**Loop complete**`), errors, "No response" and
 * interrupted-turn notices all land here. Centred and yellow so it reads as a report rather
 * than a turn — the colour is deliberate (#336) and stays.
 *
 * A one-liner keeps the pill; anything longer or formatted gets a block and renders as
 * markdown, because a loop result is full of `code` and **bold** that a whitespace-pre-wrap
 * pill printed as literal characters, in a shape built for six words.
 *
 * ── The stamp (#336)
 *
 * `createdAt` was on the record all along and nothing showed it, because the time lives in a
 * header row that only user and assistant bubbles have. These are the messages that need it
 * most: they report work that ran on its own schedule while you were elsewhere. The gap since
 * the row above is the scanning signal ("step 3 → step 4: +2m20s"); the clock time is what
 * makes the row consistent with its siblings, which render the same `formatDateTime`, in the
 * same local zone. See lib/messageStamp.ts for the zone note (#329).
 *
 * It wraps rather than overflowing: a short pill and its stamp fit on one line at 390px, and
 * when they do not the stamp drops to a second line instead of pushing the page sideways
 * (#333).
 */
export default function SystemMessage({ content, createdAt, prevCreatedAt }: {
	content: string;
	createdAt?: string;
	/** The timestamp of the entry directly above — what the elapsed gap is measured from. */
	prevCreatedAt?: string;
}) {
	// The owner's own zone when they have set one (#345) — so a zone chosen deliberately is not
	// honoured in the agent's prose and quietly ignored on hover.
	const timeZone = useAccountTimeZone();
	const long = content.length > 90 || content.includes("\n");
	const time = createdAt ? formatDateTime(createdAt) : "";
	const gap = gapBetween(prevCreatedAt, createdAt);
	const stamp = [gap && `+${gap}`, time].filter(Boolean).join(" · ");

	return (
		<div
			className={`bg-warning-soft text-warning self-center text-xs border border-warning-line max-w-[90%] ${
				long
					? "rounded-xl px-4 py-2.5 w-full"
					: "rounded-full px-4 py-1.5 flex flex-wrap items-baseline justify-center gap-x-2"
			}`}
		>
			{/* min-w-0 + break-words so a long unbreakable token (a URL in an error) wraps inside
			    the pill instead of widening the page — the #333 failure mode. */}
			<SafeHtmlView className={`min-w-0 break-words ${long ? "msg-md leading-relaxed" : ""}`} html={renderMd(content)} />
			{stamp && (
				<span
					title={stampTitle(createdAt, timeZone)}
					className={`text-2xs opacity-70 whitespace-nowrap tabular-nums ${long ? "block text-right mt-1.5" : ""}`}
				>
					{stamp}
				</span>
			)}
		</div>
	);
}
