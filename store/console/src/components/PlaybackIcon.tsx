import { Loader2, Volume2 } from "lucide-react";

export type PlaybackPhase = "idle" | "loading" | "playing";

/**
 * The speaker control's three states.
 *
 * Replaying a saved recording means fetching a blob from R2 first, which is not instant — the
 * button used to sit unchanged through that, so a tap looked like it had done nothing and people
 * tapped again (cutting off the load that was already running). And once audio started there was
 * nothing on the page saying WHICH message you were hearing, which matters most in exactly the
 * case replay exists for: a long thread you are scrolling through.
 *
 *   idle     speaker
 *   loading  spinner  — it heard you, audio is on its way
 *   playing  bars     — this is the message you are hearing
 */
export default function PlaybackIcon({ phase, size = 11 }: { phase: PlaybackPhase; size?: number }) {
	if (phase === "loading") return <Loader2 size={size} className="animate-spin" />;
	if (phase !== "playing") return <Volume2 size={size} />;
	// Bars are sized off the icon size so this drops into any of the call sites unchanged.
	const w = Math.max(1, Math.round(size / 6));
	const gap = Math.max(1, Math.round(size / 9));
	return (
		<span
			aria-hidden="true"
			className="inline-flex items-end"
			style={{ height: size, gap }}
		>
			{[0, 0.3, 0.15].map((delay, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: three fixed bars, never reordered.
					key={i}
					className="pags-eq-bar bg-current rounded-[1px]"
					style={{ width: w, height: size, animationDelay: `${delay}s` }}
				/>
			))}
		</span>
	);
}
