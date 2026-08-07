import type { HTMLAttributes, ReactNode } from "react";
import { type CardTone, cardClass } from "../lib/control-classes";

/**
 * The console's panel. One geometry (#366).
 *
 * 78 hand-written cards carried three of them, so whether a card's corner radius was 8px or
 * 12px, and whether its padding grew at the `sm` breakpoint, depended on which file you were
 * in. There is one answer now and it lives in `lib/control-classes.ts`.
 *
 * `className` is passthrough for the card's relationship to the page — `mb-4`, `flex-1`,
 * `overflow-hidden`. Padding and radius are not passthrough; see the note on `Button`.
 */
export default function Card({
	tone = "panel",
	className = "",
	children,
	...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "className"> & {
	tone?: CardTone;
	className?: string;
	children?: ReactNode;
}) {
	return (
		<div className={cardClass(tone, className)} {...rest}>
			{children}
		</div>
	);
}
